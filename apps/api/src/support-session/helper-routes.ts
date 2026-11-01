import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { sql } from '../db.js';
import { ApiError, notFound, unauthorized } from '../errors.js';
import { hashToken } from '../folder-access/sign.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { SkillResultBodySchema, StartBodySchema } from './contract.js';
import {
  assistEnabled,
  lockSession,
  recordResultTx,
  sessionAudit,
  startExecutionTx,
} from './service.js';
import { ASSIST_LIMITS } from './state.js';

/**
 * ヘルパーの実行経路（docs/63 §6、§7）。契約は contract.ts。
 * Access を通らない /api/device/agent 配下で、ヘルパートークンで守る。
 * トークン・出力・SID をログと監査へ出さない。
 */

const OpParams = z.object({ id: z.string().uuid() });

function helperToken(request: FastifyRequest): string {
  const raw = request.headers['x-folder-helper-token'];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 200) {
    throw unauthorized('ヘルパートークンが必要です。');
  }
  return token;
}

interface HelperKey {
  id: string;
  report_expired: boolean;
}

async function findHelper(token: string): Promise<HelperKey> {
  const rows = await sql<HelperKey[]>`
    SELECT id,
      (revoked_at IS NOT NULL AND revoked_at
        <= now() - (${ASSIST_LIMITS.revokedReportHours}::int * interval '1 hour')) AS report_expired
    FROM folder_access_helpers
    WHERE token_hash = ${hashToken(token)}
  `;
  const row = rows[0];
  if (!row) throw unauthorized('ヘルパートークンが無効です。');
  return row;
}

export async function supportSessionHelperRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async () => {
    if (!assistEnabled()) throw notFound('パスは存在しません。');
  });

  app.post(
    '/device/agent/folder-helper/ops/:id/start',
    { bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const helper = await findHelper(helperToken(request));
      if (!checkRateLimit(`assist-helper-start:${helper.id}`, 30, 60_000)) {
        throw new ApiError(429, 'RATE_LIMITED', 'リクエストが多すぎます。');
      }
      const { id } = OpParams.parse(request.params);
      const body = StartBodySchema.parse(request.body);
      // 失効済みのトークンでもここを通す。セッションが終わっていれば拒否を記録する（rejected_at_start。§10）。
      const outcome = await sql.begin((tx) => startExecutionTx(tx, helper.id, id, body));
      if (outcome.kind === 'missing') throw notFound('対象の操作が見つかりません。');
      if (outcome.kind === 'rejected') {
        reply.code(409);
        return { ok: false, started: false, reason: outcome.reason };
      }
      return { ok: true, started: true, opId: id, deadlineAt: outcome.deadlineAt.toISOString() };
    },
  );

  // 失効後のトークンでも受ける（kill → 報告 → トークン削除の順。§10）。
  app.post(
    '/device/agent/folder-helper/ops/:id/skill-result',
    { bodyLimit: 64 * 1024 },
    async (request) => {
      const helper = await findHelper(helperToken(request));
      if (!checkRateLimit(`assist-helper-result:${helper.id}`, 60, 60_000)) {
        throw new ApiError(429, 'RATE_LIMITED', 'リクエストが多すぎます。');
      }
      const { id } = OpParams.parse(request.params);

      // 失効から一定時間を過ぎたトークンの報告は受けない（保存しない）。判定はサーバの時刻で、
      // 基準の revoked_at は COALESCE で固定なので再送しても延びない。本文の形式より先に判定する。
      if (helper.report_expired) {
        const known = await sql.begin(async (tx) => {
          const keys = await tx<{ support_session_id: string; skill_id: string; role: string }[]>`
            SELECT support_session_id, skill_id, role FROM assist_executions
            WHERE id = ${id} AND helper_id = ${helper.id}
          `;
          const key = keys[0];
          if (!key) return false;
          const locked = await lockSession(tx, key.support_session_id);
          if (!locked) return false;
          await sessionAudit(
            tx,
            'support_session.report_expired',
            locked.session,
            'system:assist-helper',
            { opId: id, skillId: key.skill_id, role: key.role, source: 'report' },
          );
          return true;
        });
        if (!known) throw notFound('対象の操作が見つかりません。');
        throw new ApiError(410, 'RESULT_REPORT_EXPIRED', '結果を報告できる期限を過ぎました。');
      }

      const body = SkillResultBodySchema.parse(request.body);

      // real 以外は本番で必ず拒否する。本番以外でも検証用フラグが無ければ受けない（§7）。
      if (
        body.executionMode !== 'real' &&
        (config.isProduction || !config.ASSIST_ALLOW_MOCK_EXECUTION)
      ) {
        await sql.begin(async (tx) => {
          const keys = await tx<{ support_session_id: string }[]>`
          SELECT support_session_id FROM assist_executions
          WHERE id = ${id} AND helper_id = ${helper.id}
        `;
          const key = keys[0];
          if (!key) return;
          const locked = await lockSession(tx, key.support_session_id);
          if (!locked) return;
          await sessionAudit(
            tx,
            'support_session.mode_rejected',
            locked.session,
            'system:assist-helper',
            {
              opId: id,
              executionMode: body.executionMode,
            },
          );
        });
        throw new ApiError(
          403,
          'EXECUTION_MODE_REJECTED',
          '実行の出所を確認できない報告は受け付けません。',
        );
      }

      const outcome = await sql.begin((tx) => recordResultTx(tx, helper.id, id, body));
      if (outcome.kind === 'missing') throw notFound('対象の操作が見つかりません。');
      if (outcome.kind === 'accepted') return { ok: true, accepted: true };
      return { ok: true, accepted: false, reason: outcome.reason };
    },
  );
}
