/**
 * 相談者の実診断経路（docs/25 §20）: 接続確認・結果の出所・本番での模擬の拒否・
 * 本人 Y と次の提案の分離・取消/期限切れの後に進まないこと。
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { sql } from '../db.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { resetRateLimits } from '../lib/rate-limit.js';
import { buildServer } from '../server.js';
import { computeApprovalHash } from './approval.js';

const EMAIL = 'resolve-realpath@example.com';
const OTHER_EMAIL = 'resolve-realpath-other@example.com';
const DEVICE = 'realpath-device-0001';
const OFFLINE_DEVICE = 'realpath-device-0002';
const ADMIN_ONLY_DEVICE = 'realpath-device-0003';
const CASE_ID = 'CASE-REALPATH';
const TOKEN = 'realpath-token-standard-00000000';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
const AGENT_HEADERS = { 'x-device-token': TOKEN, 'x-device-id': DEVICE };

let app: FastifyInstance;
let originalDevEmail: string;
let originalNodeEnv: typeof config.NODE_ENV;

async function post(url: string, payload: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url, payload });
}

async function startSession() {
  const response = await post('/api/resolve/sessions', { caseId: CASE_ID, deviceId: DEVICE });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

const hashOf = (body: any) => computeApprovalHash(body.step.approvalChallenge.payload);

async function approveY(body: any) {
  return post(`/api/resolve/steps/${body.step.id}/approve`, {
    decision: 'Y',
    approvalHash: hashOf(body),
  });
}

/** エージェントと同じ経路でコマンドを取得する（配信済みになる）。 */
async function deliver() {
  const response = await app.inject({
    method: 'GET',
    url: '/api/device/command',
    headers: AGENT_HEADERS,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().command as { id: string };
}

async function report(commandId: string, result: unknown) {
  return app.inject({
    method: 'POST',
    url: `/api/device/command/${commandId}/result`,
    headers: AGENT_HEADERS,
    payload: { ok: true, result },
  });
}

async function getStep(stepId: string) {
  return app.inject({ method: 'GET', url: `/api/resolve/steps/${stepId}` });
}

const SPOOLER_RESULT = {
  normalized: {
    name: 'Spooler',
    displayName: 'Print Spooler',
    status: 'Running',
    startType: 'Auto',
  },
  stdoutSummary: '{"name":"Spooler"}',
  exitCode: 0,
};

async function resetData() {
  await sql`DELETE FROM device_commands WHERE user_email IN (${EMAIL}, ${OTHER_EMAIL})`;
  await sql`DELETE FROM resolution_sessions WHERE user_email IN (${EMAIL}, ${OTHER_EMAIL})`;
}

beforeAll(async () => {
  originalDevEmail = config.DEV_AUTH_EMAIL;
  originalNodeEnv = config.NODE_ENV;
  config.DEV_AUTH_EMAIL = EMAIL;
  config.RESOLVE_REQUESTER_DIAGNOSIS_ENABLED = true;
  app = await buildServer({ logger: false });
  await app.ready();
  await sql`
    UPDATE skills
    SET status = 'approved', approved_by = 'test', approved_at = now(),
        content_hash = COALESCE(content_hash, ${`sha256:${'a'.repeat(64)}`})
  `;
  await resetData();
  await sql`DELETE FROM device_tokens WHERE user_email IN (${EMAIL}, ${OTHER_EMAIL})`;
  await sql`DELETE FROM device_inventories WHERE user_email IN (${EMAIL}, ${OTHER_EMAIL})`;
  await sql`
    INSERT INTO device_inventories (user_email, source, device_id, data)
    VALUES (${EMAIL}, 'browser', ${DEVICE}, '{}'::jsonb),
           (${EMAIL}, 'browser', ${OFFLINE_DEVICE}, '{}'::jsonb),
           (${EMAIL}, 'browser', ${ADMIN_ONLY_DEVICE}, '{}'::jsonb),
           (${OTHER_EMAIL}, 'browser', 'realpath-other-device', '{}'::jsonb)
  `;
  await sql`
    INSERT INTO device_tokens (token_hash, user_email, label, device_id, last_used_at, privilege)
    VALUES (${TOKEN_HASH}, ${EMAIL}, 'test', ${DEVICE}, now(), 'standard'),
           (${`realpath-offline-${EMAIL}`}, ${EMAIL}, 'test', ${OFFLINE_DEVICE}, now() - interval '10 minutes', 'standard'),
           (${`realpath-admin-${EMAIL}`}, ${EMAIL}, 'test', ${ADMIN_ONLY_DEVICE}, now(), 'admin'),
           (${`realpath-other-${OTHER_EMAIL}`}, ${OTHER_EMAIL}, 'test', 'realpath-other-device', now(), 'standard')
  `;
  await sql`
    INSERT INTO prototype_states (user_email, name, data)
    VALUES (${EMAIL}, 'cowork', ${jsonbValue({
      v: 31,
      cases: [
        { id: CASE_ID, userId: 'u1', subject: '印刷できない', body: 'プリンタで印刷できません' },
      ],
    })})
    ON CONFLICT (user_email, name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
  `;
});

beforeEach(async () => {
  resetRateLimits();
  config.NODE_ENV = originalNodeEnv;
  config.DEV_AUTH_EMAIL = EMAIL;
  await resetData();
  await sql`UPDATE device_tokens SET last_used_at = now() WHERE token_hash = ${TOKEN_HASH}`;
});

afterAll(async () => {
  config.NODE_ENV = originalNodeEnv;
  config.DEV_AUTH_EMAIL = originalDevEmail;
  config.RESOLVE_REQUESTER_DIAGNOSIS_ENABLED = false;
  await resetData();
  await sql`DELETE FROM device_tokens WHERE user_email IN (${EMAIL}, ${OTHER_EMAIL})`;
  await sql`DELETE FROM device_inventories WHERE user_email IN (${EMAIL}, ${OTHER_EMAIL})`;
  await sql`DELETE FROM prototype_states WHERE user_email = ${EMAIL} AND name = 'cowork'`;
  await app.close();
});

describe('否定や解消の相談へ提案しない（docs/67）', () => {
  it('既定では相談者の読取診断へ案内しない', async () => {
    config.RESOLVE_REQUESTER_DIAGNOSIS_ENABLED = false;
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/resolve/device-status?deviceId=${DEVICE}`,
      });
      expect(response.json().agentConnected).toBe(false);
    } finally {
      config.RESOLVE_REQUESTER_DIAGNOSIS_ENABLED = true;
    }
  });
});

describe('GET /api/resolve/device-status', () => {
  const status = async (deviceId: string) => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/resolve/device-status?deviceId=${deviceId}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };

  it('standard エージェントが応答中の本人の端末は接続ありと返す', async () => {
    expect(await status(DEVICE)).toMatchObject({ owned: true, agentConnected: true });
  });

  it('最終応答が古い端末は未接続', async () => {
    expect(await status(OFFLINE_DEVICE)).toMatchObject({ owned: true, agentConnected: false });
  });

  it('admin エージェントだけの端末は読み取り診断を実行できないので未接続', async () => {
    expect(await status(ADMIN_ONLY_DEVICE)).toMatchObject({ owned: true, agentConnected: false });
  });

  it('他人の端末は接続を明かさない', async () => {
    expect(await status('realpath-other-device')).toMatchObject({
      owned: false,
      agentConnected: false,
    });
  });

  it('端末 ID なしは 400', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/resolve/device-status' });
    expect(response.statusCode).toBe(400);
  });
});

describe('結果の出所', () => {
  async function runWith(result: unknown) {
    const started = await startSession();
    expect((await approveY(started)).statusCode).toBe(200);
    const command = await deliver();
    expect((await report(command.id, result)).statusCode).toBe(200);
    const step = await getStep(started.step.id);
    expect(step.statusCode, step.body).toBe(200);
    return { started, body: step.json() };
  }

  it('--mock の結果は mock として保存・返却し、AI 入力にも出所を残す', async () => {
    const { started, body } = await runWith({ ...SPOOLER_RESULT, executionSource: 'mock' });
    expect(body.step.executionSource).toBe('mock');
    expect(body.step.resultSummary.executionSource).toBe('mock');
    expect(body.step.resultAi.executionSource).toBe('mock');
    expect(body.session.lastSummary.executionSource).toBe('mock');
    const rows = await sql<{ result_summary: any; result_ai: any }[]>`
      SELECT result_summary, result_ai FROM resolution_steps WHERE id = ${started.step.id}
    `;
    expect(rows[0]?.result_summary.executionSource).toBe('mock');
    expect(rows[0]?.result_ai.executionSource).toBe('mock');
  });

  it('端末エージェントの実行は endpoint_agent', async () => {
    const { body } = await runWith({ ...SPOOLER_RESULT, executionSource: 'endpoint_agent' });
    expect(body.step.executionSource).toBe('endpoint_agent');
  });

  it('申告の無い結果は unknown で、実端末とは返さない', async () => {
    const { body } = await runWith(SPOOLER_RESULT);
    expect(body.step.executionSource).toBe('unknown');
  });

  it('結果の形が宣言と違えば resultShapeOk=false を残す（解決にはしない）', async () => {
    const { body } = await runWith({
      executionSource: 'endpoint_agent',
      normalized: { name: 'Spooler' },
      stdoutSummary: '',
    });
    expect(body.step.resultSummary.resultShapeOk).toBe(false);
    expect(body.session.status).toBe('waiting_continue');
  });

  it('読み取り成功だけでは resolved にせず、次の操作は本人を待つ', async () => {
    const { started, body } = await runWith({ ...SPOOLER_RESULT, executionSource: 'mock' });
    expect(body.step.resultSummary.resultShapeOk).toBe(true);
    expect(body.session.status).toBe('waiting_continue');
    expect(body.session.lastSummary.outcome).toBeUndefined();
    const commands =
      await sql`SELECT id FROM device_commands WHERE session_id = ${started.session.id}`;
    expect(commands).toHaveLength(1);
  });
});

describe('本番での模擬の拒否', () => {
  it('NODE_ENV=production では mock の結果を 403 で拒否し、保存せず失敗として閉じる', async () => {
    const started = await startSession();
    expect((await approveY(started)).statusCode).toBe(200);
    const command = await deliver();
    config.NODE_ENV = 'production';
    const response = await report(command.id, { ...SPOOLER_RESULT, executionSource: 'mock' });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error.code).toBe('MOCK_RESULT_FORBIDDEN');
    config.NODE_ENV = originalNodeEnv;

    const rows = await sql<{ status: string; result: unknown }[]>`
      SELECT status, result FROM device_commands WHERE id = ${command.id}
    `;
    expect(rows[0]).toMatchObject({ status: 'failed', result: null });
    const step = await getStep(started.step.id);
    expect(step.json().step.status).toBe('failed');
    expect(step.json().session.status).toBe('escalated');
    expect(JSON.stringify(step.json().step.resultSummary)).not.toContain('Running');
  });

  it('本番は申告の無い Skill の結果も 403 で拒否する（旧版エージェントの fixture を入れない）', async () => {
    const started = await startSession();
    expect((await approveY(started)).statusCode).toBe(200);
    const command = await deliver();
    config.NODE_ENV = 'production';
    const response = await report(command.id, SPOOLER_RESULT);
    config.NODE_ENV = originalNodeEnv;
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error.code).toBe('UNVERIFIED_RESULT_SOURCE');
    const rows = await sql<{ status: string; result: unknown }[]>`
      SELECT status, result FROM device_commands WHERE id = ${command.id}
    `;
    expect(rows[0]).toMatchObject({ status: 'failed', result: null });
  });

  it('本番でも endpoint_agent の結果は受け付ける', async () => {
    const started = await startSession();
    expect((await approveY(started)).statusCode).toBe(200);
    const command = await deliver();
    config.NODE_ENV = 'production';
    const response = await report(command.id, {
      ...SPOOLER_RESULT,
      executionSource: 'endpoint_agent',
    });
    config.NODE_ENV = originalNodeEnv;
    expect(response.statusCode, response.body).toBe(200);
  });
});

describe('本人 Y と次の提案の分離', () => {
  it('同時の二重 Y は 1 回だけ通り、コマンドは 1 件', async () => {
    const started = await startSession();
    const statuses = (await Promise.all([approveY(started), approveY(started)]))
      .map((response) => response.statusCode)
      .sort();
    expect(statuses).toEqual([200, 409]);
    const commands =
      await sql`SELECT id FROM device_commands WHERE session_id = ${started.session.id}`;
    expect(commands).toHaveLength(1);
  });

  it('継続 Y は次の提案を作るだけで実行せず、前のハッシュでは承認できない', async () => {
    const started = await startSession();
    expect((await approveY(started)).statusCode).toBe(200);
    const command = await deliver();
    await report(command.id, { ...SPOOLER_RESULT, executionSource: 'mock' });
    await getStep(started.step.id);
    const continued = await post(`/api/resolve/steps/${started.step.id}/continue`, {
      decision: 'Y',
    });
    expect(continued.statusCode, continued.body).toBe(200);
    const next = continued.json();
    expect(next.step.status).toBe('proposed');
    expect(next.step.id).not.toBe(started.step.id);
    expect(next.step.approvalChallenge.nonce).not.toBe(started.step.approvalChallenge.nonce);
    const commands =
      await sql`SELECT id FROM device_commands WHERE session_id = ${started.session.id}`;
    expect(commands).toHaveLength(1);

    const replay = await post(`/api/resolve/steps/${next.step.id}/approve`, {
      decision: 'Y',
      approvalHash: hashOf(started),
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.code).toBe('APPROVAL_MISMATCH');
  });

  it('本人以外（別の利用者）の Y は 404 でコマンドを作らない', async () => {
    const started = await startSession();
    config.DEV_AUTH_EMAIL = OTHER_EMAIL;
    const response = await approveY(started);
    config.DEV_AUTH_EMAIL = EMAIL;
    expect(response.statusCode).toBe(404);
    const commands =
      await sql`SELECT id FROM device_commands WHERE session_id = ${started.session.id}`;
    expect(commands).toHaveLength(0);
  });

  it('端末が応答していなければ Y を受け付けない（DEVICE_OFFLINE）', async () => {
    const started = await startSession();
    await sql`UPDATE device_tokens SET last_used_at = now() - interval '10 minutes' WHERE token_hash = ${TOKEN_HASH}`;
    const response = await approveY(started);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('DEVICE_OFFLINE');
    const commands =
      await sql`SELECT id FROM device_commands WHERE session_id = ${started.session.id}`;
    expect(commands).toHaveLength(0);
  });
});

describe('N・取消・期限切れの後に進まない', () => {
  it('取消の後に届いた配信済みコマンドの結果では進めない', async () => {
    const started = await startSession();
    expect((await approveY(started)).statusCode).toBe(200);
    const command = await deliver();
    await post(`/api/resolve/sessions/${started.session.id}/stop`);
    await report(command.id, { ...SPOOLER_RESULT, executionSource: 'endpoint_agent' });
    const step = await getStep(started.step.id);
    expect(step.json().session.status).toBe('stopped');
    expect(step.json().step.status).toBe('cancelled');
    expect(step.json().step.resultSummary).toBeNull();
  });

  it('N の後の結果後操作は受け付けない', async () => {
    const started = await startSession();
    await post(`/api/resolve/steps/${started.step.id}/approve`, { decision: 'N' });
    const again = await approveY(started);
    expect(again.statusCode).toBe(409);
    const continued = await post(`/api/resolve/steps/${started.step.id}/continue`, {
      decision: 'Y',
    });
    expect(continued.statusCode).toBe(409);
  });

  it('期限を過ぎた承認済みコマンドはエージェントへ配信しない', async () => {
    const started = await startSession();
    expect((await approveY(started)).statusCode).toBe(200);
    await sql`UPDATE resolution_steps SET deadline_at = now() - interval '1 minute' WHERE id = ${started.step.id}`;
    const response = await app.inject({
      method: 'GET',
      url: '/api/device/command',
      headers: AGENT_HEADERS,
    });
    expect(response.statusCode).toBe(204);
  });
});

/**
 * 印刷の相談にも承認済み KB を届ける（docs/65 §7 欠陥 2）。外部 AI はスタブ。
 * 判定は #125 と同じ findApprovedKnowledge。state の KB は使わない。
 */
describe('解決ループの提案と承認済み KB', () => {
  const KB_REF = 'kb-resolve-refs-e2e';
  const AUTHOR_EMAIL = 'resolve-kb-author@example.com';
  const APPROVER_EMAIL = 'resolve-kb-approver@example.com';
  const KB_NO = 'KB-RESOLVE-1';
  const STATE_MARKER = 'ZX9状態のKB';
  let authorId = '';
  let approverId = '';
  const originalKey = config.DEEPSEEK_API_KEY;
  const originalProcessEnv = process.env.NODE_ENV;
  const originalFetch = globalThis.fetch;
  let sent: Array<Record<string, unknown>> = [];
  let aiReply: Record<string, unknown> = {};

  async function cleanupKb() {
    await sql`DELETE FROM knowledge WHERE client_ref = ${KB_REF} OR kb_no = ${KB_NO}`;
  }

  function stubAi() {
    sent = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!String(url).includes('/chat/completions')) return originalFetch(url, init);
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      sent.push(JSON.parse(body.messages.at(-1)?.content ?? '{}'));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(aiReply) } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
  }

  beforeEach(async () => {
    await resetData();
    await cleanupKb();
    const rows = await sql<{ id: string; email: string }[]>`
      INSERT INTO users (email, name, role, password_hash)
      VALUES (${AUTHOR_EMAIL}, '作成者', 'helpdesk', 'access-only$no-login'),
             (${APPROVER_EMAIL}, '承認者', 'approver', 'access-only$no-login')
      ON CONFLICT (lower(email)) DO UPDATE SET updated_at = now()
      RETURNING id, email
    `;
    authorId = rows.find((row) => row.email === AUTHOR_EMAIL)?.id ?? '';
    approverId = rows.find((row) => row.email === APPROVER_EMAIL)?.id ?? '';
    config.DEEPSEEK_API_KEY = 'stub-key-not-real';
    // proposer は NODE_ENV=test では AI を呼ばない。この節だけスタブへ向ける。
    process.env.NODE_ENV = 'development';
    aiReply = { skillId: 'spooler.status', params: {}, rationale: 'スタブ', decision: null };
    stubAi();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    process.env.NODE_ENV = originalProcessEnv;
    config.DEEPSEEK_API_KEY = originalKey;
    await cleanupKb();
    await sql`DELETE FROM users WHERE email IN (${AUTHOR_EMAIL}, ${APPROVER_EMAIL})`;
  });

  async function insertKb(overrides: { approverId?: string } = {}) {
    await sql`
      INSERT INTO knowledge (
        kb_no, title, symptom, cause, steps, keywords, status, author_id, approver_id,
        approved_at, client_ref, version
      ) VALUES (
        ${KB_NO}, 'プリンタの待機ジョブが滞留したときの対処', '印刷ができない',
        '待機ジョブの滞留', ${`1. 待機ジョブを確認する\n2. ${'手順の続き'.repeat(200)}`},
        ${['待機ジョブ']}, 'approved', ${authorId}, ${overrides.approverId ?? approverId},
        now(), ${KB_REF}, 2
      )
    `;
  }

  it('関連する承認済み KB の参照を提案の AI 入力へ入れる（上限つき）', async () => {
    await insertKb();
    const response = await post('/api/resolve/sessions', { caseId: CASE_ID, deviceId: DEVICE });
    expect(response.statusCode, response.body).toBe(200);
    const refs = sent.at(-1)?.knowledgeRefs as Array<Record<string, unknown>>;
    const ref = refs.find((item) => item.kbNo === KB_NO);
    expect(ref).toMatchObject({ kbNo: KB_NO, version: 2 });
    expect(String(ref?.title)).toContain('待機ジョブ');
    expect(String(ref?.stepsSummary)).toContain('待機ジョブを確認する');
    expect(String(ref?.stepsSummary).length).toBeLessThanOrEqual(301);
    expect(refs.length).toBeLessThanOrEqual(3);
  });

  it('参照に承認の出所を付け、プロンプトは「別の担当者が承認した」と決めつけない', async () => {
    await insertKb();
    let system = '';
    const stubbed = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ content: string }>;
      };
      system = body.messages?.[0]?.content ?? '';
      return stubbed(url, init);
    }) as typeof fetch;
    const response = await post('/api/resolve/sessions', { caseId: CASE_ID, deviceId: DEVICE });
    expect(response.statusCode, response.body).toBe(200);
    const refs = sent.at(-1)?.knowledgeRefs as Array<Record<string, unknown>>;
    expect(refs.find((item) => item.kbNo === KB_NO)).toMatchObject({
      approvalOrigin: 'other_person',
      approvalOriginLabel: '別の担当者が承認',
    });
    expect(refs.find((item) => item.kbNo === 'KB-2026-0003')).toMatchObject({
      approvalOrigin: 'seed',
    });
    expect(system).toContain('knowledgeRefs');
    expect(system).not.toContain('別の担当者が承認した');
    const stored = response.json().step.knowledgeRefs.matched;
    expect(
      stored.find((item: { kbNo: string }) => item.kbNo === 'KB-2026-0003').approvalOriginLabel,
    ).toBe('初期登録の資料（人の承認記録なし）');
  });

  it('AI が使わなければ、一致した KB は示すが「使った」としない', async () => {
    await insertKb();
    const body = (
      await post('/api/resolve/sessions', { caseId: CASE_ID, deviceId: DEVICE })
    ).json();
    const refs = body.step.knowledgeRefs;
    expect(refs.matched.map((item: { kbNo: string }) => item.kbNo)).toContain(KB_NO);
    expect(refs.used).toEqual([]);
  });

  it('AI が使ったと答えた KB だけ used に入る。送っていない番号は捨てる', async () => {
    await insertKb();
    aiReply = { ...aiReply, usedKnowledge: [KB_NO, 'KB-NOT-SENT'] };
    const body = (
      await post('/api/resolve/sessions', { caseId: CASE_ID, deviceId: DEVICE })
    ).json();
    expect(body.step.knowledgeRefs.used).toEqual([KB_NO]);
    const reread = (await getStep(body.step.id)).json();
    expect(reread.step.knowledgeRefs.used).toEqual([KB_NO]);
  });

  it('自己承認の KB と本人の state の KB は参照に入らない', async () => {
    await insertKb({ approverId: authorId });
    await sql`
      UPDATE prototype_states
      SET data = jsonb_set(data, '{kb}', ${jsonbValue([
        { id: 'KB-STATE', status: 'active', title: `プリンタ ${STATE_MARKER}`, symptom: '印刷' },
      ])})
      WHERE user_email = ${EMAIL} AND name = 'cowork'
    `;
    await post('/api/resolve/sessions', { caseId: CASE_ID, deviceId: DEVICE });
    const input = JSON.stringify(sent.at(-1));
    expect(input).not.toContain(KB_NO);
    expect(input).not.toContain(STATE_MARKER);
  });

  it('無関係な相談には KB を送らない', async () => {
    const { proposeNext } = await import('./proposer.js');
    const { listApprovedSkills } = await import('./skills.js');
    const { knowledgeRefsForCase } = await import('./knowledge-refs.js');
    await insertKb();
    const text = '経費精算の締め日を教えてください';
    const refs = await knowledgeRefsForCase(text);
    expect(refs.map((item) => item.kbNo)).not.toContain(KB_NO);
    await proposeNext({
      text,
      history: [],
      skills: await listApprovedSkills(),
      knowledgeRefs: refs,
    });
    expect(JSON.stringify(sent.at(-1))).not.toContain(KB_NO);
  });

  it('KB に端末情報が残っていても提案の AI 入力では除く', async () => {
    await insertKb();
    await sql`
      UPDATE knowledge SET steps = '1. WEB-2B6D41AA の待機ジョブを確認する',
        approved_at = now() + interval '1 second'
      WHERE kb_no = ${KB_NO}
    `;
    await post('/api/resolve/sessions', { caseId: CASE_ID, deviceId: DEVICE });
    const input = JSON.stringify(sent.at(-1));
    expect(input).toContain(KB_NO);
    expect(input).not.toContain('WEB-2B6D41AA');
  });
});
