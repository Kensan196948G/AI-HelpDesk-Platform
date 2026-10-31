import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAllowlistCache } from '../auth/allowlist.js';
import { clearUiRoleCache } from '../auth/ui.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { buildCaseContext, buildPcContext, type CaseSnapshot } from '../lib/case-handover.js';
import { resetRateLimits } from '../lib/rate-limit.js';
import { DEVICE_IDENTITY_PROBE_COMMAND } from '../remote-support/rsp.js';
import { buildServer } from '../server.js';
import { sweepFolderAccess } from './service.js';
import { canonicalOpJson, signOp } from './sign.js';

/**
 * 本人同意付きフォルダ一覧の統合テスト（docs/62）。API + 実 PostgreSQL テスト DB。
 * Mock: 社員名簿（mirai-info）、RSP、Mirai-Info PII API（fetch を URL で振り分ける）。
 * Mock 以外の URL への fetch は記録して失敗にする（本番 RSP へ出ていかないことの確認）。
 * 認証は実運用と同じ cloudflare-access 経路で判定する（local の DEV 例外を通さない）。
 */

const directory = vi.hoisted(() => ({ byEmail: new Map<string, Record<string, unknown>>() }));

vi.mock('../lib/mirai-info.js', () => ({
  findEmployeeByEmail: async (email: string) =>
    directory.byEmail.get(String(email || '').toLowerCase()) ?? null,
  findEmployeeEmailByNo: async () => null,
  listEmployees: async () => ({ employees: [], total: 0, cachedAt: new Date().toISOString() }),
  filterStaff: (rows: Record<string, unknown>[]) => rows,
}));

const OWNER = 'fa-owner@example.com';
const OTHER_OWNER = 'fa-other-owner@example.com';
const ASSIGNEE = 'fa-assignee@example.com';
const OTHER_ASSIGNEE = 'fa-other-assignee@example.com';
const APPROVER_ONLY = 'fa-approver-only@example.com';
const CASE_PREFIX = 'CASE-FA-';
const HOST = 'SYNTH-PC-001';
const RSP_DEVICE = '33333333-3333-4333-8333-333333333333';
const MACHINE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_MACHINE = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const SID = 'S-1-5-21-1000000001-1000000002-1000000003-1104';
const OTHER_SID = 'S-1-5-21-1000000001-1000000002-1000000003-1105';
const USER = 'CORP\\synth-user';
const SESSION = 2;
const CANARY_NAME = 'CANARY-給与明細-2026.xlsx';
const CANARY_SEGMENT = 'CANARY-個人フォルダ';
const LEASE_URL = 'https://lease.test.invalid/api/device-staff';
const RSP_URL = 'https://rsp.test.invalid';

const originals = {
  enabled: config.FOLDER_ACCESS_ENABLED,
  unverified: config.FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE,
  leaseUrl: config.LEASE_API_URL,
  leaseId: config.LEASE_API_TOKEN_ID,
  leaseSecret: config.LEASE_API_TOKEN_SECRET,
  rspKey: config.RSP_SERVICE_KEY,
  rspBase: config.RSP_BASE_URL,
  authMode: config.AUTH_MODE,
  allowlist: config.ACCESS_ALLOWLIST_FILE,
  jwt: config.ACCESS_JWT_MODE,
  persona: config.PERSONA_SWITCH_ALLOWLIST,
  requireProxy: config.REQUIRE_PROXY_SECRET,
  proxySecret: config.PROXY_SECRET,
};
const allowDir = mkdtempSync(path.join(tmpdir(), 'aihd-folder-access-'));

interface World {
  lease: unknown;
  leaseStatus: number;
  matches: Record<string, unknown>[];
  enqueueDevice: string;
  probe: { status: string; output: unknown; error_code: string | null; completed_at?: string };
  commands: Record<string, unknown>[];
  leaseCalls: number;
  probeReads: number;
  unexpected: string[];
}

let world: World;
let app: FastifyInstance;
let sequence = 0;

function leaseBody(records: Record<string, unknown>[], dataAt: string | null = 'now') {
  const now = new Date().toISOString();
  return {
    ok: true,
    source: 'device_staff_view',
    pii: true,
    generatedAt: now,
    filter: { employee_no: 'E100' },
    dataAsOf: { employeeDirectoryLastSeenAt: dataAt === 'now' ? now : dataAt },
    records,
  };
}

const LEASE_ROW = {
  asset_tag: 'A-1',
  hostname: HOST,
  employee_no: 'E100',
  employee_active: true,
  lease_active: true,
};

function probeOutput(overrides: { guid?: string; quser?: string[] } = {}): string {
  return JSON.stringify({
    machineGuid: overrides.guid ?? MACHINE,
    quser: overrides.quser ?? [
      ' USERNAME   SESSIONNAME  ID  STATE   IDLE TIME  LOGON TIME',
      `>synth-user console       ${SESSION}  Active  none       10/31/2026 9:00 AM`,
    ],
  });
}

