import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import { sql } from '../db.js';
import { resetRateLimits } from '../lib/rate-limit.js';
import { buildServer } from '../server.js';
import { resetAllowlistCache } from './allowlist.js';
import { clearUiRoleCache } from './ui.js';

// 承認者ゲート（docs/61）: 所属ではなく approver ロールで判定する。
const directory = vi.hoisted(() => ({ byEmail: new Map<string, Record<string, unknown>>() }));

vi.mock('../lib/mirai-info.js', () => ({
  findEmployeeByEmail: async (email: string) =>
    directory.byEmail.get(String(email || '').toLowerCase()) ?? null,
  findEmployeeEmailByNo: async () => null,
  listEmployees: async () => ({
    employees: [...directory.byEmail.values()],
    total: directory.byEmail.size,
    cachedAt: new Date().toISOString(),
  }),
  filterStaff: (rows: Record<string, unknown>[]) => rows,
}));

const DX_PLAIN = 'gate-dx-plain@example.com'; // DX 推進部・approver なし
const DX_APPROVER = 'gate-dx-approver@example.com'; // DX 推進部・approver あり
const TECH_APPROVER = 'gate-tech-approver@example.com'; // 技術部・approver あり
const OUTSIDE_APPROVER = 'gate-outside-approver@example.org'; // 名簿外・approver あり
const CHECKLIST = { reproducible: true, noSecrets: true, noBlame: true, scopeClear: true };
const originals = {
  self: config.ALLOW_SELF_APPROVAL,
  authMode: config.AUTH_MODE,
  allowlist: config.ACCESS_ALLOWLIST_FILE,
  jwt: config.ACCESS_JWT_MODE,
  persona: config.PERSONA_SWITCH_ALLOWLIST,
};
const allowDir = mkdtempSync(path.join(tmpdir(), 'aihd-approver-gate-'));

let app: FastifyInstance;
let sequence = 0;
let currentEmail = '';

