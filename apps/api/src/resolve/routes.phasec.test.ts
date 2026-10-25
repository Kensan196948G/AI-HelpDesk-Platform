import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { sql } from '../db.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { resetRateLimits } from '../lib/rate-limit.js';
import { buildServer } from '../server.js';
import {
  type AdminApprovalPayload,
  computeAdminApprovalHash,
  computeApprovalHash,
} from './approval.js';

/**
 * Phase C の受入テスト:
 * - 端末オフライン / 結果タイムアウトの自動失敗
 * - リスク 4 以上の IT 管理者承認（自己承認・改ざん・期限切れ）
 * - 手動「解決した」「担当者へ」
 * - outputPolicy.fieldsToAi の厳密適用
 */
const EMAIL = 'phasec-test@example.com';
const ADMIN = 'phasec-admin@example.com';
const DEVICE = 'WEB-PHASEC1';
const CASE_ID = 'CASE-PHASEC';

let app: FastifyInstance;
let originalDevEmail: string;
let originalAdminAllowlist: string;

const COWORK_FIXTURE = {
  v: 31,
  cases: [
    {
      id: CASE_ID,
      userId: 'u1',
      subject: '印刷できない',
      body: 'プリンタで印刷できません。印刷キューに残ってしまいます。',
      urg: '通常',
    },
  ],
};

async function post(url: string, payload: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url, payload });
}

async function get(url: string) {
  return app.inject({ method: 'GET', url });
}