function freshWorld(): World {
  return {
    lease: leaseBody([LEASE_ROW]),
    leaseStatus: 200,
    matches: [
      {
        device_id: RSP_DEVICE,
        hostname: HOST,
        agent_installed: true,
        agent_online: true,
        mesh_deploy_status: null,
        mesh_node_id: 'node//synth',
      },
    ],
    enqueueDevice: RSP_DEVICE,
    probe: { status: 'completed', output: probeOutput(), error_code: null },
    commands: [],
    leaseCalls: 0,
    probeReads: 0,
    unexpected: [],
  };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function fakeFetch(input: unknown, init?: RequestInit) {
  const url = String(input);
  if (url.startsWith(LEASE_URL)) {
    world.leaseCalls += 1;
    const headers = init?.headers as Record<string, string>;
    expect(headers['CF-Access-Client-Id']).toBe('synth-client-id');
    expect(headers['CF-Access-Client-Secret']).toBe('synth-client-secret');
    return jsonResponse(world.leaseStatus, world.lease);
  }
  if (url.startsWith(`${RSP_URL}/api/v1/service/devices`)) {
    return jsonResponse(200, {
      success: true,
      data: { count: world.matches.length, matches: world.matches },
    });
  }
  if (url === `${RSP_URL}/api/v1/service/commands` && init?.method === 'POST') {
    world.commands.push(JSON.parse(String(init.body)));
    return jsonResponse(201, {
      log_id: `log-${world.commands.length}`,
      device_id: world.enqueueDevice,
      status: 'queued',
      risk_level: 'safe',
    });
  }
  if (url.startsWith(`${RSP_URL}/api/v1/service/commands/`)) {
    world.probeReads += 1;
    return jsonResponse(200, { log_id: 'x', exit_code: null, ...world.probe });
  }
  world.unexpected.push(url);
  throw new Error(`unexpected fetch: ${url}`);
}

function call(
  email: string | null,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  clearUiRoleCache();
  return app.inject({
    method,
    url,
    headers: {
      ...(email ? { 'cf-access-authenticated-user-email': email } : {}),
      ...headers,
    },
    ...(payload ? { payload } : {}),
  });
}

function helperCall(token: string, url: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/device/agent/folder-helper/${url}`,
    headers: { 'x-folder-helper-token': token },
    payload,
  });
}

const beat = { sid: SID, sessionId: SESSION, sessionState: 'active' };
const poll = (token: string, body: Record<string, unknown> = beat) =>
  helperCall(token, 'poll', body);

function registerPayload(overrides: Record<string, unknown> = {}) {
  return {
    machineGuid: MACHINE,
    sid: SID,
    userName: USER,
    sessionId: SESSION,
    sessionState: 'active',
    hostname: HOST,
    helperVersion: '0.1.0',
    ...overrides,
  };
}

async function registerHelper(overrides: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/device/agent/folder-helper/register',
    payload: registerPayload(overrides),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as {
    helperId: string;
    helperToken: string;
    pairingCode: string;
    pairingExpiresAt: string;
  };
}

async function makeHandover(claimedBy: string | null = ASSIGNEE, owner = OWNER): Promise<string> {
  sequence += 1;
  const caseId = `${CASE_PREFIX}${Date.now()}-${sequence}`;
  const snapshot = {
    caseId,
    case: { id: caseId, subject: '合成の相談', userId: 'u1' },
    chat: { id: caseId, messages: [] },
    ticket: { id: `TKT-${sequence}` },
  };
  const rows = await sql<{ id: string }[]>`
    INSERT INTO case_handovers (case_id, owner_email, status, snapshot, claimed_by, claimed_at)
    VALUES (${caseId}, ${owner}, ${claimedBy ? 'claimed' : 'pending'},
            ${sql.json(snapshot)}, ${claimedBy}, ${claimedBy ? new Date() : null})
    RETURNING id
  `;
  return rows[0]?.id ?? '';
}

async function createRequest(handoverId: string, extra: Record<string, unknown> = {}) {
  const response = await call(ASSIGNEE, 'POST', '/api/folder-access/requests', {
    handoverId,
    ...extra,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().request as Record<string, any>;
}

const base = (id: string, suffix = '') => `/api/folder-access/requests/${id}${suffix}`;

async function pairedRequest(helperOverrides: Record<string, unknown> = {}) {
  const handoverId = await makeHandover();
  const request = await createRequest(handoverId);
  expect(request.status).toBe('helper_pending');
  const helper = await registerHelper(helperOverrides);
  const pair = await call(OWNER, 'POST', base(request.id, '/pair'), { code: helper.pairingCode });
  expect(pair.statusCode, pair.body).toBe(200);
  return { handoverId, id: request.id as string, helper, pair: pair.json().request };
}

const CONSENT = { root: 'Documents', segments: [CANARY_SEGMENT], ttlMinutes: 30 };

async function activeRequest() {
  const paired = await pairedRequest();
  expect(paired.pair.status).toBe('consent_pending');
  const consent = await call(OWNER, 'POST', base(paired.id, '/consent'), CONSENT);
  expect(consent.statusCode, consent.body).toBe(200);
  expect(consent.json().request.status).toBe('active');
  return paired;
}

async function deliveredOp() {
  const active = await activeRequest();
  const listed = await call(ASSIGNEE, 'POST', base(active.id, '/list'), {});
  expect(listed.statusCode, listed.body).toBe(200);
  const polled = await poll(active.helper.helperToken);
  expect(polled.statusCode, polled.body).toBe(200);
  const op = polled.json().ops[0];
  expect(op).toBeDefined();
  return { ...active, op };
}

function resultBody(entries: unknown[] = [{ name: CANARY_NAME, type: 'file', size: 10 }]) {
  return {
    actorSid: SID,
    sessionId: SESSION,
    root: 'Documents',
    status: 'ok',
    truncated: false,
    elapsedMs: 12,
    entries,
  };
}

const postResult = (token: string, opId: string, body: Record<string, unknown>) =>
  helperCall(token, `ops/${opId}/result`, body);

async function requestRow(id: string) {
  const rows = await sql<
    { status: string; end_reason: string | null; reason_code: string | null }[]
  >`SELECT status, end_reason, reason_code FROM folder_access_requests WHERE id = ${id}`;
  return rows[0];
}

async function resultCount(id: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    SELECT count(*) AS count FROM folder_access_results WHERE request_id = ${id}
  `;
  return Number(rows[0]?.count);
}

async function auditRows(id: string) {
  return sql<{ action: string; detail: unknown }[]>`
    SELECT action, detail FROM audit_log
    WHERE target_type = 'folder_access_request' AND target_id = ${id}
    ORDER BY id
  `;
}

async function addRoleUser(email: string, roles: string[]) {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, role, password_hash)
    VALUES (${email}, ${email}, 'requester', 'access-only$no-login')
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

beforeAll(async () => {
  directory.byEmail.set(OWNER, { employeeNo: 'E100', name: '相談者', section: '営業部' });
  directory.byEmail.set(OTHER_OWNER, { employeeNo: 'E101', name: '別の人', section: '営業部' });
  directory.byEmail.set(ASSIGNEE, { employeeNo: 'E300', name: '担当', section: 'DX推進部' });
  directory.byEmail.set(OTHER_ASSIGNEE, {
    employeeNo: 'E301',
    name: '別担当',
    section: 'DX推進部',
  });
  directory.byEmail.set(APPROVER_ONLY, { employeeNo: 'E400', name: '承認', section: '技術部' });
  await addRoleUser(APPROVER_ONLY, ['approver']);
  writeFileSync(
    path.join(allowDir, 'allow.txt'),
    [OWNER, OTHER_OWNER, ASSIGNEE, OTHER_ASSIGNEE, APPROVER_ONLY].join('\n'),
  );
  config.ACCESS_ALLOWLIST_FILE = path.join(allowDir, 'allow.txt');
  resetAllowlistCache();
  config.AUTH_MODE = 'cloudflare-access';
  config.ACCESS_JWT_MODE = 'off';
  config.PERSONA_SWITCH_ALLOWLIST = '';
  config.RSP_SERVICE_KEY = 'test-service-key-0123456789abcdef0123456789abcdef';
  config.RSP_BASE_URL = `${RSP_URL}/`;
  app = await buildServer({ logger: false });
  await app.ready();
});

beforeEach(() => {
  resetRateLimits();
  world = freshWorld();
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  config.FOLDER_ACCESS_ENABLED = true;
  config.FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE = false;
  config.LEASE_API_URL = LEASE_URL;
  config.LEASE_API_TOKEN_ID = 'synth-client-id';
  config.LEASE_API_TOKEN_SECRET = 'synth-client-secret';
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  vi.unstubAllGlobals();
});

afterAll(async () => {
  config.FOLDER_ACCESS_ENABLED = originals.enabled;
  config.FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE = originals.unverified;
  config.LEASE_API_URL = originals.leaseUrl;
  config.LEASE_API_TOKEN_ID = originals.leaseId;
  config.LEASE_API_TOKEN_SECRET = originals.leaseSecret;
  config.RSP_SERVICE_KEY = originals.rspKey;
  config.RSP_BASE_URL = originals.rspBase;
  config.AUTH_MODE = originals.authMode;
  config.ACCESS_ALLOWLIST_FILE = originals.allowlist;
  config.ACCESS_JWT_MODE = originals.jwt;
  config.PERSONA_SWITCH_ALLOWLIST = originals.persona;
  config.REQUIRE_PROXY_SECRET = originals.requireProxy;
  config.PROXY_SECRET = originals.proxySecret;
  resetAllowlistCache();
  await sql`DELETE FROM case_handovers WHERE case_id LIKE ${`${CASE_PREFIX}%`}`;
  await sql`DELETE FROM folder_access_helpers WHERE machine_guid IN (${MACHINE}, ${OTHER_MACHINE})`;
  await app.close();
  rmSync(allowDir, { recursive: true, force: true });
});

describe('正常系フルフロー（Mock: RSP / PII API / 名簿）', () => {
  it('依頼 → ペアリング → 同意 → 一覧 → 結果 → 終了で結果が消える', async () => {
    const handoverId = await makeHandover();
    const request = await createRequest(handoverId);
    expect(request.status).toBe('helper_pending');
    expect(request.leaseStatus).toBe('verified');
    expect(request.device.rspDeviceId).toBe(RSP_DEVICE);
    expect(request.device.meshNodeId).toBe('node//synth');

    // RSP へ投げるのは固定テンプレートだけ。案件やユーザー由来の文字列を挿入しない。
    expect(world.commands).toHaveLength(1);
    expect(world.commands[0]?.command_text).toBe(DEVICE_IDENTITY_PROBE_COMMAND);
    expect(world.commands[0]?.hostname).toBe(HOST);
    expect(DEVICE_IDENTITY_PROBE_COMMAND).toContain('MachineGuid');
    expect(DEVICE_IDENTITY_PROBE_COMMAND).toContain('quser');
    // ヘルパーがペアリングするまで結果は取りに行かない（非同期）。
    expect(world.probeReads).toBe(0);

    const helper = await registerHelper();
    expect(helper.pairingCode).toMatch(/^\d{8}$/);
    const stored = await sql<{ token_hash: string; pairing_code_hash: string; sid: string }[]>`
      SELECT token_hash, pairing_code_hash, sid FROM folder_access_helpers WHERE id = ${helper.helperId}
    `;
    expect(stored[0]?.token_hash).not.toContain(helper.helperToken);
    expect(stored[0]?.pairing_code_hash).not.toContain(helper.pairingCode);
    expect(stored[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const pair = await call(OWNER, 'POST', base(request.id, '/pair'), {
      code: helper.pairingCode,
    });
    expect(pair.statusCode, pair.body).toBe(200);
    const paired = pair.json().request;
    expect(paired.status).toBe('consent_pending');
    expect(paired.windowsUser).toBe(USER);
    expect(paired.device.helperHostname).toBe(HOST);

    const consent = await call(OWNER, 'POST', base(request.id, '/consent'), CONSENT);
    expect(consent.statusCode, consent.body).toBe(200);
    const active = consent.json().request;
    expect(active.status).toBe('active');
    expect(active.scope.root).toBe('Documents');
    expect(active.scope.segments).toEqual([CANARY_SEGMENT]);
    // 同意の直前に貸与情報を取り直す（作成時 + 同意時）。
    expect(world.leaseCalls).toBe(2);

    const listed = await call(ASSIGNEE, 'POST', base(request.id, '/list'), {});
    expect(listed.statusCode, listed.body).toBe(200);
    const again = await call(ASSIGNEE, 'POST', base(request.id, '/list'), {});
    expect(again.json().opId).toBe(listed.json().opId);
    expect(again.json().created).toBe(false);

    const polled = await poll(helper.helperToken);
    expect(polled.statusCode, polled.body).toBe(200);
    const body = polled.json();
    expect(body.revoked).toBe(false);
    expect(body.cancel).toEqual([]);
    expect(body.ops).toHaveLength(1);
    const op = body.ops[0];
    expect(op).toMatchObject({
      opId: listed.json().opId,
      requestId: request.id,
      sid: SID,
      sessionId: SESSION,
      root: 'Documents',
      segments: [CANARY_SEGMENT],
      operation: 'list_metadata',
      maxEntries: 500,
      maxBytes: 32768,
      maxSeconds: 15,
    });
    // 署名はヘルパー側で再計算できる（トークンと正規形だけで検証できる）。
    expect(op.sig).toBe(signOp(helper.helperToken, op));
    expect(canonicalOpJson(op).startsWith(`{"opId":"${op.opId}","requestId":`)).toBe(true);
    // 同じ操作を二重に配らない。
    expect((await poll(helper.helperToken)).json().ops).toEqual([]);

    expect((await call(ASSIGNEE, 'GET', base(request.id, '/result'))).json().result).toBeNull();
    const saved = await postResult(helper.helperToken, op.opId, resultBody());
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ discarded: false, truncated: false, count: 1 });

    const result = await call(ASSIGNEE, 'GET', base(request.id, '/result'));
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().result.status).toBe('ok');
    expect(result.json().result.entries[0].name).toBe(CANARY_NAME);

    const status = await call(ASSIGNEE, 'GET', base(request.id));
    expect(status.json().request.scope.segments).toEqual([CANARY_SEGMENT]);
    const mine = await call(OWNER, 'GET', `/api/folder-access/mine?handoverId=${handoverId}`);
    expect(mine.json().request.status).toBe('active');
    // 相談者向けの応答に RSP の内部 ID を出さない。
    expect(mine.json().request.device.rspDeviceId).toBeUndefined();

    const ended = await call(ASSIGNEE, 'POST', base(request.id, '/end'), {});
    expect(ended.statusCode, ended.body).toBe(200);
    expect(await requestRow(request.id)).toMatchObject({
      status: 'ended',
      end_reason: 'operator_end',
    });
    expect(await resultCount(request.id)).toBe(0);
    const scrub = await sql<{ consent_segments: unknown; windows_user: string | null }[]>`
      SELECT consent_segments, windows_user FROM folder_access_requests WHERE id = ${request.id}
    `;
    expect(scrub[0]?.consent_segments).toEqual([]);
    expect(scrub[0]?.windows_user).toBeNull();
    const opRows = await sql<{ segments: unknown }[]>`
      SELECT segments FROM folder_access_ops WHERE request_id = ${request.id}
    `;
    expect(opRows[0]?.segments).toEqual([]);

    const actions = (await auditRows(request.id)).map((row) => row.action);
    expect(actions).toEqual([
      'folder_access.request',
      'folder_access.pair',
      'folder_access.consent',
      'folder_access.list_requested',
      'folder_access.list_result',
      'folder_access.end',
    ]);
  });

  it('RSP 応答に mesh_node_id が無ければ null で進む', async () => {
    world.matches = [
      { device_id: RSP_DEVICE, hostname: HOST, agent_installed: true, agent_online: true },
    ];
    const request = await createRequest(await makeHandover());
    expect(request.status).toBe('helper_pending');
    expect(request.device.meshNodeId).toBeNull();
  });
});

