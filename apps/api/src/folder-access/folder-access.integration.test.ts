import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAllowlistCache } from '../auth/allowlist.js';
import { clearUiRoleCache } from '../auth/ui.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { computeAuditHash } from '../domain/audit.js';
import { buildCaseContext, buildPcContext, type CaseSnapshot } from '../lib/case-handover.js';
import { checkRateLimit, resetRateLimits } from '../lib/rate-limit.js';
import { DEVICE_IDENTITY_PROBE_COMMAND } from '../remote-support/rsp.js';
import { buildServer } from '../server.js';
import { resetAddressLimits } from './address-limit.js';
import { loadContext, sweepFolderAccess } from './service.js';
import { auditRef, canonicalOpJson, hashSid, signOp } from './sign.js';
import { LIMITS } from './state.js';

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
  enqueueStatus?: number;
  onEnqueue?: () => Promise<void>;
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
    if (world.onEnqueue) await world.onEnqueue();
    if (world.enqueueStatus) return jsonResponse(world.enqueueStatus, { success: false });
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
    return jsonResponse(200, {
      log_id: 'x',
      exit_code: null,
      completed_at: new Date(Date.now() + 60_000).toISOString(),
      ...world.probe,
    });
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

/** 直近に作った依頼（registerHelper の既定の導入コードの発行先）。 */
let latestRequestId = '';

async function issueEnrollCode(requestId = latestRequestId): Promise<string> {
  const issued = await call(OWNER, 'POST', base(requestId, '/enroll-code'), {});
  expect(issued.statusCode, issued.body).toBe(200);
  return issued.json().enrollCode as string;
}