async function startSession() {
  const response = await post('/api/resolve/sessions', { caseId: CASE_ID, deviceId: DEVICE });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

function challengeHash(body: any): string {
  return computeApprovalHash(body.step.approvalChallenge.payload);
}

async function approve(stepId: string, approvalHash: string, decision: 'Y' | 'N' = 'Y') {
  return post(`/api/resolve/steps/${stepId}/approve`, { decision, approvalHash });
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

async function stepRow(stepId: string) {
  const rows = await sql<Record<string, any>[]>`
    SELECT * FROM resolution_steps WHERE id = ${stepId} LIMIT 1
  `;
  return rows[0];
}

/** リスク 4 以上の Skill を提案させた状態を作る（Skill カタログは変更しない）。 */
async function makeRisk4(stepId: string) {
  await sql`
    UPDATE resolution_steps
    SET risk_level = 4,
        admin_nonce = COALESCE(admin_nonce, 'admin-nonce'),
        admin_expires_at = now() + interval '10 minutes'
    WHERE id = ${stepId}
  `;
}

beforeAll(async () => {
  originalDevEmail = config.DEV_AUTH_EMAIL;
  originalAdminAllowlist = config.RESOLVE_ADMIN_ALLOWLIST;
  config.DEV_AUTH_EMAIL = EMAIL;
  config.RESOLVE_ADMIN_ALLOWLIST = '';

  app = await buildServer({ logger: false });
  await app.ready();

  await sql`
    UPDATE skills
    SET status = 'approved',
        approved_by = 'test',
        approved_at = now(),
        content_hash = COALESCE(content_hash, ${`sha256:${'b'.repeat(64)}`})
  `;
  await sql`
    INSERT INTO device_inventories (user_email, source, device_id, data)
    VALUES (${EMAIL}, 'browser', ${DEVICE}, '{}'::jsonb)
    ON CONFLICT (user_email, source, device_id) DO NOTHING
  `;
  await sql`
    INSERT INTO device_tokens (token_hash, user_email, label, device_id, last_used_at)
    VALUES (${`phasec-token-${EMAIL}`}, ${EMAIL}, 'test', ${DEVICE}, now())
    ON CONFLICT (token_hash) DO UPDATE
      SET device_id = EXCLUDED.device_id, revoked_at = NULL, last_used_at = now()
  `;
  await sql`DELETE FROM device_commands WHERE user_email = ${EMAIL} AND session_id IS NOT NULL`;
  await sql`DELETE FROM resolution_sessions WHERE user_email = ${EMAIL}`;
  await sql`DELETE FROM prototype_states WHERE user_email = ${EMAIL} AND name = 'cowork'`;
  await sql`
    INSERT INTO prototype_states (user_email, name, data)
    VALUES (${EMAIL}, 'cowork', ${jsonbValue(COWORK_FIXTURE)})
    ON CONFLICT (user_email, name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
  `;
});

beforeEach(() => {
  resetRateLimits();
  config.DEV_AUTH_EMAIL = EMAIL;
  config.RESOLVE_ADMIN_ALLOWLIST = '';
});

afterAll(async () => {
  await sql`DELETE FROM device_commands WHERE user_email = ${EMAIL} AND session_id IS NOT NULL`;
  await sql`DELETE FROM resolution_sessions WHERE user_email = ${EMAIL}`;
  await sql`DELETE FROM device_tokens WHERE user_email = ${EMAIL}`;
  await sql`DELETE FROM prototype_states WHERE user_email = ${EMAIL} AND name = 'cowork'`;
  config.DEV_AUTH_EMAIL = originalDevEmail;
  config.RESOLVE_ADMIN_ALLOWLIST = originalAdminAllowlist;
  await app.close();
});

describe('手動「解決した」「担当者へ」', () => {
  it('解決した で resolved になり、二重操作は 409', async () => {
    const started = await startSession();
    const resolved = await post(`/api/resolve/sessions/${started.session.id}/resolve`, {
      reason: '自分で直せた',
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(resolved.json().session.status).toBe('resolved');

    const again = await post(`/api/resolve/sessions/${started.session.id}/resolve`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('SESSION_TERMINAL');
  });

  it('担当者へ で escalated になり、未実行ステップは cancelled', async () => {
    const started = await startSession();
    const escalated = await post(`/api/resolve/sessions/${started.session.id}/escalate`, {
      reason: '実機確認が必要',
    });
    expect(escalated.statusCode, escalated.body).toBe(200);
    expect(escalated.json().session.status).toBe('escalated');
    expect((await stepRow(started.step.id)).status).toBe('cancelled');
  });

  it('他人のセッションは操作できない（404）', async () => {
    const started = await startSession();
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM resolution_sessions WHERE id = ${started.session.id}
    `;
    expect(rows[0]?.id).toBe(started.session.id);
    // DEV_AUTH_EMAIL を別の利用者へ切り替えると、対象は本人のものではない。
    config.DEV_AUTH_EMAIL = ADMIN;
    const response = await post(`/api/resolve/sessions/${started.session.id}/resolve`);
    expect(response.statusCode).toBe(404);
  });
});

describe('端末オフライン / 結果タイムアウト', () => {
  it('最終応答が閾値より古いと承認は 409 DEVICE_OFFLINE', async () => {
    const started = await startSession();
    await sql`
      UPDATE device_tokens SET last_used_at = now() - interval '10 minutes'
      WHERE user_email = ${EMAIL} AND device_id = ${DEVICE}
    `;
    const response = await approve(started.step.id, challengeHash(started));
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.code).toBe('DEVICE_OFFLINE');
    await sql`
      UPDATE device_tokens SET last_used_at = now()
      WHERE user_email = ${EMAIL} AND device_id = ${DEVICE}
    `;
  });

  it('期限を過ぎた実行は failed になり、遅延した結果は状態を進めない', async () => {
    const started = await startSession();
    const approved = await approve(started.step.id, challengeHash(started));
    expect(approved.statusCode, approved.body).toBe(200);
    const stepAfterApprove = approved.json().step;
    expect(stepAfterApprove.timeoutSec).toBeGreaterThan(0);
    expect(stepAfterApprove.deadlineAt).toBeTruthy();

    await sql`
      UPDATE resolution_steps SET deadline_at = now() - interval '1 second'
      WHERE id = ${started.step.id}
    `;
    const timedOut = await get(`/api/resolve/steps/${started.step.id}`);
    expect(timedOut.statusCode, timedOut.body).toBe(200);
    expect(timedOut.json().step.status).toBe('failed');
    expect(timedOut.json().step.error).toBe('RESULT_TIMEOUT');
    expect(timedOut.json().session.status).toBe('escalated');

    // 期限後に結果が届いても done にはならない。
    await markCommandDone(started.step.id, { exitCode: 0, normalized: { service: 'Spooler' } });
    const afterLateResult = await get(`/api/resolve/steps/${started.step.id}`);
    expect(afterLateResult.json().step.status).toBe('failed');
    expect(afterLateResult.json().session.status).toBe('escalated');
  });
});

describe('outputPolicy.fieldsToAi の厳密適用', () => {
  it('宣言されたフィールドだけが resultAi に入り、画面用 summary は従来どおり', async () => {
    const started = await startSession();
    const approved = await approve(started.step.id, challengeHash(started));
    expect(approved.statusCode, approved.body).toBe(200);

    await markCommandDone(started.step.id, {
      exitCode: 0,
      stdoutSummary: 'Spooler は実行中です',
      normalized: {
        service: 'Spooler',
        status: 'running',
        extraField: 'これは AI に渡してはいけない',
        nested: { detail: 'x' },
      },
    });
    const result = await get(`/api/resolve/steps/${started.step.id}`);
    expect(result.statusCode, result.body).toBe(200);
    const step = result.json().step;

    // AI 向け（resultAi）は fieldsToAi のみ。
    expect(step.resultAi.normalized).toEqual({ service: 'Spooler', status: 'running' });
    expect(step.resultAi.normalized.extraField).toBeUndefined();
    expect(step.resultAi.normalized.nested).toBeUndefined();
    expect(step.resultAi.summary).toBe('Spooler は実行中です');
    // 画面向け summary は既存どおり（fieldsToAi で削らない）。
    expect(step.resultSummary.normalized.extraField).toBe('これは AI に渡してはいけない');
  });

  it('outputPolicy が無い Skill では normalized を AI に渡さない（fail-closed）', async () => {
    const started = await startSession();
    const approved = await approve(started.step.id, challengeHash(started));
    expect(approved.statusCode, approved.body).toBe(200);
    await sql`
      UPDATE skills SET output_policy = NULL
      WHERE id = ${started.step.skillId} AND version = ${started.step.skillVersion}
    `;
    try {
      await markCommandDone(started.step.id, {
        exitCode: 0,
        stdoutSummary: 'ok',
        normalized: { service: 'Spooler' },
      });
      const result = await get(`/api/resolve/steps/${started.step.id}`);
      expect(result.json().step.resultAi.normalized).toBeNull();
    } finally {
      await sql`
        UPDATE skills SET output_policy = ${jsonbValue({
          maxBytes: 8192,
          fieldsToAi: ['service', 'status', 'startType', 'printerCount', 'jobCount'],
          maskPii: true,
        })}
        WHERE id = ${started.step.skillId} AND version = ${started.step.skillVersion}
      `;
    }
  });
});

describe('リスク 4 以上の IT 管理者承認', () => {
  it('承認が無いと実行できず、管理者の承認後に本人 Y で実行できる', async () => {
    const started = await startSession();
    await makeRisk4(started.step.id);

    const blocked = await approve(started.step.id, challengeHash(started));
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('ADMIN_APPROVAL_REQUIRED');

    // 管理者として承認待ちを取得し、payload からハッシュを作る。
    config.DEV_AUTH_EMAIL = ADMIN;
    config.RESOLVE_ADMIN_ALLOWLIST = ADMIN;
    const pending = await get('/api/resolve/admin/pending');
    expect(pending.statusCode, pending.body).toBe(200);
    const item = pending
      .json()
      .items.find((candidate: any) => candidate.stepId === started.step.id);
    expect(item, pending.body).toBeTruthy();
    const adminHash = computeAdminApprovalHash(item.adminApprovalChallenge.payload);
    const adminApproved = await post(`/api/resolve/steps/${started.step.id}/admin-approve`, {
      decision: 'Y',
      approvalHash: adminHash,
    });
    expect(adminApproved.statusCode, adminApproved.body).toBe(200);

    // 依頼者に戻って Y。管理者承認が揃っているので実行できる。
    // risk_level を書き換えたため、承認 payload は取り直す（ハッシュは step の現在値に束縛）。
    config.DEV_AUTH_EMAIL = EMAIL;
    const refreshed = await get(`/api/resolve/steps/${started.step.id}`);
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const approved = await approve(started.step.id, challengeHash(refreshed.json()));
    expect(approved.statusCode, approved.body).toBe(200);
    const row = await stepRow(started.step.id);
    expect(row.status).toBe('approved');
    expect(row.admin_approved_by).toBe(ADMIN);
    expect(row.admin_approval_hash).toBe(adminHash);
  });

  it('自己承認は 403（依頼者を許可リストに入れても承認できない）', async () => {
    const started = await startSession();
    await makeRisk4(started.step.id);
    config.RESOLVE_ADMIN_ALLOWLIST = EMAIL;
    const payload = {
      decision: 'Y' as const,
      approvalHash: '0'.repeat(64),
    };
    const response = await post(`/api/resolve/steps/${started.step.id}/admin-approve`, payload);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  it('改ざんされた承認ハッシュは 400、期限切れは 409', async () => {
    const started = await startSession();
    await makeRisk4(started.step.id);
    config.DEV_AUTH_EMAIL = ADMIN;
    config.RESOLVE_ADMIN_ALLOWLIST = ADMIN;

    const tampered = await post(`/api/resolve/steps/${started.step.id}/admin-approve`, {
      decision: 'Y',
      approvalHash: 'f'.repeat(64),
    });
    expect(tampered.statusCode).toBe(400);
    expect(tampered.json().error.code).toBe('ADMIN_APPROVAL_MISMATCH');

    await sql`
      UPDATE resolution_steps SET admin_expires_at = now() - interval '1 second'
      WHERE id = ${started.step.id}
    `;
    const expired = await post(`/api/resolve/steps/${started.step.id}/admin-approve`, {
      decision: 'Y',
      approvalHash: 'f'.repeat(64),
    });
    expect(expired.statusCode).toBe(409);
    expect(expired.json().error.code).toBe('ADMIN_APPROVAL_EXPIRED');
  });

  it('管理者以外は承認待ちを取得できない（403）', async () => {
    const pending = await get('/api/resolve/admin/pending');
    expect(pending.statusCode).toBe(403);
    expect(pending.json().error.code).toBe('FORBIDDEN');
  });
});

describe('承認 payload の互換性', () => {
  it('依頼者向け approvalChallenge は 12 キーのまま（管理者承認を混ぜない）', async () => {
    const started = await startSession();
    const payload = started.step.approvalChallenge.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
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
    const adminPayload = buildAdminPayloadForTest(payload);
    expect(Object.keys(adminPayload)).toContain('adminEmail');
  });
});

/** 管理者 payload の形（adminEmail 追加）を型で確認するための小道具。 */
function buildAdminPayloadForTest(base: Record<string, unknown>): AdminApprovalPayload {
  return {
    stepId: String(base.stepId),
    sessionId: String(base.sessionId),
    seq: Number(base.seq),
    skillId: String(base.skillId),
    skillVersion: String(base.skillVersion),
    skillContentHash: String(base.skillContentHash),
    params: (base.params as Record<string, unknown>) ?? {},
    deviceId: String(base.deviceId),
    userEmail: String(base.userEmail),
    riskLevel: Number(base.riskLevel),
    adminEmail: ADMIN,
    nonce: String(base.nonce),
    expiresAt: String(base.expiresAt),
  };
}