describe('権限（Mock: 名簿）', () => {
  it('他人の案件: 別の相談者は参照・ペアリング・同意・取消ができない', async () => {
    const handoverId = await makeHandover();
    const request = await createRequest(handoverId);
    const helper = await registerHelper();
    const mine = await call(OTHER_OWNER, 'GET', `/api/folder-access/mine?handoverId=${handoverId}`);
    expect(mine.statusCode).toBe(403);
    const pair = await call(OTHER_OWNER, 'POST', base(request.id, '/pair'), {
      code: helper.pairingCode,
    });
    expect(pair.statusCode).toBe(403);
    const consent = await call(OTHER_OWNER, 'POST', base(request.id, '/consent'), CONSENT);
    expect(consent.statusCode).toBe(403);
    const revoke = await call(OTHER_OWNER, 'POST', base(request.id, '/revoke'), {});
    expect(revoke.statusCode).toBe(403);
    expect((await requestRow(request.id))?.status).toBe('helper_pending');
    // 別の相談者の試行でコードは消費されない。
    const ok = await call(OWNER, 'POST', base(request.id, '/pair'), { code: helper.pairingCode });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('担当者の操作を相談者はできない（結果も見られない）', async () => {
    const { id } = await activeRequest();
    for (const [method, url] of [
      ['POST', base(id, '/list')],
      ['GET', base(id, '/result')],
      ['GET', base(id)],
      ['POST', base(id, '/end')],
    ] as const) {
      const response = await call(OWNER, method, url, method === 'POST' ? {} : undefined);
      expect(response.statusCode, url).toBe(403);
    }
  });

  it('非担当者: claim していない DX 推進部の担当者は開始も操作もできない', async () => {
    const handoverId = await makeHandover();
    const created = await call(OTHER_ASSIGNEE, 'POST', '/api/folder-access/requests', {
      handoverId,
    });
    expect(created.statusCode).toBe(403);
    expect(created.json().error.code).toBe('NOT_ASSIGNEE');
    const unclaimed = await call(ASSIGNEE, 'POST', '/api/folder-access/requests', {
      handoverId: await makeHandover(null),
    });
    expect(unclaimed.statusCode).toBe(403);

    const { id } = await activeRequest();
    for (const [method, url] of [
      ['POST', base(id, '/list')],
      ['GET', base(id, '/result')],
      ['GET', base(id)],
      ['POST', base(id, '/end')],
    ] as const) {
      const response = await call(OTHER_ASSIGNEE, method, url, method === 'POST' ? {} : undefined);
      expect(response.statusCode, url).toBe(403);
    }
    expect((await requestRow(id))?.status).toBe('active');
  });

  it('approver ロールのみは 403（承認者と担当者を混同しない）', async () => {
    const { id, handoverId } = await activeRequest();
    const created = await call(APPROVER_ONLY, 'POST', '/api/folder-access/requests', {
      handoverId,
    });
    expect(created.statusCode).toBe(403);
    for (const [method, url] of [
      ['GET', `/api/folder-access/requests?handoverId=${handoverId}`],
      ['GET', base(id)],
      ['POST', base(id, '/list')],
      ['GET', base(id, '/result')],
      ['POST', base(id, '/end')],
    ] as const) {
      const response = await call(APPROVER_ONLY, method, url, method === 'POST' ? {} : undefined);
      expect(response.statusCode, url).toBe(403);
    }
  });

  it('claim 者が approver で案件を引き受けていても、DX 推進部でなければ操作できない', async () => {
    const handoverId = await makeHandover(APPROVER_ONLY);
    const created = await call(APPROVER_ONLY, 'POST', '/api/folder-access/requests', {
      handoverId,
    });
    expect(created.statusCode).toBe(403);
  });

  it('担当変更: claim 者が変わると終了し、キュー中の操作を取り消す', async () => {
    const { id, handoverId, helper } = await activeRequest();
    const listed = await call(ASSIGNEE, 'POST', base(id, '/list'), {});
    await sql`UPDATE case_handovers SET claimed_by = ${OTHER_ASSIGNEE} WHERE id = ${handoverId}`;
    const polled = await poll(helper.helperToken);
    expect(polled.json().revoked).toBe(true);
    expect(polled.json().ops).toEqual([]);
    expect(polled.json().cancel).toEqual([listed.json().opId]);
    expect(await requestRow(id)).toMatchObject({ status: 'ended', end_reason: 'assignee_changed' });
  });

  it('案件が取消・完了になると終了する', async () => {
    const { id, handoverId } = await activeRequest();
    await sql`UPDATE case_handovers SET status = 'cancelled' WHERE id = ${handoverId}`;
    const listed = await call(ASSIGNEE, 'POST', base(id, '/list'), {});
    expect(listed.statusCode).toBe(409);
    expect(listed.json().error.code).toBe('CONSENT_NOT_ACTIVE');
    expect((await requestRow(id))?.end_reason).toBe('assignee_changed');
  });
});

describe('貸与情報と端末の照合（Mock: PII API / RSP）', () => {
  it('トークン未設定は LEASE_UNAVAILABLE で留まり、外部へ出ない', async () => {
    config.LEASE_API_TOKEN_SECRET = undefined;
    const request = await createRequest(await makeHandover());
    expect(request.status).toBe('device_pending');
    expect(request.reasonCode).toBe('LEASE_UNAVAILABLE');
    expect(world.leaseCalls).toBe(0);
    expect(world.commands).toEqual([]);
  });

  it.each([
    ['0 件', () => leaseBody([]), 'LEASE_NONE'],
    [
      '複数',
      () => leaseBody([LEASE_ROW, { ...LEASE_ROW, hostname: 'SYNTH-PC-002' }]),
      'LEASE_MULTIPLE',
    ],
    [
      '絞り込み未対応（別の社員の行を含む）',
      () => leaseBody([LEASE_ROW, { ...LEASE_ROW, employee_no: 'E999' }]),
      'LEASE_UNAVAILABLE',
    ],
    [
      'filter を返さない旧プロセス',
      () => ({ ...leaseBody([LEASE_ROW]), filter: undefined }),
      'LEASE_UNAVAILABLE',
    ],
    ['退職者', () => leaseBody([{ ...LEASE_ROW, employee_active: false }]), 'LEASE_NONE'],
    ['貸与が有効でない', () => leaseBody([{ ...LEASE_ROW, lease_active: false }]), 'LEASE_NONE'],
    [
      'employee_active が不明',
      () => leaseBody([{ ...LEASE_ROW, employee_active: null }]),
      'LEASE_NONE',
    ],
    ['名簿の取得時刻なし', () => leaseBody([LEASE_ROW], null), 'LEASE_STALE'],
    [
      '古い',
      () => leaseBody([LEASE_ROW], new Date(Date.now() - 73 * 3_600_000).toISOString()),
      'LEASE_STALE',
    ],
    ['Access のログイン画面相当（形式不正）', () => ({ html: true }), 'LEASE_UNAVAILABLE'],
    ['ok=false', () => ({ ok: false, error: 'x' }), 'LEASE_UNAVAILABLE'],
  ])('%s は確定せず device_pending に留まる', async (_name, body, code) => {
    world.lease = body();
    const request = await createRequest(await makeHandover());
    expect(request.status).toBe('device_pending');
    expect(request.reasonCode).toBe(code);
    expect(world.commands).toEqual([]);
  });

  it('HTTP エラーと JSON でない応答は LEASE_UNAVAILABLE', async () => {
    world.leaseStatus = 403;
    expect((await createRequest(await makeHandover())).reasonCode).toBe('LEASE_UNAVAILABLE');
    world.leaseStatus = 200;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('html');
        },
      })),
    );
    expect((await createRequest(await makeHandover())).reasonCode).toBe('LEASE_UNAVAILABLE');
  });

  it('名簿で相談者を解決できなければ確定しない', async () => {
    const handoverId = await makeHandover(ASSIGNEE, 'fa-unknown@example.com');
    const request = await createRequest(handoverId);
    expect(request.reasonCode).toBe('EMPLOYEE_UNRESOLVED');
  });

  it.each([
    ['0 件', [], 'RSP_DEVICE_NONE'],
    [
      '複数',
      [
        { device_id: RSP_DEVICE, hostname: HOST, agent_installed: true },
        {
          device_id: '44444444-4444-4444-8444-444444444444',
          hostname: HOST,
          agent_installed: true,
        },
      ],
      'RSP_DEVICE_MULTIPLE',
    ],
    [
      '未導入',
      [{ device_id: RSP_DEVICE, hostname: HOST, agent_installed: false }],
      'RSP_AGENT_NOT_INSTALLED',
    ],
  ])('RSP 候補が %s は確定しない', async (_name, matches, code) => {
    world.matches = matches;
    const request = await createRequest(await makeHandover());
    expect(request.status).toBe('device_pending');
    expect(request.reasonCode).toBe(code);
  });

  it('担当者の指定端末が貸与情報の端末と違えば進めない', async () => {
    const request = await createRequest(await makeHandover(), {
      rspDeviceId: '55555555-5555-4555-8555-555555555555',
    });
    expect(request.status).toBe('device_pending');
    expect(request.reasonCode).toBe('LEASE_CONFLICT');
    expect(world.commands).toEqual([]);
  });

  it('キューへ積まれた端末が検索結果と違えば device_mismatch で拒否', async () => {
    world.enqueueDevice = '66666666-6666-4666-8666-666666666666';
    const request = await createRequest(await makeHandover());
    expect(request.status).toBe('denied');
    expect(request.endReason).toBe('device_mismatch');
  });

  it('留まった依頼は再送で照合をやり直せる', async () => {
    world.lease = leaseBody([]);
    const handoverId = await makeHandover();
    const first = await createRequest(handoverId);
    expect(first.status).toBe('device_pending');
    world.lease = leaseBody([LEASE_ROW]);
    const second = await createRequest(handoverId);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('helper_pending');
  });

  it('検証用フラグが無ければ担当者の指定だけでは進まない', async () => {
    config.LEASE_API_TOKEN_ID = undefined;
    const request = await createRequest(await makeHandover(), {
      rspDeviceId: RSP_DEVICE,
      hostname: HOST,
    });
    expect(request.status).toBe('device_pending');
    expect(request.reasonCode).toBe('LEASE_UNAVAILABLE');
  });

  it('検証用フラグがあれば unverified として担当者の指定端末で進む', async () => {
    config.LEASE_API_TOKEN_ID = undefined;
    config.FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE = true;
    const request = await createRequest(await makeHandover(), {
      rspDeviceId: RSP_DEVICE,
      hostname: HOST,
    });
    expect(request.status).toBe('helper_pending');
    expect(request.leaseStatus).toBe('unverified');
    expect(world.leaseCalls).toBe(0);
    const helper = await registerHelper();
    const pair = await call(OWNER, 'POST', base(request.id, '/pair'), {
      code: helper.pairingCode,
    });
    // MachineGuid の照合は省かない。
    expect(pair.json().request.status).toBe('consent_pending');
    expect(world.probeReads).toBe(1);
  });

  it('同意の直前に貸与先が変わっていれば lease_conflict で拒否', async () => {
    const { id } = await pairedRequest();
    world.lease = leaseBody([{ ...LEASE_ROW, hostname: 'SYNTH-PC-NEW' }]);
    const consent = await call(OWNER, 'POST', base(id, '/consent'), CONSENT);
    expect(consent.statusCode).toBe(409);
    expect(await requestRow(id)).toMatchObject({ status: 'denied', end_reason: 'lease_conflict' });
  });

  it('同意の直前に貸与情報を取得できなければ同意を進めない', async () => {
    const { id } = await pairedRequest();
    world.leaseStatus = 500;
    const consent = await call(OWNER, 'POST', base(id, '/consent'), CONSENT);
    expect(consent.statusCode).toBe(409);
    expect(consent.json().error.code).toBe('LEASE_UNAVAILABLE');
    expect((await requestRow(id))?.status).toBe('consent_pending');
  });
});

