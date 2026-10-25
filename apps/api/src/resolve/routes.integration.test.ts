import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { sql } from '../db.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { resetRateLimits } from '../lib/rate-limit.js';
import { buildServer } from '../server.js';
import { computeApprovalHash } from './approval.js';

const EMAIL = 'resolve-test@example.com';
const OTHER_EMAIL = 'resolve-other@example.com';
const DEVICE = 'WEB-AB12CD34';
const OTHER_DEVICE = 'WEB-AB12CD34';
const CASE_PRINT = 'CASE-RESOLVE-PRINT';
const CASE_DISK = 'CASE-RESOLVE-DISK';
const CASE_NET = 'CASE-RESOLVE-NET';
const CASE_OTHER = 'CASE-RESOLVE-OTHER';

let app: FastifyInstance;
let originalDevEmail: string;

const COWORK_FIXTURE = {
  v: 31,
  cases: [
    {
      id: CASE_PRINT,
      userId: 'u1',
      subject: '印刷できない',
      body: 'プリンタで印刷できません。印刷キューに残ってしまいます。',
      urg: '通常',
    },
    {
      id: CASE_DISK,
      userId: 'u1',
      subject: '空き容量不足',
      body: 'Cドライブの空き容量が少なく、ファイルを保存できません。',
      urg: '通常',
    },
    {
      id: CASE_NET,
      userId: 'u1',
      subject: 'ネットワークにつながらない',
      body: 'VPN に接続できず、ネットワークが不安定です。',
      urg: '通常',
    },
  ],
};

const OTHER_COWORK_FIXTURE = {
  v: 31,
  cases: [{ id: CASE_OTHER, userId: 'u9', subject: '他人の案件', body: '他人の相談本文' }],
};

async function post(url: string, payload: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url, payload });
}

async function get(url: string) {
  return app.inject({ method: 'GET', url });
}

