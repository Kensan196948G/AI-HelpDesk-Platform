import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAllowlistCache } from '../auth/allowlist.js';
import { clearUiRoleCache } from '../auth/ui.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { resetAddressLimits } from '../folder-access/address-limit.js';
import { sweepFolderAccess } from '../folder-access/service.js';
import { hashSid } from '../folder-access/sign.js';
import { resetRateLimits } from '../lib/rate-limit.js';
import { computeSkillDefinitionHash } from '../resolve/skills.js';
import { buildServer } from '../server.js';
import { SKILL_RUN_CAPABILITY, signSkillRun } from './contract.js';
import { ASSIST_SKILLS, proposableSkills } from './skills.js';
import { ASSIST_LIMITS, OPEN_SESSION_STATUSES } from './state.js';
import { sweepSupportSessions } from './sweep.js';

/**
 * 共通支援セッションの統合テスト（docs/63）。API + 実 PostgreSQL テスト DB。
 * Mock: 社員名簿、RSP、Mirai-Info PII API、DeepSeek（fetch を URL で振り分ける）、
 *       ヘルパー（HTTP を直接呼ぶ。実端末・実スクリプトは動かない）、
 *       Skill の承認（合成 manifest と合成スクリプト。approved.json を読み書きしない）。
 * mock の結果で「実機で動いた」とは言えない。実機の確認は Windows 担当と責任者が行う。
 */

const directory = vi.hoisted(() => ({ byEmail: new Map<string, Record<string, unknown>>() }));
const synth = vi.hoisted(() => ({
  manifestLoads: 0,
  entries: [] as Record<string, string>[],
  scripts: new Map<string, string>(),
  throwOnRead: false,
}));

vi.mock('../lib/mirai-info.js', () => ({
  findEmployeeByEmail: async (email: string) =>
    directory.byEmail.get(String(email || '').toLowerCase()) ?? null,
  findEmployeeEmailByNo: async () => null,
  listEmployees: async () => ({ employees: [], total: 0, cachedAt: new Date().toISOString() }),
  filterStaff: (rows: Record<string, unknown>[]) => rows,
}));

vi.mock('./skill-source.js', () => ({
  loadApprovalManifest: () => {
    synth.manifestLoads += 1;
    return { version: 1, skills: synth.entries };
  },
  readSkillScriptHash: (scriptPath: string) => {
    if (synth.throwOnRead) throw new Error('synthetic read failure');
    const content = synth.scripts.get(scriptPath);
    return content === undefined
      ? null
      : `sha256:${createHash('sha256').update(content).digest('hex')}`;
  },
}));

const OWNER = 'ss-owner@example.com';
const OTHER_OWNER = 'ss-other-owner@example.com';
const ASSIGNEE = 'ss-assignee@example.com';
const OTHER_ASSIGNEE = 'ss-other-assignee@example.com';
const APPROVER_ONLY = 'ss-approver-only@example.com';
const CASE_PREFIX = 'CASE-SS-';
const HOST = 'SYNTH-SS-PC-CANARY';
const RSP_DEVICE = '44444444-4444-4444-8444-444444444444';
const MACHINE = 'cccccccc-1111-4111-8111-cccccccccccc';
const OTHER_MACHINE = 'dddddddd-1111-4111-8111-dddddddddddd';
const SID = 'S-1-5-21-2000000001-2000000002-2000000003-1204';
const OTHER_SID = 'S-1-5-21-2000000001-2000000002-2000000003-1205';
const USER = 'CORP\\canary-user';
const SESSION = 2;
const CANARY_SEGMENT = 'CANARY-個人フォルダ';
const CANARY_SUBJECT = 'CANARY-相談本文-給与 保存先のフォルダが見つからない 容量も不足';
const LEASE_URL = 'https://lease.test.invalid/api/device-staff';
const RSP_URL = 'https://rsp.test.invalid';
const AI_URL = 'https://ai.test.invalid';

const originals = {
  folder: config.FOLDER_ACCESS_ENABLED,
  assist: config.ASSIST_SESSION_ENABLED,
  assistMode: config.ASSIST_SESSION_MODE,
  mock: config.ASSIST_ALLOW_MOCK_EXECUTION,
  isProduction: config.isProduction,
  leaseUrl: config.LEASE_API_URL,
  leaseId: config.LEASE_API_TOKEN_ID,
  leaseSecret: config.LEASE_API_TOKEN_SECRET,
  rspKey: config.RSP_SERVICE_KEY,
  rspBase: config.RSP_BASE_URL,
  authMode: config.AUTH_MODE,
  allowlist: config.ACCESS_ALLOWLIST_FILE,
  jwt: config.ACCESS_JWT_MODE,
  persona: config.PERSONA_SWITCH_ALLOWLIST,
  aiKey: config.DEEPSEEK_API_KEY,
  aiBase: config.DEEPSEEK_BASE_URL,
};
const allowDir = mkdtempSync(path.join(tmpdir(), 'aihd-support-session-'));

interface World {
  commands: Record<string, unknown>[];
  aiBodies: string[];
  aiReply: unknown;
  onAi?: () => Promise<void>;
  unexpected: string[];
}
let world: World;
let app: FastifyInstance;
let sequence = 0;

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function fakeFetch(input: unknown, init?: RequestInit) {
  const url = String(input);
  if (url.startsWith(LEASE_URL)) {
    const now = new Date().toISOString();
    return jsonResponse(200, {
      ok: true,
      source: 'device_staff_view',
      pii: true,
      generatedAt: now,
      filter: { employee_no: 'E500' },
      dataAsOf: { employeeDirectoryLastSeenAt: now },
      records: [
        {
          asset_tag: 'A-1',
          hostname: HOST,
          employee_no: 'E500',
          employee_active: true,
          lease_active: true,
        },
      ],
    });
  }
  if (url.startsWith(`${RSP_URL}/api/v1/service/devices`)) {
    return jsonResponse(200, {
      success: true,
      data: {
        count: 1,
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
      },
    });
  }
  if (url === `${RSP_URL}/api/v1/service/commands` && init?.method === 'POST') {
    world.commands.push(JSON.parse(String(init.body)));
    return jsonResponse(201, {
      log_id: `log-${world.commands.length}`,
      device_id: RSP_DEVICE,
      status: 'queued',
      risk_level: 'safe',
    });
  }
  if (url.startsWith(`${RSP_URL}/api/v1/service/commands/`)) {
    return jsonResponse(200, {
      log_id: 'x',
      exit_code: null,
      status: 'completed',
      error_code: null,
      completed_at: new Date(Date.now() + 60_000).toISOString(),
      output: JSON.stringify({
        machineGuid: MACHINE,
        quser: [
          ' USERNAME   SESSIONNAME  ID  STATE   IDLE TIME  LOGON TIME',
          `>canary-user console       ${SESSION}  Active  none       10/31/2026 9:00 AM`,
        ],
      }),
    });
  }
  if (url === `${AI_URL}/chat/completions`) {
    world.aiBodies.push(String(init?.body));
    if (world.onAi) await world.onAi();
    return jsonResponse(200, {
      choices: [{ message: { content: JSON.stringify(world.aiReply) } }],
    });
  }
  world.unexpected.push(url);
  throw new Error(`unexpected fetch: ${url}`);
}

/** 承認者が一覧で確認した本文の指紋（画面の ahReviewedHash と同じ値。#127 の束縛）。 */
async function reviewedHash(clientRef: string): Promise<string> {
  const list = await call(APPROVER_ONLY, 'GET', '/api/knowledge/pending');
  expect(list.statusCode, list.body).toBe(200);
  const items = list.json().items as { clientRef: string; contentHash: string }[];
  const item = items.find((entry) => entry.clientRef === clientRef);
  if (!item) throw new Error(`一覧にない: ${clientRef}`);
  return item.contentHash;
}