async function addUser(email: string, roles: string[]): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, role, password_hash)
    VALUES (${email}, ${email}, ${roles[0] ?? 'requester'}, 'access-only$no-login')
    ON CONFLICT (lower(email)) DO UPDATE SET updated_at = now()
    RETURNING id
  `;
  const id = rows[0]?.id ?? '';
  await sql`DELETE FROM user_roles WHERE user_id = ${id}`;
  for (const role of roles) {
    await sql`
      INSERT INTO user_roles (user_id, role, source, granted_by)
      VALUES (${id}, ${role}, 'manual', 'test')
    `;
  }
}

function as(email: string): void {
  currentEmail = email;
  clearUiRoleCache();
}

// 実運用と同じ cloudflare-access 経路で判定する（local の DEV 例外を通さない）。
function call(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) {
  return app.inject({
    method,
    url,
    headers: { 'cf-access-authenticated-user-email': currentEmail },
    ...(payload ? { payload } : {}),
  });
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    clientRef: `GATE-${Date.now()}-${(sequence += 1)}`,
    status: 'pending',
    title: 'プリンタの再接続',
    symptom: '印刷できない',
    cause: 'スプーラ停止',
    steps: '再起動する',
    keywords: [],
    ...overrides,
  };
}

async function sync(payload: Record<string, unknown>) {
  return call('POST', '/api/knowledge/ui-sync', payload);
}

beforeAll(async () => {
  directory.byEmail.set(DX_PLAIN, { employeeNo: 'T1', name: 'DX', section: 'DX推進部' });
  directory.byEmail.set(DX_APPROVER, { employeeNo: 'T2', name: 'DXA', section: 'DX推進部' });
  directory.byEmail.set(TECH_APPROVER, { employeeNo: 'T3', name: '技術', section: '技術部' });
  await addUser(DX_PLAIN, ['helpdesk']);
  await addUser(DX_APPROVER, ['helpdesk', 'approver']);
  await addUser(TECH_APPROVER, ['approver']);
  await addUser(OUTSIDE_APPROVER, ['approver']);
  writeFileSync(
    path.join(allowDir, 'allow.txt'),
    [DX_PLAIN, DX_APPROVER, TECH_APPROVER, OUTSIDE_APPROVER].join('\n'),
  );
  config.ACCESS_ALLOWLIST_FILE = path.join(allowDir, 'allow.txt');
  resetAllowlistCache();
  config.AUTH_MODE = 'cloudflare-access';
  config.ACCESS_JWT_MODE = 'off';
  config.PERSONA_SWITCH_ALLOWLIST = '';
  config.ALLOW_SELF_APPROVAL = false;
  app = await buildServer({ logger: false });
  await app.ready();
});

beforeEach(() => {
  resetRateLimits();
});

afterAll(async () => {
  config.ALLOW_SELF_APPROVAL = originals.self;
  config.AUTH_MODE = originals.authMode;
  config.ACCESS_ALLOWLIST_FILE = originals.allowlist;
  config.ACCESS_JWT_MODE = originals.jwt;
  config.PERSONA_SWITCH_ALLOWLIST = originals.persona;
  resetAllowlistCache();
  clearUiRoleCache();
  rmSync(allowDir, { recursive: true, force: true });
  await app.close();
});

describe('ナレッジの承認ゲート', () => {
  it('DX 推進部でも approver が無ければ承認・差戻しできない（下書きは可）', async () => {
    as(DX_APPROVER);
    const payload = draft();
    expect((await sync(payload)).statusCode).toBe(200);

    as(DX_PLAIN);
    const approve = await sync({ ...payload, status: 'approved', checklist: CHECKLIST });
    expect(approve.statusCode, approve.body).toBe(403);
    const reject = await sync({ ...payload, status: 'rejected', comment: '理由' });
    expect(reject.statusCode, reject.body).toBe(403);
    const mine = await sync(draft());
    expect(mine.statusCode, mine.body).toBe(200);
  });

  it.each([
    ['DX 以外', TECH_APPROVER],
    ['名簿外', OUTSIDE_APPROVER],
  ])('%s の approver は一覧を見て承認でき、下書きは作れない', async (_label, email) => {
    as(DX_APPROVER);
    const payload = draft();
    expect((await sync(payload)).statusCode).toBe(200);

    as(email);
    const pending = await call('GET', '/api/knowledge/pending');
    expect(pending.statusCode, pending.body).toBe(200);
    const approve = await sync({ ...payload, status: 'approved', checklist: CHECKLIST });
    expect(approve.statusCode, approve.body).toBe(200);
    expect(approve.json().selfApproved).toBe(false);

    const own = await sync(draft());
    expect(own.statusCode, own.body).toBe(403);
  });

  it('approver でも自分が作成したものは承認できない（職務分離）', async () => {
    as(DX_APPROVER);
    const payload = draft();
    expect((await sync(payload)).statusCode).toBe(200);
    const self = await sync({ ...payload, status: 'approved', checklist: CHECKLIST });
    expect(self.statusCode, self.body).toBe(403);
    expect(self.json().error.code).toBe('SELF_APPROVAL_FORBIDDEN');
  });
});

describe('引継ぎの承認と担当者権限の分離', () => {
  async function claimedHandoverId(): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO case_handovers (case_id, owner_email, status, snapshot, claimed_by)
      VALUES (${`CASE-GATE-${Date.now()}-${(sequence += 1)}`}, ${DX_PLAIN}, 'claimed',
        ${sql.json({ case: { subject: 'gate' } })}, ${DX_PLAIN})
      RETURNING id
    `;
    return rows[0]?.id ?? '';
  }

  it('approver の無い DX は 403、DX 以外・名簿外の approver は 200', async () => {
    const id = await claimedHandoverId();
    const url = `/api/case-handovers/${id}/approve`;

    as(DX_PLAIN);
    expect((await call('POST', url, {})).statusCode).toBe(403);

    as(OUTSIDE_APPROVER);
    const ok = await call('POST', url, {});
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().handover.selfApproved).toBe(false);

    const second = await claimedHandoverId();
    as(TECH_APPROVER);
    const tech = await call('POST', `/api/case-handovers/${second}/approve`, {});
    expect(tech.statusCode, tech.body).toBe(200);
  });

  it.each([
    ['DX 以外', TECH_APPROVER],
    ['名簿外', OUTSIDE_APPROVER],
  ])('%s の approver に受信箱・claim の権限は付かない', async (_label, email) => {
    const id = await claimedHandoverId();
    as(email);
    const inbox = await call('GET', '/api/case-handovers/inbox');
    expect(inbox.statusCode).toBe(403);
    const claim = await call('POST', `/api/case-handovers/${id}/claim`, {});
    expect(claim.statusCode).toBe(403);
  });
});

describe('社外の承認者へ社員情報を返さない', () => {
  it('名簿外は社員名簿・宛先候補が空、名簿内は従来どおり', async () => {
    as(OUTSIDE_APPROVER);
    const employees = await call('GET', '/api/employees?scope=all');
    expect(employees.statusCode).toBe(200);
    expect(employees.json().employees).toEqual([]);
    const recipients = await call('GET', '/api/case-handovers/recipients');
    expect(recipients.statusCode).toBe(200);
    expect(recipients.json().members).toEqual([]);

    as(TECH_APPROVER);
    const inside = await call('GET', '/api/employees?scope=all');
    expect(inside.json().employees.length).toBeGreaterThan(0);
  });
});