describe('ペアリングと Windows ユーザー（Mock: RSP）', () => {
  it('別端末: MachineGuid が RSP と違えば device_mismatch', async () => {
    const { id, pair, helper } = await pairedRequest({ machineGuid: OTHER_MACHINE });
    expect(pair.status).toBe('denied');
    expect(pair.endReason).toBe('device_mismatch');
    expect((await requestRow(id))?.end_reason).toBe('device_mismatch');
    expect((await poll(helper.helperToken)).json().revoked).toBe(true);
    const actions = (await auditRows(id)).map((row) => row.action);
    expect(actions).toContain('folder_access.deny');
  });

  it('RSP の結果待ち: 完了前は進まず、ヘルパーの poll の延長で非同期に照合する', async () => {
    world.probe = { status: 'running', output: null, error_code: null };
    const { id, pair, helper } = await pairedRequest();
    expect(pair.status).toBe('helper_pending');
    expect(pair.paired).toBe(true);
    const early = await call(OWNER, 'POST', base(id, '/consent'), CONSENT);
    expect(early.statusCode).toBe(409);

    world.probe = { status: 'completed', output: probeOutput(), error_code: null };
    await sql`UPDATE folder_access_requests SET rsp_probe_checked_at = NULL WHERE id = ${id}`;
    expect((await poll(helper.helperToken)).statusCode).toBe(200);
    expect((await requestRow(id))?.status).toBe('consent_pending');
  });

  it('RSP の問い合わせ間隔を守る（状態確認のたびに叩かない）', async () => {
    world.probe = { status: 'running', output: null, error_code: null };
    const { handoverId } = await pairedRequest();
    const reads = world.probeReads;
    await call(OWNER, 'GET', `/api/folder-access/mine?handoverId=${handoverId}`);
    await call(OWNER, 'GET', `/api/folder-access/mine?handoverId=${handoverId}`);
    expect(world.probeReads).toBe(reads);
  });

  it('AGENT_BUSY は再投入し、AGENT_NO_REPLY は自動再試行しない', async () => {
    world.probe = { status: 'failed', output: '[AGENT_BUSY]', error_code: 'AGENT_BUSY' };
    const { id, pair } = await pairedRequest();
    expect(pair.status).toBe('helper_pending');
    expect(world.commands).toHaveLength(2);
    expect(world.commands[1]?.command_text).toBe(DEVICE_IDENTITY_PROBE_COMMAND);

    world.probe = { status: 'failed', output: '[AGENT_NO_REPLY]', error_code: 'AGENT_NO_REPLY' };
    await sql`UPDATE folder_access_requests SET rsp_probe_checked_at = NULL WHERE id = ${id}`;
    await call(ASSIGNEE, 'GET', base(id));
    expect(world.commands).toHaveLength(2);
    expect((await requestRow(id))?.reason_code).toBe('RSP_AGENT_NO_REPLY');
    // 担当者の再確認で新しく投入できる。
    const handover = await sql<{ handover_id: string }[]>`
      SELECT handover_id FROM folder_access_requests WHERE id = ${id}
    `;
    world.probe = { status: 'completed', output: probeOutput(), error_code: null };
    const retry = await createRequest(handover[0]?.handover_id ?? '');
    expect(retry.id).toBe(id);
    expect(world.commands).toHaveLength(3);
  });

  it('ヘルパーの登録より前の結果では判断せず、固定テンプレートを取り直す', async () => {
    world.probe = {
      status: 'completed',
      output: probeOutput(),
      error_code: null,
      completed_at: '2020-01-01T00:00:00+00:00',
    };
    const { id, pair, helper } = await pairedRequest();
    expect(pair.status).toBe('helper_pending');
    expect(world.commands).toHaveLength(2);
    expect(world.commands[1]?.command_text).toBe(DEVICE_IDENTITY_PROBE_COMMAND);

    world.probe = {
      status: 'completed',
      output: probeOutput(),
      error_code: null,
      completed_at: new Date(Date.now() + 60_000).toISOString(),
    };
    await sql`UPDATE folder_access_requests SET rsp_probe_checked_at = NULL WHERE id = ${id}`;
    await poll(helper.helperToken);
    expect((await requestRow(id))?.status).toBe('consent_pending');
    expect(world.commands).toHaveLength(2);
  });

  it('RSP の出力が解釈できなければ進めない', async () => {
    world.probe = { status: 'completed', output: 'garbage', error_code: null };
    const { pair } = await pairedRequest();
    expect(pair.status).toBe('helper_pending');
    expect(pair.reasonCode).toBe('RSP_PROBE_INVALID');
  });

  it('ペアリングコードの再利用はできない', async () => {
    const first = await pairedRequest();
    const other = await createRequest(await makeHandover());
    const reuse = await call(OWNER, 'POST', base(other.id, '/pair'), {
      code: first.helper.pairingCode,
    });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().error.code).toBe('PAIRING_INVALID');
    // 同じ依頼への再入力も通らない。
    const again = await call(OWNER, 'POST', base(first.id, '/pair'), {
      code: first.helper.pairingCode,
    });
    expect(again.statusCode).toBe(409);
  });

  it('ペアリングコードの総当たりは 5 回で止まり、正しいコードでも通らない', async () => {
    const request = await createRequest(await makeHandover());
    const helper = await registerHelper();
    const wrong = helper.pairingCode === '00000000' ? '00000001' : '00000000';
    for (let index = 0; index < 5; index += 1) {
      const response = await call(OWNER, 'POST', base(request.id, '/pair'), { code: wrong });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.details.remaining).toBe(4 - index);
    }
    const locked = await call(OWNER, 'POST', base(request.id, '/pair'), {
      code: helper.pairingCode,
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('PAIRING_LOCKED');
    expect((await requestRow(request.id))?.status).toBe('helper_pending');
  });

  it('総当たりはレート制限でも止まる（依頼をまたいで数える）', async () => {
    const codes: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const request = await createRequest(await makeHandover());
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await call(OWNER, 'POST', base(request.id, '/pair'), {
          code: '12345678',
        });
        codes.push(response.json().error.code);
      }
    }
    expect(codes.slice(0, 5)).toEqual(Array(5).fill('PAIRING_INVALID'));
    expect(codes.slice(10)).toEqual(Array(5).fill('RATE_LIMITED'));
  });

  it('期限切れのペアリングコードは使えない', async () => {
    const request = await createRequest(await makeHandover());
    const helper = await registerHelper();
    await sql`
      UPDATE folder_access_helpers SET pairing_expires_at = now() - interval '1 second'
      WHERE id = ${helper.helperId}
    `;
    const response = await call(OWNER, 'POST', base(request.id, '/pair'), {
      code: helper.pairingCode,
    });
    expect(response.statusCode).toBe(400);
    expect((await poll(helper.helperToken)).json().revoked).toBe(true);
  });

  it('コード形式の不正は 400 で試行回数を消費しない', async () => {
    const request = await createRequest(await makeHandover());
    const response = await call(OWNER, 'POST', base(request.id, '/pair'), { code: 'abc' });
    expect(response.statusCode).toBe(400);
    const rows = await sql<{ pair_attempts: number }[]>`
      SELECT pair_attempts FROM folder_access_requests WHERE id = ${request.id}
    `;
    expect(rows[0]?.pair_attempts).toBe(0);
  });

  it.each(['S-1-5-18', 'S-1-5-19', 'S-1-5-20', 'S-1-5-32-544'])(
    'サービスアカウント等の SID は登録できない: %s',
    async (sid) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/device/agent/folder-helper/register',
        payload: registerPayload({ sid }),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('SID_NOT_ALLOWED');
    },
  );

  it.each([
    ['未ログオンの状態', { sessionState: 'none' }],
    ['切断中', { sessionState: 'disconnected' }],
    ['セッション 0', { sessionId: 0 }],
  ])('未ログオン: %s は登録できない', async (_name, overrides) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/device/agent/folder-helper/register',
      payload: registerPayload(overrides),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('NOT_LOGGED_ON');
  });

  it('未ログオン: RSP 側でログオン中のユーザーが無ければ同意へ進まない', async () => {
    world.probe = { status: 'completed', output: probeOutput({ quser: [] }), error_code: null };
    const { id, pair } = await pairedRequest();
    expect(pair.status).toBe('helper_pending');
    expect(pair.reasonCode).toBe('NOT_LOGGED_ON');
    const consent = await call(OWNER, 'POST', base(id, '/consent'), CONSENT);
    expect(consent.statusCode).toBe(409);
  });

  it('複数セッション未確定: 同じユーザーのセッションが複数あれば同意へ進まない', async () => {
    world.probe = {
      status: 'completed',
      output: probeOutput({
        quser: [
          `>synth-user console ${SESSION} Active none x`,
          ' synth-user rdp-tcp#1 3 Active none x',
        ],
      }),
      error_code: null,
    };
    const { id, pair } = await pairedRequest();
    expect(pair.status).toBe('helper_pending');
    expect(pair.reasonCode).toBe('SESSION_UNRESOLVED');
    const consent = await call(OWNER, 'POST', base(id, '/consent'), CONSENT);
    expect(consent.statusCode).toBe(409);
    expect(consent.json().error.details.reasonCode).toBe('SESSION_UNRESOLVED');
  });

  it('SID を S-1-5-18 に変えた heartbeat の未ペアヘルパーは失効する', async () => {
    const helper = await registerHelper();
    const polled = await poll(helper.helperToken, { ...beat, sid: 'S-1-5-18' });
    expect(polled.json().revoked).toBe(true);
    expect((await poll(helper.helperToken)).json().revoked).toBe(true);
  });
});