function call(
  email: string | null,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
) {
  clearUiRoleCache();
  return app.inject({
    method,
    url,
    headers: email ? { 'cf-access-authenticated-user-email': email } : {},
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

const beat = {
  sid: SID,
  sessionId: SESSION,
  sessionState: 'active',
  capabilities: [SKILL_RUN_CAPABILITY],
};
const poll = async (token: string, body: Record<string, unknown> = beat) => {
  const response = await helperCall(token, 'poll', body);
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as {
    ops: Record<string, unknown>[];
    skillOps?: Op[];
    cancel: string[];
    revoked: boolean;
  };
};

interface Op {
  opId: string;
  skillId: string;
  skillVersion: string;
  scriptHash: string;
  startNonce: string;
  role: string;
  sig: string;
  [key: string]: unknown;
}

const startBody = (op: Op, overrides: Record<string, unknown> = {}) => ({
  actorSid: SID,
  sessionId: SESSION,
  machineGuid: MACHINE,
  startNonce: op.startNonce,
  scriptHash: op.scriptHash,
  ...overrides,
});

const start = (token: string, op: Op, overrides: Record<string, unknown> = {}) =>
  helperCall(token, `ops/${op.opId}/start`, startBody(op, overrides));

function resultBody(op: Op, output: Record<string, unknown> | null, overrides = {}) {
  return {
    executionMode: 'real',
    actorSid: SID,
    sessionId: SESSION,
    skillId: op.skillId,
    skillVersion: op.skillVersion,
    scriptHash: op.scriptHash,
    status: 'ok',
    resultCode: 'OK',
    exitCode: 0,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: 10,
    output,
    ...overrides,
  };
}

const report = (token: string, op: Op, body: Record<string, unknown>) =>
  helperCall(token, `ops/${op.opId}/skill-result`, body);

const FOLDER_OUTPUT = {
  accessible: true,
  fileCount: 3,
  directoryCount: 1,
  linkCount: 0,
  totalBytes: 2048,
  truncated: false,
};

function setManifest(skillIds?: string[]) {
  synth.entries = [];
  synth.scripts = new Map();
  for (const skill of ASSIST_SKILLS) {
    const { definition } = skill;
    if (skillIds && !skillIds.includes(definition.id)) continue;
    const content = `# 合成スクリプト ${definition.id}`;
    const scriptHash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    synth.scripts.set(definition.scriptPath, content);
    synth.entries.push({
      id: definition.id,
      version: definition.version,
      scriptHash,
      contentHash: computeSkillDefinitionHash(definition, scriptHash),
      approvedBy: 'synthetic-review@example.com',
      approvedAt: '2026-10-31T00:00:00.000Z',
    });
  }
}

const ALL_BUT_DISK = [
  'folder.summary',
  'user.marker.set',
  'user.marker.clear',
  'user.marker.status',
];

async function makeHandover(): Promise<string> {
  sequence += 1;
  const caseId = `${CASE_PREFIX}${Date.now()}-${sequence}`;
  const snapshot = {
    caseId,
    case: { id: caseId, subject: CANARY_SUBJECT, userId: 'u1' },
    chat: { id: caseId, messages: [{ kind: 'user', text: CANARY_SUBJECT }] },
    ticket: { id: `TKT-${sequence}` },
  };
  const rows = await sql<{ id: string }[]>`
    INSERT INTO case_handovers (case_id, owner_email, status, snapshot, claimed_by, claimed_at)
    VALUES (${caseId}, ${OWNER}, 'claimed', ${sql.json(snapshot)}, ${ASSIGNEE}, ${new Date()})
    RETURNING id
  `;
  return rows[0]?.id ?? '';
}

const folderBase = (id: string, suffix = '') => `/api/folder-access/requests/${id}${suffix}`;
const base = (id: string, suffix = '') => `/api/support-sessions/${id}${suffix}`;

/** フォルダ同意が active になるところまで（Mock の RSP / PII / 名簿）。 */
async function activeFolderRequest(existingHandoverId?: string) {
  const handoverId = existingHandoverId ?? (await makeHandover());
  const created = await call(ASSIGNEE, 'POST', '/api/folder-access/requests', { handoverId });
  expect(created.statusCode, created.body).toBe(200);
  const requestId = created.json().request.id as string;
  const enrolled = await call(OWNER, 'POST', folderBase(requestId, '/enroll-code'), {});
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  const registered = await app.inject({
    method: 'POST',
    url: '/api/device/agent/folder-helper/register',
    payload: {
      enrollCode: enrolled.json().enrollCode,
      machineGuid: MACHINE,
      sid: SID,
      userName: USER,
      sessionId: SESSION,
      sessionState: 'active',
      hostname: HOST,
      helperVersion: '0.2.0',
    },
  });
  expect(registered.statusCode, registered.body).toBe(200);
  const helper = registered.json() as {
    helperId: string;
    helperToken: string;
    pairingCode: string;
  };
  const paired = await call(OWNER, 'POST', folderBase(requestId, '/pair'), {
    code: helper.pairingCode,
  });
  expect(paired.statusCode, paired.body).toBe(200);
  const consent = await call(OWNER, 'POST', folderBase(requestId, '/consent'), {
    root: 'Documents',
    segments: [CANARY_SEGMENT],
    ttlMinutes: 60,
  });
  expect(consent.statusCode, consent.body).toBe(200);
  expect(consent.json().request.status).toBe('active');
  return { handoverId, requestId, token: helper.helperToken, helperId: helper.helperId };
}

async function startSession() {
  const folder = await activeFolderRequest();
  const created = await call(ASSIGNEE, 'POST', '/api/support-sessions', {
    handoverId: folder.handoverId,
  });
  expect(created.statusCode, created.body).toBe(200);
  expect(created.json().session.status).toBe('consent_pending');
  return { ...folder, id: created.json().session.id as string };
}

async function readySession(scope: 'read_only' | 'user_reversible' = 'user_reversible') {
  const session = await startSession();
  const consent = await call(OWNER, 'POST', base(session.id, '/consents/operation'), {
    scope,
    version: 'operation-consent/1',
    ttlMinutes: 30,
  });
  expect(consent.statusCode, consent.body).toBe(200);
  expect(consent.json().session.status).toBe('ready');
  return session;
}

/** 提案が出ずに終わった理由の監査（固定語彙のみ）。 */
async function noProposalDetail(id: string) {
  const rows = await sql<{ detail: Record<string, unknown> }[]>`
    SELECT detail FROM audit_log
    WHERE action = 'support_session.no_proposal' AND target_id = ${id}
  `;
  expect(rows).toHaveLength(1);
  return rows[0]?.detail;
}

async function propose(id: string, as = ASSIGNEE) {
  const response = await call(as, 'POST', base(id, '/proposals'), {});
  expect(response.statusCode, response.body).toBe(200);
  const session = response.json().session;
  return { session, proposal: session.proposals.at(-1) };
}

const decide = (id: string, proposalId: string, body: Record<string, unknown>, as = OWNER) =>
  call(as, 'POST', base(id, `/proposals/${proposalId}/decision`), body);

async function approveFirst(session: { id: string }) {
  const { proposal } = await propose(session.id);
  const response = await decide(session.id, proposal.id, {
    decision: 'Y',
    approvalHash: proposal.approvalHash,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().session.status).toBe('approved');
  return proposal;
}

/** 提案 → Y → 配送 → 開始（実行中まで）。 */
async function executing(session: { id: string; token: string }) {
  const proposal = await approveFirst(session);
  const polled = await poll(session.token);
  const op = polled.skillOps?.[0];
  if (!op) throw new Error('op が配送されていません');
  const started = await start(session.token, op);
  expect(started.statusCode, started.body).toBe(200);
  expect(started.json().started).toBe(true);
  return { proposal, op };
}

async function sessionRow(id: string) {
  const rows = await sql<
    { status: string; end_reason: string | null; proposal_count: number }[]
  >`SELECT status, end_reason, proposal_count FROM support_sessions WHERE id = ${id}`;
  return rows[0];
}

async function executionRows(id: string) {
  return sql<Record<string, any>[]>`
    SELECT * FROM assist_executions WHERE support_session_id = ${id} ORDER BY created_at
  `;
}

async function helperRevoked(helperId: string): Promise<boolean> {
  const rows = await sql<{ revoked: boolean }[]>`
    SELECT (revoked_at IS NOT NULL) AS revoked FROM folder_access_helpers WHERE id = ${helperId}
  `;
  return rows[0]?.revoked === true;
}

async function deviceCommandCount(): Promise<number> {
  const rows = await sql<{ count: string }[]>`SELECT count(*) AS count FROM device_commands`;
  return Number(rows[0]?.count);
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
  directory.byEmail.set(OWNER, { employeeNo: 'E500', name: '相談者', section: '営業部' });
  directory.byEmail.set(OTHER_OWNER, { employeeNo: 'E501', name: '別の人', section: '営業部' });
  directory.byEmail.set(ASSIGNEE, { employeeNo: 'E600', name: '担当', section: 'DX推進部' });
  directory.byEmail.set(OTHER_ASSIGNEE, {
    employeeNo: 'E601',
    name: '別担当',
    section: 'DX推進部',
  });
  directory.byEmail.set(APPROVER_ONLY, { employeeNo: 'E700', name: '承認', section: '技術部' });
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
  world = { commands: [], aiBodies: [], aiReply: {}, unexpected: [] };
  synth.throwOnRead = false;
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  config.FOLDER_ACCESS_ENABLED = true;
  config.ASSIST_SESSION_ENABLED = true;
  config.ASSIST_SESSION_MODE = undefined;
  config.ASSIST_ALLOW_MOCK_EXECUTION = false;
  config.isProduction = false;
  config.DEEPSEEK_API_KEY = undefined;
  config.DEEPSEEK_BASE_URL = AI_URL;
  config.LEASE_API_URL = LEASE_URL;
  config.LEASE_API_TOKEN_ID = 'synth-client-id';
  config.LEASE_API_TOKEN_SECRET = 'synth-client-secret';
  setManifest();
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  vi.unstubAllGlobals();
});

afterAll(async () => {
  config.FOLDER_ACCESS_ENABLED = originals.folder;
  config.ASSIST_SESSION_ENABLED = originals.assist;
  config.ASSIST_SESSION_MODE = originals.assistMode;
  config.ASSIST_ALLOW_MOCK_EXECUTION = originals.mock;
  config.isProduction = originals.isProduction;
  config.LEASE_API_URL = originals.leaseUrl;
  config.LEASE_API_TOKEN_ID = originals.leaseId;
  config.LEASE_API_TOKEN_SECRET = originals.leaseSecret;
  config.RSP_SERVICE_KEY = originals.rspKey;
  config.RSP_BASE_URL = originals.rspBase;
  config.AUTH_MODE = originals.authMode;
  config.ACCESS_ALLOWLIST_FILE = originals.allowlist;
  config.ACCESS_JWT_MODE = originals.jwt;
  config.PERSONA_SWITCH_ALLOWLIST = originals.persona;
  config.DEEPSEEK_API_KEY = originals.aiKey;
  config.DEEPSEEK_BASE_URL = originals.aiBase;
  resetAllowlistCache();
  await sql`DELETE FROM case_handovers WHERE case_id LIKE ${`${CASE_PREFIX}%`}`;
  await sql`DELETE FROM folder_access_helpers WHERE machine_guid IN (${MACHINE}, ${OTHER_MACHINE})`;
  await app.close();
  rmSync(allowDir, { recursive: true, force: true });
});

describe('共通支援セッション（Mock: ヘルパー / RSP / 名簿 / PII API / DeepSeek / 合成 Skill）', () => {
  describe('正常系', () => {
    it('読取 → 変更の 2 提案を通し、確認操作は枠を消費せず、本人の解決確認で終わる', async () => {
      setManifest(ALL_BUT_DISK);
      const before = await deviceCommandCount();
      const commandsBefore = 0;
      const session = await readySession();

      // 提案 1: 読取
      const first = await propose(session.id);
      expect(first.session.status).toBe('awaiting_approval');
      expect(first.proposal.skillId).toBe('folder.summary');
      expect(first.proposal.effect).toBe('read');
      expect(first.proposal.proposalSource).toBe('rule');
      expect(first.proposal.target).toBe('T1');
      expect(JSON.stringify(first.session)).not.toContain(SID);
      const y1 = await decide(session.id, first.proposal.id, {
        decision: 'Y',
        approvalHash: first.proposal.approvalHash,
      });
      expect(y1.json().session.status).toBe('approved');

      const polled = await poll(session.token);
      const op = polled.skillOps?.[0] as Op;
      expect(op.role).toBe('main');
      expect(op.targetRoot).toBe('Documents');
      expect(op.targetSegments).toEqual([CANARY_SEGMENT]);
      expect(op.paramsJson).toBe('{"target":"T1"}');
      const { sig, ...signable } = op;
      expect(signSkillRun(session.token, signable as never)).toBe(sig);
      expect(polled.ops).toEqual([]);

      const started = await start(session.token, op);
      expect(started.json()).toMatchObject({ ok: true, started: true, opId: op.opId });
      expect((await sessionRow(session.id))?.status).toBe('executing');

      const finished = await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      expect(finished.json()).toEqual({ ok: true, accepted: true });
      expect((await sessionRow(session.id))?.status).toBe('awaiting_next');

      // 提案 2: 変更（承認時に提示した確認操作つき）
      const second = await propose(session.id);
      expect(second.proposal.skillId).toBe('user.marker.set');
      expect(second.proposal.effect).toBe('modify');
      expect(second.proposal.verifyOps.map((item: { skillId: string }) => item.skillId)).toEqual([
        'user.marker.status',
      ]);
      await decide(session.id, second.proposal.id, {
        decision: 'Y',
        approvalHash: second.proposal.approvalHash,
      });
      const op2 = (await poll(session.token)).skillOps?.[0] as Op;
      expect(op2.targetRoot).toBeNull();
      expect((await start(session.token, op2)).statusCode).toBe(200);
      await report(
        session.token,
        op2,
        resultBody(op2, { applied: true, previousPresent: false, previousValue: null }),
      );
      expect((await sessionRow(session.id))?.status).toBe('verifying');

      const verifyOp = (await poll(session.token)).skillOps?.[0] as Op;
      expect(verifyOp.role).toBe('verify');
      expect(verifyOp.skillId).toBe('user.marker.status');
      expect((await start(session.token, verifyOp)).statusCode).toBe(200);
      await report(
        session.token,
        verifyOp,
        resultBody(verifyOp, { present: true, value: 'VERIFY_A' }),
      );

      const row = await sessionRow(session.id);
      expect(row?.status).toBe('resolve_confirm');
      expect(row?.proposal_count).toBe(2);

      const executions = await executionRows(session.id);
      expect(executions.map((item) => item.role)).toEqual(['main', 'main', 'verify']);
      for (const item of executions) {
        expect(item.execution_mode).toBe('real');
        expect(item.result_source).toBe('helper_token');
        expect(item.evidence).toBe(true);
        expect(item.verify_ok).toBe(true);
      }
      expect(executions.map((item) => item.result_code)).toEqual([
        'FOLDER_SUMMARY_OK',
        'MARKER_SET',
        'MARKER_STATUS_OK',
      ]);

      // AI や担当者では解決にできない。
      const byAssignee = await call(ASSIGNEE, 'POST', base(session.id, '/resolution'), {
        resolved: true,
      });
      expect(byAssignee.statusCode).toBe(403);
      const resolved = await call(OWNER, 'POST', base(session.id, '/resolution'), {
        resolved: true,
      });
      expect(resolved.json().session.status).toBe('resolved');
      expect(await helperRevoked(session.helperId)).toBe(true);

      // device_commands / RSP へ配送していない（§6）。
      expect(await deviceCommandCount()).toBe(before);
      expect(world.commands.length - commandsBefore).toBe(1); // 依頼の確定時の固定テンプレートだけ
    });

    it('解決でないと答えれば次の提案へ戻る', async () => {
      setManifest(ALL_BUT_DISK);
      const session = await readySession();
      const { op } = await executing(session);
      await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      const no = await call(OWNER, 'POST', base(session.id, '/resolution'), { resolved: false });
      expect(no.json().session.status).toBe('awaiting_next');
    });

    it('本人の画面で同意しなければ提案できない（フォルダ同意から導出しない）', async () => {
      const session = await startSession();
      const response = await call(ASSIGNEE, 'POST', base(session.id, '/proposals'), {});
      expect(response.statusCode).toBe(409);
      const byAssignee = await call(ASSIGNEE, 'POST', base(session.id, '/consents/operation'), {
        scope: 'read_only',
        version: 'operation-consent/1',
        ttlMinutes: 10,
      });
      expect(byAssignee.statusCode).toBe(403);
    });

    it('active でない依頼には開始できず、同じ案件の 2 回目は同じセッションを返す', async () => {
      const handoverId = await makeHandover();
      const none = await call(ASSIGNEE, 'POST', '/api/support-sessions', { handoverId });
      expect(none.statusCode).toBe(409);
      expect(none.json().error.code).toBe('FOLDER_REQUEST_NOT_ACTIVE');

      const session = await startSession();
      const again = await call(ASSIGNEE, 'POST', '/api/support-sessions', {
        handoverId: session.handoverId,
      });
      expect(again.json().session.id).toBe(session.id);
    });
  });

  describe('N は副作用なし', () => {
    it('N で stopped になり、実行が 1 件も作られず、配送されない', async () => {
      const session = await readySession();
      const { proposal } = await propose(session.id);
      const response = await decide(session.id, proposal.id, { decision: 'N' });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().session.status).toBe('stopped');
      expect(response.json().session.endReason).toBe('requester_declined');
      expect(await executionRows(session.id)).toEqual([]);
      const polled = await poll(session.token);
      expect(polled.revoked).toBe(true);
      expect(polled.skillOps ?? []).toEqual([]);
      expect(await helperRevoked(session.helperId)).toBe(true);
    });
  });

  describe('他人 / 別端末 / 別 SID / 別セッション', () => {
    it('本人以外は Y/N できない。承認者のみのアカウントは参照もできない', async () => {
      const session = await readySession();
      const { proposal } = await propose(session.id);
      const y = { decision: 'Y', approvalHash: proposal.approvalHash };
      for (const email of [OTHER_OWNER, ASSIGNEE, APPROVER_ONLY]) {
        const response = await decide(session.id, proposal.id, y, email);
        expect(response.statusCode, email).toBe(403);
      }
      const view = await call(APPROVER_ONLY, 'GET', base(session.id));
      expect(view.statusCode).toBe(403);
      const other = await call(OTHER_OWNER, 'GET', base(session.id));
      expect(other.statusCode).toBe(403);
      const stop = await call(OTHER_ASSIGNEE, 'POST', base(session.id, '/stop'), {});
      expect(stop.statusCode).toBe(403);
      const revoke = await call(OTHER_OWNER, 'POST', base(session.id, '/revoke'), {});
      expect(revoke.statusCode).toBe(403);
      expect((await sessionRow(session.id))?.status).toBe('awaiting_approval');
    });

    it('担当者以外はセッションを開始できない', async () => {
      const folder = await activeFolderRequest();
      for (const email of [OTHER_ASSIGNEE, OWNER, APPROVER_ONLY]) {
        const response = await call(email, 'POST', '/api/support-sessions', {
          handoverId: folder.handoverId,
        });
        expect(response.statusCode, email).toBe(403);
      }
    });

    it('別のヘルパーのトークンでは開始も報告もできない', async () => {
      const session = await readySession();
      await approveFirst(session);
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      // 別の依頼の導入コードで登録した、別の端末のヘルパー。
      const otherHandover = await makeHandover();
      const otherRequest = await call(ASSIGNEE, 'POST', '/api/folder-access/requests', {
        handoverId: otherHandover,
      });
      const otherEnroll = await call(
        OWNER,
        'POST',
        folderBase(otherRequest.json().request.id, '/enroll-code'),
        {},
      );
      const registered = await app.inject({
        method: 'POST',
        url: '/api/device/agent/folder-helper/register',
        payload: {
          enrollCode: otherEnroll.json().enrollCode,
          machineGuid: OTHER_MACHINE,
          sid: OTHER_SID,
          userName: 'other',
          sessionId: SESSION,
          sessionState: 'active',
          hostname: 'OTHER-HOST',
          helperVersion: '0.2.0',
        },
      });
      const otherToken = registered.json().helperToken as string;
      expect((await start(otherToken, op)).statusCode).toBe(404);
      expect((await report(otherToken, op, resultBody(op, FOLDER_OUTPUT))).statusCode).toBe(404);
      expect((await poll(otherToken)).skillOps ?? []).toEqual([]);
      expect((await sessionRow(session.id))?.status).toBe('approved');
    });

    it.each([
      ['別 SID', { actorSid: OTHER_SID }, 'SID_MISMATCH', 'sid_mismatch'],
      ['別セッション', { sessionId: 7 }, 'SESSION_MISMATCH', 'session_changed'],
      ['別端末', { machineGuid: OTHER_MACHINE }, 'DEVICE_MISMATCH', 'device_mismatch'],
    ])('/start に %s を申告すると拒否して終了する', async (_name, overrides, reason, endReason) => {
      const session = await readySession();
      await approveFirst(session);
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      const response = await start(session.token, op, overrides);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ ok: false, started: false, reason });
      const row = await sessionRow(session.id);
      expect(row?.end_reason).toBe(endReason);
      expect(row?.status).toBe('revoked');
      expect((await executionRows(session.id))[0]?.status).toBe('rejected_at_start');
      expect(await helperRevoked(session.helperId)).toBe(true);
    });

    it('heartbeat の SID・セッションが変わると終了し、キューを取り消す', async () => {
      const session = await readySession();
      await approveFirst(session);
      const polled = await poll(session.token, { ...beat, sid: OTHER_SID });
      expect(polled.revoked).toBe(true);
      expect(polled.skillOps ?? []).toEqual([]);
      const row = await sessionRow(session.id);
      expect(row?.status).toBe('revoked');
      expect(row?.end_reason).toBe('sid_mismatch');
      expect((await executionRows(session.id))[0]?.status).toBe('cancelled');
    });

    it('結果の実行主体 SID が違えば終了し、証拠にしない', async () => {
      const session = await readySession();
      const { op } = await executing(session);
      const response = await report(
        session.token,
        op,
        resultBody(op, FOLDER_OUTPUT, { actorSid: OTHER_SID }),
      );
      expect(response.json()).toEqual({ ok: true, accepted: false, reason: 'SID_MISMATCH' });
      expect((await sessionRow(session.id))?.end_reason).toBe('sid_mismatch');
      const execution = (await executionRows(session.id))[0];
      expect(execution?.evidence).toBe(false);
      // 報告値は残すが、成功にしない。改ざんの可能性は固定コードで示す。
      expect(execution?.normalized_output).toEqual(FOLDER_OUTPUT);
      expect(execution?.actor_sid).toBe(OTHER_SID);
      expect(execution?.result_code).toBe('RESULT_MISMATCH');
      expect(execution?.verify_ok).toBeNull();
    });
  });

  describe('承認後の束縛の変更（§5）', () => {
    it('提示と違う承認ハッシュの Y は無効で、実行されない', async () => {
      const session = await readySession();
      const { proposal } = await propose(session.id);
      const response = await decide(session.id, proposal.id, {
        decision: 'Y',
        approvalHash: 'a'.repeat(64),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('APPROVAL_INVALID');
      expect(await executionRows(session.id)).toEqual([]);
      expect((await sessionRow(session.id))?.end_reason).toBe('binding_changed');
    });

    it.each([
      [
        'params の書き換え',
        async (id: string) => {
          await sql`UPDATE assist_proposals SET params = ${sql.json({ target: 'T2' })} WHERE support_session_id = ${id}`;
        },
        'APPROVAL_INVALID',
      ],
      [
        '確認操作の定義の書き換え',
        async (id: string) => {
          await sql`UPDATE assist_proposals SET verify = ${sql.json({ mainCheck: { resultField: 'x', equals: 1 }, ops: [] })} WHERE support_session_id = ${id}`;
        },
        'APPROVAL_INVALID',
      ],
      [
        '操作範囲の同意の変更',
        async (id: string) => {
          await sql`UPDATE operation_consents SET scope = 'read_only' WHERE support_session_id = ${id}`;
          await sql`UPDATE support_sessions SET operation_consent_scope = 'read_only' WHERE id = ${id}`;
        },
        'APPROVAL_INVALID',
      ],
      [
        '操作範囲の同意の取消',
        async (id: string) => {
          await sql`UPDATE operation_consents SET revoked_at = now() WHERE support_session_id = ${id}`;
        },
        'CONSENT_INVALID',
      ],
      [
        'スクリプトの差し替え',
        async () => {
          synth.scripts.set('scripts/skills/windows/folder-summary.ps1', '# 差し替え');
        },
        'SKILL_NOT_APPROVED',
      ],
      [
        '承認の取り下げ',
        async () => {
          setManifest([]);
        },
        'SKILL_NOT_APPROVED',
      ],
    ])('Y の後の %s で /start を拒否する', async (_name, mutate, reason) => {
      const session = await readySession();
      await approveFirst(session);
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      await mutate(session.id);
      const response = await start(session.token, op);
      expect(response.statusCode).toBe(409);
      expect(response.json().reason).toBe(reason);
      expect((await executionRows(session.id))[0]?.status).toBe('rejected_at_start');
      expect((await executionRows(session.id))[0]?.started_at).toBeNull();
      expect((await sessionRow(session.id))?.status).toBe('stopped');
    });

    it('Y の後にフォルダ同意の範囲が変われば無効になる', async () => {
      const session = await readySession();
      await approveFirst(session);
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      await sql`UPDATE folder_access_requests SET consent_root = 'Desktop' WHERE id = ${session.requestId}`;
      const response = await start(session.token, op);
      expect(response.json().reason).toBe('APPROVAL_INVALID');
    });

    it('Y の前に束縛が変わっていれば Y を受けない', async () => {
      const session = await readySession();
      const { proposal } = await propose(session.id);
      await sql`UPDATE assist_proposals SET params = ${sql.json({ target: 'T2' })} WHERE id = ${proposal.id}`;
      const response = await decide(session.id, proposal.id, {
        decision: 'Y',
        approvalHash: proposal.approvalHash,
      });
      expect(response.statusCode).toBe(409);
      expect(await executionRows(session.id)).toEqual([]);
    });
  });

  describe('nonce と二重配送', () => {
    it('同じ Y の再送を受けない', async () => {
      const session = await readySession();
      const proposal = await approveFirst(session);
      const replay = await decide(session.id, proposal.id, {
        decision: 'Y',
        approvalHash: proposal.approvalHash,
      });
      expect(replay.statusCode).toBe(409);
      expect((await executionRows(session.id)).length).toBe(1);
    });

    it('/start の nonce は 1 回だけ。再送しても実行が増えない', async () => {
      const session = await readySession();
      const { op } = await executing(session);
      const replay = await start(session.token, op);
      expect(replay.statusCode).toBe(409);
      expect(replay.json().reason).toBe('NONCE_CONSUMED');
      const execution = (await executionRows(session.id))[0];
      expect(execution?.status).toBe('executing');
    });

    it('nonce が違えば開始しない', async () => {
      const session = await readySession();
      await approveFirst(session);
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      const response = await start(session.token, op, { startNonce: 'x'.repeat(22) });
      expect(response.json().reason).toBe('NONCE_MISMATCH');
      expect((await executionRows(session.id))[0]?.start_nonce_consumed_at).toBeNull();
    });

    it('同じ操作を 2 回配送しない', async () => {
      const session = await readySession();
      await approveFirst(session);
      expect((await poll(session.token)).skillOps?.length).toBe(1);
      expect((await poll(session.token)).skillOps?.length).toBe(0);
    });

    it('skill_run を申告しないヘルパーには配送しない（既存ヘルパーを BAD_OP にしない）', async () => {
      const session = await readySession();
      await approveFirst(session);
      const { capabilities: _omitted, ...legacy } = beat;
      expect((await poll(session.token, legacy)).skillOps).toEqual([]);
      expect((await executionRows(session.id))[0]?.status).toBe('queued');
    });

    it('切断中のセッションには配送しない', async () => {
      const session = await readySession();
      await approveFirst(session);
      const polled = await poll(session.token, { ...beat, sessionState: 'disconnected' });
      expect(polled.skillOps).toEqual([]);
      expect((await executionRows(session.id))[0]?.status).toBe('queued');
    });

    it('二重の結果報告は最初の記録を上書きしない', async () => {
      setManifest(ALL_BUT_DISK);
      const session = await readySession();
      const { op } = await executing(session);
      await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      const second = await report(
        session.token,
        op,
        resultBody(op, { ...FOLDER_OUTPUT, fileCount: 999 }),
      );
      expect(second.json()).toEqual({ ok: true, accepted: false, reason: 'DUPLICATE' });
      expect((await executionRows(session.id))[0]?.normalized_output.fileCount).toBe(3);
    });
  });

  describe('取消の伝搬（§10）', () => {
    it('承認前の取消: 提案は無効になり、実行は作られない', async () => {
      const session = await readySession();
      const { proposal } = await propose(session.id);
      const revoked = await call(OWNER, 'POST', base(session.id, '/revoke'), {});
      expect(revoked.json().session.status).toBe('revoked');
      expect(revoked.json().session.endReason).toBe('requester_revoked');
      expect(await executionRows(session.id)).toEqual([]);
      const y = await decide(session.id, proposal.id, {
        decision: 'Y',
        approvalHash: proposal.approvalHash,
      });
      expect(y.statusCode).toBe(409);
      expect(await helperRevoked(session.helperId)).toBe(true);
    });

    it('配送前の取消: キューを cancelled にし、配送しない', async () => {
      const session = await readySession();
      await approveFirst(session);
      await call(OWNER, 'POST', base(session.id, '/revoke'), {});
      const execution = (await executionRows(session.id))[0];
      expect(execution?.status).toBe('cancelled');
      const polled = await poll(session.token);
      expect(polled.revoked).toBe(true);
      expect(polled.skillOps ?? []).toEqual([]);
    });

    it('配送後・実行直前の取消: /start を拒否し rejected_at_start を記録する', async () => {
      const session = await readySession();
      await approveFirst(session);
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      await call(OWNER, 'POST', base(session.id, '/revoke'), {});
      const polled = await poll(session.token);
      expect(polled.cancel).toContain(op.opId);
      expect(polled.revoked).toBe(true);
      const response = await start(session.token, op);
      expect(response.statusCode).toBe(409);
      expect(response.json().started).toBe(false);
      expect(response.json().reason).toBe('SESSION_ENDED');
      const execution = (await executionRows(session.id))[0];
      expect(execution?.status).toBe('rejected_at_start');
      expect(execution?.started_at).toBeNull();
      expect(execution?.stop_requested_at).not.toBeNull();
      expect(execution?.stop_outcome).toBe('not_running');
    });

    it('担当者の中止で /start を拒否する（トークン失効の前に届いた場合）', async () => {
      const session = await readySession();
      await approveFirst(session);
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      await sql`UPDATE support_sessions SET status = 'stopped', end_reason = 'operator_stop', ended_at = now() WHERE id = ${session.id}`;
      const response = await start(session.token, op);
      expect(response.statusCode).toBe(409);
      expect(response.json().reason).toBe('SESSION_ENDED');
      expect((await executionRows(session.id))[0]?.status).toBe('rejected_at_start');
    });

    it('実行中の取消: stop_requested と stopped を別に記録し、遅延結果は保存するが進めない', async () => {
      setManifest(ALL_BUT_DISK);
      const session = await readySession();
      const first = await executing(session);
      await report(session.token, first.op, resultBody(first.op, FOLDER_OUTPUT));
      // 変更系を実行中にする。
      const second = await propose(session.id);
      await decide(session.id, second.proposal.id, {
        decision: 'Y',
        approvalHash: second.proposal.approvalHash,
      });
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      await start(session.token, op);

      await call(ASSIGNEE, 'POST', base(session.id, '/stop'), {});
      expect((await sessionRow(session.id))?.status).toBe('stopped');
      let execution = (await executionRows(session.id))[1];
      expect(execution?.stop_requested_at).not.toBeNull();
      expect(execution?.stopped_at).toBeNull();
      expect(execution?.partial_effect).toEqual(['POSSIBLE_CHANGE']);

      const polled = await poll(session.token);
      expect(polled.cancel).toContain(op.opId);
      expect(polled.revoked).toBe(true);

      // kill → 報告 → トークン削除。失効後のトークンでも報告できる。
      const late = await report(
        session.token,
        op,
        resultBody(
          op,
          { applied: true, previousPresent: false, previousValue: null },
          {
            status: 'cancelled',
            resultCode: 'CANCELLED',
            exitCode: null,
            stopOutcome: 'stopped',
            partialEffect: ['MARKER_WRITTEN'],
          },
        ),
      );
      expect(late.json()).toEqual({ ok: true, accepted: false, reason: 'LATE_RESULT' });
      execution = (await executionRows(session.id))[1];
      expect(execution?.late_result).toBe(true);
      expect(execution?.evidence).toBe(false);
      expect(execution?.stop_outcome).toBe('stopped');
      expect(execution?.stopped_at).not.toBeNull();
      expect(execution?.partial_effect.sort()).toEqual(['MARKER_WRITTEN', 'POSSIBLE_CHANGE']);
      expect((await sessionRow(session.id))?.status).toBe('stopped');
    });

    it('停止できなかった報告は stop_failed として記録する', async () => {
      const session = await readySession();
      const { op } = await executing(session);
      await call(OWNER, 'POST', base(session.id, '/revoke'), {});
      await report(
        session.token,
        op,
        resultBody(op, null, {
          status: 'error',
          resultCode: 'EXEC_FAILED',
          exitCode: null,
          stopOutcome: 'stop_failed',
          partialEffect: ['STOP_FAILED_CHILD_RUNNING'],
        }),
      );
      const execution = (await executionRows(session.id))[0];
      expect(execution?.stop_outcome).toBe('stop_failed');
      expect(execution?.stopped_at).toBeNull();
      expect(execution?.partial_effect).toContain('STOP_FAILED_CHILD_RUNNING');
    });

    it('フォルダ同意の取消もセッションへ伝わる', async () => {
      const session = await readySession();
      await approveFirst(session);
      await call(OWNER, 'POST', folderBase(session.requestId, '/revoke'), {});
      const row = await sessionRow(session.id);
      expect(row?.status).toBe('revoked');
      expect(row?.end_reason).toBe('requester_revoked');
      expect((await executionRows(session.id))[0]?.status).toBe('cancelled');
    });
  });

  describe('ログオフ / 担当変更 / 期限切れ / 通信断', () => {
    it('ログオフ（sessionState の変化）で終了する', async () => {
      const session = await readySession();
      const { op } = await executing(session);
      const polled = await poll(session.token, { ...beat, sessionState: 'down' });
      expect(polled.revoked).toBe(true);
      expect(polled.cancel).toContain(op.opId);
      const row = await sessionRow(session.id);
      expect(row?.end_reason).toBe('user_logged_off');
      expect(row?.status).toBe('revoked');
    });

    it('担当変更で終了し、/start を拒否する', async () => {
      const session = await readySession();
      await approveFirst(session);
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      await sql`UPDATE case_handovers SET claimed_by = ${OTHER_ASSIGNEE} WHERE id = ${session.handoverId}`;
      const response = await start(session.token, op);
      expect(response.statusCode).toBe(409);
      expect(response.json().reason).toBe('ASSIGNEE_CHANGED');
      expect((await sessionRow(session.id))?.end_reason).toBe('assignee_changed');
      expect((await executionRows(session.id))[0]?.status).toBe('rejected_at_start');
    });

    it('セッションの期限切れ（30 分）で expired になる', async () => {
      const session = await readySession();
      await approveFirst(session);
      await sql`UPDATE support_sessions SET expires_at = now() - interval '1 second' WHERE id = ${session.id}`;
      await sweepSupportSessions();
      const row = await sessionRow(session.id);
      expect(row?.status).toBe('expired');
      expect(row?.end_reason).toBe('expired');
      expect((await executionRows(session.id))[0]?.status).toBe('cancelled');
      expect(await helperRevoked(session.helperId)).toBe(true);
    });

    it('承認の期限切れ（5 分）で Y を受けない', async () => {
      const session = await readySession();
      const { proposal } = await propose(session.id);
      expect(new Date(proposal.approvalExpiresAt).getTime() - Date.now()).toBeLessThanOrEqual(
        ASSIST_LIMITS.approvalMinutes * 60_000,
      );
      await sql`UPDATE assist_proposals SET approval_expires_at = now() - interval '1 second' WHERE id = ${proposal.id}`;
      const response = await decide(session.id, proposal.id, {
        decision: 'Y',
        approvalHash: proposal.approvalHash,
      });
      expect(response.statusCode).toBe(409);
      const row = await sessionRow(session.id);
      expect(row?.end_reason).toBe('approval_expired');
      expect(await executionRows(session.id)).toEqual([]);
    });

    it('配信の期限切れで止まり、成功にしない', async () => {
      const session = await readySession();
      await approveFirst(session);
      await sql`UPDATE assist_executions SET expires_at = now() - interval '1 second' WHERE support_session_id = ${session.id}`;
      await sweepSupportSessions();
      expect((await sessionRow(session.id))?.end_reason).toBe('execution_expired');
      expect((await executionRows(session.id))[0]?.status).toBe('expired');
    });

    it('通信断（heartbeat の途絶）で user_logged_off になる', async () => {
      const session = await readySession();
      await approveFirst(session);
      await sql`UPDATE folder_access_helpers SET last_seen_at = now() - interval '1 hour' WHERE id = ${session.helperId}`;
      await sweepFolderAccess();
      const row = await sessionRow(session.id);
      expect(row?.end_reason).toBe('user_logged_off');
      expect(row?.status).toBe('revoked');
    });

    it('実行中に結果が届かなければタイムアウトで止まり、その後の結果は遅延として保存して進めない', async () => {
      const session = await readySession();
      const { op } = await executing(session);
      await sql`UPDATE assist_executions SET deadline_at = now() - interval '1 second' WHERE support_session_id = ${session.id}`;
      await sweepSupportSessions();
      const row = await sessionRow(session.id);
      expect(row?.end_reason).toBe('execution_timeout');
      let execution = (await executionRows(session.id))[0];
      expect(execution?.status).toBe('timed_out');
      expect(execution?.stop_requested_at).not.toBeNull();
      expect(execution?.verify_ok).toBeNull();

      const late = await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      expect(late.json()).toEqual({ ok: true, accepted: false, reason: 'LATE_RESULT' });
      execution = (await executionRows(session.id))[0];
      expect(execution?.late_result).toBe(true);
      expect(execution?.evidence).toBe(false);
      expect(execution?.normalized_output.fileCount).toBe(3);
      expect((await sessionRow(session.id))?.status).toBe('stopped');
    });

    it('停止要求の後に報告が無ければ stop_unconfirmed として残す（止まったと書かない）', async () => {
      const session = await readySession();
      await executing(session);
      await call(OWNER, 'POST', base(session.id, '/revoke'), {});
      await sql`UPDATE assist_executions SET stop_requested_at = now() - interval '1 hour' WHERE support_session_id = ${session.id}`;
      await sweepSupportSessions();
      const execution = (await executionRows(session.id))[0];
      expect(execution?.stop_outcome).toBe('stop_unconfirmed');
      expect(execution?.stopped_at).toBeNull();
      // 読取の Skill なので、変更の可能性は出さない（変更系は「指摘 2 回目」で確認する）。
      expect(execution?.partial_effect).toBeNull();
    });

    it('期限が過ぎた識別子を消す（状態は残す）', async () => {
      const session = await readySession();
      await executing(session);
      await call(OWNER, 'POST', base(session.id, '/revoke'), {});
      await sql`UPDATE support_sessions SET ended_at = now() - interval '400 days' WHERE id = ${session.id}`;
      await sweepSupportSessions();
      const rows = await sql<Record<string, unknown>[]>`
      SELECT status, sid, machine_guid FROM support_sessions WHERE id = ${session.id}
    `;
      expect(rows[0]).toMatchObject({ status: 'revoked', sid: null, machine_guid: null });
      expect((await executionRows(session.id))[0]?.sid).toBeNull();
    });
  });

  describe('受付の停止と既存の終了（ASSIST_SESSION_MODE）', () => {
    const scrubbed = async (id: string) => {
      const rows = await sql<Record<string, unknown>[]>`
        SELECT status, end_reason, sid, machine_guid FROM support_sessions WHERE id = ${id}
      `;
      return rows[0];
    };

    describe('drain', () => {
      const draining = (response: { statusCode: number; json: () => any }) => {
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe('ASSIST_DRAINING');
      };

      it('新しいセッション・同意・提案・Y を受け付けない。何も配送しない', async () => {
        const consentPending = await startSession();
        const ready = await readySession();
        const { proposal } = await propose(ready.id);
        const fresh = await activeFolderRequest();
        config.ASSIST_SESSION_MODE = 'drain';

        draining(
          await call(ASSIGNEE, 'POST', '/api/support-sessions', { handoverId: fresh.handoverId }),
        );
        draining(
          await call(OWNER, 'POST', base(consentPending.id, '/consents/operation'), {
            scope: 'read_only',
            version: 'operation-consent/1',
            ttlMinutes: 30,
          }),
        );
        draining(
          await call(OWNER, 'POST', base(consentPending.id, '/consents/ai-input'), {
            version: 'ai-input-consent/2',
            ttlMinutes: 30,
          }),
        );
        draining(await call(OWNER, 'POST', base(consentPending.id, '/proposals'), {}));
        draining(
          await decide(ready.id, proposal.id, {
            decision: 'Y',
            approvalHash: proposal.approvalHash,
          }),
        );
        expect((await sessionRow(ready.id))?.status).toBe('awaiting_approval');
        expect((await executionRows(ready.id)).length).toBe(0);
        expect((await poll(ready.token)).skillOps ?? []).toEqual([]);
      });

      it('N・取消・中止・状態の確認は動く。画面へ受付停止を伝える', async () => {
        const declined = await readySession();
        const { proposal } = await propose(declined.id);
        const revoked = await readySession();
        const stopped = await readySession();
        config.ASSIST_SESSION_MODE = 'drain';

        const view = (await call(OWNER, 'GET', base(revoked.id))).json().session;
        expect(view.acceptingNew).toBe(false);
        const lookup = await call(
          ASSIGNEE,
          'GET',
          `/api/support-sessions?handoverId=${revoked.handoverId}`,
        );
        expect(lookup.json().acceptingNew).toBe(false);

        const no = await decide(declined.id, proposal.id, { decision: 'N' });
        expect(no.statusCode, no.body).toBe(200);
        expect((await sessionRow(declined.id))?.end_reason).toBe('requester_declined');
        const revoke = await call(OWNER, 'POST', base(revoked.id, '/revoke'), {});
        expect(revoke.statusCode, revoke.body).toBe(200);
        expect((await sessionRow(revoked.id))?.status).toBe('revoked');
        const stop = await call(ASSIGNEE, 'POST', base(stopped.id, '/stop'), {});
        expect(stop.statusCode, stop.body).toBe(200);
        expect((await sessionRow(stopped.id))?.end_reason).toBe('operator_stop');
      });

      it('承認済みの実行は開始でき、結果と確認操作と解決確認まで終えられる', async () => {
        setManifest(ALL_BUT_DISK);
        const session = await readySession();
        const first = await executing(session);
        config.ASSIST_SESSION_MODE = 'drain';
        const result = await report(session.token, first.op, resultBody(first.op, FOLDER_OUTPUT));
        expect(result.json().accepted).toBe(true);
        expect((await sessionRow(session.id))?.status).toBe('awaiting_next');
        const resolved = await call(OWNER, 'POST', base(session.id, '/resolution'), {
          resolved: true,
        });
        expect(resolved.statusCode, resolved.body).toBe(200);
        expect((await sessionRow(session.id))?.status).toBe('resolved');
      });

      it('Y の後で受付を止めても、配送と開始は動く', async () => {
        const session = await readySession();
        await approveFirst(session);
        config.ASSIST_SESSION_MODE = 'drain';
        const op = (await poll(session.token)).skillOps?.[0] as Op;
        expect(op).toBeTruthy();
        const started = await start(session.token, op);
        expect(started.statusCode, started.body).toBe(200);
      });

      it('定期処理と同意の終了の伝搬が動く', async () => {
        const expired = await readySession();
        const folderEnded = await readySession();
        config.ASSIST_SESSION_MODE = 'drain';
        await sql`UPDATE support_sessions SET expires_at = now() - interval '1 minute' WHERE id = ${expired.id}`;
        await sweepSupportSessions();
        expect((await sessionRow(expired.id))?.status).toBe('expired');
        const revoked = await call(OWNER, 'POST', folderBase(folderEnded.requestId, '/revoke'), {});
        expect(revoked.statusCode, revoked.body).toBe(200);
        expect((await sessionRow(folderEnded.id))?.status).toBe('revoked');
      });

      it('ASSIST_SESSION_ENABLED=false でも drain は既存の終了処理を動かす', async () => {
        const session = await readySession();
        config.ASSIST_SESSION_ENABLED = false;
        config.ASSIST_SESSION_MODE = 'drain';
        const response = await call(OWNER, 'POST', base(session.id, '/revoke'), {});
        expect(response.statusCode, response.body).toBe(200);
      });
    });

    describe('off', () => {
      const off = () => {
        config.ASSIST_SESSION_MODE = 'off';
      };

      it('API は 404 だが、保持期限を過ぎた識別子は消える', async () => {
        const session = await readySession();
        await call(OWNER, 'POST', base(session.id, '/revoke'), {});
        await sql`UPDATE support_sessions SET ended_at = now() - interval '400 days' WHERE id = ${session.id}`;
        off();
        expect((await call(OWNER, 'GET', '/api/support-sessions/mine')).statusCode).toBe(404);
        await sweepSupportSessions();
        expect(await scrubbed(session.id)).toMatchObject({
          status: 'revoked',
          end_reason: 'requester_revoked',
          sid: null,
          machine_guid: null,
        });
      });

      it('ASSIST_SESSION_ENABLED=false と FOLDER_ACCESS_ENABLED=false でも消える', async () => {
        const session = await readySession();
        await call(OWNER, 'POST', base(session.id, '/revoke'), {});
        await sql`UPDATE support_sessions SET ended_at = now() - interval '400 days' WHERE id = ${session.id}`;
        config.ASSIST_SESSION_ENABLED = false;
        config.FOLDER_ACCESS_ENABLED = false;
        await sweepSupportSessions();
        expect((await scrubbed(session.id))?.sid).toBeNull();
      });

      it('保持期限の前の識別子は消さず、期限の処理で進行中のセッションを終えない', async () => {
        const session = await readySession();
        await sql`UPDATE support_sessions SET expires_at = now() - interval '1 minute' WHERE id = ${session.id}`;
        off();
        await sweepSupportSessions();
        expect(await scrubbed(session.id)).toMatchObject({ status: 'ready', end_reason: null });
        expect((await scrubbed(session.id))?.sid).not.toBeNull();
      });

      it('終わらないまま無効になったセッションも、期限 + 保持期間で消え、戻すと終わる', async () => {
        const session = await readySession();
        await sql`UPDATE support_sessions SET expires_at = now() - interval '400 days' WHERE id = ${session.id}`;
        off();
        await sweepSupportSessions();
        expect(await scrubbed(session.id)).toMatchObject({ status: 'ready', sid: null });
        config.ASSIST_SESSION_MODE = 'on';
        const response = await call(OWNER, 'GET', base(session.id));
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().session.status).not.toBe('ready');
      });

      it('結果が来ていない実行は、識別子を消す前に停止未確認として閉じる', async () => {
        const session = await readySession();
        await executing(session);
        await sql`UPDATE support_sessions SET expires_at = now() - interval '400 days' WHERE id = ${session.id}`;
        off();
        await sweepSupportSessions();
        const execution = (await executionRows(session.id))[0];
        expect(execution?.report_expired_at).not.toBeNull();
        expect(execution?.stop_outcome).toBe('stop_unconfirmed');
        expect(execution?.stopped_at).toBeNull();
        expect(execution?.verify_ok).toBeNull();
        expect(execution?.evidence).toBe(false);
        expect(execution?.sid).toBeNull();
        expect(execution?.helper_id).toBeNull();
      });

      it('承認時にタグの列へ書かない（035 未適用でも承認を止めない）', async () => {
        sequence += 1;
        const clientRef = `ui-ss-off-${sequence}`;
        const payload = {
          clientRef,
          title: '容量が足りないときの対処',
          symptom: '容量が不足',
          cause: 'x',
          steps: 'x',
          keywords: [],
        };
        off();
        try {
          await call(ASSIGNEE, 'POST', '/api/knowledge/ui-sync', { ...payload, status: 'pending' });
          const approved = await call(APPROVER_ONLY, 'POST', '/api/knowledge/ui-sync', {
            ...payload,
            status: 'approved',
            contentHash: await reviewedHash(clientRef),
            checklist: { reproducible: true, noSecrets: true, noBlame: true, scopeClear: true },
          });
          expect(approved.statusCode, approved.body).toBe(200);
          const rows = await sql<{ symptom_tags: string[] | null; status: string }[]>`
            SELECT symptom_tags, status FROM knowledge WHERE client_ref = ${clientRef}
          `;
          expect(rows[0]).toMatchObject({ status: 'approved', symptom_tags: null });
        } finally {
          await sql`DELETE FROM knowledge WHERE client_ref = ${clientRef}`;
        }
      });
    });
  });

  describe('コードレビューの指摘（#120）', () => {
    /** 読取の提案を終え、変更系の本体を実行中にする。 */
    async function modifyExecuting(session: { id: string; token: string }) {
      const first = await executing(session);
      await report(session.token, first.op, resultBody(first.op, FOLDER_OUTPUT));
      const second = await propose(session.id);
      await decide(session.id, second.proposal.id, {
        decision: 'Y',
        approvalHash: second.proposal.approvalHash,
      });
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      expect((await start(session.token, op)).statusCode).toBe(200);
      return op;
    }

    it('1. 変更系のタイムアウトは結果がなくても POSSIBLE_CHANGE を記録する', async () => {
      setManifest(ALL_BUT_DISK);
      const session = await readySession();
      await modifyExecuting(session);
      await sql`
        UPDATE assist_executions SET deadline_at = now() - interval '1 second'
        WHERE support_session_id = ${session.id} AND status = 'executing'
      `;
      await sweepSupportSessions();
      const execution = (await executionRows(session.id))[1];
      expect(execution?.status).toBe('timed_out');
      expect(execution?.partial_effect).toEqual(['POSSIBLE_CHANGE']);
    });

    it('1. 読取のタイムアウトには変更の可能性を記録しない', async () => {
      const session = await readySession();
      await executing(session);
      await sql`
        UPDATE assist_executions SET deadline_at = now() - interval '1 second'
        WHERE support_session_id = ${session.id}
      `;
      await sweepSupportSessions();
      expect((await executionRows(session.id))[0]?.partial_effect).toBeNull();
    });

    it('1. 確認操作の途中で止めると、完了済みの変更系本体に POSSIBLE_CHANGE を記録する', async () => {
      setManifest(ALL_BUT_DISK);
      const session = await readySession();
      const op = await modifyExecuting(session);
      await report(
        session.token,
        op,
        resultBody(op, { applied: true, previousPresent: false, previousValue: null }),
      );
      expect((await sessionRow(session.id))?.status).toBe('verifying');
      await call(ASSIGNEE, 'POST', base(session.id, '/stop'), {});
      const main = (await executionRows(session.id)).find((row) => row.id === op.opId);
      expect(main?.status).toBe('completed');
      expect(main?.partial_effect).toEqual(['POSSIBLE_CHANGE']);
    });

    it('2. 報告が期限切れを発火させても stop_outcome を保存し、状態を上書きしない', async () => {
      const session = await readySession();
      const { op } = await executing(session);
      await sql`
        UPDATE assist_executions SET deadline_at = now() - interval '1 second'
        WHERE support_session_id = ${session.id}
      `;
      const response = await report(
        session.token,
        op,
        resultBody(op, null, {
          status: 'cancelled',
          resultCode: 'CANCELLED',
          exitCode: null,
          stopOutcome: 'stopped',
        }),
      );
      expect(response.json()).toEqual({ ok: true, accepted: false, reason: 'LATE_RESULT' });
      const execution = (await executionRows(session.id))[0];
      expect(execution?.status).toBe('timed_out');
      expect(execution?.stop_outcome).toBe('stopped');
      expect(execution?.stopped_at).not.toBeNull();
      expect((await sessionRow(session.id))?.end_reason).toBe('execution_timeout');
    });

    it('4. rejected（未実行）の申告は not_running を記録する（停止要求の後）', async () => {
      const session = await readySession();
      await approveFirst(session);
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      await call(OWNER, 'POST', base(session.id, '/revoke'), {});
      await report(
        session.token,
        op,
        resultBody(op, null, { status: 'rejected', resultCode: 'BAD_SIGNATURE', exitCode: null }),
      );
      const execution = (await executionRows(session.id))[0];
      expect(execution?.status).toBe('rejected_by_helper');
      expect(execution?.stop_outcome).toBe('not_running');
      expect(execution?.stopped_at).not.toBeNull();
    });

    it('4. rejected（未実行）の申告は not_running を記録する（停止要求の前）', async () => {
      const session = await readySession();
      await approveFirst(session);
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      await report(
        session.token,
        op,
        resultBody(op, null, { status: 'rejected', resultCode: 'ELEVATED', exitCode: null }),
      );
      expect((await executionRows(session.id))[0]?.stop_outcome).toBe('not_running');
    });

    it('5. disk.space は freeGB が数値でなければ成功にしない', async () => {
      setManifest(['disk.space']);
      const session = await readySession();
      const { op } = await executing(session);
      expect(op.skillId).toBe('disk.space');
      await report(
        session.token,
        op,
        resultBody(op, { volumes: [{ deviceId: 'C:', freeGB: null, totalGB: null }] }),
      );
      const row = await sessionRow(session.id);
      expect(row?.end_reason).toBe('verify_failed');
      expect((await executionRows(session.id))[0]?.verify_ok).toBe(false);
    });

    it('6. proposing の後の例外で元の状態へ戻し、提案を作らず、やり直せる', async () => {
      const session = await readySession();
      synth.throwOnRead = true;
      const failed = await call(OWNER, 'POST', base(session.id, '/proposals'), {});
      synth.throwOnRead = false;
      expect(failed.statusCode).toBe(500);
      const row = await sessionRow(session.id);
      expect(row?.status).toBe('ready');
      expect(row?.proposal_count).toBe(0);
      const { proposal } = await propose(session.id);
      expect(proposal.skillId).toBe('folder.summary');
    });

    it('6. 2 回目の提案の例外では awaiting_next へ戻す', async () => {
      setManifest(ALL_BUT_DISK);
      const session = await readySession();
      const { op } = await executing(session);
      await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      synth.throwOnRead = true;
      const failed = await call(OWNER, 'POST', base(session.id, '/proposals'), {});
      synth.throwOnRead = false;
      expect(failed.statusCode).toBe(500);
      expect((await sessionRow(session.id))?.status).toBe('awaiting_next');
    });

    it('6. proposing の期限は AI の応答待ちより長く、過ぎたら sweep で止める', async () => {
      const session = await readySession();
      await call(OWNER, 'POST', base(session.id, '/consents/ai-input'), {
        version: 'ai-input-consent/2',
        ttlMinutes: 30,
      });
      config.DEEPSEEK_API_KEY = 'synthetic-ai-key';
      let remainingMs = 0;
      world.aiReply = { skillId: 'folder.summary', params: { target: 'T1' }, rationale: '確認' };
      world.onAi = async () => {
        const rows = await sql<{ ms: number }[]>`
          SELECT (EXTRACT(EPOCH FROM proposing_expires_at - now()) * 1000)::float8 AS ms
          FROM support_sessions WHERE id = ${session.id}
        `;
        remainingMs = rows[0]?.ms ?? 0;
      };
      await propose(session.id);
      world.onAi = undefined;
      expect(remainingMs).toBeGreaterThan(config.DEEPSEEK_TIMEOUT_MS);

      const stalled = await readySession();
      await sql`
        UPDATE support_sessions
        SET status = 'proposing', proposing_expires_at = now() - interval '1 second'
        WHERE id = ${stalled.id}
      `;
      await sweepSupportSessions();
      const row = await sessionRow(stalled.id);
      expect(row?.status).toBe('stopped');
      expect(row?.end_reason).toBe('proposing_timeout');
      expect(await helperRevoked(stalled.helperId)).toBe(true);
    });

    it('6. 期限前の proposing は sweep で止めない', async () => {
      const session = await readySession();
      await sql`
        UPDATE support_sessions
        SET status = 'proposing', proposing_expires_at = now() + interval '1 minute'
        WHERE id = ${session.id}
      `;
      await sweepSupportSessions();
      expect((await sessionRow(session.id))?.status).toBe('proposing');
      await sql`UPDATE support_sessions SET status = 'ready' WHERE id = ${session.id}`;
    });

    describe('7. フラグ無効では新テーブルに触らない（028 未適用の DB を再現）', () => {
      const TABLES = [
        'assist_executions',
        'assist_proposals',
        'ai_input_consents',
        'operation_consents',
        'support_sessions',
      ];
      async function withoutTables(run: () => Promise<void>) {
        for (const table of TABLES) {
          await sql.unsafe(`ALTER TABLE ${table} RENAME TO ${table}_hidden`);
        }
        try {
          await run();
        } finally {
          for (const table of TABLES) {
            await sql.unsafe(`ALTER TABLE ${table}_hidden RENAME TO ${table}`);
          }
        }
      }

      it('poll・フォルダ同意の終了・定期処理が失敗しない', async () => {
        const folder = await activeFolderRequest();
        config.ASSIST_SESSION_ENABLED = false;
        await withoutTables(async () => {
          const polled = await poll(folder.token);
          expect(polled.revoked).toBe(false);
          expect(polled).not.toHaveProperty('skillOps');

          const revoked = await call(OWNER, 'POST', folderBase(folder.requestId, '/revoke'), {});
          expect(revoked.statusCode, revoked.body).toBe(200);
          expect(revoked.json().request.status).toBe('revoked');
          const rows = await sql<{ status: string }[]>`
            SELECT status FROM folder_access_requests WHERE id = ${folder.requestId}
          `;
          expect(rows[0]?.status).toBe('revoked');
          expect(await helperRevoked(folder.helperId)).toBe(true);

          await expect(sweepSupportSessions()).resolves.toBe(0);
          await expect(sweepFolderAccess()).resolves.toBeGreaterThanOrEqual(0);
        });
      });

      it('無効の間に同意が終わったセッションは、有効に戻した後の確認で止まる', async () => {
        const session = await readySession();
        config.ASSIST_SESSION_ENABLED = false;
        expect(
          (await call(OWNER, 'POST', folderBase(session.requestId, '/revoke'), {})).statusCode,
        ).toBe(200);
        expect((await sessionRow(session.id))?.status).toBe('ready');
        config.ASSIST_SESSION_ENABLED = true;
        const response = await call(OWNER, 'GET', base(session.id));
        expect(response.json().session.status).toBe('stopped');
      });
    });

    it('9. 進行中ステータスを複製しない（部分一意インデックスとも一致する）', async () => {
      const dir = path.dirname(new URL(import.meta.url).pathname);
      for (const file of ['routes.ts', 'propagate.ts', 'sweep.ts', 'service.ts']) {
        const source = readFileSync(path.join(dir, file), 'utf8');
        expect(source, file).not.toMatch(/'consent_pending',\s*'ready'/);
      }
      const rows = await sql<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'support_sessions_open_handover_idx'
      `;
      for (const status of OPEN_SESSION_STATUSES) {
        expect(rows[0]?.indexdef).toContain(`'${status}'`);
      }
    });

    describe('10. /support-sessions/mine', () => {
      it('終了済みのセッションをロックしない（行ロック中でも待たずに返す）', async () => {
        const session = await readySession();
        await call(OWNER, 'POST', base(session.id, '/revoke'), {});
        await sql.begin(async (tx) => {
          await tx`SELECT id FROM support_sessions WHERE id = ${session.id} FOR UPDATE`;
          await tx`SELECT id FROM folder_access_requests WHERE id = ${session.requestId} FOR UPDATE`;
          const response = await call(OWNER, 'GET', '/api/support-sessions/mine');
          expect(response.statusCode).toBe(200);
          const found = response
            .json()
            .sessions.find((item: { id: string }) => item.id === session.id);
          expect(found.status).toBe('revoked');
          expect(found.endReason).toBe('requester_revoked');
        });
      }, 5000);

      it('進行中は期限を反映し、提案と実行をセッションごとに分けて返す', async () => {
        const first = await readySession();
        const { proposal } = await propose(first.id);
        const second = await readySession();
        const executed = await executing(second);
        await sql`UPDATE support_sessions SET expires_at = now() - interval '1 second' WHERE id = ${first.id}`;
        const response = await call(OWNER, 'GET', '/api/support-sessions/mine');
        const sessions = response.json().sessions as Record<string, any>[];
        const a = sessions.find((item) => item.id === first.id);
        const b = sessions.find((item) => item.id === second.id);
        expect(a?.status).toBe('expired');
        expect(a?.proposals.map((item: { id: string }) => item.id)).toEqual([proposal.id]);
        expect(a?.executions).toEqual([]);
        expect(b?.status).toBe('executing');
        expect(b?.proposals.map((item: { id: string }) => item.id)).toEqual([executed.proposal.id]);
        expect(b?.executions.map((item: { id: string }) => item.id)).toEqual([executed.op.opId]);
        expect(b?.device?.hostname).toBe(HOST);
      });

      it('所有者が変わったセッションは返さず、状態も変えない', async () => {
        const session = await readySession();
        await sql`UPDATE case_handovers SET owner_email = ${OTHER_OWNER} WHERE id = ${session.handoverId}`;
        const response = await call(OWNER, 'GET', '/api/support-sessions/mine');
        const ids = response.json().sessions.map((item: { id: string }) => item.id);
        expect(ids).not.toContain(session.id);
        expect((await sessionRow(session.id))?.status).toBe('ready');
      });
    });
  });

  describe('導入コードとの合流（docs/62 の導入コード）', () => {
    const beginRequest = async () => {
      const handoverId = await makeHandover();
      const created = await call(ASSIGNEE, 'POST', '/api/folder-access/requests', { handoverId });
      expect(created.statusCode, created.body).toBe(200);
      return { handoverId, requestId: created.json().request.id as string };
    };
    const enrollAndRegister = async (requestId: string) => {
      const enrolled = await call(OWNER, 'POST', folderBase(requestId, '/enroll-code'), {});
      expect(enrolled.statusCode, enrolled.body).toBe(200);
      const registered = await app.inject({
        method: 'POST',
        url: '/api/device/agent/folder-helper/register',
        payload: {
          enrollCode: enrolled.json().enrollCode,
          machineGuid: MACHINE,
          sid: SID,
          userName: USER,
          sessionId: SESSION,
          sessionState: 'active',
          hostname: HOST,
          helperVersion: '0.2.0',
        },
      });
      expect(registered.statusCode, registered.body).toBe(200);
      return registered.json() as { helperId: string; helperToken: string; pairingCode: string };
    };

    it('導入コードで登録しただけ（未ペア）ではセッションを開始できず、操作も配られない', async () => {
      const { handoverId, requestId } = await beginRequest();
      const helper = await enrollAndRegister(requestId);
      const created = await call(ASSIGNEE, 'POST', '/api/support-sessions', { handoverId });
      expect(created.statusCode).toBe(409);
      expect(created.json().error.code).toBe('FOLDER_REQUEST_NOT_ACTIVE');
      const polled = await poll(helper.helperToken);
      expect(polled.skillOps ?? []).toEqual([]);
    });

    it('セッションの最中に導入コードを発行してヘルパーを差し替えられない', async () => {
      const session = await readySession();
      const issued = await call(OWNER, 'POST', folderBase(session.requestId, '/enroll-code'), {});
      expect(issued.statusCode).toBe(409);
      const rows = await sql<{ helper_id: string }[]>`
        SELECT helper_id FROM support_sessions WHERE id = ${session.id}
      `;
      expect(rows[0]?.helper_id).toBe(session.helperId);
    });

    it('終了の後の再導入は新しい依頼と新しいコードで行い、古いトークンは新しい操作を受けない', async () => {
      const first = await readySession();
      await call(OWNER, 'POST', base(first.id, '/revoke'), {});

      const again = await activeFolderRequest(first.handoverId);
      expect(again.helperId).not.toBe(first.helperId);
      expect(again.requestId).not.toBe(first.requestId);
      const created = await call(ASSIGNEE, 'POST', '/api/support-sessions', {
        handoverId: first.handoverId,
      });
      expect(created.statusCode, created.body).toBe(200);
      const id = created.json().session.id as string;
      expect(id).not.toBe(first.id);
      const consent = await call(OWNER, 'POST', base(id, '/consents/operation'), {
        scope: 'read_only',
        version: 'operation-consent/1',
        ttlMinutes: 30,
      });
      expect(consent.statusCode, consent.body).toBe(200);
      const proposal = await approveFirst({ id });
      expect(proposal.skillId).toBe('folder.summary');

      const stale = await poll(first.token);
      expect(stale.revoked).toBe(true);
      expect(stale.skillOps ?? []).toEqual([]);
      const op = (await poll(again.token)).skillOps?.[0] as Op;
      expect(op).toBeDefined();
      expect((await start(first.token, op)).statusCode).toBe(404);
      expect((await start(again.token, op)).statusCode).toBe(200);
    });
  });

  describe('コードレビューの指摘 2 回目（#120）', () => {
    async function modifyExecuting(session: { id: string; token: string }) {
      const first = await executing(session);
      await report(session.token, first.op, resultBody(first.op, FOLDER_OUTPUT));
      const second = await propose(session.id);
      await decide(session.id, second.proposal.id, {
        decision: 'Y',
        approvalHash: second.proposal.approvalHash,
      });
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      expect((await start(session.token, op)).statusCode).toBe(200);
      return op;
    }
    const notRun = (op: Op) =>
      resultBody(op, null, {
        status: 'rejected',
        resultCode: 'START_NO_RESPONSE',
        exitCode: null,
        startedAt: null,
        finishedAt: null,
      });
    const row = async (id: string, opId: string) =>
      (await executionRows(id)).find((item) => item.id === opId);

    it('1. /start の応答を失った「実行していない」申告を保存し、変更の可能性を付けない', async () => {
      setManifest(ALL_BUT_DISK);
      const session = await readySession();
      const op = await modifyExecuting(session);
      const response = await report(session.token, op, notRun(op));
      expect(response.json()).toEqual({ ok: true, accepted: false, reason: 'REJECTED_BY_HELPER' });
      const execution = await row(session.id, op.opId);
      expect(execution?.status).toBe('rejected_by_helper');
      expect(execution?.result_code).toBe('START_NO_RESPONSE');
      expect(execution?.stop_outcome).toBe('not_running');
      expect(execution?.evidence).toBe(false);
      expect(execution?.partial_effect).toBeNull();
      // execution_mode は real でも、実行したとは返さない。
      const view = (await call(OWNER, 'GET', base(session.id))).json().session;
      const shown = view.executions.find((item: { id: string }) => item.id === op.opId);
      expect(shown.executionMode).toBe('real');
      expect(shown.phase).toBe('rejected_before_start');
      expect(shown.verification).toBe('not_applicable');
      expect(view.executionSummary.notRun).toBeGreaterThanOrEqual(1);
      expect((await sessionRow(session.id))?.end_reason).toBe('execution_failed');
    });

    it('1. 先に停止した後に届いても、実行していない申告で変更の可能性を取り消す', async () => {
      setManifest(ALL_BUT_DISK);
      const session = await readySession();
      const op = await modifyExecuting(session);
      await call(OWNER, 'POST', base(session.id, '/revoke'), {});
      expect((await row(session.id, op.opId))?.partial_effect).toEqual(['POSSIBLE_CHANGE']);
      await report(session.token, op, notRun(op));
      const execution = await row(session.id, op.opId);
      expect(execution?.partial_effect).toBeNull();
      expect(execution?.stop_outcome).toBe('not_running');
      expect(execution?.stopped_at).not.toBeNull();
    });

    it('1. 申告に partialEffect が付いていても未実行なら記録しない', async () => {
      setManifest(ALL_BUT_DISK);
      const session = await readySession();
      const op = await modifyExecuting(session);
      await report(session.token, op, { ...notRun(op), partialEffect: ['MARKER_WRITTEN'] });
      expect((await row(session.id, op.opId))?.partial_effect).toBeNull();
    });

    it('2. 停止要求がなくても、ヘルパー自身の kill の結果を保存する', async () => {
      for (const stopOutcome of ['stopped', 'stop_failed'] as const) {
        const session = await readySession();
        const { op } = await executing(session);
        await report(
          session.token,
          op,
          resultBody(op, null, {
            status: 'timeout',
            resultCode: 'TIMEOUT',
            exitCode: null,
            stopOutcome,
          }),
        );
        const execution = await row(session.id, op.opId);
        expect(execution?.stop_outcome).toBe(stopOutcome);
        expect(execution?.stopped_at === null).toBe(stopOutcome === 'stop_failed');
      }
    });

    it.each([
      ['SID', { actorSid: OTHER_SID }, 'sid_mismatch'],
      ['セッション', { sessionId: 7 }, 'session_changed'],
    ])(
      '3. %s の不一致でも報告値（停止・部分的な変更・終了コード）を残す',
      async (_n, over, end) => {
        setManifest(ALL_BUT_DISK);
        const session = await readySession();
        const op = await modifyExecuting(session);
        await report(
          session.token,
          op,
          resultBody(
            op,
            { applied: true, previousPresent: false, previousValue: null },
            {
              ...over,
              status: 'error',
              resultCode: 'EXEC_FAILED',
              exitCode: 3,
              stopOutcome: 'stop_failed',
              partialEffect: ['MARKER_WRITTEN'],
            },
          ),
        );
        const execution = await row(session.id, op.opId);
        expect(execution?.result_code).toBe('RESULT_MISMATCH');
        expect(execution?.evidence).toBe(false);
        expect(execution?.verify_ok).toBeNull();
        expect(execution?.exit_code).toBe(3);
        expect(execution?.stop_outcome).toBe('stop_failed');
        expect(execution?.partial_effect.sort()).toEqual(['MARKER_WRITTEN', 'POSSIBLE_CHANGE']);
        expect(execution?.result_source).toBe('helper_token');
        expect((await sessionRow(session.id))?.end_reason).toBe(end);
      },
    );

    const ageStop = (id: string) => sql`
      UPDATE assist_executions SET stop_requested_at = now() - interval '1 hour'
      WHERE support_session_id = ${id} AND stop_requested_at IS NOT NULL
    `;

    it('4. 読取の Skill の停止未確認に変更の可能性を出さない', async () => {
      const session = await readySession();
      await executing(session);
      await call(OWNER, 'POST', base(session.id, '/revoke'), {});
      await ageStop(session.id);
      await sweepSupportSessions();
      const execution = (await executionRows(session.id))[0];
      expect(execution?.stop_outcome).toBe('stop_unconfirmed');
      expect(execution?.partial_effect).toBeNull();
      await sql`
        UPDATE folder_access_helpers SET revoked_at = now() - interval '25 hours'
        WHERE id = ${session.helperId}
      `;
      await sweepSupportSessions();
      expect((await executionRows(session.id))[0]?.partial_effect).toBeNull();
    });

    it('4. 変更系の停止未確認は記録し、後から stopped が届けば未確認を解消する', async () => {
      setManifest(ALL_BUT_DISK);
      const session = await readySession();
      const op = await modifyExecuting(session);
      await call(OWNER, 'POST', base(session.id, '/revoke'), {});
      await ageStop(session.id);
      await sweepSupportSessions();
      let execution = await row(session.id, op.opId);
      expect(execution?.stop_outcome).toBe('stop_unconfirmed');
      expect(execution?.partial_effect.sort()).toEqual(['POSSIBLE_CHANGE', 'STOP_UNCONFIRMED']);

      await report(
        session.token,
        op,
        resultBody(op, null, {
          status: 'cancelled',
          resultCode: 'CANCELLED',
          exitCode: null,
          stopOutcome: 'stopped',
        }),
      );
      execution = await row(session.id, op.opId);
      expect(execution?.stop_outcome).toBe('stopped');
      expect(execution?.stopped_at).not.toBeNull();
      // 動いていたので変更の可能性は残し、未確認だけを消す。
      expect(execution?.partial_effect).toEqual(['POSSIBLE_CHANGE']);
    });

    it('8. 提案の候補を求める 1 回の呼び出しで manifest を 1 度だけ読む', () => {
      synth.manifestLoads = 0;
      expect(proposableSkills('user_reversible').length).toBeGreaterThan(1);
      expect(synth.manifestLoads).toBe(1);
    });

    it('8. Y の再検証でも manifest を 1 度だけ読む', async () => {
      setManifest(ALL_BUT_DISK);
      const session = await readySession();
      const first = await executing(session);
      await report(session.token, first.op, resultBody(first.op, FOLDER_OUTPUT));
      const second = await propose(session.id);
      synth.manifestLoads = 0;
      await decide(session.id, second.proposal.id, {
        decision: 'Y',
        approvalHash: second.proposal.approvalHash,
      });
      expect(second.proposal.verifyOps).toHaveLength(1);
      expect(synth.manifestLoads).toBe(1);
    });
  });

  describe('操作導線（API）', () => {
    it('同時の Y でも実行は 1 件だけ', async () => {
      const session = await readySession();
      const { proposal } = await propose(session.id);
      const y = { decision: 'Y', approvalHash: proposal.approvalHash };
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => decide(session.id, proposal.id, y)),
      );
      const codes = responses.map((response) => response.statusCode).sort();
      expect(codes).toEqual([200, 409, 409, 409, 409]);
      expect(await executionRows(session.id)).toHaveLength(1);
      expect((await poll(session.token)).skillOps).toHaveLength(1);
    });

    it('実行の後に同じ Y を再送しても（通信の再送）実行が増えない', async () => {
      const session = await readySession();
      const { proposal, op } = await executing(session);
      await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      const replay = await decide(session.id, proposal.id, {
        decision: 'Y',
        approvalHash: proposal.approvalHash,
      });
      expect(replay.statusCode).toBe(409);
      expect(await executionRows(session.id)).toHaveLength(1);
      expect((await poll(session.token)).skillOps).toEqual([]);
      expect((await sessionRow(session.id))?.status).toBe('awaiting_next');
    });

    it('古い画面の Y（前の提案へ）は新しい提案を動かさず、止めもしない', async () => {
      setManifest(ALL_BUT_DISK);
      const session = await readySession();
      const { proposal: old, op } = await executing(session);
      await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      const { proposal: fresh } = await propose(session.id);
      expect(fresh.id).not.toBe(old.id);
      const stale = await decide(session.id, old.id, {
        decision: 'Y',
        approvalHash: old.approvalHash,
      });
      expect(stale.statusCode).toBe(409);
      const after = await sessionRow(session.id);
      expect(after?.status).toBe('awaiting_approval');
      expect(await executionRows(session.id)).toHaveLength(1);
      // 表示中の提案の Y は有効なまま。
      const ok = await decide(session.id, fresh.id, {
        decision: 'Y',
        approvalHash: fresh.approvalHash,
      });
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it('前の提案のハッシュで新しい提案へ Y を送っても無効', async () => {
      setManifest(ALL_BUT_DISK);
      const session = await readySession();
      const { proposal: old, op } = await executing(session);
      await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      const { proposal: fresh } = await propose(session.id);
      const response = await decide(session.id, fresh.id, {
        decision: 'Y',
        approvalHash: old.approvalHash,
      });
      expect(response.statusCode).toBe(409);
      expect(await executionRows(session.id)).toHaveLength(1);
    });

    it('担当者の参照: 引き受けた本人だけ。承認者だけ・他の担当者には見せない', async () => {
      const session = await startSession();
      const url = `/api/support-sessions?handoverId=${session.handoverId}`;
      expect((await call(ASSIGNEE, 'GET', url)).json().session.id).toBe(session.id);
      for (const email of [APPROVER_ONLY, OTHER_ASSIGNEE, OWNER]) {
        expect((await call(email, 'GET', url)).statusCode, email).toBe(403);
      }
      const fresh = await makeHandover();
      expect(
        (await call(ASSIGNEE, 'GET', `/api/support-sessions?handoverId=${fresh}`)).json().session,
      ).toBeNull();
    });

    it('本人の表示に対象 PC・ユーザー・許可範囲・期限があり、担当者には本人向けの情報を返さない', async () => {
      const session = await readySession();
      const mine = (await call(OWNER, 'GET', base(session.id))).json().session;
      expect(mine.device).toEqual({ hostname: HOST, windowsUser: USER });
      expect(mine.folderScope.root).toBe('Documents');
      expect(mine.folderScope.segments).toEqual([CANARY_SEGMENT]);
      expect(mine.folderScope.expiresAt).toBeTruthy();
      expect(mine.operationConsent.expiresAt).toBeTruthy();
      const staff = (await call(ASSIGNEE, 'GET', base(session.id))).json().session;
      expect(staff.device).toBeNull();
      expect(staff.folderScope).toBeNull();
    });

    it('承認済みの Skill の数を返し、0 件なら提案できないと分かる', async () => {
      setManifest([]);
      const none = await startSession();
      const dto = (await call(OWNER, 'GET', base(none.id))).json().session;
      expect(dto.skillAvailability).toEqual({ readOnly: 0, userReversible: 0 });
      expect(dto.aiAvailable).toBe(false);
      setManifest(['folder.summary']);
      const read = (await call(OWNER, 'GET', base(none.id))).json().session;
      expect(read.skillAvailability).toEqual({ readOnly: 1, userReversible: 1 });
    });
  });

  describe('コードレビューの指摘 3 回目', () => {
    describe('1. 進行中のセッションは引継ぎごと（案件番号は相談者ごとの採番）', () => {
      /** 別の相談者の、同じ案件番号の引継ぎでセッションの前まで進める。 */
      async function otherRequesterSameCase(caseId: string) {
        const folder = await activeFolderRequest();
        await sql`
          UPDATE case_handovers SET case_id = ${caseId}, owner_email = ${OTHER_OWNER}
          WHERE id = ${folder.handoverId}
        `;
        await sql`
          UPDATE folder_access_requests SET case_id = ${caseId}, requester_email = ${OTHER_OWNER}
          WHERE id = ${folder.requestId}
        `;
        return folder;
      }

      it('別の相談者の同じ案件番号で、別人のセッションを返さない', async () => {
        const mine = await startSession();
        const cases = await sql<{ case_id: string }[]>`
          SELECT case_id FROM support_sessions WHERE id = ${mine.id}
        `;
        const other = await otherRequesterSameCase(cases[0]?.case_id ?? '');
        const created = await call(ASSIGNEE, 'POST', '/api/support-sessions', {
          handoverId: other.handoverId,
        });
        expect(created.statusCode, created.body).toBe(200);
        const session = created.json().session;
        expect(session.id).not.toBe(mine.id);
        expect(session.handoverId).toBe(other.handoverId);
        const rows = await sql<{ requester_email: string }[]>`
          SELECT requester_email FROM support_sessions WHERE id = ${session.id}
        `;
        expect(rows[0]?.requester_email).toBe(OTHER_OWNER);
        // 互いの本人パネルに混ざらない。
        const ownIds = (await call(OWNER, 'GET', '/api/support-sessions/mine'))
          .json()
          .sessions.map((item: { id: string }) => item.id);
        expect(ownIds).toContain(mine.id);
        expect(ownIds).not.toContain(session.id);
      });

      it('同じ引継ぎの 2 回目は同じセッションを返し、DB でも 2 件にならない', async () => {
        const session = await startSession();
        const again = await call(ASSIGNEE, 'POST', '/api/support-sessions', {
          handoverId: session.handoverId,
        });
        expect(again.json().session.id).toBe(session.id);
        const rows = await sql<
          { folder_request_id: string; case_id: string; expires_at: Date; lease_status: string }[]
        >`
          SELECT folder_request_id, case_id, expires_at, lease_status
          FROM support_sessions WHERE id = ${session.id}
        `;
        const row = rows[0];
        await expect(
          sql`
            INSERT INTO support_sessions (
              handover_id, case_id, requester_email, assignee_email, folder_request_id,
              lease_status, status, expires_at
            ) VALUES (
              ${session.handoverId}, ${`${row?.case_id}-dup`}, ${OWNER}, ${ASSIGNEE},
              ${row?.folder_request_id ?? ''}, ${row?.lease_status ?? ''}, 'ready',
              ${row?.expires_at ?? new Date()}
            )
          `,
        ).rejects.toThrow();
      });
    });

    describe('2. 停止の前に完了した実行', () => {
      async function modifyRunning(session: { id: string; token: string }) {
        const first = await executing(session);
        await report(session.token, first.op, resultBody(first.op, FOLDER_OUTPUT));
        const second = await propose(session.id);
        await decide(session.id, second.proposal.id, {
          decision: 'Y',
          approvalHash: second.proposal.approvalHash,
        });
        const op = (await poll(session.token)).skillOps?.[0] as Op;
        await start(session.token, op);
        return op;
      }
      const output = { applied: true, previousPresent: false, previousValue: null };

      it('completed_before_stop は停止にせず、変更の可能性を残す', async () => {
        setManifest(ALL_BUT_DISK);
        const session = await readySession();
        const op = await modifyRunning(session);
        await call(OWNER, 'POST', base(session.id, '/revoke'), {});
        await report(
          session.token,
          op,
          resultBody(op, output, { stopOutcome: 'completed_before_stop' }),
        );
        const execution = (await executionRows(session.id)).find((row) => row.id === op.opId);
        expect(execution?.stop_outcome).toBe('completed_before_stop');
        expect(execution?.stopped_at).toBeNull();
        expect(execution?.partial_effect).toContain('POSSIBLE_CHANGE');
      });

      it('動いた実行の not_running（ok の報告）は未実行として扱わない', async () => {
        setManifest(ALL_BUT_DISK);
        const session = await readySession();
        const op = await modifyRunning(session);
        await call(OWNER, 'POST', base(session.id, '/revoke'), {});
        await report(session.token, op, resultBody(op, output, { stopOutcome: 'not_running' }));
        const execution = (await executionRows(session.id)).find((row) => row.id === op.opId);
        expect(execution?.stop_outcome).toBe('completed_before_stop');
        expect(execution?.stopped_at).toBeNull();
        expect(execution?.partial_effect).toContain('POSSIBLE_CHANGE');
      });

      it('未確認の後に届いたら未確認だけを解消し、変更の可能性は残す', async () => {
        setManifest(ALL_BUT_DISK);
        const session = await readySession();
        const op = await modifyRunning(session);
        await call(OWNER, 'POST', base(session.id, '/revoke'), {});
        await sql`
          UPDATE assist_executions SET stop_requested_at = now() - interval '1 hour'
          WHERE id = ${op.opId}
        `;
        await sweepSupportSessions();
        await report(
          session.token,
          op,
          resultBody(op, output, { stopOutcome: 'completed_before_stop' }),
        );
        const execution = (await executionRows(session.id)).find((row) => row.id === op.opId);
        expect(execution?.partial_effect).toEqual(['POSSIBLE_CHANGE']);
      });
    });

    describe('4. 定期処理は 1 件の失敗で止まらない', () => {
      /** 指定の行の更新だけを失敗させる（合成の障害）。 */
      async function withFailingRow(table: string, id: string, run: () => Promise<void>) {
        await sql.unsafe(`
          CREATE OR REPLACE FUNCTION test_fail_row() RETURNS trigger AS $$
          BEGIN
            IF NEW.id = '${id}'::uuid THEN RAISE EXCEPTION 'synthetic sweep failure'; END IF;
            RETURN NEW;
          END $$ LANGUAGE plpgsql
        `);
        await sql.unsafe(`
          CREATE TRIGGER test_fail_row BEFORE UPDATE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION test_fail_row()
        `);
        try {
          await run();
        } finally {
          await sql.unsafe(`DROP TRIGGER test_fail_row ON ${table}`);
          await sql.unsafe('DROP FUNCTION test_fail_row()');
        }
      }

      it('セッションごとに捕捉してログし、他のセッションと保持期限の削除を続ける', async () => {
        const broken = await readySession();
        const healthy = await readySession();
        const retained = await readySession();
        await call(OWNER, 'POST', base(retained.id, '/revoke'), {});
        await sql`
          UPDATE support_sessions SET ended_at = now() - interval '400 days' WHERE id = ${retained.id}
        `;
        await sql`
          UPDATE support_sessions SET expires_at = now() - interval '1 second'
          WHERE id IN (${broken.id}, ${healthy.id})
        `;
        const errors: unknown[] = [];
        await withFailingRow('support_sessions', broken.id, async () => {
          await sweepSupportSessions({ error: (obj) => errors.push(obj) });
        });
        expect(errors.length).toBeGreaterThan(0);
        expect(JSON.stringify(errors)).toContain(broken.id);
        expect((await sessionRow(broken.id))?.status).toBe('ready');
        expect((await sessionRow(healthy.id))?.status).toBe('expired');
        const rows = await sql<{ sid: string | null }[]>`
          SELECT sid FROM support_sessions WHERE id = ${retained.id}
        `;
        expect(rows[0]?.sid).toBeNull();
      });

      it('報告期限の記録も 1 件の失敗で止まらない', async () => {
        const broken = await readySession();
        const brokenRun = await executing(broken);
        const healthy = await readySession();
        const healthyRun = await executing(healthy);
        await call(OWNER, 'POST', base(broken.id, '/revoke'), {});
        await call(OWNER, 'POST', base(healthy.id, '/revoke'), {});
        await sql`
          UPDATE folder_access_helpers SET revoked_at = now() - interval '25 hours'
          WHERE id IN (${broken.helperId}, ${healthy.helperId})
        `;
        const errors: unknown[] = [];
        await withFailingRow('assist_executions', brokenRun.op.opId, async () => {
          await sweepSupportSessions({ error: (obj) => errors.push(obj) });
        });
        expect(errors.length).toBeGreaterThan(0);
        const row = (await executionRows(healthy.id)).find((e) => e.id === healthyRun.op.opId);
        expect(row?.report_expired_at).not.toBeNull();
      });
    });

    it('8. 状態確認の 1 リクエストで承認の manifest を 1 回だけ読む', async () => {
      await startSession();
      await startSession();
      synth.manifestLoads = 0;
      const response = await call(OWNER, 'GET', '/api/support-sessions/mine');
      expect(response.json().sessions.length).toBeGreaterThanOrEqual(2);
      expect(synth.manifestLoads).toBe(1);
    });
  });

  describe('失効済みトークンの報告期限（410 RESULT_REPORT_EXPIRED）', () => {
    async function revokedDuringRun() {
      const session = await readySession();
      const { op } = await executing(session);
      await call(OWNER, 'POST', base(session.id, '/revoke'), {});
      return { session, op };
    }
    const ageRevocation = (helperId: string, age: string) =>
      sql`
        UPDATE folder_access_helpers SET revoked_at = now() - ${age}::interval WHERE id = ${helperId}
      `;
    const revokedAt = async (helperId: string) =>
      (
        await sql<{ revoked_at: Date }[]>`
          SELECT revoked_at FROM folder_access_helpers WHERE id = ${helperId}
        `
      )[0]?.revoked_at.getTime();
    const auditActions = async (id: string) =>
      sql<{ detail: unknown }[]>`
        SELECT detail FROM audit_log
        WHERE target_type = 'support_session' AND target_id = ${id}
          AND action = 'support_session.report_expired'
        ORDER BY id
      `;

    it('期限内は遅延結果（accepted:false）として保存する', async () => {
      const { session, op } = await revokedDuringRun();
      await ageRevocation(session.helperId, '23 hours');
      const response = await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, accepted: false, reason: 'LATE_RESULT' });
      expect((await executionRows(session.id))[0]?.late_result).toBe(true);
    });

    it('期限切れは 410 で保存せず、監査に機微を残さない', async () => {
      const { session, op } = await revokedDuringRun();
      await ageRevocation(session.helperId, '25 hours');
      const response = await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      expect(response.statusCode).toBe(410);
      expect(response.json().error.code).toBe('RESULT_REPORT_EXPIRED');
      expect(response.json()).not.toHaveProperty('accepted');
      const execution = (await executionRows(session.id))[0];
      expect(execution?.result_received_at).toBeNull();
      expect(execution?.normalized_output).toBeNull();
      expect(execution?.late_result).toBe(false);
      const audits = await auditActions(session.id);
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits)).toContain(op.opId);
      const text = JSON.stringify(audits);
      for (const canary of [SID, MACHINE, HOST, session.token, CANARY_SEGMENT]) {
        expect(text).not.toContain(canary);
      }
    });

    it('本文の形式より先に判定し、mock でも 410 を返す', async () => {
      const { session, op } = await revokedDuringRun();
      await ageRevocation(session.helperId, '25 hours');
      const malformed = await report(session.token, op, {});
      expect(malformed.statusCode).toBe(410);
      const mock = await report(
        session.token,
        op,
        resultBody(op, FOLDER_OUTPUT, { executionMode: 'mock' }),
      );
      expect(mock.statusCode).toBe(410);
    });

    it('再送・poll で期限が延びない', async () => {
      const { session, op } = await revokedDuringRun();
      await ageRevocation(session.helperId, '25 hours');
      const before = await revokedAt(session.helperId);
      for (let i = 0; i < 3; i += 1) {
        expect((await report(session.token, op, resultBody(op, FOLDER_OUTPUT))).statusCode).toBe(
          410,
        );
        expect((await poll(session.token)).revoked).toBe(true);
      }
      expect(await revokedAt(session.helperId)).toBe(before);
      await sweepSupportSessions();
      expect(await revokedAt(session.helperId)).toBe(before);
      expect((await report(session.token, op, resultBody(op, FOLDER_OUTPUT))).statusCode).toBe(410);
    });

    it('自分の実行でなければ 404 のまま', async () => {
      const { session } = await revokedDuringRun();
      await ageRevocation(session.helperId, '25 hours');
      const response = await helperCall(session.token, `ops/${RSP_DEVICE}/skill-result`, {});
      expect(response.statusCode).toBe(404);
    });

    it('失効していないトークンには期限がない', async () => {
      const session = await readySession();
      const { op } = await executing(session);
      await sql`
        UPDATE folder_access_helpers SET last_seen_at = now() WHERE id = ${session.helperId}
      `;
      const response = await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      expect(response.statusCode).toBe(200);
    });

    it('/start の扱いは変わらない（期限切れでも 409 で拒否を記録する）', async () => {
      const session = await readySession();
      await approveFirst(session);
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      await call(OWNER, 'POST', base(session.id, '/revoke'), {});
      await ageRevocation(session.helperId, '25 hours');
      const response = await start(session.token, op);
      expect(response.statusCode).toBe(409);
      expect(response.json().reason).toBe('SESSION_ENDED');
      expect((await executionRows(session.id))[0]?.status).toBe('rejected_at_start');
    });

    it('期限切れの後の状態: 報告済みにも停止確認済みにも数えず、監査を残し、期限で識別子を消す', async () => {
      const { session, op } = await revokedDuringRun();
      await ageRevocation(session.helperId, '25 hours');
      await sweepSupportSessions();
      const before = (await call(OWNER, 'GET', base(session.id))).json().session;
      expect(before.executions[0].phase).toBe('stop_unconfirmed');
      expect(before.executions[0].verification).toBe('unverified');
      expect(before.executions[0].reportExpiredAt).not.toBeNull();
      expect(before.executionSummary).toMatchObject({
        reported: 0,
        stopConfirmed: 0,
        stopUnconfirmed: 1,
      });

      // 期限を過ぎた報告は保存しない。再度届いても数えない。
      const late = await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      expect(late.statusCode).toBe(410);
      const stored = (await executionRows(session.id))[0];
      expect(stored?.result_received_at).toBeNull();
      expect(stored?.normalized_output).toBeNull();
      expect(stored?.evidence).toBe(false);
      expect(stored?.verify_ok).toBeNull();
      expect(stored?.stopped_at).toBeNull();
      const audits = await sql<{ detail: Record<string, unknown> }[]>`
        SELECT detail FROM audit_log
        WHERE action = 'support_session.report_expired' AND target_id = ${session.id}
        ORDER BY created_at
      `;
      expect(audits.map((row) => row.detail.source)).toEqual(['sweep', 'report']);

      await sql`UPDATE support_sessions SET ended_at = now() - interval '400 days' WHERE id = ${session.id}`;
      await sweepSupportSessions();
      const after = (await executionRows(session.id))[0];
      expect(after?.sid).toBeNull();
      expect(after?.helper_id).toBeNull();
      expect(after?.stop_outcome).toBe('stop_unconfirmed');
      expect(after?.report_expired_at).not.toBeNull();
      const view = (await call(OWNER, 'GET', base(session.id))).json();
      expect(view.session.endReason).toBe('requester_revoked');
    });

    it('失効の後でも期限内の結果は受け付け、次へ進めない', async () => {
      const { session, op } = await revokedDuringRun();
      const response = await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ accepted: false, reason: 'LATE_RESULT' });
      const view = (await call(OWNER, 'GET', base(session.id))).json().session;
      expect(view.executions[0].lateResult).toBe(true);
      expect(view.executions[0].verification).toBe('unverified');
      expect(view.executionSummary.reported).toBe(1);
      expect(view.status).toBe('revoked');
    });

    it('報告が来ないまま期限を過ぎた実行は sweep で停止未確認として残す', async () => {
      const { session } = await revokedDuringRun();
      await ageRevocation(session.helperId, '25 hours');
      await sweepSupportSessions();
      const execution = (await executionRows(session.id))[0];
      expect(execution?.report_expired_at).not.toBeNull();
      expect(execution?.stop_outcome).toBe('stop_unconfirmed');
      expect(execution?.stopped_at).toBeNull();
      expect(execution?.evidence).toBe(false);
      expect(execution?.verify_ok).toBeNull();
      expect(execution?.result_received_at).toBeNull();
      expect(execution?.status).not.toBe('completed');
      expect(await auditActions(session.id)).toHaveLength(1);
      // 同じ実行を 2 回記録しない。
      await sweepSupportSessions();
      expect(await auditActions(session.id)).toHaveLength(1);
      const response = await call(OWNER, 'GET', base(session.id));
      expect(response.json().session.executions[0].reportExpiredAt).not.toBeNull();
    });

    it('sweep は既存の stop_outcome / partial_effect を消さない', async () => {
      const { session } = await revokedDuringRun();
      await sql`
        UPDATE assist_executions
        SET stop_outcome = 'stop_failed', partial_effect = ${sql.json(['MARKER_WRITTEN'])}
        WHERE support_session_id = ${session.id}
      `;
      await ageRevocation(session.helperId, '25 hours');
      await sweepSupportSessions();
      const execution = (await executionRows(session.id))[0];
      expect(execution?.stop_outcome).toBe('stop_failed');
      expect(execution?.partial_effect).toEqual(['MARKER_WRITTEN']);
      expect(execution?.report_expired_at).not.toBeNull();
    });

    it('期限前に報告済み・未開始の実行は記録の対象にしない', async () => {
      const reported = await revokedDuringRun();
      await report(reported.session.token, reported.op, resultBody(reported.op, FOLDER_OUTPUT));
      await ageRevocation(reported.session.helperId, '25 hours');
      const unstarted = await readySession();
      await approveFirst(unstarted);
      await poll(unstarted.token);
      await call(OWNER, 'POST', base(unstarted.id, '/revoke'), {});
      await ageRevocation(unstarted.helperId, '25 hours');
      await sweepSupportSessions();
      const first = (await executionRows(reported.session.id))[0];
      expect(first?.report_expired_at).toBeNull();
      expect(first?.late_result).toBe(true);
      expect((await executionRows(unstarted.id))[0]?.report_expired_at).toBeNull();
    });
  });

  describe('結果の出所', () => {
    it.each(['mock', 'manual'])('既定では %s の報告を拒否し、何も保存しない', async (mode) => {
      const session = await readySession();
      const { op } = await executing(session);
      const response = await report(
        session.token,
        op,
        resultBody(op, FOLDER_OUTPUT, { executionMode: mode }),
      );
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('EXECUTION_MODE_REJECTED');
      const execution = (await executionRows(session.id))[0];
      expect(execution?.result_received_at).toBeNull();
      expect(execution?.status).toBe('executing');
    });

    it.each(['mock', 'manual'])('本番では検証用フラグがあっても %s を拒否する', async (mode) => {
      const session = await readySession();
      const { op } = await executing(session);
      config.ASSIST_ALLOW_MOCK_EXECUTION = true;
      config.isProduction = true;
      const response = await report(
        session.token,
        op,
        resultBody(op, FOLDER_OUTPUT, { executionMode: mode }),
      );
      expect(response.statusCode).toBe(403);
      expect((await executionRows(session.id))[0]?.execution_mode).toBeNull();
    });

    it.each(['mock', 'manual'])(
      '検証用フラグで %s を記録しても証拠にせず、進めない',
      async (mode) => {
        config.ASSIST_ALLOW_MOCK_EXECUTION = true;
        const session = await readySession();
        const { op } = await executing(session);
        const response = await report(
          session.token,
          op,
          resultBody(op, FOLDER_OUTPUT, { executionMode: mode }),
        );
        expect(response.json()).toEqual({ ok: true, accepted: false, reason: 'NOT_REAL' });
        const execution = (await executionRows(session.id))[0];
        expect(execution?.execution_mode).toBe(mode);
        expect(execution?.result_source).toBe('unverified_report');
        expect(execution?.evidence).toBe(false);
        expect(execution?.verify_ok).toBeNull();
        const row = await sessionRow(session.id);
        expect(row?.end_reason).toBe('unverifiable');
      },
    );

    it('DB の制約でも real 以外を証拠にできない', async () => {
      const session = await readySession();
      await executing(session);
      await expect(
        sql`UPDATE assist_executions SET execution_mode = 'mock', evidence = true WHERE support_session_id = ${session.id}`,
      ).rejects.toThrow();
    });

    it.each([
      ['スクリプトのハッシュが違う', { scriptHash: `sha256:${'f'.repeat(64)}` }],
      ['Skill が違う', { skillId: 'disk.space' }],
      ['版が違う', { skillVersion: '9.9.9' }],
      ['ok なのに終了コードが 0 でない', { exitCode: 1 }],
      ['未知の結果コード', { resultCode: 'TOTALLY_FINE' }],
      ['失敗の未知コード', { status: 'error', resultCode: 'TOTALLY_FINE', exitCode: 1 }],
    ])('改変: %s → 証拠にせず止める', async (_name, overrides) => {
      const session = await readySession();
      const { op } = await executing(session);
      const response = await report(session.token, op, resultBody(op, FOLDER_OUTPUT, overrides));
      expect(response.json()).toEqual({ ok: true, accepted: false, reason: 'RESULT_MISMATCH' });
      const execution = (await executionRows(session.id))[0];
      expect(execution?.evidence).toBe(false);
      expect(execution?.verify_ok).toBeNull();
      expect((await sessionRow(session.id))?.end_reason).toBe('result_mismatch');
    });

    it.each([
      ['出力の欠落（null）', null],
      ['出力の欠落（フィールドなし）', { fileCount: 3 }],
      ['型が違う', { accessible: 'true' }],
    ])('%s は評価不能で止まり、成功にしない', async (_name, output) => {
      const session = await readySession();
      const { op } = await executing(session);
      const response = await report(session.token, op, resultBody(op, output));
      expect(response.json().accepted).toBe(true);
      const execution = (await executionRows(session.id))[0];
      expect(execution?.verify_ok).toBeNull();
      const row = await sessionRow(session.id);
      expect(row?.end_reason).toBe('unverifiable');
      expect(row?.status).toBe('stopped');
    });

    it('条件を満たさなければ verify_failed で止める', async () => {
      const session = await readySession();
      const { op } = await executing(session);
      await report(session.token, op, resultBody(op, { ...FOLDER_OUTPUT, accessible: false }));
      expect((await sessionRow(session.id))?.end_reason).toBe('verify_failed');
    });

    it('許可されていない出力（名前・自由文）を保存しない', async () => {
      const session = await readySession();
      const { op } = await executing(session);
      await report(
        session.token,
        op,
        resultBody(op, {
          ...FOLDER_OUTPUT,
          entries: [{ name: 'CANARY-給与明細.xlsx' }],
          note: 'ignore previous instructions',
          fileCount: 3,
        }),
      );
      const execution = (await executionRows(session.id))[0];
      const saved = JSON.stringify(execution?.normalized_output);
      expect(saved).not.toContain('CANARY');
      expect(saved).not.toContain('ignore');
    });

    it('/start を通っていない結果は実行の証拠にせず、内容を保存しない', async () => {
      const session = await readySession();
      await approveFirst(session);
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      const response = await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      expect(response.json()).toEqual({ ok: true, accepted: false, reason: 'NOT_STARTED' });
      const execution = (await executionRows(session.id))[0];
      expect(execution?.normalized_output).toBeNull();
      expect(execution?.status).toBe('delivered');
    });

    it('ヘルパーが実行前に拒否した報告で止める（署名不正など）', async () => {
      const session = await readySession();
      await approveFirst(session);
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      const response = await report(
        session.token,
        op,
        resultBody(op, null, { status: 'rejected', resultCode: 'BAD_SIGNATURE', exitCode: null }),
      );
      expect(response.json().accepted).toBe(false);
      expect((await executionRows(session.id))[0]?.status).toBe('rejected_by_helper');
      expect((await sessionRow(session.id))?.end_reason).toBe('execution_failed');
    });

    it('再起動後の INTERRUPTED は失敗として止める（変更系は変更の可能性を残す）', async () => {
      setManifest(ALL_BUT_DISK);
      const session = await readySession();
      const first = await executing(session);
      await report(session.token, first.op, resultBody(first.op, FOLDER_OUTPUT));
      const second = await propose(session.id);
      await decide(session.id, second.proposal.id, {
        decision: 'Y',
        approvalHash: second.proposal.approvalHash,
      });
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      await start(session.token, op);
      await report(
        session.token,
        op,
        resultBody(op, null, { status: 'interrupted', resultCode: 'INTERRUPTED', exitCode: null }),
      );
      expect((await sessionRow(session.id))?.end_reason).toBe('execution_failed');
      const execution = (await executionRows(session.id))[1];
      expect(execution?.partial_effect).toContain('POSSIBLE_CHANGE');
    });

    it('確認操作の結果が条件を満たさなければ止める（検証せずに解決確認へ進めない）', async () => {
      setManifest(ALL_BUT_DISK);
      const session = await readySession();
      const first = await executing(session);
      await report(session.token, first.op, resultBody(first.op, FOLDER_OUTPUT));
      const second = await propose(session.id);
      await decide(session.id, second.proposal.id, {
        decision: 'Y',
        approvalHash: second.proposal.approvalHash,
      });
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      await start(session.token, op);
      await report(session.token, op, resultBody(op, { applied: true, previousPresent: false }));
      const verifyOp = (await poll(session.token)).skillOps?.[0] as Op;
      await start(session.token, verifyOp);
      await report(
        session.token,
        verifyOp,
        resultBody(verifyOp, { present: true, value: 'OTHER' }),
      );
      expect((await sessionRow(session.id))?.end_reason).toBe('verify_failed');
      expect(
        (await call(OWNER, 'POST', base(session.id, '/resolution'), { resolved: true })).statusCode,
      ).toBe(409);
    });
  });

  describe('上限と停止条件（§8）', () => {
    it('6 提案まで。7 件目は proposal_limit で止める', async () => {
      const session = await readySession();
      await sql`UPDATE support_sessions SET proposal_count = 5 WHERE id = ${session.id}`;
      const { session: sixth } = await propose(session.id);
      expect(sixth.proposalCount).toBe(ASSIST_LIMITS.maxProposals);
      const { op } = (await (async () => {
        const proposal = sixth.proposals.at(-1);
        await decide(session.id, proposal.id, {
          decision: 'Y',
          approvalHash: proposal.approvalHash,
        });
        const delivered = (await poll(session.token)).skillOps?.[0] as Op;
        await start(session.token, delivered);
        return { op: delivered };
      })()) as { op: Op };
      await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      const seventh = await call(ASSIGNEE, 'POST', base(session.id, '/proposals'), {});
      expect(seventh.statusCode).toBe(409);
      expect(seventh.json().error.code).toBe('PROPOSAL_LIMIT');
      const row = await sessionRow(session.id);
      expect(row?.end_reason).toBe('proposal_limit');
      expect(row?.proposal_count).toBe(6);
    });

    /** AI の提案で変更系を確認まで通す。 */
    async function runModify(
      session: { id: string; token: string },
      skillId: string,
      params: Record<string, unknown>,
      output: Record<string, unknown>,
      status: Record<string, unknown>,
    ) {
      world.aiReply = { skillId, params, rationale: '検証' };
      const { proposal } = await propose(session.id);
      expect(proposal.skillId).toBe(skillId);
      await decide(session.id, proposal.id, {
        decision: 'Y',
        approvalHash: proposal.approvalHash,
      });
      const op = (await poll(session.token)).skillOps?.[0] as Op;
      await start(session.token, op);
      await report(session.token, op, resultBody(op, output));
      const verifyOp = (await poll(session.token)).skillOps?.[0] as Op;
      await start(session.token, verifyOp);
      await report(session.token, verifyOp, resultBody(verifyOp, status));
    }

    async function aiSession() {
      setManifest(ALL_BUT_DISK);
      config.DEEPSEEK_API_KEY = 'synthetic-ai-key';
      const session = await readySession();
      await call(OWNER, 'POST', base(session.id, '/consents/ai-input'), {
        version: 'ai-input-consent/2',
        ttlMinutes: 30,
      });
      // 変更系の提案には、固定条件で確かめた読み取りが先に要る。
      world.aiReply = { skillId: 'folder.summary', params: { target: 'T1' }, rationale: '確認' };
      const { op } = await executing(session);
      await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      return session;
    }

    it('異なる変更系の成功は進捗として扱い、解決確認へ進む', async () => {
      const session = await aiSession();
      await runModify(
        session,
        'user.marker.set',
        { value: 'VERIFY_A' },
        { applied: true, previousPresent: false, previousValue: null },
        { present: true, value: 'VERIFY_A' },
      );
      await call(OWNER, 'POST', base(session.id, '/resolution'), { resolved: false });
      await runModify(
        session,
        'user.marker.set',
        { value: 'VERIFY_B' },
        { applied: true, previousPresent: true, previousValue: 'VERIFY_A' },
        { present: true, value: 'VERIFY_B' },
      );
      expect((await sessionRow(session.id))?.status).toBe('resolve_confirm');
    });

    it('Skill・params・出力が過去の実行と同じなら、直前でなくても進捗なしで止める', async () => {
      const session = await aiSession();
      const first = { applied: true, previousPresent: false, previousValue: null };
      await runModify(session, 'user.marker.set', { value: 'VERIFY_A' }, first, {
        present: true,
        value: 'VERIFY_A',
      });
      await call(OWNER, 'POST', base(session.id, '/resolution'), { resolved: false });
      await runModify(
        session,
        'user.marker.clear',
        {},
        { cleared: true, previousPresent: true, previousValue: 'VERIFY_A' },
        { present: false, value: null },
      );
      await call(OWNER, 'POST', base(session.id, '/resolution'), { resolved: false });
      // 重複の提案は先に止まるので、記録を合わせて「同じ操作が同じ結果を返した」場面を作る。
      await sql`
        UPDATE assist_executions SET params = ${sql.json({ value: 'VERIFY_B' })}
        WHERE support_session_id = ${session.id} AND role = 'main'
          AND skill_id = 'user.marker.set'
      `;
      await runModify(session, 'user.marker.set', { value: 'VERIFY_B' }, first, {
        present: true,
        value: 'VERIFY_B',
      });
      const row = await sessionRow(session.id);
      expect(row?.end_reason).toBe('no_progress');
    });

    it('交互の再提案（設定 → 消去 → 同じ設定）は止まり、解決確認へ進まない', async () => {
      const session = await aiSession();
      const first = { applied: true, previousPresent: false, previousValue: null };
      await runModify(session, 'user.marker.set', { value: 'VERIFY_A' }, first, {
        present: true,
        value: 'VERIFY_A',
      });
      await call(OWNER, 'POST', base(session.id, '/resolution'), { resolved: false });
      await runModify(
        session,
        'user.marker.clear',
        {},
        { cleared: true, previousPresent: true, previousValue: 'VERIFY_A' },
        { present: false, value: null },
      );
      await call(OWNER, 'POST', base(session.id, '/resolution'), { resolved: false });
      world.aiReply = { skillId: 'user.marker.set', params: { value: 'VERIFY_A' }, rationale: 'x' };
      await call(OWNER, 'POST', base(session.id, '/proposals'), {});
      expect((await sessionRow(session.id))?.end_reason).toBe('duplicate_proposal');
      expect(await noProposalDetail(session.id)).toMatchObject({ cause: 'ai_duplicate' });
    });

    it('同一操作の重複で止める（AI が同じ操作を再提案）', async () => {
      config.DEEPSEEK_API_KEY = 'synthetic-ai-key';
      const session = await readySession();
      await call(OWNER, 'POST', base(session.id, '/consents/ai-input'), {
        version: 'ai-input-consent/2',
        ttlMinutes: 30,
      });
      world.aiReply = { skillId: 'folder.summary', params: { target: 'T1' }, rationale: '確認' };
      const { op } = await executing(session);
      await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      await propose(session.id).catch(() => undefined);
      const response = await call(OWNER, 'GET', base(session.id));
      expect(response.json().session.endReason).toBe('duplicate_proposal');
    });

    it('操作範囲 read_only では変更系を提案しない（候補が尽きたら止める）', async () => {
      setManifest(ALL_BUT_DISK);
      const session = await readySession('read_only');
      const { op } = await executing(session);
      await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      const { session: after } = await propose(session.id);
      expect(after.status).toBe('stopped');
      expect(after.endReason).toBe('no_candidate');
      expect(after.proposals.length).toBe(1);
      expect(await noProposalDetail(session.id)).toMatchObject({
        reason: 'no_candidate',
        cause: 'no_rule',
      });
    });

    it('AI が操作範囲の外を選んでも採用しない', async () => {
      setManifest(ALL_BUT_DISK);
      config.DEEPSEEK_API_KEY = 'synthetic-ai-key';
      const session = await readySession('read_only');
      await call(OWNER, 'POST', base(session.id, '/consents/ai-input'), {
        version: 'ai-input-consent/2',
        ttlMinutes: 30,
      });
      world.aiReply = { skillId: 'user.marker.set', params: { value: 'VERIFY_A' }, rationale: 'x' };
      const { proposal } = await propose(session.id);
      expect(proposal.skillId).toBe('folder.summary');
      expect(proposal.proposalSource).toBe('rule');
    });

    it('承認されていない Skill は提案しない（合成 manifest が空）', async () => {
      setManifest([]);
      const session = await readySession();
      const { session: after } = await propose(session.id);
      expect(after.status).toBe('stopped');
      expect(after.endReason).toBe('no_candidate');
    });

    it('確認操作を実行できない変更系は提案しない', async () => {
      setManifest(['folder.summary', 'user.marker.set']);
      const session = await readySession();
      const { op } = await executing(session);
      await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      const { session: after } = await propose(session.id);
      expect(after.endReason).toBe('no_candidate');
      expect(after.proposals).toHaveLength(1);
    });
  });

  describe('AI へ渡す内容（送信する HTTP 本文で確認）', () => {
    const AI_CANARIES = [
      SID,
      MACHINE,
      HOST,
      'canary-user',
      CANARY_SEGMENT,
      CANARY_SUBJECT,
      OWNER,
      ASSIGNEE,
      'node//synth',
      RSP_DEVICE,
      'CANARY',
    ];

    async function withAi(scope: 'read_only' | 'user_reversible' = 'user_reversible') {
      setManifest(ALL_BUT_DISK);
      config.DEEPSEEK_API_KEY = 'synthetic-ai-key';
      const session = await readySession(scope);
      const consent = await call(OWNER, 'POST', base(session.id, '/consents/ai-input'), {
        version: 'ai-input-consent/2',
        ttlMinutes: 30,
      });
      expect(consent.statusCode, consent.body).toBe(200);
      return session;
    }

    it('同意がなければ AI を呼ばず、proposal_source=rule を保存する', async () => {
      config.DEEPSEEK_API_KEY = 'synthetic-ai-key';
      const session = await readySession();
      const { proposal } = await propose(session.id);
      expect(world.aiBodies).toEqual([]);
      expect(proposal.proposalSource).toBe('rule');
      const rows = await sql<{ proposal_source: string }[]>`
      SELECT proposal_source FROM assist_proposals WHERE id = ${proposal.id}
    `;
      expect(rows[0]?.proposal_source).toBe('rule');
    });

    it('AI の応答待ちに取り消して再同意しても、取消前の応答を採用しない', async () => {
      const session = await withAi();
      world.aiReply = { skillId: 'folder.summary', params: { target: 'T1' }, rationale: '確認' };
      world.onAi = async () => {
        const revoked = await call(
          OWNER,
          'POST',
          base(session.id, '/consents/ai-input/revoke'),
          {},
        );
        expect(revoked.statusCode, revoked.body).toBe(200);
        const again = await call(OWNER, 'POST', base(session.id, '/consents/ai-input'), {
          version: 'ai-input-consent/2',
          ttlMinutes: 30,
        });
        expect(again.statusCode, again.body).toBe(200);
      };
      const response = await call(OWNER, 'POST', base(session.id, '/proposals'), {});
      world.onAi = undefined;
      expect(world.aiBodies).toHaveLength(1);
      const proposals = await sql`
        SELECT id FROM assist_proposals WHERE support_session_id = ${session.id}
      `;
      expect(proposals, response.body).toHaveLength(0);
      const rows = await sql<{ status: string; end_reason: string }[]>`
        SELECT status, end_reason FROM support_sessions WHERE id = ${session.id}
      `;
      expect(rows[0]?.end_reason).toBe('ai_consent_changed');
    });

    describe('AI の応答待ちに同意が変わると、応答の種類によらず同じ理由で止める', () => {
      const revokeDuringAi = (id: string) => async () => {
        const revoked = await call(OWNER, 'POST', base(id, '/consents/ai-input/revoke'), {});
        expect(revoked.statusCode, revoked.body).toBe(200);
      };
      const reconsentDuringAi = (id: string) => async () => {
        await revokeDuringAi(id)();
        const again = await call(OWNER, 'POST', base(id, '/consents/ai-input'), {
          version: 'ai-input-consent/2',
          ttlMinutes: 30,
        });
        expect(again.statusCode, again.body).toBe(200);
      };
      const expireDuringAi = (id: string) => async () => {
        await sql`
          UPDATE support_sessions SET ai_input_consent_expires_at = now() - interval '1 second'
          WHERE id = ${id}
        `;
      };
      const changeExpiryDuringAi = (id: string) => async () => {
        await sql`
          UPDATE support_sessions
          SET ai_input_consent_expires_at = ai_input_consent_expires_at + interval '1 minute'
          WHERE id = ${id}
        `;
      };

      async function proposeDuringChange(id: string, change: () => Promise<void>) {
        world.onAi = change;
        const response = await call(OWNER, 'POST', base(id, '/proposals'), {});
        world.onAi = undefined;
        expect(world.aiBodies.length, response.body).toBeGreaterThan(0);
        const rows = await sql<{ status: string; end_reason: string | null }[]>`
          SELECT status, end_reason FROM support_sessions WHERE id = ${id}
        `;
        const proposals = await sql`
          SELECT id, status FROM assist_proposals WHERE support_session_id = ${id}
        `;
        return { row: rows[0], proposals };
      }

      it.each([
        ['取消', revokeDuringAi],
        ['取消して再同意', reconsentDuringAi],
        ['期限切れ', expireDuringAi],
        ['期限の変更', changeExpiryDuringAi],
      ])('stop の応答: %s', async (_name, change) => {
        const session = await withAi();
        world.aiReply = { skillId: '', decision: 'stop', rationale: '終了' };
        const { row } = await proposeDuringChange(session.id, change(session.id));
        expect(row).toEqual({ status: 'stopped', end_reason: 'ai_consent_changed' });
      });

      it.each([
        ['取消', revokeDuringAi],
        ['取消して再同意', reconsentDuringAi],
        ['期限切れ', expireDuringAi],
      ])('escalate の応答: %s', async (_name, change) => {
        const session = await withAi();
        world.aiReply = { skillId: '', decision: 'escalate', rationale: '人手' };
        const { row } = await proposeDuringChange(session.id, change(session.id));
        expect(row).toEqual({ status: 'stopped', end_reason: 'ai_consent_changed' });
      });

      it.each([
        ['取消', revokeDuringAi],
        ['取消して再同意', reconsentDuringAi],
        ['期限切れ', expireDuringAi],
      ])('confirm（検証済みの後の stop）: %s', async (_name, change) => {
        const session = await withAi();
        world.aiReply = { skillId: 'folder.summary', params: { target: 'T1' }, rationale: '確認' };
        const { op } = await executing(session);
        await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
        world.aiReply = { skillId: '', decision: 'stop', rationale: '解決' };
        const { row } = await proposeDuringChange(session.id, change(session.id));
        expect(row).toEqual({ status: 'stopped', end_reason: 'ai_consent_changed' });
      });

      it('AI の応答が使えなくても、ルールベースへ切り替えて提案しない', async () => {
        const session = await withAi();
        world.aiReply = { skillId: 'system.shutdown', params: {} };
        const { row, proposals } = await proposeDuringChange(
          session.id,
          revokeDuringAi(session.id),
        );
        expect(row).toEqual({ status: 'stopped', end_reason: 'ai_consent_changed' });
        expect(proposals).toHaveLength(0);
      });

      it('重複の応答でも同意の変更を理由に止める', async () => {
        const session = await withAi();
        world.aiReply = { skillId: 'folder.summary', params: { target: 'T1' }, rationale: '確認' };
        const { op } = await executing(session);
        await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
        const { row } = await proposeDuringChange(session.id, revokeDuringAi(session.id));
        expect(row).toEqual({ status: 'stopped', end_reason: 'ai_consent_changed' });
      });

      it('同意が変わらなければ escalate はそのまま進む', async () => {
        const session = await withAi();
        world.aiReply = { skillId: '', decision: 'escalate', rationale: '人手' };
        const { row } = await proposeDuringChange(session.id, async () => undefined);
        expect(row).toEqual({ status: 'escalated', end_reason: 'escalated' });
      });
    });

    it('同意を取り消せば AI を呼ばない', async () => {
      const session = await withAi();
      const revoked = await call(OWNER, 'POST', base(session.id, '/consents/ai-input/revoke'), {});
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect(revoked.json().session.aiInputConsent).toBeNull();
      const { proposal } = await propose(session.id);
      expect(world.aiBodies).toEqual([]);
      expect(proposal.proposalSource).toBe('rule');
    });

    it('構造化要約だけを渡す（実パス・名前・SID・ホスト名・自由文を含まない）', async () => {
      const session = await withAi();
      world.aiReply = {
        skillId: 'folder.summary',
        params: { target: 'T1' },
        rationale: '状態の確認',
      };
      const { proposal, op } = await executing(session);
      expect(proposal.proposalSource).toBe('deepseek');
      const rows = await sql<{ proposal_source: string }[]>`
      SELECT proposal_source FROM assist_proposals WHERE id = ${proposal.id}
    `;
      expect(rows[0]?.proposal_source).toBe('deepseek');

      // 端末の出力に紛れた名前・自由文（許可外フィールドと文字列）も次の入力へ渡らない。
      await report(
        session.token,
        op,
        resultBody(op, {
          ...FOLDER_OUTPUT,
          name: 'CANARY-給与明細.xlsx',
          path: `C:\\Users\\canary-user\\${CANARY_SEGMENT}`,
        }),
      );
      world.aiReply = {
        skillId: 'user.marker.set',
        params: { value: 'VERIFY_B' },
        rationale: '検証',
      };
      await propose(session.id);

      expect(world.aiBodies.length).toBe(2);
      for (const body of world.aiBodies) {
        for (const canary of AI_CANARIES) expect(body).not.toContain(canary);
        expect(body).not.toContain('C:\\\\');
      }
      const request = JSON.parse(world.aiBodies[1] as string);
      const content = JSON.parse(request.messages[1].content);
      expect(Object.keys(content).sort()).toEqual([
        'executed',
        'facts',
        'skillCatalog',
        'skillTags',
      ]);
      expect(content.facts.schema).toBe('assist-ai-input/2');
      expect(content.facts.case).toEqual({
        caseCategory: 'storage',
        symptomTags: ['folder_missing', 'storage_full'],
        purpose: 'repair',
        confirmedFacts: ['FOLDER_ACCESSIBLE', 'FOLDER_HAS_ENTRIES'],
        // ID と固定タグだけ（シードの承認済みナレッジが含まれる）。
        knowledgeRefs: expect.any(Array),
      });
      for (const ref of content.facts.case.knowledgeRefs) {
        expect(Object.keys(ref).sort()).toEqual(['id', 'tags']);
      }
      expect(content.facts.targets).toEqual([{ ref: 'T1', rootKind: 'Documents' }]);
      expect(content.facts.steps[0]).toEqual({
        skillId: 'folder.summary',
        effect: 'read',
        resultCode: 'FOLDER_SUMMARY_OK',
        verified: true,
        summary: {
          accessible: true,
          fileCount: 3,
          directoryCount: 1,
          linkCount: 0,
          totalBytes: 2048,
          truncated: false,
        },
      });
      expect(content.executed).toEqual([{ skillId: 'folder.summary', params: { target: 'T1' } }]);
    });

    it.each([
      ['登録外の Skill', { skillId: 'system.shutdown', params: {} }],
      ['実パスの params', { skillId: 'folder.summary', params: { target: 'C:\\Users\\x' } }],
      ['未定義の params', { skillId: 'folder.summary', params: { target: 'T1', command: 'calc' } }],
      ['コマンド文字列', { command: 'Remove-Item C:\\ -Recurse' }],
      ['確認専用の Skill', { skillId: 'user.marker.status', params: {} }],
    ])('AI の %s を採用しない（ルールへ戻る）', async (_name, reply) => {
      const session = await withAi();
      world.aiReply = reply;
      const { proposal } = await propose(session.id);
      expect(proposal.proposalSource).toBe('rule');
      expect(proposal.skillId).toBe('folder.summary');
      expect(proposal.status).toBe('proposed');
    });

    it('AI の説明文は表示用で、個人情報を伏せる', async () => {
      const session = await withAi();
      world.aiReply = {
        skillId: 'folder.summary',
        params: { target: 'T1' },
        rationale: '連絡先 someone@example.com を確認',
      };
      const { proposal } = await propose(session.id);
      expect(proposal.rationale).toBeNull();
      expect(proposal.aiGuess).toContain('確認');
      expect(proposal.aiGuess).not.toContain('someone@example.com');
    });

    it('AI の引継ぎは担当者へ渡す。解決の宣言（stop）は受けない', async () => {
      const escalated = await withAi();
      world.aiReply = { skillId: '', decision: 'handover', rationale: '人手が必要' };
      const after = await propose(escalated.id);
      expect(after.session.status).toBe('escalated');

      const stopped = await withAi();
      world.aiReply = { skillId: '', decision: 'stop', rationale: '解決しました' };
      const afterStop = await propose(stopped.id);
      expect(afterStop.session.status).toBe('awaiting_approval');
      expect(afterStop.proposal.proposalSource).toBe('rule');
      expect(afterStop.proposal.effect).toBe('read');
    });

    it('検証済みの後の AI の stop でも解決にせず、本人の確認まで進めない', async () => {
      const session = await withAi();
      world.aiReply = { skillId: 'folder.summary', params: { target: 'T1' }, rationale: '確認' };
      const { op } = await executing(session);
      await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      world.aiReply = { skillId: '', decision: 'stop', rationale: '解決' };
      const response = await call(OWNER, 'POST', base(session.id, '/proposals'), {});
      expect(response.json().session.status).not.toBe('resolved');
      expect(response.json().session.status).not.toBe('resolve_confirm');
    });

    describe('相談例（Mock: DeepSeek の応答。提案の検証は実物）', () => {
      const setSubject = (handoverId: string, subject: string) => sql`
        UPDATE case_handovers
        SET snapshot = snapshot || ${sql.json({
          case: { subject },
          chat: { messages: [{ kind: 'user', text: subject }] },
        })}
        WHERE id = ${handoverId}
      `;
      async function consultation(subject: string, scope?: 'read_only' | 'user_reversible') {
        const session = await withAi(scope);
        setManifest();
        await setSubject(session.handoverId, subject);
        return session;
      }
      const lastInput = () => {
        const request = JSON.parse(world.aiBodies.at(-1) as string);
        return JSON.parse(request.messages[1].content);
      };

      it('容量の相談: 症状に合う診断を選び、理由を固定コードで返す', async () => {
        const session = await consultation('ディスクの容量が不足して保存できません');
        world.aiReply = { skillId: 'disk.space', params: {}, rationale: '空き容量の確認が必要' };
        const { proposal } = await propose(session.id);
        expect(proposal.skillId).toBe('disk.space');
        expect(proposal.proposalSource).toBe('deepseek');
        expect(proposal.effect).toBe('read');
        expect(proposal.reasonCodes).toEqual(
          expect.arrayContaining(['AI_SELECTED', 'SYMPTOM_MATCH']),
        );
        expect(proposal.aiGuess).toBe('空き容量の確認が必要');
        expect(lastInput().facts.case).toMatchObject({
          caseCategory: 'storage',
          symptomTags: ['storage_full', 'save_failed'],
        });
        expect(world.aiBodies.at(-1)).not.toContain('保存できません');
      });

      it('フォルダの相談: 対応する読取の診断を選べる', async () => {
        const session = await consultation('共有のフォルダが見つかりません');
        world.aiReply = { skillId: 'folder.summary', params: { target: 'T1' }, rationale: '確認' };
        const { proposal } = await propose(session.id);
        expect(proposal.skillId).toBe('folder.summary');
        expect(proposal.reasonCodes).toContain('SYMPTOM_MATCH');
      });

      it('根拠不足: 症状が分からない相談では読取でも選ばず、担当者へ引き継ぐ', async () => {
        const session = await consultation('よろしくお願いします');
        world.aiReply = { skillId: 'disk.space', params: {}, rationale: '念のため' };
        const { session: after } = await propose(session.id);
        expect(after.status).toBe('escalated');
        expect(after.proposals).toHaveLength(0);
        expect(lastInput().facts.case.symptomTags).toEqual([]);
        expect(lastInput().facts.case.caseCategory).toBe('other');
        // 実機では理由を追えなかった。監査に固定語彙だけで残す（AI の文面は残さない）。
        const detail = await noProposalDetail(session.id);
        expect(detail).toMatchObject({ reason: 'escalated', cause: 'ai_no_symptom_match' });
        expect(JSON.stringify(detail)).not.toContain('念のため');
      });

      it('根拠不足: 確かめた読み取りが無ければ変更を提案しない', async () => {
        const session = await consultation('保存できません');
        world.aiReply = {
          skillId: 'user.marker.set',
          params: { value: 'VERIFY_A' },
          rationale: 'x',
        };
        const { session: after } = await propose(session.id);
        expect(after.status).toBe('escalated');
        expect(after.proposals).toHaveLength(0);
        expect(await noProposalDetail(session.id)).toMatchObject({
          cause: 'ai_modify_without_verified',
        });
      });

      it('非対応の相談: AI の引継ぎで担当者へ渡す', async () => {
        const session = await consultation('プリンタで印刷できません');
        world.aiReply = { skillId: '', decision: 'handover' };
        const { session: after } = await propose(session.id);
        expect(after.status).toBe('escalated');
        expect(lastInput().facts.case.caseCategory).toBe('printing');
        expect(await noProposalDetail(session.id)).toMatchObject({ cause: 'ai_handover' });
      });

      it('AI の障害と無効な応答を、監査で区別する', async () => {
        const failed = await consultation('プリンタで印刷できません');
        world.onAi = async () => {
          throw new Error('synthetic outage');
        };
        const first = await propose(failed.id);
        expect(first.session.status).toBe('escalated');
        expect(await noProposalDetail(failed.id)).toMatchObject({
          cause: 'unsupported_symptom',
          aiOutcome: 'ai_error',
        });
        world.onAi = undefined;

        const invalid = await consultation('プリンタで印刷できません');
        world.aiReply = { skillId: '', decision: 'stop' };
        const second = await propose(invalid.id);
        expect(second.session.status).toBe('escalated');
        expect(await noProposalDetail(invalid.id)).toMatchObject({
          cause: 'unsupported_symptom',
          aiOutcome: 'ai_invalid',
        });
      });

      it('非対応の相談: AI が合わない診断を選んでも採用しない', async () => {
        const session = await consultation('プリンタで印刷できません');
        world.aiReply = { skillId: 'disk.space', params: {}, rationale: '容量かも' };
        const { session: after } = await propose(session.id);
        expect(after.status).toBe('escalated');
        expect(after.proposals).toHaveLength(0);
      });

      it('非対応の相談: AI を使わないルールでも操作を提案せず、引き継ぐ', async () => {
        config.DEEPSEEK_API_KEY = undefined;
        const session = await readySession();
        await setSubject(session.handoverId, 'プリンタで印刷できません');
        const { session: after } = await propose(session.id);
        expect(after.status).toBe('escalated');
        expect(after.proposals).toHaveLength(0);
        const detail = await noProposalDetail(session.id);
        expect(detail).toMatchObject({ cause: 'unsupported_symptom' });
        expect(detail).not.toHaveProperty('aiOutcome');
      });

      it('AI が使えない場合のルールは読取だけ（AI の失敗を変更の根拠にしない）', async () => {
        const session = await consultation('フォルダが見つかりません');
        setManifest(['folder.summary', 'user.marker.set', 'user.marker.status']);
        world.aiReply = { skillId: 'folder.summary', params: { target: 'T1' }, rationale: '確認' };
        const { op } = await executing(session);
        await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
        world.aiReply = { skillId: 'system.shutdown', params: {} };
        const { session: after } = await propose(session.id);
        // 読取は実行済みなので候補が無く、変更系へ置き換えず引き継ぐ。
        expect(after.status).toBe('escalated');
        expect(after.proposals).toHaveLength(1);
      });

      it.each([
        ['assessment が resolved', { assessment: 'resolved', rationale: '状況の確認' }],
        ['説明文が解決を示す', { rationale: 'もう解決しました' }],
      ])('検証結果と矛盾する説明は採用しない: %s', async (_name, reply) => {
        const session = await consultation('フォルダが見つかりません');
        await sql`
          UPDATE assist_proposals SET verify_ok = NULL WHERE support_session_id = ${session.id}
        `;
        world.aiReply = { skillId: 'disk.space', params: {}, ...reply };
        setManifest();
        const subjectSession = await setSubject(session.handoverId, '容量が不足しています');
        expect(subjectSession).toBeDefined();
        const { proposal, session: after } = await propose(session.id);
        expect(proposal.skillId).toBe('disk.space');
        expect(proposal.aiGuess).toBeNull();
        expect(proposal.reasonCodes).toContain('AI_EXPLANATION_REJECTED');
        expect(after.status).toBe('awaiting_approval');
        expect(after.verifiedFacts.every((fact: { ok: boolean }) => fact.ok === true)).toBe(true);
      });

      it('検証済みの事実と AI の推測を分けて返す', async () => {
        const session = await consultation('容量が不足しています');
        world.aiReply = { skillId: 'folder.summary', params: { target: 'T1' }, rationale: '確認' };
        const { op } = await executing(session);
        await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
        world.aiReply = { skillId: 'disk.space', params: {}, rationale: '次は容量を確認' };
        const { proposal, session: after } = await propose(session.id);
        expect(proposal.aiGuess).toBe('次は容量を確認');
        expect(after.verifiedFacts).toEqual([
          {
            stepSeq: 1,
            role: 'main',
            skillId: 'folder.summary',
            condition: 'フォルダへアクセスできた',
            ok: true,
          },
        ]);
      });

      it('承認済みナレッジは ID と固定タグだけを渡す（本文・タイトル・下書きを渡さない）', async () => {
        const users = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
        sequence += 1;
        const rows = await sql<{ id: string }[]>`
          INSERT INTO knowledge (kb_no, title, symptom, cause, steps, keywords, status, author_id)
          VALUES
            (${`KB-SS-A-${sequence}`}, 'CANARY-KB-TITLE', 'CANARY-KB-SYMPTOM', 'CANARY', 'CANARY',
             ${['容量', 'CANARY-KEYWORD']}, 'approved', ${users[0]?.id ?? ''}),
            (${`KB-SS-D-${sequence}`}, 'CANARY-DRAFT', 'x', 'x', 'x', ${['容量']}, 'draft',
             ${users[0]?.id ?? ''})
          RETURNING id, status
        `;
        try {
          const session = await consultation('容量が不足しています');
          world.aiReply = { skillId: 'disk.space', params: {}, rationale: '確認' };
          const { proposal } = await propose(session.id);
          const body = world.aiBodies.at(-1) as string;
          expect(body).not.toContain('CANARY');
          const refs = lastInput().facts.case.knowledgeRefs;
          expect(refs.some((ref: { id: string }) => ref.id === rows[0]?.id)).toBe(true);
          expect(refs.some((ref: { id: string }) => ref.id === rows[1]?.id)).toBe(false);
          expect(refs.find((ref: { id: string }) => ref.id === rows[0]?.id).tags).toEqual([
            'storage_full',
          ]);
          expect(proposal.reasonCodes).toContain('KNOWLEDGE_REF');
        } finally {
          await sql`DELETE FROM knowledge WHERE id IN (${rows[0]?.id ?? ''}, ${rows[1]?.id ?? ''})`;
        }
      });

      describe('画面で作って別人が承認したナレッジ', () => {
        const FULL_CHECKLIST = {
          reproducible: true,
          noSecrets: true,
          noBlame: true,
          scopeClear: true,
        };
        const uiKnowledge = async (status: 'pending' | 'approved', ref: string) => {
          const payload = {
            clientRef: ref,
            title: 'CANARY-UI-TITLE 容量が足りないときの対処',
            symptom: 'CANARY-UI-SYMPTOM ディスクの容量が不足して保存できません',
            cause: 'CANARY-UI-CAUSE',
            steps: 'CANARY-UI-STEPS',
            // 画面の同期は keywords を常に空で送る（assist-bridge.js の ahKnowledgeSyncPayload）。
            keywords: [],
          };
          const drafted = await call(ASSIGNEE, 'POST', '/api/knowledge/ui-sync', {
            ...payload,
            status: 'pending',
          });
          expect(drafted.statusCode, drafted.body).toBe(200);
          if (status === 'pending') return drafted.json().knowledge.id as string;
          const approved = await call(APPROVER_ONLY, 'POST', '/api/knowledge/ui-sync', {
            ...payload,
            status: 'approved',
            contentHash: await reviewedHash(ref),
            checklist: FULL_CHECKLIST,
          });
          expect(approved.statusCode, approved.body).toBe(200);
          expect(approved.json().selfApproved).toBe(false);
          return approved.json().knowledge.id as string;
        };
        const removeUiKnowledge = async (ref: string) => {
          await sql`DELETE FROM knowledge WHERE client_ref = ${ref}`;
        };

        it('承認で固定のタグを保存し、参照に入る。自由文を AI へ渡さない', async () => {
          sequence += 1;
          const ref = `ui-ss-kb-${sequence}`;
          try {
            const id = await uiKnowledge('approved', ref);
            const stored = await sql<{ symptom_tags: string[] | null; keywords: string[] }[]>`
              SELECT symptom_tags, keywords FROM knowledge WHERE id = ${id}
            `;
            expect(stored[0]?.keywords).toEqual([]);
            expect(stored[0]?.symptom_tags).toEqual(['storage_full', 'save_failed']);

            const session = await consultation('容量が不足しています');
            world.aiReply = { skillId: 'disk.space', params: {}, rationale: '確認' };
            const { proposal } = await propose(session.id);
            const body = world.aiBodies.at(-1) as string;
            expect(body).not.toContain('CANARY-UI');
            const refs = lastInput().facts.case.knowledgeRefs;
            expect(refs).toContainEqual({ id, tags: ['storage_full'] });
            expect(proposal.reasonCodes).toContain('KNOWLEDGE_REF');
          } finally {
            await removeUiKnowledge(ref);
          }
        });

        it('承認待ちは参照に入らず、タグも保存しない', async () => {
          sequence += 1;
          const ref = `ui-ss-kb-${sequence}`;
          try {
            const id = await uiKnowledge('pending', ref);
            const stored = await sql<{ symptom_tags: string[] | null }[]>`
              SELECT symptom_tags FROM knowledge WHERE id = ${id}
            `;
            expect(stored[0]?.symptom_tags).toBeNull();
            const session = await consultation('容量が不足しています');
            world.aiReply = { skillId: 'disk.space', params: {}, rationale: '確認' };
            await propose(session.id);
            const refs = lastInput().facts.case.knowledgeRefs;
            expect(refs.some((item: { id: string }) => item.id === id)).toBe(false);
          } finally {
            await removeUiKnowledge(ref);
          }
        });

        it('タグの列を導入する前に承認された行は、本文から固定のタグだけを求める', async () => {
          sequence += 1;
          const ref = `ui-ss-kb-${sequence}`;
          try {
            const id = await uiKnowledge('approved', ref);
            await sql`UPDATE knowledge SET symptom_tags = NULL WHERE id = ${id}`;
            const session = await consultation('容量が不足しています');
            world.aiReply = { skillId: 'disk.space', params: {}, rationale: '確認' };
            await propose(session.id);
            expect(world.aiBodies.at(-1)).not.toContain('CANARY-UI');
            expect(lastInput().facts.case.knowledgeRefs).toContainEqual({
              id,
              tags: ['storage_full'],
            });
          } finally {
            await removeUiKnowledge(ref);
          }
        });

        it('列を手で書き換えても、固定の語彙の外は AI へ渡さない', async () => {
          sequence += 1;
          const ref = `ui-ss-kb-${sequence}`;
          try {
            const id = await uiKnowledge('approved', ref);
            await sql`
              UPDATE knowledge SET symptom_tags = ${['storage_full', 'CANARY-UI-TAG']}
              WHERE id = ${id}
            `;
            const session = await consultation('容量が不足しています');
            world.aiReply = { skillId: 'disk.space', params: {}, rationale: '確認' };
            await propose(session.id);
            expect(world.aiBodies.at(-1)).not.toContain('CANARY-UI');
            expect(lastInput().facts.case.knowledgeRefs).toContainEqual({
              id,
              tags: ['storage_full'],
            });
          } finally {
            await removeUiKnowledge(ref);
          }
        });
      });

      it('古い版の同意では案件の情報を渡さない', async () => {
        const session = await consultation('容量が不足しています');
        await sql`
          UPDATE support_sessions SET ai_input_consent_version = 'ai-input-consent/1'
          WHERE id = ${session.id}
        `;
        world.aiReply = { skillId: 'disk.space', params: {}, rationale: '確認' };
        await propose(session.id);
        const facts = lastInput().facts;
        expect(facts.schema).toBe('assist-ai-input/1');
        expect(facts).not.toHaveProperty('case');
        expect(world.aiBodies.at(-1)).not.toContain('storage_full"]');
      });

      it('古い版の同意は新たに受け付けない', async () => {
        const session = await readySession();
        const response = await call(OWNER, 'POST', base(session.id, '/consents/ai-input'), {
          version: 'ai-input-consent/1',
          ttlMinutes: 30,
        });
        expect(response.statusCode).toBe(400);
      });

      it('別の案件のスナップショットの内容が混ざらない', async () => {
        const session = await consultation('容量が不足しています');
        const other = await makeHandover();
        await setSubject(other, 'プリンタで印刷できません CANARY-他人の相談');
        world.aiReply = { skillId: 'disk.space', params: {}, rationale: '確認' };
        await propose(session.id);
        expect(lastInput().facts.case.symptomTags).toEqual(['storage_full']);
        expect(world.aiBodies.at(-1)).not.toContain('CANARY');
      });
    });
  });

  describe('監査に機微なし', () => {
    it('SID・パス・ホスト名・トークン・出力を監査へ書かない', async () => {
      setManifest(ALL_BUT_DISK);
      const session = await readySession();
      const { op } = await executing(session);
      await report(
        session.token,
        op,
        resultBody(op, { ...FOLDER_OUTPUT, name: 'CANARY-給与明細.xlsx' }),
      );
      await call(OWNER, 'POST', base(session.id, '/revoke'), {});
      const rows = await sql<{ action: string; detail: unknown }[]>`
      SELECT action, detail FROM audit_log
      WHERE target_type = 'support_session' AND target_id = ${session.id}
      ORDER BY id
    `;
      const actions = rows.map((row) => row.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'support_session.start_session',
          'support_session.operation_consent',
          'support_session.proposal',
          'support_session.decision',
          'support_session.start',
          'support_session.result',
          'support_session.end',
        ]),
      );
      const text = JSON.stringify(rows);
      for (const canary of [
        SID,
        MACHINE,
        HOST,
        CANARY_SEGMENT,
        'CANARY',
        session.token,
        'canary-user',
        '"Documents"',
      ]) {
        expect(text).not.toContain(canary);
      }
      expect(text).toContain(hashSid(SID));
      expect(text).not.toContain(createHash('sha256').update(SID).digest('hex'));
    });
  });

  describe('device_commands / RSP へ配送しない（§6）', () => {
    it('実行器はヘルパーだけ: 通しで device_commands が増えず、RSP へ投入しない', async () => {
      setManifest(ALL_BUT_DISK);
      const before = await deviceCommandCount();
      const session = await readySession();
      const commandsAfterBinding = world.commands.length;
      const { op } = await executing(session);
      await report(session.token, op, resultBody(op, FOLDER_OUTPUT));
      await propose(session.id);
      expect(await deviceCommandCount()).toBe(before);
      expect(world.commands.length).toBe(commandsAfterBinding);
      const linked = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM device_commands
      WHERE step_id IN (SELECT id FROM assist_proposals WHERE support_session_id = ${session.id})
         OR id IN (SELECT id FROM assist_executions WHERE support_session_id = ${session.id})
    `;
      expect(Number(linked[0]?.count)).toBe(0);
    });

    it('resolve の承認 API は共通セッションの提案を受け付けない', async () => {
      const session = await readySession();
      const { proposal } = await propose(session.id);
      const before = await deviceCommandCount();
      const response = await call(OWNER, 'POST', `/api/resolve/steps/${proposal.id}/approve`, {
        approvalHash: proposal.approvalHash,
      });
      expect([400, 403, 404]).toContain(response.statusCode);
      expect(await deviceCommandCount()).toBe(before);
    });

    it('本機能のコードに device_commands と RSP クライアントへの経路がない', () => {
      const dir = path.dirname(new URL(import.meta.url).pathname);
      const files = readdirSync(dir).filter(
        (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
      );
      expect(files.length).toBeGreaterThan(5);
      for (const file of files) {
        const source = readFileSync(path.join(dir, file), 'utf8');
        expect(source, file).not.toMatch(/INSERT INTO device_commands/);
        expect(source, file).not.toMatch(/remote-support\/rsp/);
        expect(source, file).not.toMatch(/endpoint-command-agent['"`]/);
      }
    });

    it('本経路の Skill は resolve のカタログへ入れない（承認されても SYSTEM 経路に載らない）', async () => {
      const { SKILL_CATALOG } = await import('../resolve/skills.js');
      const ids = SKILL_CATALOG.map((skill) => skill.id);
      for (const id of [
        'folder.summary',
        'user.marker.set',
        'user.marker.clear',
        'user.marker.status',
      ]) {
        expect(ids).not.toContain(id);
      }
    });
  });

  describe('機能フラグ', () => {
    it('無効時は API が 404 で、poll の形も変わらない', async () => {
      const session = await readySession();
      const { proposal } = await propose(session.id);
      config.ASSIST_SESSION_ENABLED = false;

      const urls: ['GET' | 'POST', string][] = [
        ['GET', '/api/support-sessions/mine'],
        ['GET', base(session.id)],
        ['POST', '/api/support-sessions'],
        ['POST', base(session.id, '/proposals')],
        ['POST', base(session.id, `/proposals/${proposal.id}/decision`)],
        ['POST', base(session.id, '/consents/operation')],
        ['POST', base(session.id, '/consents/ai-input')],
        ['POST', base(session.id, '/resolution')],
        ['POST', base(session.id, '/revoke')],
        ['POST', base(session.id, '/stop')],
      ];
      for (const [method, url] of urls) {
        const response = await call(OWNER, method, url, method === 'POST' ? {} : undefined);
        expect(response.statusCode, url).toBe(404);
      }
      const start404 = await helperCall(session.token, `ops/${session.id}/start`, {});
      expect(start404.statusCode).toBe(404);
      const result404 = await helperCall(session.token, `ops/${session.id}/skill-result`, {});
      expect(result404.statusCode).toBe(404);

      const polled = await poll(session.token);
      expect(polled).not.toHaveProperty('skillOps');
      expect(polled).not.toHaveProperty('nextPollSeconds');
    });

    it('FOLDER_ACCESS_ENABLED が無効でも 404 になる', async () => {
      config.FOLDER_ACCESS_ENABLED = false;
      const response = await call(OWNER, 'GET', '/api/support-sessions/mine');
      expect(response.statusCode).toBe(404);
    });

    it('未認証は 401/403', async () => {
      const response = await call(null, 'GET', '/api/support-sessions/mine');
      expect([401, 403]).toContain(response.statusCode);
      const helper = await app.inject({
        method: 'POST',
        url: `/api/device/agent/folder-helper/ops/${RSP_DEVICE}/start`,
        payload: {},
      });
      expect(helper.statusCode).toBe(401);
    });
  });
});
