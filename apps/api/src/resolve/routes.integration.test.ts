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
  it('承認済み Skill の一覧を返す（Windows / リスク 1 / パラメータスキーマ付き）', async () => {
    const response = await get('/api/resolve/skills');
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.skills.map((skill: any) => skill.id).sort()).toEqual(
      ['disk.space', 'network.adapters', 'os.info', 'service.status', 'spooler.status'].sort(),
    );
    for (const skill of body.skills) {
      expect(skill.status).toBe('approved');
      expect(skill.os).toContain('windows');
      expect(skill.riskLevel).toBe(1);
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