describe('同意と毎操作の検証（Mock: RSP）', () => {
  it('同意なし: 同意前は一覧の投入も結果も拒否し、操作は配らない', async () => {
    const { id, helper } = await pairedRequest();
    const listed = await call(ASSIGNEE, 'POST', base(id, '/list'), {});
    expect(listed.statusCode).toBe(409);
    expect(listed.json().error.code).toBe('CONSENT_NOT_ACTIVE');
    expect((await call(ASSIGNEE, 'GET', base(id, '/result'))).statusCode).toBe(409);
    expect((await poll(helper.helperToken)).json().ops).toEqual([]);
  });

  it.each([
    ['ttlMinutes 超過', { ...CONSENT, ttlMinutes: 61 }],
    ['root が enum 外', { ...CONSENT, root: 'C:\\Users' }],
    ['親ディレクトリ', { ...CONSENT, segments: ['..'] }],
    ['区切り文字', { ...CONSENT, segments: ['a\\b'] }],
    ['予約デバイス名', { ...CONSENT, segments: ['CON'] }],
  ])('同意の入力検証: %s は 400', async (_name, payload) => {
    const { id } = await pairedRequest();
    const response = await call(OWNER, 'POST', base(id, '/consent'), payload);
    expect(response.statusCode).toBe(400);
    expect((await requestRow(id))?.status).toBe('consent_pending');
  });

  it('期限切れ: 同意の期限を過ぎると終了し、結果を消す', async () => {
    const { id, helper, op } = await deliveredOp();
    await postResult(helper.helperToken, op.opId, resultBody());
    expect(await resultCount(id)).toBe(1);
    await sql`
      UPDATE folder_access_requests SET consent_expires_at = now() - interval '1 second'
      WHERE id = ${id}
    `;
    const listed = await call(ASSIGNEE, 'POST', base(id, '/list'), {});
    expect(listed.statusCode).toBe(409);
    expect(await requestRow(id)).toMatchObject({ status: 'expired', end_reason: 'expired' });
    expect(await resultCount(id)).toBe(0);
    expect((await call(ASSIGNEE, 'GET', base(id, '/result'))).statusCode).toBe(409);
  });

  it('期限切れ: 掃除処理は誰も画面を開かなくても結果を消す', async () => {
    const { id, helper, op } = await deliveredOp();
    await postResult(helper.helperToken, op.opId, resultBody());
    await sql`
      UPDATE folder_access_requests SET consent_expires_at = now() - interval '1 second'
      WHERE id = ${id}
    `;
    expect(await sweepFolderAccess()).toBeGreaterThan(0);
    expect((await requestRow(id))?.status).toBe('expired');
    expect(await resultCount(id)).toBe(0);
    const actions = (await auditRows(id)).map((row) => row.action);
    expect(actions).toContain('folder_access.expire');
  });

  it('期限切れ: 同意前の依頼も期限で終わり、未ペアの登録情報は掃除で消える', async () => {
    const request = await createRequest(await makeHandover());
    const helper = await registerHelper();
    await sql`
      UPDATE folder_access_requests SET request_expires_at = now() - interval '1 second'
      WHERE id = ${request.id}
    `;
    await sql`
      UPDATE folder_access_helpers SET pairing_expires_at = now() - interval '1 second'
      WHERE id = ${helper.helperId}
    `;
    await sweepFolderAccess();
    expect((await requestRow(request.id))?.status).toBe('expired');
    const scrubbed = await sql<{ user_name: string | null; hostname: string | null }[]>`
      SELECT user_name, hostname FROM folder_access_helpers WHERE id = ${helper.helperId}
    `;
    expect(scrubbed[0]).toEqual({ user_name: null, hostname: null });
    // 掃除の後も revoked:true を返す（401 にしない。ヘルパーが自動で再登録しないように）。
    const polled = await poll(helper.helperToken);
    expect(polled.statusCode).toBe(200);
    expect(polled.json().revoked).toBe(true);

    await sql`
      UPDATE folder_access_helpers SET pairing_expires_at = now() - interval '2 days'
      WHERE id = ${helper.helperId}
    `;
    await sweepFolderAccess();
    const rows = await sql`SELECT id FROM folder_access_helpers WHERE id = ${helper.helperId}`;
    expect(rows).toHaveLength(0);
    expect((await poll(helper.helperToken)).statusCode).toBe(401);
  });

  it('取消後: 本人の取消で即時に終了し、結果を消してキューを取り消す', async () => {
    const { id, helper, op } = await deliveredOp();
    await postResult(helper.helperToken, op.opId, resultBody());
    const queued = await call(ASSIGNEE, 'POST', base(id, '/list'), {});
    const revoke = await call(OWNER, 'POST', base(id, '/revoke'), {});
    expect(revoke.statusCode, revoke.body).toBe(200);
    expect(await requestRow(id)).toMatchObject({
      status: 'revoked',
      end_reason: 'requester_revoked',
    });
    expect(await resultCount(id)).toBe(0);
    expect((await call(ASSIGNEE, 'POST', base(id, '/list'), {})).statusCode).toBe(409);
    expect((await call(ASSIGNEE, 'GET', base(id, '/result'))).statusCode).toBe(409);
    const polled = (await poll(helper.helperToken)).json();
    expect(polled.revoked).toBe(true);
    expect(polled.ops).toEqual([]);
    expect(polled.cancel).toContain(queued.json().opId);
    expect(polled.cancel).toEqual([queued.json().opId]);
    expect((await auditRows(id)).map((row) => row.action)).toContain('folder_access.revoke');
  });

  it('取消は同意前でも使え（拒否）、再送しても監査を増やさない', async () => {
    const { id } = await pairedRequest();
    expect((await call(OWNER, 'POST', base(id, '/revoke'), {})).statusCode).toBe(200);
    expect((await call(OWNER, 'POST', base(id, '/revoke'), {})).statusCode).toBe(200);
    const actions = (await auditRows(id)).map((row) => row.action);
    expect(actions.filter((action) => action === 'folder_access.revoke')).toHaveLength(1);
    expect((await call(OWNER, 'POST', base(id, '/consent'), CONSENT)).statusCode).toBe(409);
  });

  it('トークン再利用: 終了後のトークンでは操作を受け取れず、結果も保存されない', async () => {
    const { id, helper, op } = await deliveredOp();
    await call(ASSIGNEE, 'POST', base(id, '/end'), {});
    const polled = (await poll(helper.helperToken)).json();
    expect(polled.revoked).toBe(true);
    expect(polled.ops).toEqual([]);
    // 新しい同意でも古いトークンには配らない（別のヘルパー登録が必要）。
    const next = await activeRequest();
    await call(ASSIGNEE, 'POST', base(next.id, '/list'), {});
    expect((await poll(helper.helperToken)).json().ops).toEqual([]);
    const late = await postResult(helper.helperToken, op.opId, resultBody());
    expect(late.json().discarded).toBe(true);
    expect(await resultCount(id)).toBe(0);
  });

  it('トークン: 無効なトークンは 401、未ペアのトークンは poll 以外に使えない', async () => {
    const unknown = await poll('x'.repeat(43));
    expect(unknown.statusCode).toBe(401);
    expect((await poll('short')).statusCode).toBe(401);
    const { op } = await deliveredOp();
    const unpaired = await registerHelper();
    const posted = await postResult(unpaired.helperToken, op.opId, resultBody());
    expect(posted.statusCode).toBe(403);
    expect(posted.json().error.code).toBe('HELPER_NOT_PAIRED');
    expect((await poll(unpaired.helperToken)).statusCode).toBe(200);
  });

  it('他のヘルパーの操作へ結果を送れない', async () => {
    const first = await deliveredOp();
    const second = await activeRequest();
    const posted = await postResult(second.helper.helperToken, first.op.opId, resultBody());
    expect(posted.statusCode).toBe(404);
    expect(await resultCount(first.id)).toBe(0);
  });

  it('別 SID: 結果の actorSid が同意と違えば sid_mismatch で終了して保存しない', async () => {
    const { id, helper, op } = await deliveredOp();
    const posted = await postResult(helper.helperToken, op.opId, {
      ...resultBody(),
      actorSid: OTHER_SID,
    });
    expect(posted.json()).toMatchObject({ discarded: true, reason: 'SID_MISMATCH' });
    expect(await requestRow(id)).toMatchObject({ status: 'ended', end_reason: 'sid_mismatch' });
    expect(await resultCount(id)).toBe(0);
  });

  it('別セッションの結果は session_changed で終了して保存しない', async () => {
    const { id, helper, op } = await deliveredOp();
    await postResult(helper.helperToken, op.opId, { ...resultBody(), sessionId: SESSION + 1 });
    expect(await requestRow(id)).toMatchObject({ end_reason: 'session_changed' });
    expect(await resultCount(id)).toBe(0);
  });

  it.each([
    ['SID 不一致', { ...beat, sid: OTHER_SID }, 'sid_mismatch'],
    ['セッション番号の変更', { ...beat, sessionId: SESSION + 1 }, 'session_changed'],
    ['ログオフ', { ...beat, sessionState: 'loggedoff' }, 'user_logged_off'],
    ['想定外の状態', { ...beat, sessionState: 'unknown' }, 'user_logged_off'],
  ])('ユーザー切替: heartbeat の%sで終了し、キューを取り消す', async (_name, body, reason) => {
    const { id, helper } = await activeRequest();
    const listed = await call(ASSIGNEE, 'POST', base(id, '/list'), {});
    const polled = (await poll(helper.helperToken, body)).json();
    expect(polled.revoked).toBe(true);
    expect(polled.ops).toEqual([]);
    expect(polled.cancel).toEqual([listed.json().opId]);
    expect((await requestRow(id))?.end_reason).toBe(reason);
    expect((await call(ASSIGNEE, 'POST', base(id, '/list'), {})).statusCode).toBe(409);
  });

  it('disconnected は同意を保つが、操作を配らず投入も拒否する', async () => {
    const { id, helper } = await activeRequest();
    const disconnected = { ...beat, sessionState: 'Disconnected' };
    await call(ASSIGNEE, 'POST', base(id, '/list'), {});
    const polled = (await poll(helper.helperToken, disconnected)).json();
    expect(polled).toMatchObject({ ops: [], revoked: false });
    expect((await requestRow(id))?.status).toBe('active');
    await sql`UPDATE folder_access_ops SET status = 'cancelled' WHERE request_id = ${id}`;
    const listed = await call(ASSIGNEE, 'POST', base(id, '/list'), {});
    expect(listed.statusCode).toBe(409);
    expect(listed.json().error.code).toBe('SESSION_NOT_ACTIVE');
    // 戻れば再開できる。
    expect((await poll(helper.helperToken)).json().revoked).toBe(false);
    expect((await call(ASSIGNEE, 'POST', base(id, '/list'), {})).statusCode).toBe(200);
  });

  it('heartbeat が途絶えたらログオフ扱いで終了する', async () => {
    const { id, helper } = await activeRequest();
    await sql`
      UPDATE folder_access_helpers SET last_seen_at = now() - interval '10 minutes'
      WHERE id = ${helper.helperId}
    `;
    expect((await call(ASSIGNEE, 'POST', base(id, '/list'), {})).statusCode).toBe(409);
    expect((await requestRow(id))?.end_reason).toBe('user_logged_off');
  });

  it('ヘルパーが失効していれば helper_revoked で終了する', async () => {
    const { id, helper } = await activeRequest();
    await sql`UPDATE folder_access_helpers SET revoked_at = now() WHERE id = ${helper.helperId}`;
    expect((await call(ASSIGNEE, 'POST', base(id, '/list'), {})).statusCode).toBe(409);
    expect(await requestRow(id)).toMatchObject({ status: 'revoked', end_reason: 'helper_revoked' });
  });

  it('ヘルパーの失効通知で同意を終了し、トークンを無効にする', async () => {
    const { id, helper, op } = await deliveredOp();
    await postResult(helper.helperToken, op.opId, resultBody());
    const revoked = await helperCall(helper.helperToken, 'revoke', {});
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(await requestRow(id)).toMatchObject({ status: 'revoked', end_reason: 'helper_revoked' });
    expect(await resultCount(id)).toBe(0);
    expect((await poll(helper.helperToken)).json().revoked).toBe(true);
    // 再送しても失敗しない。無効なトークンは 401。
    expect((await helperCall(helper.helperToken, 'revoke', {})).statusCode).toBe(200);
    expect((await helperCall('y'.repeat(43), 'revoke', {})).statusCode).toBe(401);
  });

  it('未ペアのヘルパーも失効でき、そのコードは使えなくなる', async () => {
    const request = await createRequest(await makeHandover());
    const helper = await registerHelper();
    expect((await helperCall(helper.helperToken, 'revoke', {})).statusCode).toBe(200);
    const pair = await call(OWNER, 'POST', base(request.id, '/pair'), {
      code: helper.pairingCode,
    });
    expect(pair.statusCode).toBe(400);
  });

  it('poll の paired はペアリング後だけ true', async () => {
    const helper = await registerHelper();
    expect((await poll(helper.helperToken)).json().paired).toBe(false);
    const request = await createRequest(await makeHandover());
    await call(OWNER, 'POST', base(request.id, '/pair'), { code: helper.pairingCode });
    expect((await poll(helper.helperToken)).json().paired).toBe(true);
    await call(OWNER, 'POST', base(request.id, '/revoke'), {});
    const after = (await poll(helper.helperToken)).json();
    expect(after).toMatchObject({ paired: false, revoked: true });
  });

  it('遅延結果の破棄: 同意の終了後に届いた結果は保存せず監査に result_discarded', async () => {
    const { id, helper, op } = await deliveredOp();
    await call(ASSIGNEE, 'POST', base(id, '/end'), {});
    const late = await postResult(helper.helperToken, op.opId, resultBody());
    expect(late.statusCode).toBe(200);
    expect(late.json()).toMatchObject({ discarded: true, reason: 'CONSENT_NOT_ACTIVE' });
    expect(await resultCount(id)).toBe(0);
    const rows = await auditRows(id);
    const discarded = rows.find((row) => row.action === 'folder_access.result_discarded');
    expect(discarded).toBeDefined();
    expect(JSON.stringify(discarded?.detail)).not.toContain('CANARY');
  });

  it('遅延結果の破棄: 操作の期限切れと二重送信は保存しない', async () => {
    const { id, helper, op } = await deliveredOp();
    await sql`
      UPDATE folder_access_ops SET expires_at = now() - interval '1 second' WHERE id = ${op.opId}
    `;
    const late = await postResult(helper.helperToken, op.opId, resultBody());
    expect(late.json()).toMatchObject({ discarded: true, reason: 'OP_EXPIRED' });
    expect(await resultCount(id)).toBe(0);

    await call(ASSIGNEE, 'POST', base(id, '/list'), {});
    const second = (await poll(helper.helperToken)).json().ops[0];
    await postResult(helper.helperToken, second.opId, resultBody());
    const dup = await postResult(helper.helperToken, second.opId, resultBody([]));
    expect(dup.json()).toMatchObject({ discarded: true, reason: 'OP_NOT_DELIVERED' });
    const saved = await call(ASSIGNEE, 'GET', base(id, '/result'));
    expect(saved.json().result.count).toBe(1);
  });

  it('同意と違うルートの結果は保存しない', async () => {
    const { id, helper, op } = await deliveredOp();
    const posted = await postResult(helper.helperToken, op.opId, {
      ...resultBody(),
      root: 'Desktop',
    });
    expect(posted.json()).toMatchObject({ discarded: true, reason: 'ROOT_MISMATCH' });
    expect(await resultCount(id)).toBe(0);
  });
});