async function registerHelper(overrides: Record<string, unknown> = {}, requestId?: string) {
  const enrollCode = await issueEnrollCode(requestId);
  const response = await app.inject({
    method: 'POST',
    url: '/api/device/agent/folder-helper/register',
    payload: registerPayload({ enrollCode, ...overrides }),
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
  latestRequestId = response.json().request.id as string;
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
  resetAddressLimits();
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
      'folder_access.enroll_code',
      'folder_access.enroll_registered',
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

  it('同時送信で一意インデックスに当たっても 500 にせず、先に作られた依頼を返す', async () => {
    const handoverId = await makeHandover();
    const rows = await sql<{ case_id: string }[]>`
      SELECT case_id FROM case_handovers WHERE id = ${handoverId}
    `;
    const caseId = rows[0]?.case_id ?? '';
    let winner = '';
    let pending: ReturnType<typeof call> | undefined;
    // 未コミットの行はルートの事前確認から見えず、INSERT はコミットまで待って 23505 になる。
    await sql.begin(async (tx) => {
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO folder_access_requests (
          handover_id, case_id, requester_email, assignee_email, request_expires_at
        ) VALUES (
          ${handoverId}, ${caseId}, ${OWNER}, ${ASSIGNEE}, now() + interval '30 minutes'
        )
        RETURNING id
      `;
      winner = inserted[0]?.id ?? '';
      pending = call(ASSIGNEE, 'POST', '/api/folder-access/requests', { handoverId });
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    const response = await pending;
    expect(response?.statusCode, response?.body).toBe(200);
    expect(response?.json().request.id).toBe(winner);
    const count = await sql`
      SELECT id FROM folder_access_requests WHERE handover_id = ${handoverId}
    `;
    expect(count).toHaveLength(1);
  });

  it('同じ引継ぎへの並行送信はすべて成功し、依頼は 1 件だけになる', async () => {
    const handoverId = await makeHandover();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        call(ASSIGNEE, 'POST', '/api/folder-access/requests', { handoverId }),
      ),
    );
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    expect(new Set(responses.map((response) => response.json().request.id)).size).toBe(1);
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

  it('検証用フラグがあれば hostname だけでも担当者の指定端末で進む', async () => {
    config.LEASE_API_TOKEN_ID = undefined;
    config.FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE = true;
    const request = await createRequest(await makeHandover(), { hostname: HOST });
    expect(request.status).toBe('helper_pending');
    expect(request.leaseStatus).toBe('unverified');
    expect(request.device.rspDeviceId).toBe(RSP_DEVICE);
    expect(world.leaseCalls).toBe(0);
  });

  it('検証用フラグが無ければ hostname の指定は無視して貸与情報で判定する', async () => {
    const request = await createRequest(await makeHandover(), { hostname: 'SYNTH-OTHER' });
    expect(request.leaseStatus).toBe('verified');
    expect(world.commands[0]?.hostname).toBe(HOST);
  });

  it('社員名簿は別名のメールでも解決する', async () => {
    const primary = 'fa-alias-primary@example.com';
    const alias = 'fa-alias-other@example.com';
    directory.byEmail.set(alias, { employeeNo: 'E100', name: '別名', section: '営業部' });
    const original = config.EMAIL_ALIASES;
    config.EMAIL_ALIASES = `${alias}=${primary}`;
    try {
      const request = await createRequest(await makeHandover(ASSIGNEE, primary));
      expect(request.status).toBe('helper_pending');
      expect(request.leaseStatus).toBe('verified');
    } finally {
      config.EMAIL_ALIASES = original;
      directory.byEmail.delete(alias);
    }
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

  it('取り直しの上限に達しても古い結果では進めず、理由を出して留まる', async () => {
    const stale = {
      status: 'completed',
      output: probeOutput(),
      error_code: null,
      completed_at: '2020-01-01T00:00:00+00:00',
    };
    world.probe = stale;
    const { id, handoverId, helper } = await pairedRequest();
    for (let index = 0; index < 3; index += 1) {
      await sql`UPDATE folder_access_requests SET rsp_probe_checked_at = NULL WHERE id = ${id}`;
      await poll(helper.helperToken);
    }
    expect(world.commands).toHaveLength(3);
    expect(await requestRow(id)).toMatchObject({
      status: 'helper_pending',
      reason_code: 'RSP_PROBE_STALE',
    });
    expect((await call(OWNER, 'POST', base(id, '/consent'), CONSENT)).statusCode).toBe(409);

    // 担当者の再確認で投入し直し、新しい結果なら進める。
    const retried = await createRequest(handoverId);
    expect(retried.id).toBe(id);
    expect(world.commands).toHaveLength(4);
    world.probe = { ...stale, completed_at: new Date(Date.now() + 60_000).toISOString() };
    await sql`UPDATE folder_access_requests SET rsp_probe_checked_at = NULL WHERE id = ${id}`;
    await poll(helper.helperToken);
    expect((await requestRow(id))?.status).toBe('consent_pending');
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
    await createRequest(await makeHandover());
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
    await createRequest(await makeHandover());
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
    const request = await createRequest(await makeHandover());
    const helper = await registerHelper();
    expect((await poll(helper.helperToken)).json().paired).toBe(false);
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

describe('保持期間（docs/62 §7-1）', () => {
  async function identifiers(id: string, helperId: string) {
    const requests = await sql<Record<string, unknown>[]>`
      SELECT status, end_reason, ended_at, created_at, sid, session_id, machine_guid, consent_root,
             rsp_hostname, rsp_device_id, mesh_node_id, rsp_machine_guid, rsp_probe_log_id,
             lease_asset_tag
      FROM folder_access_requests WHERE id = ${id}
    `;
    const ops = await sql<{ sid: string | null; root: string | null }[]>`
      SELECT sid, root FROM folder_access_ops WHERE request_id = ${id}
    `;
    const helpers = await sql<Record<string, unknown>[]>`
      SELECT sid, machine_guid, hostname FROM folder_access_helpers WHERE id = ${helperId}
    `;
    return { request: requests[0] ?? {}, ops, helper: helpers[0] ?? {} };
  }

  const backdate = (id: string, days: number) => sql`
    UPDATE folder_access_requests
    SET ended_at = now() - (${days}::int * interval '1 day') WHERE id = ${id}
  `;

  it('期限を過ぎた行の識別子を消し、状態・終了理由・時刻・監査は残す', async () => {
    const { id, helper, op } = await deliveredOp();
    await call(ASSIGNEE, 'POST', base(id, '/end'), {});
    const auditBefore = await auditRows(id);
    await backdate(id, 31);
    const before = await identifiers(id, helper.helperId);
    expect(before.request.sid).toBe(SID);
    expect(before.helper.machine_guid).toBe(MACHINE);
    expect(before.ops[0]?.root).toBe('Documents');

    await sweepFolderAccess();

    const after = await identifiers(id, helper.helperId);
    for (const column of [
      'sid',
      'session_id',
      'machine_guid',
      'consent_root',
      'rsp_hostname',
      'rsp_device_id',
      'mesh_node_id',
      'rsp_machine_guid',
      'rsp_probe_log_id',
      'lease_asset_tag',
    ]) {
      expect(after.request[column], column).toBeNull();
    }
    expect(after.ops).toEqual([{ sid: null, root: null }]);
    expect(after.helper).toEqual({ sid: null, machine_guid: null, hostname: null });
    expect(after.request.status).toBe('ended');
    expect(after.request.end_reason).toBe('operator_end');
    expect(after.request.ended_at).toEqual(before.request.ended_at);
    expect(after.request.created_at).toEqual(before.request.created_at);
    expect(await auditRows(id)).toEqual(auditBefore);

    // 識別子を消した後も、古いヘルパーは失効扱いで止まり、遅延結果は保存されない。
    expect((await poll(helper.helperToken)).json().revoked).toBe(true);
    const late = await postResult(helper.helperToken, op.opId, resultBody());
    expect(late.json().discarded).toBe(true);
    // 状態確認も壊れない。
    expect((await call(ASSIGNEE, 'GET', base(id))).json().request.device.hostname).toBeNull();
  });

  it('期限内の行と進行中の行は消さない', async () => {
    const ended = await activeRequest();
    await call(ASSIGNEE, 'POST', base(ended.id, '/end'), {});
    await backdate(ended.id, 29);
    const running = await activeRequest();
    await sweepFolderAccess();
    expect((await identifiers(ended.id, ended.helper.helperId)).request.sid).toBe(SID);
    expect((await identifiers(running.id, running.helper.helperId)).request.sid).toBe(SID);
    expect((await requestRow(running.id))?.status).toBe('active');
  });

  it('FOLDER_ACCESS_RETENTION_DAYS で日数を変えられる', async () => {
    const { id, helper } = await activeRequest();
    await call(ASSIGNEE, 'POST', base(id, '/end'), {});
    await backdate(id, 6);
    const original = config.FOLDER_ACCESS_RETENTION_DAYS;
    config.FOLDER_ACCESS_RETENTION_DAYS = 5;
    try {
      await sweepFolderAccess();
    } finally {
      config.FOLDER_ACCESS_RETENTION_DAYS = original;
    }
    expect((await identifiers(id, helper.helperId)).request.sid).toBeNull();
  });
});

describe('相談者の依頼一覧（Mock: RSP）', () => {
  // 他のテストが残した同じ相談者の依頼を一覧から外す。
  beforeEach(async () => {
    await sql`
      UPDATE folder_access_requests
      SET status = 'ended', end_reason = 'operator_end', ended_at = now() - interval '1 hour'
      WHERE requester_email = ${OWNER}
        AND (ended_at IS NULL OR ended_at > now() - interval '1 hour')
    `;
  });

  it('進行中の依頼をすべて返し、古い同意も確認・取消できる', async () => {
    const older = await activeRequest();
    const newer = await pairedRequest();
    const response = await call(OWNER, 'GET', '/api/folder-access/mine');
    expect(response.statusCode, response.body).toBe(200);
    const ids = response.json().requests.map((item: { id: string }) => item.id);
    expect(ids).toContain(older.id);
    expect(ids).toContain(newer.id);
    const oldItem = response.json().requests.find((item: { id: string }) => item.id === older.id);
    expect(oldItem.status).toBe('active');
    expect(oldItem.scope.segments).toEqual([CANARY_SEGMENT]);

    expect((await call(OWNER, 'POST', base(older.id, '/revoke'), {})).statusCode).toBe(200);
    expect((await requestRow(older.id))?.status).toBe('revoked');
    expect((await requestRow(newer.id))?.status).toBe('consent_pending');
    await call(OWNER, 'POST', base(newer.id, '/revoke'), {});
  });

  it('他人の依頼は含めず、handoverId 指定は従来どおり 1 件', async () => {
    const mine = await pairedRequest();
    const others = await call(OTHER_OWNER, 'GET', '/api/folder-access/mine');
    expect(others.json().requests.map((item: { id: string }) => item.id)).not.toContain(mine.id);
    const single = await call(
      OWNER,
      'GET',
      `/api/folder-access/mine?handoverId=${mine.handoverId}`,
    );
    expect(single.json().requests).toHaveLength(1);
    expect(single.json().request.id).toBe(mine.id);
    await call(OWNER, 'POST', base(mine.id, '/revoke'), {});
  });

  it('終了から 10 分より前の依頼は返さない', async () => {
    const { id } = await pairedRequest();
    await call(OWNER, 'POST', base(id, '/revoke'), {});
    const recent = await call(OWNER, 'GET', '/api/folder-access/mine');
    expect(recent.json().requests.map((item: { id: string }) => item.id)).toContain(id);
    await sql`
      UPDATE folder_access_requests SET ended_at = now() - interval '11 minutes' WHERE id = ${id}
    `;
    const later = await call(OWNER, 'GET', '/api/folder-access/mine');
    expect(later.json().requests.map((item: { id: string }) => item.id)).not.toContain(id);
  });
});

describe('権限確認を状態更新より先に行う（Mock: RSP）', () => {
  const expire = (id: string) => sql`
    UPDATE folder_access_requests
    SET consent_expires_at = now() - interval '1 second',
        request_expires_at = now() - interval '1 second'
    WHERE id = ${id}
  `;

  it.each([
    ['GET /requests/:id', OTHER_ASSIGNEE, 'GET', ''],
    ['GET /result', OTHER_ASSIGNEE, 'GET', '/result'],
  ] as const)(
    '権限のない %s は期限切れの依頼を終了させない',
    async (_name, email, method, path) => {
      const { id } = await activeRequest();
      await expire(id);
      const response = await call(email, method, base(id, path));
      expect(response.statusCode).toBe(403);
      expect((await requestRow(id))?.status).toBe('active');
      await call(ASSIGNEE, 'POST', base(id, '/end'), {});
    },
  );

  it('権限のない POST /consent は状態を更新せず、RSP にも問い合わせない', async () => {
    world.probe = { status: 'running', output: null, error_code: null };
    const { id } = await pairedRequest();
    await sql`UPDATE folder_access_requests SET rsp_probe_checked_at = NULL WHERE id = ${id}`;
    const reads = world.probeReads;
    const response = await call(OTHER_OWNER, 'POST', base(id, '/consent'), CONSENT);
    expect(response.statusCode).toBe(403);
    expect(world.probeReads).toBe(reads);
    await expire(id);
    expect((await call(OTHER_OWNER, 'POST', base(id, '/consent'), CONSENT)).statusCode).toBe(403);
    expect((await requestRow(id))?.status).toBe('helper_pending');
    await call(OWNER, 'POST', base(id, '/revoke'), {});
  });

  it('存在しない依頼は 404', async () => {
    const missing = '77777777-7777-4777-8777-777777777777';
    expect((await call(ASSIGNEE, 'GET', base(missing))).statusCode).toBe(404);
    expect((await call(OWNER, 'POST', base(missing, '/consent'), CONSENT)).statusCode).toBe(404);
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
      // Access / Proxy Secret ではなく導入コードで守られる。
      expect(registered.statusCode, registered.body).toBe(403);
      expect(registered.json().error.code).toBe('ENROLL_CODE_INVALID');

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

describe('コードレビューの指摘（#117。Mock: RSP / PII API / 名簿）', () => {
  describe('1. 担当者が引き受けた引継ぎの検索', () => {
    const lookup = (email: string, ref: string) =>
      call(email, 'GET', `/api/folder-access/handovers/lookup?ref=${encodeURIComponent(ref)}`);

    async function withRefs(status = 'claimed', claimedBy = ASSIGNEE) {
      const handoverId = await makeHandover(claimedBy);
      sequence += 1;
      const inc = `INC-${CASE_PREFIX}${Date.now()}-${sequence}`;
      const ticket = `TKT-${CASE_PREFIX}${Date.now()}-${sequence}`;
      const rows = await sql<{ case_id: string }[]>`
        UPDATE case_handovers
        SET status = ${status},
            snapshot = snapshot || ${sql.json({ inc: { id: inc }, ticket: { id: ticket } })}
        WHERE id = ${handoverId}
        RETURNING case_id
      `;
      return { handoverId, caseId: rows[0]?.case_id ?? '', inc, ticket };
    }

    it('caseId / INC / チケット番号で引ける（resolved も）', async () => {
      const refs = await withRefs('resolved');
      for (const ref of [refs.caseId, refs.inc, refs.ticket]) {
        const response = await lookup(ASSIGNEE, ref);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({ ok: true, handoverId: refs.handoverId });
      }
    });

    it('他の担当者の引継ぎや未 claim は返さない（ID も内容も漏らさない）', async () => {
      const refs = await withRefs('claimed', OTHER_ASSIGNEE);
      const response = await lookup(ASSIGNEE, refs.caseId);
      expect(response.json()).toEqual({ ok: true, handoverId: null });
      const completed = await withRefs('completed');
      expect((await lookup(ASSIGNEE, completed.caseId)).json().handoverId).toBeNull();
    });

    it('担当者でなければ 403（承認者のみ・相談者）', async () => {
      const refs = await withRefs();
      for (const email of [OWNER, APPROVER_ONLY]) {
        expect((await lookup(email, refs.caseId)).statusCode, email).toBe(403);
      }
    });

    it('機能が無効なら 404', async () => {
      config.FOLDER_ACCESS_ENABLED = false;
      expect((await lookup(ASSIGNEE, 'CASE-X')).statusCode).toBe(404);
    });
  });

  describe('3. RSP の再投入', () => {
    it('再投入先の端末が確定した端末と違えば device_mismatch で終了する', async () => {
      world.probe = { status: 'failed', output: '[AGENT_BUSY]', error_code: 'AGENT_BUSY' };
      const handoverId = await makeHandover();
      const request = await createRequest(handoverId);
      const helper = await registerHelper();
      world.enqueueDevice = '99999999-9999-4999-8999-999999999999';
      await call(OWNER, 'POST', base(request.id, '/pair'), { code: helper.pairingCode });
      expect(await requestRow(request.id)).toMatchObject({
        status: 'denied',
        end_reason: 'device_mismatch',
      });
    });

    it('同時の確認でも再投入は 1 回だけで、回数を原子的に予約する', async () => {
      world.probe = { status: 'running', output: null, error_code: null };
      const { id } = await pairedRequest();
      const commands = world.commands.length;
      world.probe = { status: 'failed', output: '[AGENT_BUSY]', error_code: 'AGENT_BUSY' };
      await sql`UPDATE folder_access_requests SET rsp_probe_checked_at = NULL WHERE id = ${id}`;
      await Promise.all(Array.from({ length: 5 }, () => call(ASSIGNEE, 'GET', base(id))));
      expect(world.commands.length).toBe(commands + 1);
      const rows = await sql<{ rsp_probe_attempts: number; rsp_probe_log_id: string | null }[]>`
        SELECT rsp_probe_attempts, rsp_probe_log_id FROM folder_access_requests WHERE id = ${id}
      `;
      expect(rows[0]?.rsp_probe_attempts).toBe(2);
      expect(rows[0]?.rsp_probe_log_id).not.toBeNull();
    });

    it('同時の確認でも問い合わせの間隔を守る', async () => {
      world.probe = { status: 'running', output: null, error_code: null };
      const { id } = await pairedRequest();
      await sql`UPDATE folder_access_requests SET rsp_probe_checked_at = NULL WHERE id = ${id}`;
      const reads = world.probeReads;
      await Promise.all(Array.from({ length: 5 }, () => call(ASSIGNEE, 'GET', base(id))));
      expect(world.probeReads).toBe(reads + 1);
    });

    it('再投入に失敗しても確認を続けられる（結果の参照を失わない）', async () => {
      world.probe = { status: 'running', output: null, error_code: null };
      const { id } = await pairedRequest();
      const before = await sql<{ rsp_probe_log_id: string }[]>`
        SELECT rsp_probe_log_id FROM folder_access_requests WHERE id = ${id}
      `;
      world.probe = { status: 'failed', output: '[AGENT_BUSY]', error_code: 'AGENT_BUSY' };
      world.enqueueStatus = 500;
      await sql`UPDATE folder_access_requests SET rsp_probe_checked_at = NULL WHERE id = ${id}`;
      await call(ASSIGNEE, 'GET', base(id));
      world.enqueueStatus = undefined;
      const rows = await sql<{ rsp_probe_log_id: string; reason_code: string }[]>`
        SELECT rsp_probe_log_id, reason_code FROM folder_access_requests WHERE id = ${id}
      `;
      expect(rows[0]?.rsp_probe_log_id).toBe(before[0]?.rsp_probe_log_id);
      expect(rows[0]?.reason_code).toBe('RSP_PROBE_UNAVAILABLE');
    });
  });

  describe('4. 未知の状態と恒久失敗', () => {
    it.each(['weird', '', 'cancelled', 'timeout'])(
      '実行中と分からない状態（%s）は待たず、理由を出して再確認できる',
      async (status) => {
        world.probe = { status, output: null, error_code: null };
        const { id, handoverId } = await pairedRequest();
        const row = await requestRow(id);
        expect(row?.status).toBe('helper_pending');
        expect(row?.reason_code).toBe('RSP_PROBE_UNKNOWN_STATUS');
        const probe = await sql<{ rsp_probe_status: string }[]>`
          SELECT rsp_probe_status FROM folder_access_requests WHERE id = ${id}
        `;
        expect(probe[0]?.rsp_probe_status).toBe('failed');

        world.probe = { status: 'completed', output: probeOutput(), error_code: null };
        const retried = await createRequest(handoverId);
        expect(retried.id).toBe(id);
        expect(world.commands.length).toBeGreaterThan(1);
      },
    );

    it.each(['queued', 'pending', 'running'])('既知の実行中（%s）は待つ', async (status) => {
      world.probe = { status, output: null, error_code: null };
      const { id } = await pairedRequest();
      expect((await requestRow(id))?.reason_code).toBeNull();
      const probe = await sql<{ rsp_probe_status: string }[]>`
        SELECT rsp_probe_status FROM folder_access_requests WHERE id = ${id}
      `;
      expect(probe[0]?.rsp_probe_status).toBe('pending');
    });

    it('問い合わせの回数に上限があり、超えたら理由を出す。再確認で数え直す', async () => {
      world.probe = { status: 'running', output: null, error_code: null };
      const { id, handoverId } = await pairedRequest();
      await sql`
        UPDATE folder_access_requests
        SET rsp_probe_reads = ${LIMITS.maxProbeReads}, rsp_probe_checked_at = NULL
        WHERE id = ${id}
      `;
      const reads = world.probeReads;
      await call(ASSIGNEE, 'GET', base(id));
      expect(world.probeReads).toBe(reads);
      expect((await requestRow(id))?.reason_code).toBe('RSP_PROBE_TIMEOUT');

      world.probe = { status: 'completed', output: probeOutput(), error_code: null };
      await createRequest(handoverId);
      const rows = await sql<{ rsp_probe_reads: number; rsp_probe_status: string }[]>`
        SELECT rsp_probe_reads, rsp_probe_status FROM folder_access_requests WHERE id = ${id}
      `;
      expect(rows[0]).toEqual({ rsp_probe_reads: 0, rsp_probe_status: 'pending' });
    });
  });

  describe('8. ペアリング失敗の監査', () => {
    const failures = async (id: string) =>
      (await auditRows(id)).filter((row) => row.action === 'folder_access.pair_failed');

    it('誤コードを監査し、コードを残さない', async () => {
      const request = await createRequest(await makeHandover());
      const helper = await registerHelper();
      const wrong = helper.pairingCode === '00000000' ? '00000001' : '00000000';
      await call(OWNER, 'POST', base(request.id, '/pair'), { code: wrong });
      const rows = await failures(request.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.detail).toMatchObject({ result: 'invalid' });
      const text = JSON.stringify(rows);
      expect(text).not.toContain(wrong);
      expect(text).not.toContain(helper.pairingCode);
    });

    it('ロックアウトを監査する', async () => {
      const request = await createRequest(await makeHandover());
      await sql`
        UPDATE folder_access_requests SET pair_attempts = ${LIMITS.maxPairAttempts}
        WHERE id = ${request.id}
      `;
      await call(OWNER, 'POST', base(request.id, '/pair'), { code: '12345678' });
      expect((await failures(request.id))[0]?.detail).toMatchObject({ result: 'locked' });
    });

    it('セッション不一致を監査する', async () => {
      const request = await createRequest(await makeHandover());
      const helper = await registerHelper();
      await poll(helper.helperToken, { ...beat, sessionState: 'disconnected' });
      const response = await call(OWNER, 'POST', base(request.id, '/pair'), {
        code: helper.pairingCode,
      });
      expect(response.statusCode).toBe(409);
      expect((await failures(request.id))[0]?.detail).toMatchObject({ result: 'session' });
    });
  });

  describe('9. 監査の識別子', () => {
    it('hostname・RSP 端末 ID・Mesh ノード ID を平文で残さず、HMAC の参照にする', async () => {
      const { id } = await activeRequest();
      const rows = await auditRows(id);
      const text = JSON.stringify(rows);
      for (const plain of [HOST, RSP_DEVICE, 'node//synth', SID]) {
        expect(text, plain).not.toContain(plain);
      }
      const consent = rows.find((row) => row.action === 'folder_access.consent');
      expect(consent?.detail).toMatchObject({
        hostnameRef: auditRef('hostname', HOST),
        rspDeviceRef: auditRef('rsp_device', RSP_DEVICE),
        meshNodeRef: auditRef('mesh_node', 'node//synth'),
        sidHash: hashSid(SID),
      });
      expect(consent?.detail).not.toHaveProperty('hostname');
      expect(consent?.detail).not.toHaveProperty('rspDeviceId');
      expect(consent?.detail).not.toHaveProperty('meshNodeId');
    });

    it('SID のハッシュは秘密を持たないと計算できない（素の SHA-256 ではない）', () => {
      expect(hashSid(SID)).not.toBe(createHash('sha256').update(SID).digest('hex'));
      expect(hashSid(SID)).toMatch(/^[0-9a-f]{64}$/);
      // 同じ値でも種類が違えば別の参照になる（突き合わせで種類を超えて追跡できない）。
      expect(auditRef('hostname', 'x')).not.toBe(auditRef('rsp_device', 'x'));
      // 大文字小文字の違いで別の端末に見えない。
      expect(auditRef('hostname', 'SYNTH-PC')).toBe(auditRef('hostname', 'synth-pc'));
    });

    it('監査のハッシュチェーンを壊さない', async () => {
      const { id } = await activeRequest();
      const rows = await sql<
        {
          id: string;
          prev_hash: string;
          hash: string;
          detail: Record<string, unknown>;
          action: string;
          target_type: string;
          target_id: string;
          actor_id: string | null;
        }[]
      >`
        SELECT id, prev_hash, hash, detail, action, target_type, target_id, actor_id
        FROM audit_log WHERE target_type = 'folder_access_request' AND target_id = ${id}
        ORDER BY id
      `;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(
          computeAuditHash(row.prev_hash, {
            actorId: row.actor_id,
            action: row.action,
            targetType: row.target_type,
            targetId: row.target_id,
            detail: row.detail,
          }),
        ).toBe(row.hash);
      }
    });
  });

  describe('10. 未認証の登録の上限', () => {
    async function fillUnpaired(count: number, expired: boolean) {
      await sql`
        INSERT INTO folder_access_helpers (
          token_hash, machine_guid, sid, session_id, session_state, pairing_expires_at
        )
        SELECT 'synthetic-fill-' || g, ${OTHER_MACHINE}, ${OTHER_SID}, 2, 'active',
          ${expired ? sql`now() - interval '1 minute'` : sql`now() + interval '10 minutes'`}
        FROM generate_series(1, ${count}::int) AS g
      `;
    }
    const clearFill = () => sql`
      DELETE FROM folder_access_helpers WHERE token_hash LIKE 'synthetic-fill-%'
    `;
    const unpairedCount = async () =>
      Number(
        (
          await sql<{ count: string }[]>`
            SELECT count(*) AS count FROM folder_access_helpers WHERE request_id IS NULL
          `
        )[0]?.count,
      );
    const registerRaw = async (headers: Record<string, string> = {}) => {
      // 上限より先に導入コードを確かめるので、有効なコードで試す。
      const request = await createRequest(await makeHandover());
      return app.inject({
        method: 'POST',
        url: '/api/device/agent/folder-helper/register',
        headers,
        payload: registerPayload({ enrollCode: await issueEnrollCode(request.id) }),
      });
    };

    afterEach(async () => {
      await clearFill();
    });

    it('有効な未ペアが全体の上限に達したら登録を拒否する', async () => {
      await clearFill();
      await sql`
        DELETE FROM folder_access_helpers
        WHERE request_id IS NULL AND pairing_expires_at <= now()
      `;
      await fillUnpaired(LIMITS.maxUnpairedHelpers - (await unpairedCount()), false);
      const response = await registerRaw();
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('REGISTRATION_BUSY');
      expect(response.body).not.toContain('helperToken');
      expect(await unpairedCount()).toBe(LIMITS.maxUnpairedHelpers);
    });

    it('期限切れの未ペアは上限に数えず、上限に達したら先に片付ける', async () => {
      await clearFill();
      await fillUnpaired(LIMITS.maxUnpairedHelpers, true);
      const response = await registerRaw();
      expect(response.statusCode, response.body).toBe(200);
      expect(await unpairedCount()).toBeLessThan(LIMITS.maxUnpairedHelpers);
    });

    it('期限切れの未ペアは短い保持期間で消す', async () => {
      const helper = await registerHelper();
      await sql`
        UPDATE folder_access_helpers
        SET pairing_expires_at = now() - (${LIMITS.unpairedRetentionMinutes + 1}::int * interval '1 minute')
        WHERE id = ${helper.helperId}
      `;
      const keep = await registerHelper();
      await sql`
        UPDATE folder_access_helpers
        SET pairing_expires_at = now() - (${LIMITS.unpairedRetentionMinutes - 1}::int * interval '1 minute')
        WHERE id = ${keep.helperId}
      `;
      await sweepFolderAccess();
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM folder_access_helpers WHERE id IN (${helper.helperId}, ${keep.helperId})
      `;
      expect(rows.map((row) => row.id)).toEqual([keep.helperId]);
    });

    it('未認証の接続元の制限は共通のバケットを使わない（満杯でも互いに影響しない）', async () => {
      const prepared = await createRequest(await makeHandover());
      const enrollCode = await issueEnrollCode(prepared.id);
      for (let index = 0; index < 10_000; index += 1) {
        checkRateLimit(`synthetic-fill:${index}`, 1, 60_000);
      }
      expect(checkRateLimit('authenticated-route', 1, 60_000)).toBe(false);
      const registered = await app.inject({
        method: 'POST',
        url: '/api/device/agent/folder-helper/register',
        headers: { 'cf-connecting-ip': '192.0.2.10' },
        payload: registerPayload({ enrollCode }),
      });
      expect(registered.statusCode, registered.body).toBe(200);
      resetRateLimits();

      // 接続元を変えて登録を繰り返しても、認証済みの経路のバケットは増えない。
      for (let index = 0; index < 30; index += 1) {
        await app.inject({
          method: 'POST',
          url: '/api/device/agent/folder-helper/register',
          headers: { 'cf-connecting-ip': `198.51.100.${index}` },
          payload: registerPayload(),
        });
      }
      expect(checkRateLimit('authenticated-route', 1, 60_000)).toBe(true);
    });

    it('全体の登録の頻度にも上限がある（接続元を変えても超えられない）', async () => {
      let limited = false;
      for (let index = 0; index < LIMITS.registerGlobalPerMinute + 5; index += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/device/agent/folder-helper/register',
          headers: { 'cf-connecting-ip': `203.0.113.${index % 250}` },
          payload: registerPayload(),
        });
        if (response.statusCode === 429) limited = true;
      }
      expect(limited).toBe(true);
    }, 30_000);
  });
});