async function startSession(caseId = CASE_PRINT) {
  const response = await post('/api/resolve/sessions', { caseId, deviceId: DEVICE });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

function challengeHash(body: any): string {
  return computeApprovalHash(body.step.approvalChallenge.payload);
}

async function approve(stepId: string, approvalHash: string, decision: 'Y' | 'N' = 'Y') {
  return post(`/api/resolve/steps/${stepId}/approve`, { decision, approvalHash });
}

async function approveWithChallenge(body: any) {
  return approve(body.step.id, challengeHash(body));
}

async function commandIdFor(stepId: string): Promise<string> {
  const rows = await sql<{ command_id: string | null }[]>`
    SELECT command_id FROM resolution_steps WHERE id = ${stepId}
  `;
  const commandId = rows[0]?.command_id;
  expect(commandId).toBeTruthy();
  return commandId as string;
}

async function markCommandDone(stepId: string, result: unknown) {
  const commandId = await commandIdFor(stepId);
  await sql`
    UPDATE device_commands
    SET status = 'done', result = ${jsonbValue(result)}, completed_at = now()
    WHERE id = ${commandId}
  `;
}

async function markCommandFailed(stepId: string, error: string) {
  const commandId = await commandIdFor(stepId);
  await sql`
    UPDATE device_commands
    SET status = 'failed', error = ${error}, completed_at = now()
    WHERE id = ${commandId}
  `;
}

async function getStep(stepId: string) {
  return get(`/api/resolve/steps/${stepId}`);
}

beforeAll(async () => {
  originalDevEmail = config.DEV_AUTH_EMAIL;
  // 既存テストの dev@example.com の状態を汚さないよう、解決ループ専用の利用者を使う。
  config.DEV_AUTH_EMAIL = EMAIL;
  app = await buildServer({ logger: false });
  await app.ready();

  // スクリプト実体は別担当が作成する。Phase B のフロー検証用に承認済みへ進める。
  await sql`
    UPDATE skills
    SET status = 'approved',
        approved_by = 'test',
        approved_at = now(),
        content_hash = COALESCE(content_hash, ${`sha256:${'a'.repeat(64)}`})
  `;

  await sql`
    INSERT INTO device_inventories (user_email, source, device_id, data)
    VALUES (${EMAIL}, 'browser', ${DEVICE}, '{}'::jsonb),
           (${OTHER_EMAIL}, 'browser', ${OTHER_DEVICE}, '{}'::jsonb)
    ON CONFLICT (user_email, source, device_id) DO NOTHING
  `;
  // Phase C: 承認時の端末オンライン判定は device_tokens.last_used_at を正とする。
  // 端末エージェントが実際にポーリングしている状態を fixture でも再現する。
  await sql`
    INSERT INTO device_tokens (token_hash, user_email, label, device_id, last_used_at)
    VALUES (${`test-token-${EMAIL}`}, ${EMAIL}, 'test', ${DEVICE}, now()),
           (${`test-token-${OTHER_EMAIL}`}, ${OTHER_EMAIL}, 'test', ${OTHER_DEVICE}, now())
    ON CONFLICT (token_hash) DO UPDATE
      SET user_email = EXCLUDED.user_email,
          device_id = EXCLUDED.device_id,
          revoked_at = NULL,
          last_used_at = now()
  `;
  await sql`DELETE FROM device_commands WHERE user_email IN (${EMAIL}, ${OTHER_EMAIL}) AND session_id IS NOT NULL`;
  await sql`DELETE FROM resolution_sessions WHERE user_email IN (${EMAIL}, ${OTHER_EMAIL})`;
  await sql`DELETE FROM prototype_states WHERE user_email IN (${EMAIL}, ${OTHER_EMAIL}) AND name = 'cowork'`;
  await sql`
    INSERT INTO prototype_states (user_email, name, data)
    VALUES (${EMAIL}, 'cowork', ${jsonbValue(COWORK_FIXTURE)})
    ON CONFLICT (user_email, name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
  `;
  await sql`
    INSERT INTO prototype_states (user_email, name, data)
    VALUES (${OTHER_EMAIL}, 'cowork', ${jsonbValue(OTHER_COWORK_FIXTURE)})
    ON CONFLICT (user_email, name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
  `;
});

beforeEach(() => {
  resetRateLimits();
});

afterAll(async () => {
  await sql`DELETE FROM device_commands WHERE user_email IN (${EMAIL}, ${OTHER_EMAIL}) AND session_id IS NOT NULL`;
  await sql`DELETE FROM resolution_sessions WHERE user_email IN (${EMAIL}, ${OTHER_EMAIL})`;
  await sql`DELETE FROM prototype_states WHERE user_email IN (${EMAIL}, ${OTHER_EMAIL}) AND name = 'cowork'`;
  config.DEV_AUTH_EMAIL = originalDevEmail;
  await app.close();
});

describe('GET /api/resolve/skills', () => {
  it('承認済み Skill の一覧を返す（承認済みのみ / パラメータスキーマ付き）', async () => {
    const response = await get('/api/resolve/skills');
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    const ids = body.skills.map((skill: any) => skill.id);
    // Phase B の読み取り 5 件は常に承認済みで返る。Phase 2 の修復 7 件は
    // 人間が scripts/skills/approved.json を更新するまで draft のため返らない
    // （自動承認しないため、承認の前後どちらでもこの 5 件は含まれる）。
    expect(ids).toEqual(
      expect.arrayContaining([
        'disk.space',
        'network.adapters',
        'os.info',
        'service.status',
        'spooler.status',
      ]),
    );
    for (const skill of body.skills) {
      expect(skill.status).toBe('approved');
      expect(skill.os).toContain('windows');
      // 承認済みは読み取り（1）と修復（2・3）だけ。4 以上は管理者承認が要る。
      expect(skill.riskLevel).toBeGreaterThanOrEqual(1);
      expect(skill.riskLevel).toBeLessThanOrEqual(3);
      expect(typeof skill.title).toBe('string');
      expect(skill.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    const service = body.skills.find((skill: any) => skill.id === 'service.status');
    expect(service.paramsSchema.properties.service.enum).toEqual(['Spooler', 'W32Time', 'Winmgmt']);
  });
});

describe('POST /api/resolve/sessions', () => {
  it('案件を照合してセッションと初回提案（approvalChallenge 付き）を返す', async () => {
    const before = Date.now();
    const body = await startSession(CASE_PRINT);
    const after = Date.now();

    expect(body.session.status).toBe('waiting_execute');
    expect(body.session.caseId).toBe(CASE_PRINT);
    expect(body.session.deviceId).toBe(DEVICE);
    expect(body.session.stepCount).toBe(1);
    expect(body.session.maxSteps).toBe(6);
    const sessionTtl =
      new Date(body.session.expiresAt).getTime() - new Date(body.session.startedAt).getTime();
    expect(sessionTtl).toBeGreaterThan(29 * 60 * 1000);
    expect(sessionTtl).toBeLessThanOrEqual(31 * 60 * 1000);

    expect(body.step.seq).toBe(1);
    expect(body.step.status).toBe('proposed');
    expect(body.step.skillId).toBe('spooler.status');
    expect(body.step.skill.title).toContain('印刷');
    expect(body.step.params).toEqual({});
    expect(body.step.rationale).toContain('印刷');

    const challenge = body.step.approvalChallenge;
    expect(challenge).toBeTruthy();
    expect(Object.keys(challenge.payload).sort()).toEqual(
      [
        'deviceId',
        'expiresAt',
        'nonce',
        'params',
        'riskLevel',
        'seq',
        'sessionId',
        'skillContentHash',
        'skillId',
        'skillVersion',
        'stepId',
        'userEmail',
      ].sort(),
    );
    expect(challenge.payload.sessionId).toBe(body.session.id);
    expect(challenge.payload.stepId).toBe(body.step.id);
    expect(challenge.payload.userEmail).toBe(EMAIL);
    expect(challenge.payload.deviceId).toBe(DEVICE);
    expect(challenge.payload.riskLevel).toBe(1);
    expect(challenge.nonce).toBe(challenge.payload.nonce);
    expect(challenge.expiresAt).toBe(challenge.payload.expiresAt);
    const approvalTtl = new Date(challenge.expiresAt).getTime();
    expect(approvalTtl).toBeGreaterThan(before + 4 * 60 * 1000);
    expect(approvalTtl).toBeLessThan(after + 6 * 60 * 1000);
  });

  it('存在しない案件は 404 を返す', async () => {
    const response = await post('/api/resolve/sessions', {
      caseId: 'CASE-DOES-NOT-EXIST',
      deviceId: DEVICE,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('他者の案件は 404 を返す（案件の認可）', async () => {
    const response = await post('/api/resolve/sessions', { caseId: CASE_OTHER, deviceId: DEVICE });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/resolve/steps/:id/approve', () => {
  it('改ざんされた承認ハッシュを拒否し、コマンドを登録しない', async () => {
    const started = await startSession();
    const tampered = { ...started.step.approvalChallenge.payload, deviceId: 'WEB-99999999' };
    const response = await approve(started.step.id, computeApprovalHash(tampered));
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('APPROVAL_MISMATCH');

    const detail = await getStep(started.step.id);
    expect(detail.json().step.status).toBe('proposed');
    const commands = await sql`
      SELECT id FROM device_commands WHERE step_id = ${started.step.id}
    `;
    expect(commands.length).toBe(0);
  });

  it('正しいハッシュの Y で device_commands に queued 登録し、step=approved / session=executing にする', async () => {
    const started = await startSession();
    const response = await approveWithChallenge(started);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();

    expect(body.step.status).toBe('approved');
    expect(body.session.status).toBe('executing');
    expect(body.step.approvalChallenge).toBeNull();
    expect(body.command.status).toBe('queued');
    expect(body.command.opId).toBe('spooler.status');
    expect(body.command.deviceId).toBe(DEVICE);
    expect(body.command.skillId).toBe('spooler.status');
    expect(body.command.skillVersion).toBe(started.step.skillVersion);
    expect(body.command.sessionId).toBe(started.session.id);
    expect(body.command.stepId).toBe(started.step.id);

    const rows = await sql<any[]>`
      SELECT user_email, device_id, op_id, params, skill_id, skill_version, session_id, step_id, status
      FROM device_commands WHERE id = ${body.command.id}
    `;
    expect(rows[0].user_email).toBe(EMAIL);
    expect(rows[0].device_id).toBe(DEVICE);
    expect(rows[0].op_id).toBe('spooler.status');
    expect(rows[0].params).toEqual({});
    expect(rows[0].skill_id).toBe('spooler.status');
    expect(rows[0].session_id).toBe(started.session.id);
    expect(rows[0].step_id).toBe(started.step.id);
    expect(rows[0].status).toBe('queued');
  });

  it('N は step=rejected / session=stopped にし、コマンドを登録しない', async () => {
    const started = await startSession();
    const response = await approve(started.step.id, challengeHash(started), 'N');
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.step.status).toBe('rejected');
    expect(body.session.status).toBe('stopped');
    const commands = await sql`SELECT id FROM device_commands WHERE step_id = ${started.step.id}`;
    expect(commands.length).toBe(0);
  });

  it('同じ承認ハッシュ（nonce）を再利用できない', async () => {
    const started = await startSession();
    const first = await approveWithChallenge(started);
    expect(first.statusCode, first.body).toBe(200);
    const hash = challengeHash(started);

    const second = await approve(started.step.id, hash);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('STEP_NOT_APPROVABLE');
    const commands = await sql`SELECT id FROM device_commands WHERE step_id = ${started.step.id}`;
    expect(commands.length).toBe(1);
  });

  it('承認チャレンジの 5 分期限が切れたら拒否する', async () => {
    const started = await startSession();
    await sql`
      UPDATE resolution_steps SET approval_expires_at = now() - interval '1 minute'
      WHERE id = ${started.step.id}
    `;
    const response = await approve(started.step.id, challengeHash(started));
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('APPROVAL_EXPIRED');
  });

  it('セッションの 30 分期限が切れたら拒否し、session=expired / step=cancelled にする', async () => {
    const started = await startSession();
    await sql`
      UPDATE resolution_sessions SET expires_at = now() - interval '1 minute'
      WHERE id = ${started.session.id}
    `;
    const response = await approve(started.step.id, challengeHash(started));
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('SESSION_EXPIRED');

    const detail = await get(`/api/resolve/sessions/${started.session.id}`);
    expect(detail.json().session.status).toBe('expired');
    expect(detail.json().steps[0].status).toBe('cancelled');
  });

  it('他者のステップは承認できない（404）', async () => {
    const other = await createOtherSessionWithStep();
    const response = await approve(other.stepId, 'a'.repeat(64));
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/resolve/steps/:id', () => {
  it('コマンド done で step=done / session=waiting_continue にし、PII を伏せ字化して保存する', async () => {
    const started = await startSession();
    await approveWithChallenge(started);
    await markCommandDone(started.step.id, {
      ok: true,
      exitCode: 0,
      normalized: { service: 'Spooler', note: '連絡先 a@b.com / 090-1234-5678' },
      stdoutSummary: 'Spooler: Running / a@b.com / 090-1234-5678',
    });

    const response = await getStep(started.step.id);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.step.status).toBe('done');
    expect(body.session.status).toBe('waiting_continue');
    expect(body.step.resultSummary.ok).toBe(true);
    expect(body.step.resultSummary.exitCode).toBe(0);
    expect(body.step.resultSummary.summary).toContain('[メールアドレス]');
    expect(body.step.resultSummary.summary).toContain('[電話番号]');
    expect(body.step.resultSummary.summary).not.toContain('a@b.com');
    expect(body.step.resultSummary.summary).not.toContain('090-1234-5678');
    expect(JSON.stringify(body.step.resultSummary)).not.toContain('a@b.com');
    expect(body.session.lastSummary).toEqual(body.step.resultSummary);
  });

  it('完了した GET を繰り返しても二重更新しない（executedAt が変わらない）', async () => {
    const started = await startSession();
    await approveWithChallenge(started);
    await markCommandDone(started.step.id, { ok: true, exitCode: 0, normalized: {} });

    const first = (await getStep(started.step.id)).json();
    const secondResponse = await getStep(started.step.id);
    const second = secondResponse.json();
    expect(first.step.status).toBe('done');
    expect(second.step.status).toBe('done');
    expect(second.session.status).toBe('waiting_continue');
    expect(second.step.executedAt).toBe(first.step.executedAt);
    const rows = await sql<{ status: string }[]>`
      SELECT status FROM resolution_steps WHERE id = ${started.step.id}
    `;
    expect(rows[0]?.status).toBe('done');
  });

  it('コマンド failed で step=failed / session=escalated にし、エラーを伏せ字化する', async () => {
    const started = await startSession();
    await approveWithChallenge(started);
    await markCommandFailed(started.step.id, '実行に失敗しました。連絡先 a@b.com');

    const response = await getStep(started.step.id);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.step.status).toBe('failed');
    expect(body.session.status).toBe('escalated');
    expect(body.step.error).toContain('[メールアドレス]');
    expect(body.step.error).not.toContain('a@b.com');
  });

  it('他者のステップは 404 を返す', async () => {
    const other = await createOtherSessionWithStep();
    const response = await getStep(other.stepId);
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/resolve/steps/:id/continue', () => {
  it('Y で次ステップを提案し、同一 Skill + params の再提案を避ける', async () => {
    const started = await startSession(CASE_PRINT);
    await approveWithChallenge(started);
    await markCommandDone(started.step.id, {
      ok: true,
      exitCode: 0,
      normalized: { service: 'Spooler', status: 'Running' },
      stdoutSummary: 'Spooler: Running',
    });
    await getStep(started.step.id);

    const response = await post(`/api/resolve/steps/${started.step.id}/continue`, {
      decision: 'Y',
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.step).toBeTruthy();
    expect(body.step.seq).toBe(2);
    expect(body.step.status).toBe('proposed');
    expect(body.step.approvalChallenge).toBeTruthy();
    expect(body.session.status).toBe('waiting_execute');
    expect(body.session.stepCount).toBe(2);
    const duplicate =
      body.step.skillId === started.step.skillId &&
      JSON.stringify(body.step.params) === JSON.stringify(started.step.params);
    expect(duplicate).toBe(false);
  });

  it('N で停止する', async () => {
    const started = await startSession();
    await approveWithChallenge(started);
    await markCommandDone(started.step.id, { ok: true, exitCode: 0, normalized: {} });
    await getStep(started.step.id);

    const response = await post(`/api/resolve/steps/${started.step.id}/continue`, {
      decision: 'N',
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.step).toBeNull();
    expect(body.session.status).toBe('stopped');
  });

  it('結果が揃っていないステップは継続できない（409）', async () => {
    const started = await startSession();
    await approveWithChallenge(started);
    const response = await post(`/api/resolve/steps/${started.step.id}/continue`, {
      decision: 'Y',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('STEP_NOT_CONTINUABLE');
  });

  it('ステップ上限（6 回）に達したら 409 STEP_LIMIT でエスカレーションする', async () => {
    const started = await startSession();
    await approveWithChallenge(started);
    await markCommandDone(started.step.id, { ok: true, exitCode: 0, normalized: {} });
    await getStep(started.step.id);
    await sql`
      UPDATE resolution_sessions SET step_count = max_steps WHERE id = ${started.session.id}
    `;

    const response = await post(`/api/resolve/steps/${started.step.id}/continue`, {
      decision: 'Y',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('STEP_LIMIT');

    const detail = await get(`/api/resolve/sessions/${started.session.id}`);
    expect(detail.json().session.status).toBe('escalated');
  });

  it('他者のステップは継続できない（404）', async () => {
    const other = await createOtherSessionWithStep();
    const response = await post(`/api/resolve/steps/${other.stepId}/continue`, {
      decision: 'Y',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/resolve/sessions/:id/stop と GET /api/resolve/sessions/:id', () => {
  it('中止すると stopped になり、承認待ちステップは cancelled になる', async () => {
    const started = await startSession();
    const response = await post(`/api/resolve/sessions/${started.session.id}/stop`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().session.status).toBe('stopped');

    const detail = await get(`/api/resolve/sessions/${started.session.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().session.status).toBe('stopped');
    expect(detail.json().steps[0].status).toBe('cancelled');
  });

  it('セッション詳細は状態とステップ概要（結果サマリ付き）を返す', async () => {
    const started = await startSession(CASE_DISK);
    expect(started.step.skillId).toBe('disk.space');
    await approveWithChallenge(started);
    await markCommandDone(started.step.id, {
      ok: true,
      exitCode: 0,
      normalized: { disks: [{ mount: 'C:', freeBytes: 10 }] },
    });
    await getStep(started.step.id);

    const response = await get(`/api/resolve/sessions/${started.session.id}`);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.session.status).toBe('waiting_continue');
    expect(body.steps.length).toBe(1);
    expect(body.steps[0].skillTitle).toContain('ディスク');
    expect(body.steps[0].resultSummary.ok).toBe(true);
  });

  it('他者のセッションは停止・参照できない（404）', async () => {
    const other = await createOtherSessionWithStep();
    expect((await post(`/api/resolve/sessions/${other.sessionId}/stop`)).statusCode).toBe(404);
    expect((await get(`/api/resolve/sessions/${other.sessionId}`)).statusCode).toBe(404);
  });
});

describe('案件の種類ごとの初回提案', () => {
  it('容量の相談では disk.space、ネットワークの相談では network.adapters を提案する', async () => {
    const disk = await startSession(CASE_DISK);
    expect(disk.step.skillId).toBe('disk.space');
    const network = await startSession(CASE_NET);
    expect(network.step.skillId).toBe('network.adapters');
  });
});

async function createOtherSessionWithStep(): Promise<{ sessionId: string; stepId: string }> {
  const sessions = await sql<{ id: string }[]>`
    INSERT INTO resolution_sessions (
      user_email, case_id, device_id, status, step_count, max_steps, expires_at
    ) VALUES (
      ${OTHER_EMAIL}, ${CASE_OTHER}, 'WEB-OTHER123', 'waiting_execute', 1, 6,
      now() + interval '30 minutes'
    )
    RETURNING id
  `;
  const sessionId = sessions[0]?.id;
  expect(sessionId).toBeTruthy();
  const steps = await sql<{ id: string }[]>`
    INSERT INTO resolution_steps (
      session_id, seq, skill_id, skill_version, skill_content_hash, params, rationale,
      risk_level, status, nonce, approval_expires_at
    ) VALUES (
      ${sessionId}, 1, 'os.info', '1.0.0', ${`sha256:${'c'.repeat(64)}`},
      ${jsonbValue({})}, '他者テスト', 1, 'proposed', 'nonce-other',
      now() + interval '5 minutes'
    )
    RETURNING id
  `;
  const stepId = steps[0]?.id;
  expect(stepId).toBeTruthy();
  return { sessionId: sessionId as string, stepId: stepId as string };
}

/**
 * 変更系（修復）Skill の「実行中」セッションと、結果 done の端末コマンドを直接作る。
 * applyCommandOutcome（GET /resolve/steps/:id 経由の取り込み）の検証に使う。
 */
async function createRepairStepWithResult(
  skillId: string,
  result: unknown,
): Promise<{ sessionId: string; stepId: string }> {
  const skillRows = await sql<
    { version: string; content_hash: string | null; risk_level: number }[]
  >`
    SELECT version, content_hash, risk_level FROM skills WHERE id = ${skillId} LIMIT 1
  `;
  const skill = skillRows[0];
  expect(skill, `${skillId} が skills に無い（ensureSkillCatalog を確認）`).toBeTruthy();
  const version = skill?.version ?? '1.0.0';
  const contentHash = skill?.content_hash ?? `sha256:${'e'.repeat(64)}`;
  const riskLevel = Number(skill?.risk_level ?? 2);

  const sessionRows = await sql<{ id: string }[]>`
    INSERT INTO resolution_sessions (
      user_email, case_id, device_id, status, step_count, max_steps, expires_at
    ) VALUES (
      ${EMAIL}, ${CASE_PRINT}, ${DEVICE}, 'executing', 1, 6, now() + interval '30 minutes'
    )
    RETURNING id
  `;
  const sessionId = sessionRows[0]?.id as string;
  const stepRows = await sql<{ id: string }[]>`
    INSERT INTO resolution_steps (
      session_id, seq, skill_id, skill_version, skill_content_hash, params, rationale,
      risk_level, status, nonce, approval_expires_at
    ) VALUES (
      ${sessionId}, 1, ${skillId}, ${version}, ${contentHash}, ${jsonbValue({})},
      'verify 検証用', ${riskLevel}, 'approved', ${`nonce-${skillId}-${sessionId}`},
      now() + interval '5 minutes'
    )
    RETURNING id
  `;
  const stepId = stepRows[0]?.id as string;
  const commandRows = await sql<{ id: string }[]>`
    INSERT INTO device_commands (
      user_email, device_id, op_id, params, status, result, completed_at,
      session_id, step_id, skill_id, skill_version
    ) VALUES (
      ${EMAIL}, ${DEVICE}, ${skillId}, ${jsonbValue({})}, 'done', ${jsonbValue(result)},
      now(), ${sessionId}, ${stepId}, ${skillId}, ${version}
    )
    RETURNING id
  `;
  const commandId = commandRows[0]?.id as string;
  await sql`UPDATE resolution_steps SET command_id = ${commandId} WHERE id = ${stepId}`;
  return { sessionId, stepId };
}

describe('ハードニング（端末バインド・estop・停止）', () => {
  it('本人の端末在庫に無い deviceId ではセッションを開始できない', async () => {
    const response = await post('/api/resolve/sessions', {
      caseId: CASE_PRINT,
      deviceId: 'WEB-NOT-OWNED',
    });
    expect(response.statusCode, response.body).toBe(404);
  });

  it('緊急停止中はセッションを開始できない', async () => {
    await sql`
      UPDATE prototype_states
      SET data = jsonb_set((data #>> '{}')::jsonb, '{estop}', 'true'::jsonb)
      WHERE user_email = ${EMAIL} AND name = 'cowork'
    `;
    const response = await post('/api/resolve/sessions', { caseId: CASE_PRINT, deviceId: DEVICE });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.code).toBe('ESTOP_ACTIVE');
    await sql`
      UPDATE prototype_states
      SET data = jsonb_set((data #>> '{}')::jsonb, '{estop}', 'false'::jsonb)
      WHERE user_email = ${EMAIL} AND name = 'cowork'
    `;
  });

  it('停止すると未配信コマンドが expired になり、結果が届いても進まない', async () => {
    const started = await startSession(CASE_PRINT);
    const approved = await approveWithChallenge(started);
    expect(approved.statusCode, approved.body).toBe(200);
    const commandId = await commandIdFor(started.step.id);

    const stopped = await post(`/api/resolve/sessions/${started.session.id}/stop`, {});
    expect(stopped.statusCode, stopped.body).toBe(200);
    const commandRows = await sql<{ status: string }[]>`
      SELECT status FROM device_commands WHERE id = ${commandId}
    `;
    expect(commandRows[0]?.status).toBe('expired');

    await sql`
      UPDATE device_commands
      SET status = 'done', result = ${jsonbValue({ ok: true, summary: 'late' })}, completed_at = now()
      WHERE id = ${commandId}
    `;
    const step = await getStep(started.step.id);
    expect(step.statusCode, step.body).toBe(200);
    expect(step.json().session.status).toBe('stopped');
    expect(step.json().step.status).toBe('cancelled');
  });
});

describe('Phase 5: verify 評価と終了条件', () => {
  it('verify.ok=true の修復ステップは AI を呼ばずに止まり、awaitingResolution を返す', async () => {
    // 変更系（リスク2以上）かつ verify を resultField で評価できる Skill を使う。
    // dns.flush はリスク 1 のため「解決候補」にはしない（2026-10-25 の誤分類の回帰）。
    const { sessionId, stepId } = await createRepairStepWithResult('spooler.queue.purge', {
      ok: true,
      exitCode: 0,
      normalized: { remainingErrorCount: 0, purgedCount: 1, failedCount: 0, irreversible: true },
      stdoutSummary: '{"remainingErrorCount":0}',
    });

    const detail = await getStep(stepId);
    expect(detail.statusCode, detail.body).toBe(200);
    const body = detail.json();
    expect(body.step.status).toBe('done');
    expect(body.step.verifyResult).toMatchObject({
      ok: true,
      evaluated: true,
      field: 'remainingErrorCount',
      actual: 0,
      expected: 0,
    });
    // resolved への自動遷移はしない（利用者の確認が必須なので waiting_continue のまま）。
    expect(body.session.status).toBe('waiting_continue');
    expect(body.session.lastSummary).toMatchObject({
      outcome: 'verified',
      stepId,
      skillId: 'spooler.queue.purge',
      verify: { ok: true, evaluated: true },
    });
    // 既存の結果サマリは残す（UI が lastSummary.ok 等を読んでも壊れない）。
    expect(body.session.lastSummary.ok).toBe(true);

    // verify_result は DB に保存される（ok だけでなく null も保存する）。
    const rows = await sql<{ verify_result: any }[]>`
      SELECT verify_result FROM resolution_steps WHERE id = ${stepId}
    `;
    expect(rows[0]?.verify_result).toMatchObject({ ok: true, evaluated: true });

    const response = await post(`/api/resolve/steps/${stepId}/continue`, { decision: 'Y' });
    expect(response.statusCode, response.body).toBe(200);
    const cont = response.json();
    expect(cont.ok).toBe(true);
    expect(cont.awaitingResolution).toBe(true);
    expect(cont.step).toBeNull();
    expect(cont.session.status).toBe('waiting_continue');
    expect(cont.session.lastSummary.awaitingDecision).toBe(true);

    // 次ステップを提案していない（AI 呼び出しも行わない）。
    const steps = await sql<{ id: string }[]>`
      SELECT id FROM resolution_steps WHERE session_id = ${sessionId}
    `;
    expect(steps.length).toBe(1);
    const sessionRows = await sql<{ status: string; step_count: number }[]>`
      SELECT status, step_count FROM resolution_sessions WHERE id = ${sessionId}
    `;
    expect(sessionRows[0]?.status).toBe('waiting_continue');
    expect(Number(sessionRows[0]?.step_count)).toBe(1);

    const audits = await sql<{ action: string }[]>`
      SELECT action FROM audit_log
      WHERE target_id = ${sessionId} AND action = 'resolution.awaiting_decision'
    `;
    expect(audits.length).toBe(1);
  });

  it('awaitingResolution の後に continue しても再開しない（409 AWAITING_DECISION）', async () => {
    const { sessionId, stepId } = await createRepairStepWithResult('spooler.queue.purge', {
      ok: true,
      normalized: { remainingErrorCount: 0 },
      stdoutSummary: '{"remainingErrorCount":0}',
    });
    await getStep(stepId);
    const first = await post(`/api/resolve/steps/${stepId}/continue`, { decision: 'Y' });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().awaitingResolution).toBe(true);

    const second = await post(`/api/resolve/steps/${stepId}/continue`, { decision: 'Y' });
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().error.code).toBe('AWAITING_DECISION');

    const steps = await sql<
      { id: string }[]
    >`SELECT id FROM resolution_steps WHERE session_id = ${sessionId}`;
    expect(steps.length).toBe(1);
  });

  it('awaitingResolution でも利用者の /resolve と /escalate は選べる（自動遷移しない）', async () => {
    const resolvedFixture = await createRepairStepWithResult('spooler.queue.purge', {
      ok: true,
      normalized: { remainingErrorCount: 0 },
      stdoutSummary: '{"remainingErrorCount":0}',
    });
    await getStep(resolvedFixture.stepId);
    await post(`/api/resolve/steps/${resolvedFixture.stepId}/continue`, { decision: 'Y' });
    const resolved = await post(`/api/resolve/sessions/${resolvedFixture.sessionId}/resolve`, {
      reason: '直りました',
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json().session.status).toBe('resolved');

    const escalatedFixture = await createRepairStepWithResult('spooler.queue.purge', {
      ok: true,
      normalized: { remainingErrorCount: 0 },
      stdoutSummary: '{"remainingErrorCount":0}',
    });
    await getStep(escalatedFixture.stepId);
    await post(`/api/resolve/steps/${escalatedFixture.stepId}/continue`, { decision: 'Y' });
    const escalated = await post(`/api/resolve/sessions/${escalatedFixture.sessionId}/escalate`, {
      reason: '要確認',
    });
    expect(escalated.statusCode, escalated.body).toBe(200);
    expect(escalated.json().session.status).toBe('escalated');
  });

  it('verify.ok=false は保存するが停止せず、従来どおり次ステップを提案する', async () => {
    const { stepId } = await createRepairStepWithResult('dns.flush', {
      ok: true,
      normalized: { flushed: false },
      stdoutSummary: '{"flushed":false}',
    });
    const detail = await getStep(stepId);
    const body = detail.json();
    expect(body.step.verifyResult).toMatchObject({
      ok: false,
      evaluated: true,
      field: 'flushed',
      actual: false,
      expected: true,
    });
    expect(body.session.lastSummary.outcome).toBeUndefined();

    const response = await post(`/api/resolve/steps/${stepId}/continue`, { decision: 'Y' });
    expect(response.statusCode, response.body).toBe(200);
    const cont = response.json();
    expect(cont.awaitingResolution).toBeUndefined();
    expect(cont.step).not.toBeNull();
    expect(cont.step.seq).toBe(2);
  });

  it('script 形態の verify は requires_followup として保存し、追撃を自動 enqueue する', async () => {
    const { stepId } = await createRepairStepWithResult('spooler.restart', {
      ok: true,
      exitCode: 0,
      normalized: { name: 'Spooler', status: 'Running', restarted: true },
      stdoutSummary: '{"name":"Spooler","status":"Running"}',
    });
    const detail = await getStep(stepId);
    const body = detail.json();
    expect(body.step.verifyResult).toMatchObject({
      ok: null,
      evaluated: false,
      reason: 'requires_followup',
    });
    expect(body.session.lastSummary.outcome).toBeUndefined();
    // Phase 6a: 親が変更系なので、verify.script に一致する読み取り Skill の
    // 追撃ステップが自動承認で積まれ、セッションは executing に戻る。
    expect(body.session.status).toBe('executing');
    expect(body.session.stepCount).toBe(2);
    const followups = await sql<{ id: string; seq: number; skill_id: string; status: string }[]>`
      SELECT id, seq, skill_id, status FROM resolution_steps WHERE verify_for_step_id = ${stepId}
    `;
    expect(followups).toHaveLength(1);
    expect(followups[0]?.skill_id).toBe('service.status');
    expect(followups[0]?.seq).toBe(2);
    expect(followups[0]?.status).toBe('approved');
  });

  it('読み取りステップ（verify 未定義）は no_verify_definition を保存し、既存挙動を変えない', async () => {
    const { stepId } = await createRepairStepWithResult('spooler.status', {
      ok: true,
      exitCode: 0,
      normalized: { name: 'Spooler', status: 'Running' },
      stdoutSummary: 'Spooler: Running',
    });
    const detail = await getStep(stepId);
    const body = detail.json();
    expect(body.step.verifyResult).toMatchObject({
      ok: null,
      evaluated: false,
      reason: 'no_verify_definition',
    });
    // 従来どおり last_summary は結果サマリそのもの。
    expect(body.session.lastSummary).toEqual(body.step.resultSummary);
  });
});

/**
 * Phase 6a: script 形態 verify の追撃実行。
 * 親（変更系 / risk>=2）の verify が requires_followup のとき、verify.script と
 * 一致する approved / risk_level=1 の読み取り Skill を自動承認で 1 回だけ積み、
 * 追撃結果で親の verify_result をサブセット一致評価する。
 */
describe('Phase 6a: script 形態 verify の追撃実行', () => {
  const SERVICE_STATUS_SCRIPT = 'scripts/skills/windows/service-status.ps1';

  function parentResult() {
    return {
      ok: true,
      exitCode: 0,
      normalized: { name: 'Spooler', status: 'Restarted', restarted: true },
      stdoutSummary: 'Spooler restarted',
    };
  }

  async function followupsFor(parentStepId: string): Promise<any[]> {
    return sql<any[]>`
      SELECT id, seq, skill_id, skill_version, skill_content_hash, params, status, risk_level,
             approved_by, approved_at, command_id, verify_for_step_id, verify_result
      FROM resolution_steps
      WHERE verify_for_step_id = ${parentStepId}
      ORDER BY seq ASC
    `;
  }

  async function sessionRow(sessionId: string) {
    const rows = await sql<{ status: string; step_count: number; last_summary: any }[]>`
      SELECT status, step_count, last_summary FROM resolution_sessions WHERE id = ${sessionId}
    `;
    return rows[0];
  }

  it('親の verify.script に一致する risk1 Skill を自動承認で 1 回だけ enqueue する', async () => {
    const { sessionId, stepId } = await createRepairStepWithResult(
      'spooler.restart',
      parentResult(),
    );

    const body = (await getStep(stepId)).json();
    expect(body.step.status).toBe('done');
    expect(body.session.status).toBe('executing');
    expect(body.session.stepCount).toBe(2);

    const followups = await followupsFor(stepId);
    expect(followups).toHaveLength(1);
    const followup = followups[0];
    expect(followup).toMatchObject({
      seq: 2,
      skill_id: 'service.status',
      status: 'approved',
      risk_level: 1,
      approved_by: 'system:verify',
      verify_for_step_id: stepId,
      params: { service: 'Spooler' },
    });
    expect(followup.approved_at).toBeTruthy();
    expect(followup.command_id).toBeTruthy();
    // 親の verify_result は追撃完了までは requires_followup のまま（成功と見なさない）。
    const parent = await sql<{ verify_result: any }[]>`
      SELECT verify_result FROM resolution_steps WHERE id = ${stepId}
    `;
    expect(parent[0]?.verify_result).toMatchObject({
      ok: null,
      evaluated: false,
      reason: 'requires_followup',
    });

    const commands = await sql<any[]>`
      SELECT op_id, params, status, session_id, step_id, skill_id
      FROM device_commands WHERE step_id = ${followup.id}
    `;
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      op_id: 'service.status',
      params: { service: 'Spooler' },
      status: 'queued',
      session_id: sessionId,
      step_id: followup.id,
      skill_id: 'service.status',
    });

    const audits = await sql<any[]>`
      SELECT detail FROM audit_log
      WHERE target_id = ${sessionId} AND action = 'resolution.verify_enqueued'
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({
      parentStepId: stepId,
      verifySkillId: 'service.status',
      scriptPath: SERVICE_STATUS_SCRIPT,
    });
  });

  it('mapping が無ければ追撃せず、従来どおり requires_followup のまま次を提案する', async () => {
    await sql`UPDATE skills SET script_path = ${`${SERVICE_STATUS_SCRIPT}.missing`} WHERE id = 'service.status'`;
    try {
      const { stepId } = await createRepairStepWithResult('spooler.restart', parentResult());
      const body = (await getStep(stepId)).json();
      expect(body.session.status).toBe('waiting_continue');
      expect(body.session.stepCount).toBe(1);
      expect(await followupsFor(stepId)).toHaveLength(0);

      const response = await post(`/api/resolve/steps/${stepId}/continue`, { decision: 'Y' });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().step.seq).toBe(2);
    } finally {
      await sql`UPDATE skills SET script_path = ${SERVICE_STATUS_SCRIPT} WHERE id = 'service.status'`;
    }
  });

  it('親が読み取り（risk1）なら追撃しない', async () => {
    await sql`UPDATE skills SET risk_level = 1 WHERE id = 'spooler.restart'`;
    try {
      const { stepId } = await createRepairStepWithResult('spooler.restart', parentResult());
      const body = (await getStep(stepId)).json();
      expect(body.step.verifyResult).toMatchObject({ reason: 'requires_followup' });
      expect(body.session.status).toBe('waiting_continue');
      expect(body.session.stepCount).toBe(1);
      expect(await followupsFor(stepId)).toHaveLength(0);
    } finally {
      await sql`UPDATE skills SET risk_level = 2 WHERE id = 'spooler.restart'`;
    }
  });

  it('追撃結果が expect に一致すれば親を verified にし、既存の停止経路に合流する', async () => {
    const { sessionId, stepId } = await createRepairStepWithResult(
      'spooler.restart',
      parentResult(),
    );
    await getStep(stepId);
    const [followup] = await followupsFor(stepId);
    await markCommandDone(followup.id, {
      ok: true,
      exitCode: 0,
      normalized: { name: 'Spooler', displayName: 'Print Spooler', status: 'Running' },
      stdoutSummary: 'Spooler: Running',
    });

    const body = (await getStep(followup.id)).json();
    expect(body.step.status).toBe('done');
    // 追撃ステップ自身は risk1 の読み取りなので従来の停止条件では止まらない。
    expect(body.step.verifyResult).toMatchObject({ reason: 'no_verify_definition' });
    expect(body.session.status).toBe('waiting_continue');
    expect(body.session.lastSummary).toMatchObject({
      outcome: 'verified',
      stepId: followup.id,
      skillId: 'service.status',
      verify: { ok: true, evaluated: true, field: null },
    });

    const parent = await sql<{ verify_result: any }[]>`
      SELECT verify_result FROM resolution_steps WHERE id = ${stepId}
    `;
    expect(parent[0]?.verify_result).toMatchObject({
      ok: true,
      evaluated: true,
      field: null,
      actual: { status: 'Running' },
      expected: { status: 'Running' },
    });
    expect(parent[0]?.verify_result.reason).toBeUndefined();

    const audits = await sql<any[]>`
      SELECT detail FROM audit_log
      WHERE target_id = ${sessionId} AND action = 'resolution.verify_result'
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({ parentStepId: stepId, ok: true });

    // 追加提案はせず、最終判断待ち（resolved への自動遷移はしない）。
    const response = await post(`/api/resolve/steps/${followup.id}/continue`, { decision: 'Y' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().awaitingResolution).toBe(true);
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM resolution_steps WHERE session_id = ${sessionId}
    `;
    expect(rows).toHaveLength(2);
    expect((await sessionRow(sessionId))?.status).toBe('waiting_continue');
  });

  it('追撃結果が expect に一致しなければ停止せず、従来どおり次を提案する', async () => {
    const { sessionId, stepId } = await createRepairStepWithResult(
      'spooler.restart',
      parentResult(),
    );
    await getStep(stepId);
    const [followup] = await followupsFor(stepId);
    await markCommandDone(followup.id, {
      ok: true,
      exitCode: 0,
      normalized: { name: 'Spooler', status: 'Stopped' },
      stdoutSummary: 'Spooler: Stopped',
    });

    const body = (await getStep(followup.id)).json();
    expect(body.session.status).toBe('waiting_continue');
    expect(body.session.lastSummary.outcome).toBeUndefined();

    const parent = await sql<{ verify_result: any }[]>`
      SELECT verify_result FROM resolution_steps WHERE id = ${stepId}
    `;
    expect(parent[0]?.verify_result).toMatchObject({
      ok: false,
      evaluated: true,
      field: null,
      actual: { status: 'Stopped' },
      expected: { status: 'Running' },
      reason: 'attempt_expect_mismatch',
    });

    const audits = await sql<any[]>`
      SELECT detail FROM audit_log
      WHERE target_id = ${sessionId} AND action = 'resolution.verify_result'
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toMatchObject({ parentStepId: stepId, ok: false });

    const response = await post(`/api/resolve/steps/${followup.id}/continue`, { decision: 'Y' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().awaitingResolution).toBeUndefined();
    expect(response.json().step.seq).toBe(3);
  });

  it('同じ親から二重に enqueue しない（GET を繰り返しても 1 回だけ）', async () => {
    const { sessionId, stepId } = await createRepairStepWithResult(
      'spooler.restart',
      parentResult(),
    );
    await getStep(stepId);
    await getStep(stepId);
    await getStep(stepId);
    const followups = await followupsFor(stepId);
    expect(followups).toHaveLength(1);
    const commands = await sql<{ id: string }[]>`
      SELECT id FROM device_commands WHERE step_id = ${followups[0]?.id}
    `;
    expect(commands).toHaveLength(1);
    const session = await sessionRow(sessionId);
    expect(session?.status).toBe('executing');
    expect(Number(session?.step_count)).toBe(2);
  });

  it('追撃の追撃は作らない（verify_for_step_id 付きステップでは enqueue しない）', async () => {
    const { sessionId, stepId } = await createRepairStepWithResult(
      'spooler.restart',
      parentResult(),
    );
    await getStep(stepId);
    const [followup] = await followupsFor(stepId);

    // 追撃ステップを「script 形態 verify を持つ変更系」に差し替えて、
    // 追撃生成の条件だけが verify_for_step_id で止まることを確かめる。
    const skillRows = await sql<{ version: string; content_hash: string }[]>`
      SELECT version, content_hash FROM skills WHERE id = 'spooler.restart' LIMIT 1
    `;
    const spoolerRestart = skillRows[0];
    expect(spoolerRestart).toBeTruthy();
    if (!spoolerRestart) throw new Error('spooler.restart が skills に無い');
    await sql`
      UPDATE resolution_steps
      SET skill_id = 'spooler.restart', skill_version = ${spoolerRestart.version},
          skill_content_hash = ${spoolerRestart.content_hash}
      WHERE id = ${followup.id}
    `;
    await markCommandDone(followup.id, {
      ok: true,
      exitCode: 0,
      normalized: { status: 'Running' },
      stdoutSummary: 'Spooler: Running',
    });

    const body = (await getStep(followup.id)).json();
    // 親（spooler.restart）の expect は追撃結果で評価され、停止経路に合流する。
    expect(body.session.lastSummary.outcome).toBe('verified');
    const nested = await sql<{ id: string }[]>`
      SELECT id FROM resolution_steps WHERE verify_for_step_id = ${followup.id}
    `;
    expect(nested).toHaveLength(0);
    const all = await sql<{ id: string }[]>`
      SELECT id FROM resolution_steps WHERE session_id = ${sessionId}
    `;
    expect(all).toHaveLength(2);
  });

  it('自動承認は risk_level=1 の Skill だけ（risk2 の同 script Skill は選ばない）', async () => {
    await sql`
      INSERT INTO skills (
        id, version, title, summary, symptoms, os, risk_level, requires, params_schema,
        script_path, args, verify, rollback, timeout_sec, result_schema, output_policy,
        status, content_hash
      ) VALUES (
        'test.elevated.verify', '1.0.0', 'テスト用 risk2', '', '[]'::jsonb, ARRAY['windows'], 2,
        '{}'::jsonb, '{}'::jsonb, ${SERVICE_STATUS_SCRIPT}, '[]'::jsonb, NULL, NULL, 60,
        NULL, NULL, 'approved', ${`sha256:${'f'.repeat(64)}`}
      )
      ON CONFLICT (id, version) DO NOTHING
    `;
    try {
      const { sessionId, stepId } = await createRepairStepWithResult(
        'spooler.restart',
        parentResult(),
      );
      await getStep(stepId);
      const followups = await followupsFor(stepId);
      expect(followups).toHaveLength(1);
      expect(followups[0]).toMatchObject({
        skill_id: 'service.status',
        risk_level: 1,
        approved_by: 'system:verify',
      });
      const elevated = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM resolution_steps
        WHERE session_id = ${sessionId}
          AND approved_by = 'system:verify'
          AND risk_level >= 2
      `;
      expect(Number(elevated[0]?.n)).toBe(0);
    } finally {
      await sql`DELETE FROM skills WHERE id = 'test.elevated.verify'`;
    }
  });

  it('verify.args の {{name}} を親 params で解決して params に変換する（service.start）', async () => {
    const { stepId } = await createRepairStepWithResult('service.start', {
      ok: true,
      exitCode: 0,
      normalized: { name: 'Spooler', status: 'Running', started: true },
      stdoutSummary: 'Spooler started',
    });
    await sql`UPDATE resolution_steps SET params = ${jsonbValue({ name: 'Spooler' })} WHERE id = ${stepId}`;

    const body = (await getStep(stepId)).json();
    expect(body.session.status).toBe('executing');
    const followups = await followupsFor(stepId);
    expect(followups).toHaveLength(1);
    // verify.args = ['-Service', '{{name}}'] → { service: 'Spooler' }
    expect(followups[0]).toMatchObject({
      skill_id: 'service.status',
      params: { service: 'Spooler' },
      approved_by: 'system:verify',
    });
  });

  it('params が paramsSchema を通らなければ追撃しない（自動承認の安全側）', async () => {
    const { stepId } = await createRepairStepWithResult('service.start', {
      ok: true,
      exitCode: 0,
      normalized: { name: 'Spooler', status: 'Running', started: true },
      stdoutSummary: 'Spooler started',
    });
    // service.status の enum は Spooler / W32Time / Winmgmt のみ。範囲外は通さない。
    await sql`UPDATE resolution_steps SET params = ${jsonbValue({ name: 'AttackerChosen' })} WHERE id = ${stepId}`;

    const body = (await getStep(stepId)).json();
    expect(body.session.status).toBe('waiting_continue');
    expect(await followupsFor(stepId)).toHaveLength(0);
  });
});