describe('結果の上限と無害化（Mock: RSP）', () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ name: `f${index}`, type: 'file' }));

  it('上限超過: 500 件を超える入力は切り詰めて truncated にする', async () => {
    const { id, helper, op } = await deliveredOp();
    const posted = await postResult(helper.helperToken, op.opId, resultBody(many(501)));
    expect(posted.statusCode, posted.body).toBe(200);
    expect(posted.json()).toMatchObject({ truncated: true, count: 500 });
    const saved = (await call(ASSIGNEE, 'GET', base(id, '/result'))).json().result;
    expect(saved.status).toBe('partial');
    expect(saved.truncated).toBe(true);
    expect(saved.entries).toHaveLength(500);
  });

  it('上限超過: 32KB を超える内容は切り詰める', async () => {
    const { id, helper, op } = await deliveredOp();
    const entries = Array.from({ length: 200 }, (_, index) => ({
      name: `${index}-${'x'.repeat(200)}`,
      type: 'file',
    }));
    const posted = await postResult(helper.helperToken, op.opId, resultBody(entries));
    expect(posted.json().truncated).toBe(true);
    const saved = (await call(ASSIGNEE, 'GET', base(id, '/result'))).json().result;
    expect(Buffer.byteLength(JSON.stringify(saved.entries))).toBeLessThanOrEqual(32 * 1024);
  });

  it('上限超過: 64KB を超える本文は 413 で拒否する', async () => {
    const { id, helper, op } = await deliveredOp();
    const entries = Array.from({ length: 400 }, (_, index) => ({
      name: `${index}-${'x'.repeat(200)}`,
      type: 'file',
    }));
    const posted = await postResult(helper.helperToken, op.opId, resultBody(entries));
    expect(posted.statusCode).toBe(413);
    expect(await resultCount(id)).toBe(0);
  });

  it('部分結果: ヘルパーの truncated / partial をそのまま伝える', async () => {
    const { id, helper, op } = await deliveredOp();
    const posted = await postResult(helper.helperToken, op.opId, {
      ...resultBody(),
      status: 'partial',
      truncated: true,
    });
    expect(posted.json().truncated).toBe(true);
    const saved = (await call(ASSIGNEE, 'GET', base(id, '/result'))).json().result;
    expect(saved).toMatchObject({ status: 'partial', truncated: true, count: 1 });
  });

  it('ACL 拒否は理由コードだけを保存し、一覧は保存しない', async () => {
    const { id, helper, op } = await deliveredOp();
    await postResult(helper.helperToken, op.opId, {
      ...resultBody(),
      status: 'error',
      reason: 'ACCESS_DENIED',
    });
    const saved = (await call(ASSIGNEE, 'GET', base(id, '/result'))).json().result;
    expect(saved).toMatchObject({ status: 'error', reason: 'ACCESS_DENIED', count: 0 });
    expect(saved.entries).toEqual([]);
  });

  it('理由にパスを入れられない（固定コードのみ）', async () => {
    const { helper, op } = await deliveredOp();
    const posted = await postResult(helper.helperToken, op.opId, {
      ...resultBody(),
      status: 'error',
      reason: 'C:\\Users\\someone',
    });
    expect(posted.statusCode).toBe(400);
  });

  it('name の制御文字を除去し、未知の項目（内容など）を保存しない', async () => {
    const { id, helper, op } = await deliveredOp();
    await postResult(
      helper.helperToken,
      op.opId,
      resultBody([
        {
          name: 'a\u0000b\u001b[31m\u202Ec<img src=x onerror=alert(1)>',
          type: 'file',
          size: 1,
          modifiedAt: '2026-10-31T00:00:00Z',
          attrs: { reparse: false, cloudOnly: true, hidden: false, secret: 'x' },
          content: 'SHOULD-NOT-BE-STORED',
        },
      ]),
    );
    const rows = await sql<{ entries: unknown }[]>`
      SELECT entries FROM folder_access_results WHERE request_id = ${id}
    `;
    const text = JSON.stringify(rows[0]?.entries);
    expect(text).not.toContain('SHOULD-NOT-BE-STORED');
    expect(text).not.toContain('secret');
    const stored = (rows[0]?.entries ?? []) as { name: string; attrs: unknown }[];
    const entry = stored[0];
    expect(entry?.name).toBe('ab[31mc<img src=x onerror=alert(1)>');
    expect(entry?.attrs).toEqual({ reparse: false, cloudOnly: true, hidden: false });
  });
});

