import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetAllowlistCache } from '../auth/allowlist.js';
import { clearUiRoleCache } from '../auth/ui.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { buildServer } from '../server.js';

/**
 * P0 ロールマトリクス（QA 2026-11-11 / 運用統合UI切替）。
 *
 * Access の許可リストを通過したうえで、users/users_roles のロール集合が
 * ops UI/API の読み書き境界に効くことを実 DB で確認する。
 * 既存の role-separation テスト（セッション認証）とは別に、UI 経路（Access ヘッダー）で叩く。
 */
const PREFIX = 'p0-role-';
const EMAILS = {
  requester: `${PREFIX}requester@mirai-const.co.jp`,
  helpdeskRoleOnly: `${PREFIX}helpdesk-role-only@mirai-const.co.jp`,
  helpdeskDemo: `${PREFIX}helpdesk-demo@mirai-const.co.jp`,
  approver: `${PREFIX}approver@mirai-const.co.jp`,
  auditor: `${PREFIX}auditor@mirai-const.co.jp`,
} as const;
const USERS = [
  [EMAILS.requester, 'requester'],
  [EMAILS.helpdeskRoleOnly, 'helpdesk'],
  [EMAILS.helpdeskDemo, 'requester'],
  [EMAILS.approver, 'approver'],
  [EMAILS.auditor, 'auditor'],
] as const;
const MARK = '【E2E】p0-role';
const dir = mkdtempSync(path.join(tmpdir(), 'aihd-p0-roles-'));
const allowlistFile = path.join(dir, 'allowlist.txt');
const original = {
  AUTH_MODE: config.AUTH_MODE,
  ACCESS_JWT_MODE: config.ACCESS_JWT_MODE,
  ACCESS_ALLOWLIST_FILE: config.ACCESS_ALLOWLIST_FILE,
  REQUIRE_PROXY_SECRET: config.REQUIRE_PROXY_SECRET,
  OPS_UI_PRIMARY: config.OPS_UI_PRIMARY,
  PERSONA_SWITCH_ALLOWLIST: config.PERSONA_SWITCH_ALLOWLIST,
};
let app: FastifyInstance | undefined;

function server(): FastifyInstance {
  if (!app) throw new Error('server is not ready');
  return app;
}

function headers(email: string): Record<string, string> {
  return { 'cf-access-authenticated-user-email': email };
}

beforeAll(async () => {
  writeFileSync(
    allowlistFile,
    `@mirai-const.co.jp\n${USERS.map(([email]) => email).join('\n')}\n`,
    { mode: 0o600 },
  );
  Object.assign(config, {
    AUTH_MODE: 'cloudflare-access',
    ACCESS_JWT_MODE: 'off',
    ACCESS_ALLOWLIST_FILE: allowlistFile,
    REQUIRE_PROXY_SECRET: false,
    OPS_UI_PRIMARY: true,
    // helpdesk の全件スコープは users.role ではなく、DX 名簿所属または
    // PERSONA_SWITCH_ALLOWLIST のデモ許可で決まる（helpdesk-scope.ts）。
    PERSONA_SWITCH_ALLOWLIST: EMAILS.helpdeskDemo,
  });
  resetAllowlistCache();
  await sql`DELETE FROM users WHERE email LIKE ${`${PREFIX}%`}`;
  for (const [email, role] of USERS) {
    await sql`
      INSERT INTO users (email, name, role, password_hash)
      VALUES (${email}, ${email}, ${role}, 'x')
    `;
  }
  clearUiRoleCache();
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  try {
    await sql`DELETE FROM ops_tickets WHERE subject LIKE ${`${MARK}%`}`;
    await sql`
      UPDATE ops_estop
      SET active = false, reason = null, actor_email = null, updated_at = now()
      WHERE id = 1
    `;
    await sql`DELETE FROM users WHERE email LIKE ${`${PREFIX}%`}`;
    clearUiRoleCache();
  } finally {
    if (app) await app.close();
    Object.assign(config, original);
    resetAllowlistCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('P0 ロールマトリクス（UI/Access 経路）', () => {
  it('requester は自分のチケットだけを一覧できる', async () => {
    const subject = `${MARK} requester scope ${Date.now()}`;
    const created = await server().inject({
      method: 'POST',
      url: '/api/ops/tickets',
      headers: headers(EMAILS.requester),
      payload: { subject, body: 'P0 ロール試験の受付です。', category: 'other' },
    });
    expect(created.statusCode).toBe(200);

    const list = await server().inject({
      method: 'GET',
      url: '/api/ops/tickets',
      headers: headers(EMAILS.requester),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { scope: string; tickets: { subject: string }[] };
    expect(body.scope).toBe('mine');
    expect(body.tickets.some((ticket) => ticket.subject === subject)).toBe(true);
  });

  it('users.role=helpdesk だけでは全件にならない（名簿/デモ許可が正本・fail-closed）', async () => {
    const list = await server().inject({
      method: 'GET',
      url: '/api/ops/tickets',
      headers: headers(EMAILS.helpdeskRoleOnly),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { scope: string }).scope).toBe('mine');
  });

  it('DX名簿またはデモ許可のヘルプデスクは全件を一覧できる', async () => {
    const list = await server().inject({
      method: 'GET',
      url: '/api/ops/tickets',
      headers: headers(EMAILS.helpdeskDemo),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { scope: string }).scope).toBe('all');
  });

  it('auditor は ops の書込みが 403（読み取り専用）', async () => {
    const response = await server().inject({
      method: 'POST',
      url: '/api/ops/tickets',
      headers: headers(EMAILS.auditor),
      payload: { subject: `${MARK} auditor write`, body: '監査ロールの書込みは拒否される。' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('auditor は ops status を読める', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/api/ops/status',
      headers: headers(EMAILS.auditor),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; audit: unknown };
    expect(body.ok).toBe(true);
    expect(body.audit).not.toBeNull();
  });

  it('approver は estop を操作でき、requester は 403', async () => {
    const on = await server().inject({
      method: 'POST',
      url: '/api/ops/estop',
      headers: headers(EMAILS.approver),
      payload: { active: true, reason: 'P0 E2E' },
    });
    expect(on.statusCode).toBe(200);

    const off = await server().inject({
      method: 'POST',
      url: '/api/ops/estop',
      headers: headers(EMAILS.approver),
      payload: { active: false },
    });
    expect(off.statusCode).toBe(200);

    const denied = await server().inject({
      method: 'POST',
      url: '/api/ops/estop',
      headers: headers(EMAILS.requester),
      payload: { active: true, reason: 'requester should fail' },
    });
    expect(denied.statusCode).toBe(403);
  });
});