describe('導入コード（Mock: RSP / PII API / 名簿）', () => {
  const registerWith = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/device/agent/folder-helper/register',
      headers,
      payload: registerPayload(payload),
    });

  function expectRefused(response: { statusCode: number; body: string; json: () => any }) {
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error.code).toBe('ENROLL_CODE_INVALID');
    // 匿名でトークンもペアリングコードも発行されない。
    expect(response.body).not.toContain('helperToken');
    expect(response.body).not.toContain('pairingCode');
  }

  const helperCount = async () =>
    Number(
      (await sql<{ count: string }[]>`SELECT count(*) AS count FROM folder_access_helpers`)[0]
        ?.count,
    );

  it('発行: 本人だけ、helper_pending のときだけ。一回限りの 10 分のコードを返す', async () => {
    const request = await createRequest(await makeHandover());
    const before = Date.now();
    const issued = await call(OWNER, 'POST', base(request.id, '/enroll-code'), {});
    expect(issued.statusCode, issued.body).toBe(200);
    const body = issued.json();
    expect(body.enrollCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
    const ttl = new Date(body.expiresAt).getTime() - before;
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000 + 5_000);
  });

  it.each([OTHER_OWNER, ASSIGNEE, OTHER_ASSIGNEE, APPROVER_ONLY])(
    '他人（%s）は他人の依頼のコードを発行できない',
    async (email) => {
      const request = await createRequest(await makeHandover());
      const issued = await call(email, 'POST', base(request.id, '/enroll-code'), {});
      expect(issued.statusCode).toBe(403);
      expect(issued.body).not.toContain('enrollCode');
    },
  );

  it('helper_pending 以外では発行できない', async () => {
    world.lease = leaseBody([]);
    const pending = await createRequest(await makeHandover());
    expect(pending.status).toBe('device_pending');
    expect((await call(OWNER, 'POST', base(pending.id, '/enroll-code'), {})).statusCode).toBe(409);
    world.lease = leaseBody([LEASE_ROW]);

    const { id } = await pairedRequest();
    expect((await call(OWNER, 'POST', base(id, '/enroll-code'), {})).statusCode).toBe(409);
    const ended = await createRequest(await makeHandover());
    await call(OWNER, 'POST', base(ended.id, '/revoke'), {});
    expect((await call(OWNER, 'POST', base(ended.id, '/enroll-code'), {})).statusCode).toBe(409);
  });

  it('未認証は発行できない', async () => {
    const request = await createRequest(await makeHandover());
    const issued = await call(null, 'POST', base(request.id, '/enroll-code'), {});
    expect([401, 403]).toContain(issued.statusCode);
  });

  it.each([
    ['コードなし', {}],
    ['誤り', { enrollCode: 'ABCDEFGHJKMN' }],
    ['形式違い', { enrollCode: "'; DROP TABLE x;--" }],
    ['長すぎる', { enrollCode: 'A'.repeat(500) }],
  ])('登録: %s は 403 でトークンを発行しない', async (_name, payload) => {
    await createRequest(await makeHandover());
    const before = await helperCount();
    expectRefused(await registerWith(payload));
    expect(await helperCount()).toBe(before);
  });

  it('登録: 再利用できない（一回限り）', async () => {
    const request = await createRequest(await makeHandover());
    const enrollCode = await issueEnrollCode(request.id);
    expect((await registerWith({ enrollCode })).statusCode).toBe(200);
    expectRefused(await registerWith({ enrollCode }));
  });

  it('登録: 期限切れは使えない', async () => {
    const request = await createRequest(await makeHandover());
    const enrollCode = await issueEnrollCode(request.id);
    await sql`
      UPDATE folder_access_requests SET enroll_code_expires_at = now() - interval '1 second'
      WHERE id = ${request.id}
    `;
    expectRefused(await registerWith({ enrollCode }));
  });

  it('登録: 再発行すると旧コードは無効になる', async () => {
    const request = await createRequest(await makeHandover());
    const old = await issueEnrollCode(request.id);
    const fresh = await issueEnrollCode(request.id);
    expect(fresh).not.toBe(old);
    expectRefused(await registerWith({ enrollCode: old }));
    expect((await registerWith({ enrollCode: fresh })).statusCode).toBe(200);
  });

  it('登録: 依頼が終わったら使えない', async () => {
    const request = await createRequest(await makeHandover());
    const enrollCode = await issueEnrollCode(request.id);
    await call(OWNER, 'POST', base(request.id, '/revoke'), {});
    expectRefused(await registerWith({ enrollCode }));
  });

  it('登録の失敗でコードを消費しない（SID やセッションの拒否、上限）', async () => {
    const request = await createRequest(await makeHandover());
    const enrollCode = await issueEnrollCode(request.id);
    expect((await registerWith({ enrollCode, sid: 'S-1-5-18' })).statusCode).toBe(403);
    expect((await registerWith({ enrollCode, sessionState: 'down' })).statusCode).toBe(409);
    expect((await registerWith({ enrollCode })).statusCode).toBe(200);
  });

  it('誤ったコードの試行に接続元ごとの上限がある（正しいコードでも止まる）', async () => {
    const request = await createRequest(await makeHandover());
    const enrollCode = await issueEnrollCode(request.id);
    const headers = { 'cf-connecting-ip': '192.0.2.77' };
    for (let index = 0; index < LIMITS.enrollFailuresPerAddress; index += 1) {
      expectRefused(await registerWith({ enrollCode: 'ABCDEFGHJKMN' }, headers));
    }
    const limited = await registerWith({ enrollCode }, headers);
    expect(limited.statusCode).toBe(429);
    expect(limited.body).not.toContain('helperToken');
    // 別の接続元には影響しない。
    expect((await registerWith({ enrollCode })).statusCode).toBe(200);
  });

  it('発行の回数に上限がある', async () => {
    const request = await createRequest(await makeHandover());
    for (let index = 0; index < LIMITS.maxEnrollCodeIssues; index += 1) {
      await issueEnrollCode(request.id);
    }
    const over = await call(OWNER, 'POST', base(request.id, '/enroll-code'), {});
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('ENROLL_CODE_LIMIT');
  });

  it('HMAC で保存し、監査にコードを残さない', async () => {
    const request = await createRequest(await makeHandover());
    const enrollCode = await issueEnrollCode(request.id);
    const rows = await sql<{ enroll_code_hash: string }[]>`
      SELECT enroll_code_hash FROM folder_access_requests WHERE id = ${request.id}
    `;
    expect(rows[0]?.enroll_code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.enroll_code_hash).not.toContain(enrollCode);
    expect(rows[0]?.enroll_code_hash).not.toBe(
      createHash('sha256').update(enrollCode).digest('hex'),
    );
    await registerWith({ enrollCode });
    const audits = await auditRows(request.id);
    const actions = audits.map((row) => row.action);
    expect(actions).toContain('folder_access.enroll_code');
    expect(actions).toContain('folder_access.enroll_registered');
    expect(JSON.stringify(audits)).not.toContain(enrollCode);
    const used = await sql<{ enroll_code_hash: string | null }[]>`
      SELECT enroll_code_hash FROM folder_access_requests WHERE id = ${request.id}
    `;
    expect(used[0]?.enroll_code_hash).toBeNull();
  });

  it('依頼の終了で未使用のコードを消す', async () => {
    const request = await createRequest(await makeHandover());
    await issueEnrollCode(request.id);
    await call(OWNER, 'POST', base(request.id, '/revoke'), {});
    const rows = await sql<{ enroll_code_hash: string | null }[]>`
      SELECT enroll_code_hash FROM folder_access_requests WHERE id = ${request.id}
    `;
    expect(rows[0]?.enroll_code_hash).toBeNull();
  });

  it('ペア: 別の依頼の導入コードで登録したヘルパーはペアできない', async () => {
    const other = await createRequest(await makeHandover());
    const helper = await registerHelper({}, other.id);
    const mine = await createRequest(await makeHandover());
    const response = await call(OWNER, 'POST', base(mine.id, '/pair'), {
      code: helper.pairingCode,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('PAIRING_INVALID');
    const rows = await sql<{ request_id: string | null }[]>`
      SELECT request_id FROM folder_access_helpers WHERE id = ${helper.helperId}
    `;
    expect(rows[0]?.request_id).toBeNull();
    // 正しい依頼ではペアできる。
    const ok = await call(OWNER, 'POST', base(other.id, '/pair'), { code: helper.pairingCode });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('ペア: 導入コードで紐付いていないヘルパー（旧来の行）はペアできない', async () => {
    const request = await createRequest(await makeHandover());
    const helper = await registerHelper({}, request.id);
    await sql`
      UPDATE folder_access_helpers SET enrolled_request_id = NULL WHERE id = ${helper.helperId}
    `;
    const response = await call(OWNER, 'POST', base(request.id, '/pair'), {
      code: helper.pairingCode,
    });
    expect(response.statusCode).toBe(400);
  });

  it('既存のペアリング（本人が画面へ入力）は残る。コードなしでは同意まで進まない', async () => {
    const request = await createRequest(await makeHandover());
    const helper = await registerHelper({}, request.id);
    const status = await call(OWNER, 'GET', '/api/folder-access/mine');
    expect(status.statusCode).toBe(200);
    expect((await call(OWNER, 'POST', base(request.id, '/consent'), CONSENT)).statusCode).toBe(409);
    const pair = await call(OWNER, 'POST', base(request.id, '/pair'), { code: helper.pairingCode });
    expect(pair.json().request.status).toBe('consent_pending');
  });
});

describe('コードレビューの指摘 2 回目（#117。Mock: RSP / PII API / 名簿）', () => {
  describe('1. 引継ぎの検索は候補が複数なら確定しない', () => {
    const lookup = (ref: string, owner?: string) =>
      call(
        ASSIGNEE,
        'GET',
        `/api/folder-access/handovers/lookup?ref=${encodeURIComponent(ref)}${
          owner ? `&owner=${encodeURIComponent(owner)}` : ''
        }`,
      );

    async function twoOwnersSameCase() {
      sequence += 1;
      const caseId = `${CASE_PREFIX}SAME-${Date.now()}-${sequence}`;
      const a = await makeHandover(ASSIGNEE, OWNER);
      const b = await makeHandover(ASSIGNEE, OTHER_OWNER);
      await sql`UPDATE case_handovers SET case_id = ${caseId} WHERE id IN (${a}, ${b})`;
      return { caseId, a, b };
    }

    it('別の相談者の同じ案件 ID があれば 409 AMBIGUOUS で ID を返さない', async () => {
      const { caseId, a, b } = await twoOwnersSameCase();
      const response = await lookup(caseId);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('AMBIGUOUS');
      expect(response.body).not.toContain(a);
      expect(response.body).not.toContain(b);
    });

    it('画面が所有者を持つ場合だけ 1 件に絞る', async () => {
      const { caseId, a, b } = await twoOwnersSameCase();
      expect((await lookup(caseId, OWNER)).json()).toEqual({ ok: true, handoverId: a });
      expect((await lookup(caseId, OTHER_OWNER)).json()).toEqual({ ok: true, handoverId: b });
      expect((await lookup(caseId, 'nobody@example.com')).json().handoverId).toBeNull();
    });

    it('同じ相談者の同じ案件 ID が複数でも推測しない', async () => {
      sequence += 1;
      const caseId = `${CASE_PREFIX}SAME-${Date.now()}-${sequence}`;
      const a = await makeHandover(ASSIGNEE, OWNER);
      const b = await makeHandover(ASSIGNEE, OWNER);
      // 進行中の重複は DB で拒否されるので、解決済みと進行中の組で確かめる。
      await sql`UPDATE case_handovers SET status = 'resolved' WHERE id = ${a}`;
      await sql`UPDATE case_handovers SET case_id = ${caseId} WHERE id IN (${a}, ${b})`;
      expect((await lookup(caseId, OWNER)).statusCode).toBe(409);
    });

    it('1 件なら所有者なしでも引ける', async () => {
      const id = await makeHandover();
      const rows = await sql<{ case_id: string }[]>`
        SELECT case_id FROM case_handovers WHERE id = ${id}
      `;
      expect((await lookup(rows[0]?.case_id ?? '')).json()).toEqual({ ok: true, handoverId: id });
    });
  });

  describe('2. 再投入の予約は結果の参照を失わない', () => {
    it('投入中も前の結果の参照を残し、他の確認を止める', async () => {
      world.probe = { status: 'running', output: null, error_code: null };
      const { id } = await pairedRequest();
      const before = await sql<{ rsp_probe_log_id: string }[]>`
        SELECT rsp_probe_log_id FROM folder_access_requests WHERE id = ${id}
      `;
      world.probe = { status: 'failed', output: '[AGENT_BUSY]', error_code: 'AGENT_BUSY' };
      await sql`UPDATE folder_access_requests SET rsp_probe_checked_at = NULL WHERE id = ${id}`;
      let during: string | null | undefined;
      let readsDuring = 0;
      world.onEnqueue = async () => {
        const rows = await sql<{ rsp_probe_log_id: string | null }[]>`
          SELECT rsp_probe_log_id FROM folder_access_requests WHERE id = ${id}
        `;
        during = rows[0]?.rsp_probe_log_id;
        const reads = world.probeReads;
        await call(ASSIGNEE, 'GET', base(id));
        readsDuring = world.probeReads - reads;
      };
      await call(ASSIGNEE, 'GET', base(id));
      world.onEnqueue = undefined;
      expect(during).toBe(before[0]?.rsp_probe_log_id);
      expect(readsDuring).toBe(0);
    });

    it('投入の途中で落ちても（予約の期限切れ）確認を再開できる', async () => {
      world.probe = { status: 'running', output: null, error_code: null };
      const { id } = await pairedRequest();
      const commands = world.commands.length;
      // 落ちた直後の状態: 回数だけ増え、参照は前のまま、予約の時刻が未来。
      await sql`
        UPDATE folder_access_requests
        SET rsp_probe_attempts = 2, rsp_probe_checked_at = now() + interval '1 minute'
        WHERE id = ${id}
      `;
      world.probe = { status: 'failed', output: '[AGENT_BUSY]', error_code: 'AGENT_BUSY' };
      await call(ASSIGNEE, 'GET', base(id));
      expect(world.commands.length).toBe(commands);

      await sql`
        UPDATE folder_access_requests SET rsp_probe_checked_at = now() - interval '1 minute'
        WHERE id = ${id}
      `;
      await call(ASSIGNEE, 'GET', base(id));
      expect(world.commands.length).toBe(commands + 1);
    });
  });

  describe('3. 終了の応答は DB の値を返す', () => {
    it.each([
      ['/end', ASSIGNEE, '/end'],
      ['/revoke', OWNER, '/revoke'],
    ])('%s の応答に消した値を出さず、endedAt を返す', async (_name, email, path) => {
      const { id } = await activeRequest();
      const response = await call(email, 'POST', base(id, path), {});
      expect(response.statusCode, response.body).toBe(200);
      const request = response.json().request;
      expect(request.windowsUser).toBeNull();
      expect(request.device.helperHostname).toBeNull();
      expect(request.endedAt).not.toBeNull();
      expect(request.scope).toBeNull();
    });

    it('期限切れを反映した状態確認の応答にも消した値を出さない', async () => {
      const { id } = await activeRequest();
      await sql`
        UPDATE folder_access_requests SET consent_expires_at = now() - interval '1 second'
        WHERE id = ${id}
      `;
      const response = await call(ASSIGNEE, 'GET', base(id));
      const request = response.json().request;
      expect(request.status).toBe('expired');
      expect(request.windowsUser).toBeNull();
      expect(request.device.helperHostname).toBeNull();
      expect(request.endedAt).not.toBeNull();
    });
  });

  describe('5. 同意前は Windows ユーザーと端末名を担当者に見せない', () => {
    it('consent_pending までは返さず、active で返す。本人には見せる', async () => {
      const { id } = await pairedRequest();
      const before = (await call(ASSIGNEE, 'GET', base(id))).json().request;
      expect(before.status).toBe('consent_pending');
      expect(before.windowsUser).toBeNull();
      expect(before.device.helperHostname).toBeNull();
      const mine = (await call(OWNER, 'GET', '/api/folder-access/mine')).json().requests;
      const own = mine.find((item: { id: string }) => item.id === id);
      expect(own.windowsUser).toBe(USER);
      expect(own.device.helperHostname).toBe(HOST);

      await call(OWNER, 'POST', base(id, '/consent'), CONSENT);
      const after = (await call(ASSIGNEE, 'GET', base(id))).json().request;
      expect(after.status).toBe('active');
      expect(after.windowsUser).toBe(USER);
      expect(after.device.helperHostname).toBe(HOST);
    });
  });

  describe('6. 完了時刻が比較できない結果は古い扱いにする', () => {
    it.each([
      ['タイムゾーンなし', '2026-10-31T00:00:00'],
      ['解釈不能', 'invalid+00:00'],
      ['なし', null],
    ])('%s の結果では進めず、取り直す', async (_name, completedAt) => {
      world.probe = {
        status: 'completed',
        output: probeOutput(),
        error_code: null,
        completed_at: completedAt as string,
      };
      const { id, pair } = await pairedRequest();
      expect(pair.status).toBe('helper_pending');
      expect(world.commands).toHaveLength(2);
      expect((await requestRow(id))?.status).toBe('helper_pending');
    });
  });

  describe('7. 対にならないサロゲート', () => {
    it('同意のサブフォルダは 400 で拒否する（500 にしない）', async () => {
      const { id } = await pairedRequest();
      const response = await app.inject({
        method: 'POST',
        url: base(id, '/consent'),
        headers: {
          'cf-access-authenticated-user-email': OWNER,
          'content-type': 'application/json',
        },
        payload: '{"root":"Documents","segments":["a\\ud83d"],"ttlMinutes":10}',
      });
      expect(response.statusCode, response.body).toBe(400);
    });

    it('結果の名前に含まれていても保存で失敗しない', async () => {
      const { helper, op } = await deliveredOp();
      const response = await postResult(
        helper.helperToken,
        op.opId,
        resultBody([{ name: 'a\ud83db.txt', type: 'file', size: 1 }]),
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().count).toBe(1);
    });

    it('ヘルパーの登録情報に含まれていても失敗しない', async () => {
      const request = await createRequest(await makeHandover());
      const response = await app.inject({
        method: 'POST',
        url: '/api/device/agent/folder-helper/register',
        payload: registerPayload({
          enrollCode: await issueEnrollCode(request.id),
          hostname: 'HOST\ud83d',
          userName: 'user\ud83d',
        }),
      });
      expect(response.statusCode, response.body).toBe(200);
    });
  });

  it('10. 使わないコードを残さない', async () => {
    const state = await import('./state.js');
    expect(state).not.toHaveProperty('canTransition');
    const { id } = await pairedRequest();
    const row = await sql.begin((tx) => loadContext(tx, id));
    expect(row).not.toHaveProperty('probe_check_due');
  });
});