describe('機微情報の分離（Mock: RSP）', () => {
  it('監査に機微なし: パス・ファイル名・トークン・コード・SID・ユーザー名を入れない', async () => {
    const paired = await pairedRequest();
    await call(OWNER, 'POST', base(paired.id, '/consent'), CONSENT);
    await call(ASSIGNEE, 'POST', base(paired.id, '/list'), {});
    const op = (await poll(paired.helper.helperToken)).json().ops[0];
    await postResult(paired.helper.helperToken, op.opId, resultBody());
    await call(ASSIGNEE, 'POST', base(paired.id, '/end'), {});
    await postResult(paired.helper.helperToken, op.opId, resultBody());

    const rows = await auditRows(paired.id);
    expect(rows.length).toBeGreaterThanOrEqual(6);
    const text = JSON.stringify(rows.map((row) => row.detail));
    for (const secret of [
      CANARY_NAME,
      CANARY_SEGMENT,
      'Documents',
      paired.helper.helperToken,
      paired.helper.pairingCode,
      SID,
      'synth-user',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).toContain('sidHash');
  });

  it('AI コンテキスト・snapshot・boot・prototype_states に結果が入らない', async () => {
    const { id, handoverId, helper, op } = await deliveredOp();
    await postResult(helper.helperToken, op.opId, resultBody());

    const handover = await sql<{ snapshot: CaseSnapshot; case_id: string }[]>`
      SELECT snapshot, case_id FROM case_handovers WHERE id = ${handoverId}
    `;
    const snapshot = handover[0]?.snapshot as CaseSnapshot;
    expect(JSON.stringify(snapshot)).not.toContain('CANARY');
    expect(buildPcContext(snapshot)).not.toContain('CANARY');
    expect(buildCaseContext(snapshot)).not.toContain('CANARY');

    const answer = await call(ASSIGNEE, 'POST', '/api/ai/answer-case', {
      caseId: handover[0]?.case_id,
      text: 'フォルダの中身は何ですか',
    });
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.body).not.toContain('CANARY');

    for (const email of [OWNER, ASSIGNEE]) {
      const page = await call(email, 'GET', '/');
      expect(page.statusCode).toBe(200);
      expect(page.body).not.toContain('CANARY');
    }
    const states = await sql<{ data: unknown }[]>`
      SELECT data FROM prototype_states WHERE user_email IN (${OWNER}, ${ASSIGNEE})
    `;
    expect(JSON.stringify(states)).not.toContain('CANARY');
    // 結果はまだ active の間は専用テーブルにだけある。
    expect(await resultCount(id)).toBe(1);
  });

  it('相談者・担当者の状態 API は結果を返さない', async () => {
    const { id, handoverId, helper, op } = await deliveredOp();
    await postResult(helper.helperToken, op.opId, resultBody());
    for (const response of [
      await call(ASSIGNEE, 'GET', base(id)),
      await call(OWNER, 'GET', `/api/folder-access/mine?handoverId=${handoverId}`),
    ]) {
      expect(response.body).not.toContain(CANARY_NAME);
    }
  });
});

describe('機能フラグと経路', () => {
  it('フラグ無効: 全ルートが 404 で DB にも触らない', async () => {
    const paired = await pairedRequest();
    const beforeRows = await requestRow(paired.id);
    config.FOLDER_ACCESS_ENABLED = false;
    const routes: [string | null, 'GET' | 'POST', string][] = [
      [OWNER, 'GET', '/api/folder-access/mine'],
      [OWNER, 'POST', base(paired.id, '/pair')],
      [OWNER, 'POST', base(paired.id, '/consent')],
      [OWNER, 'POST', base(paired.id, '/revoke')],
      [ASSIGNEE, 'POST', '/api/folder-access/requests'],
      [ASSIGNEE, 'GET', `/api/folder-access/requests?handoverId=${paired.handoverId}`],
      [ASSIGNEE, 'GET', base(paired.id)],
      [ASSIGNEE, 'POST', base(paired.id, '/list')],
      [ASSIGNEE, 'GET', base(paired.id, '/result')],
      [ASSIGNEE, 'POST', base(paired.id, '/end')],
      [null, 'POST', '/api/device/agent/folder-helper/register'],
      [null, 'POST', '/api/device/agent/folder-helper/poll'],
      [null, 'POST', '/api/device/agent/folder-helper/revoke'],
      [null, 'POST', `/api/device/agent/folder-helper/ops/${paired.id}/result`],
    ];
    for (const [email, method, url] of routes) {
      const response = await call(email, method, url, method === 'POST' ? {} : undefined);
      expect(response.statusCode, url).toBe(404);
    }
    expect(await requestRow(paired.id)).toEqual(beforeRows);
    expect(world.commands.length).toBe(1);
  });

  it('ヘルパー経路は Access と Proxy Secret を要求せず、トークンで守られる', async () => {
    config.REQUIRE_PROXY_SECRET = true;
    config.PROXY_SECRET = 'synth-proxy-secret-0123456789';
    try {
      const noToken = await app.inject({
        method: 'POST',
        url: '/api/device/agent/folder-helper/poll',
        payload: beat,
      });
      expect(noToken.statusCode).toBe(401);
      expect(noToken.json().error.code).toBe('UNAUTHORIZED');
      expect(noToken.json().error.message).toContain('ヘルパートークン');

      const registered = await app.inject({
        method: 'POST',
        url: '/api/device/agent/folder-helper/register',
        payload: registerPayload(),
      });
      expect(registered.statusCode, registered.body).toBe(200);

      // 人間向けの API は従来どおり Access / Proxy Secret が必須。
      const human = await app.inject({ method: 'GET', url: '/api/folder-access/mine' });
      expect(human.statusCode).toBe(401);
      expect(human.json().error.code).toBe('PROXY_REQUIRED');
    } finally {
      config.REQUIRE_PROXY_SECRET = originals.requireProxy;
      config.PROXY_SECRET = originals.proxySecret;
    }
  });

  it('Access なしで人間向け API は 401', async () => {
    const response = await call(null, 'GET', '/api/folder-access/mine');
    expect(response.statusCode).toBe(401);
  });

  it('登録にはレート制限がある', async () => {
    let limited = false;
    for (let index = 0; index < 25; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/device/agent/folder-helper/register',
        payload: registerPayload(),
      });
      if (response.statusCode === 429) limited = true;
    }
    expect(limited).toBe(true);
  });

  it('入力は zod で検証する（不正な MachineGuid / UUID）', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/device/agent/folder-helper/register',
      payload: registerPayload({ machineGuid: 'not-a-guid' }),
    });
    expect(bad.statusCode).toBe(400);
    expect((await call(ASSIGNEE, 'GET', base('not-a-uuid'))).statusCode).toBe(400);
  });
});
