import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.js';
import { ApiError, unauthorized } from '../errors.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { checkRateLimit, clientAddress } from '../lib/rate-limit.js';
import { SKILL_RUN_CAPABILITY, signSkillRun } from '../support-session/contract.js';
import { assistPollTx } from '../support-session/service.js';
import { checkAddressLimit, isAddressLimited } from './address-limit.js';
import { requireFolderAccessEnabled } from './routes.js';
import {
  activeViolation,
  appendFolderAudit,
  endRequestTx,
  loadContext,
  type RequestContext,
  reconcileProbe,
  type Tx,
} from './service.js';
import {
  ENROLL_CODE_PATTERN,
  generateHelperToken,
  generatePairingCode,
  hashEnrollCode,
  hashPairingCode,
  hashToken,
  signOp,
} from './sign.js';
import {
  type EndReason,
  heartbeatDecision,
  isMachineGuid,
  isTerminal,
  isUserSid,
  LIMITS,
  normalizeEntries,
  normalizeSessionState,
  ResultBodySchema,
  sanitizeEntryName,
} from './state.js';

/**
 * ヘルパー経路（docs/62 §5）。Access を通らない /api/device/agent 配下で、トークンで守る。
 * トークン・ファイル名・パスをログと監査へ出さない。
 */

const HELPER_ACTOR = 'system:folder-helper';

const SessionFields = {
  sid: z.string().trim().min(1).max(200),
  sessionId: z.number().int().min(0).max(65535),
  sessionState: z.string().trim().min(1).max(40),
};

const RegisterBody = z.object({
  machineGuid: z.string().trim().refine(isMachineGuid, 'MachineGuid の形式が不正です。'),
  userName: z.string().trim().min(1).max(256),
  hostname: z.string().trim().min(1).max(128),
  helperVersion: z.string().trim().min(1).max(40),
  // 必須だが、欠落も形式違いも誤りと同じ応答にする（検証は本文の他の項目の後）。
  enrollCode: z.unknown().optional(),
  ...SessionFields,
});
// capabilities は skill_run を実行できるヘルパーの申告（docs/63 / support-session/contract.ts）。
const PollBody = z.object({
  ...SessionFields,
  capabilities: z.array(z.string().max(40)).max(16).optional(),
});
const OpParams = z.object({ id: z.string().uuid() });

interface HelperRow {
  id: string;
  sid: string;
  session_id: number;
  request_id: string | null;
  revoked_at: Date | null;
  pairing_expired: boolean;
}

function helperToken(request: FastifyRequest): string {
  const raw = request.headers['x-folder-helper-token'];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 200) {
    throw unauthorized('ヘルパートークンが必要です。');
  }
  return token;
}

async function findHelper(token: string): Promise<HelperRow> {
  const rows = await sql<HelperRow[]>`
    SELECT id, sid, session_id, request_id, revoked_at,
           (pairing_expires_at <= now()) AS pairing_expired
    FROM folder_access_helpers
    WHERE token_hash = ${hashToken(token)}
  `;
  const row = rows[0];
  if (!row) throw unauthorized('ヘルパートークンが無効です。');
  return row;
}

/** 導入コードを 1 回だけ消費する。有効な依頼が無ければ null（理由は区別しない）。 */
async function consumeEnrollCode(tx: Tx, code: string): Promise<RequestContext | null> {
  const hash = hashEnrollCode(code);
  const found = await tx<{ id: string }[]>`
    SELECT id FROM folder_access_requests WHERE enroll_code_hash = ${hash}
  `;
  const id = found[0]?.id;
  if (!id) return null;
  const ctx = await loadContext(tx, id);
  if (!ctx) return null;
  const consumed = await tx<{ id: string }[]>`
    UPDATE folder_access_requests
    SET enroll_code_hash = NULL, enroll_code_expires_at = NULL, updated_at = now()
    WHERE id = ${id}
      AND enroll_code_hash = ${hash}
      AND enroll_code_expires_at > now()
      AND status = 'helper_pending'
      AND helper_id IS NULL
      AND request_expires_at > now()
    RETURNING id
  `;
  return consumed[0] ? ctx : null;
}

/**
 * 未ペア行の全体の上限（多層防御）。上限に達したら期限切れの行を先に片付け、
 * それでも空かなければ登録を拒否する。行は残さないので、埋められても期限切れで空く。
 */
async function reserveUnpairedSlot(tx: Tx): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(918273646)`;
  const rows = await tx<{ count: string }[]>`
    SELECT count(*) AS count FROM folder_access_helpers WHERE request_id IS NULL
  `;
  if (Number(rows[0]?.count) < LIMITS.maxUnpairedHelpers) return;
  await tx`
    DELETE FROM folder_access_helpers
    WHERE request_id IS NULL AND pairing_expires_at <= now()
  `;
  const after = await tx<{ count: string }[]>`
    SELECT count(*) AS count FROM folder_access_helpers WHERE request_id IS NULL
  `;
  if (Number(after[0]?.count) >= LIMITS.maxUnpairedHelpers) {
    throw new ApiError(503, 'REGISTRATION_BUSY', '現在登録できません。少し待ってください。');
  }
}

async function drainCancels(tx: Tx, helperId: string): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    UPDATE folder_access_ops
    SET cancel_acked_at = now()
    WHERE helper_id = ${helperId} AND status = 'cancelled' AND cancel_acked_at IS NULL
    RETURNING id
  `;
  return rows.map((row) => row.id);
}

interface DeliveredOp {
  id: string;
  request_id: string;
  sid: string;
  session_id: number;
  root: string;
  segments: string[];
  operation: string;
  expires_at: Date;
  max_entries: number;
  max_bytes: number;
  max_seconds: number;
}

async function pollTx(
  tx: Tx,
  helper: HelperRow,
  beat: { sid: string; sessionId: number; sessionState: string },
): Promise<{
  revoked: boolean;
  cancel: string[];
  ops: DeliveredOp[];
  pendingRequestId: string | null;
}> {
  const empty = { ops: [] as DeliveredOp[], pendingRequestId: null };
  const revokeSelf = async () => {
    await tx`
      UPDATE folder_access_helpers
      SET revoked_at = COALESCE(revoked_at, now()), user_name = NULL
      WHERE id = ${helper.id}
    `;
    return { ...empty, revoked: true, cancel: await drainCancels(tx, helper.id) };
  };

  if (helper.revoked_at) return revokeSelf();

  const decision = heartbeatDecision({ sid: helper.sid, sessionId: helper.session_id }, beat);

  if (!helper.request_id) {
    // 未ペアは一覧に関わらない。期限切れや別ユーザーの申告なら作り直させる。
    if (helper.pairing_expired || decision.kind === 'end') return revokeSelf();
    await touch(tx, helper.id, beat.sessionState);
    return { ...empty, revoked: false, cancel: [] };
  }

  const ctx = await loadContext(tx, helper.request_id);
  if (!ctx || isTerminal(ctx.status) || ctx.helper_id !== helper.id) return revokeSelf();

  if (decision.kind === 'end') {
    await endRequestTx(tx, ctx, decision.reason, HELPER_ACTOR);
    return revokeSelf();
  }
  await touch(tx, helper.id, beat.sessionState);

  if (ctx.status === 'helper_pending') {
    return { ...empty, revoked: false, cancel: [], pendingRequestId: ctx.id };
  }
  if (ctx.status !== 'active') return { ...empty, revoked: false, cancel: [] };

  // いま heartbeat を受けたので stale ではない。残りの束縛を毎回確認する。
  const violation = activeViolation({ ...ctx, helper_stale: false });
  if (violation) {
    await endRequestTx(tx, ctx, violation, HELPER_ACTOR);
    return revokeSelf();
  }
  const cancel = await drainCancels(tx, helper.id);
  if (!decision.sessionActive) return { ...empty, revoked: false, cancel };

  const ops = await tx<DeliveredOp[]>`
    UPDATE folder_access_ops
    SET status = 'delivered', delivered_at = now()
    WHERE request_id = ${ctx.id}
      AND helper_id = ${helper.id}
      AND consent_id = ${ctx.consent_id}
      AND status = 'queued'
      AND expires_at > now()
    RETURNING id, request_id, sid, session_id, root, segments, operation, expires_at,
              max_entries, max_bytes, max_seconds
  `;
  return { ops: [...ops], pendingRequestId: null, revoked: false, cancel };
}

async function touch(tx: Tx, helperId: string, sessionState: string): Promise<void> {
  await tx`
    UPDATE folder_access_helpers
    SET last_seen_at = now(), session_state = ${normalizeSessionState(sessionState)}
    WHERE id = ${helperId}
  `;
}

type ResultOutcome =
  | { kind: 'stored'; truncated: boolean; count: number }
  | { kind: 'discarded'; reason: string }
  | { kind: 'missing' };

export async function folderHelperRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async () => {
    requireFolderAccessEnabled();
  });

  app.post('/device/agent/folder-helper/register', { bodyLimit: 4 * 1024 }, async (request) => {
    // 接続元ごとの制限と全体の制限。未認証なので共通のバケットを使わない。
    if (
      !checkAddressLimit(
        `register:${clientAddress(request)}`,
        LIMITS.registerPerAddressPerMinute,
        60_000,
      ) ||
      !checkAddressLimit('register:global', LIMITS.registerGlobalPerMinute, 60_000)
    ) {
      throw new ApiError(429, 'RATE_LIMITED', '登録が多すぎます。少し待ってください。');
    }
    const body = RegisterBody.parse(request.body);
    if (!isUserSid(body.sid)) {
      throw new ApiError(403, 'SID_NOT_ALLOWED', 'このアカウントではヘルパーを利用できません。');
    }
    if (normalizeSessionState(body.sessionState) !== 'active' || body.sessionId === 0) {
      throw new ApiError(409, 'NOT_LOGGED_ON', 'ログオン中のアクティブなセッションが必要です。');
    }
    const address = clientAddress(request);
    const failureKey = `enroll-failure:${address}`;
    if (isAddressLimited(failureKey, LIMITS.enrollFailuresPerAddress)) {
      throw new ApiError(429, 'RATE_LIMITED', '試行が多すぎます。少し待ってください。');
    }
    const refuse = () => {
      checkAddressLimit(failureKey, LIMITS.enrollFailuresPerAddress + 1, 10 * 60_000);
      return new ApiError(
        403,
        'ENROLL_CODE_INVALID',
        '導入コードが正しくないか、期限が切れています。',
      );
    };
    const enrollCode =
      typeof body.enrollCode === 'string' ? body.enrollCode.trim().toUpperCase() : '';
    if (!ENROLL_CODE_PATTERN.test(enrollCode)) throw refuse();
    const token = generateHelperToken();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generatePairingCode();
      try {
        const row = await sql.begin(async (tx) => {
          // 失敗（上限やコードの衝突）ではロールバックするので、導入コードを消費しない。
          const enrolled = await consumeEnrollCode(tx, enrollCode);
          if (!enrolled) throw refuse();
          await reserveUnpairedSlot(tx);
          const rows = await tx<{ id: string; pairing_expires_at: Date }[]>`
            INSERT INTO folder_access_helpers (
              token_hash, machine_guid, sid, user_name, session_id, session_state, hostname,
              helper_version, pairing_code_hash, pairing_expires_at, enrolled_request_id
            ) VALUES (
              ${hashToken(token)}, ${body.machineGuid.toLowerCase()}, ${body.sid},
              ${sanitizeEntryName(body.userName)}, ${body.sessionId},
              ${normalizeSessionState(body.sessionState)}, ${sanitizeEntryName(body.hostname)},
              ${sanitizeEntryName(body.helperVersion)}, ${hashPairingCode(code)},
              now() + (${LIMITS.pairingMinutes}::int * interval '1 minute'),
              ${enrolled.id}
            )
            RETURNING id, pairing_expires_at
          `;
          await appendFolderAudit(tx, 'folder_access.enroll_registered', enrolled, HELPER_ACTOR, {
            helperId: rows[0]?.id ?? null,
          });
          return rows[0];
        });
        if (!row) throw new Error('ヘルパーの登録に失敗しました。');
        return {
          helperId: row.id,
          helperToken: token,
          pairingCode: code,
          pairingExpiresAt: row.pairing_expires_at.toISOString(),
        };
      } catch (error) {
        // コードが他の未使用コードと衝突した場合だけ引き直す。
        if ((error as { code?: string }).code !== '23505') throw error;
      }
    }
    throw new ApiError(503, 'PAIRING_UNAVAILABLE', 'コードを発行できませんでした。');
  });

  app.post('/device/agent/folder-helper/poll', { bodyLimit: 4 * 1024 }, async (request) => {
    const token = helperToken(request);
    if (!checkAddressLimit(`poll:${clientAddress(request)}`, 600, 60_000)) {
      throw new ApiError(429, 'RATE_LIMITED', 'リクエストが多すぎます。');
    }
    const helper = await findHelper(token);
    if (!checkRateLimit(`folder-helper-poll:${helper.id}`, 60, 60_000)) {
      throw new ApiError(429, 'RATE_LIMITED', 'リクエストが多すぎます。');
    }
    const beat = PollBody.parse(request.body);
    const outcome = await sql.begin(async (tx) => {
      const polled = await pollTx(tx, helper, beat);
      const assist = await assistPollTx(tx, {
        helperId: helper.id,
        requestId: helper.request_id,
        revoked: polled.revoked,
        capable: beat.capabilities?.includes(SKILL_RUN_CAPABILITY) === true,
        sessionActive: normalizeSessionState(beat.sessionState) === 'active',
      });
      return { ...polled, assist };
    });
    if (outcome.pendingRequestId) {
      await reconcileProbe(outcome.pendingRequestId, HELPER_ACTOR);
    }
    return {
      // 署名の鍵はトークンの平文。DB には無いので、ここで受け取った値で配信時に計算する。
      ops: outcome.ops.map((op) => {
        const signable = {
          opId: op.id,
          requestId: op.request_id,
          sid: op.sid,
          sessionId: op.session_id,
          root: op.root,
          segments: op.segments,
          operation: op.operation,
          expiresAt: op.expires_at.toISOString(),
        };
        return {
          ...signable,
          maxEntries: op.max_entries,
          maxBytes: op.max_bytes,
          maxSeconds: op.max_seconds,
          sig: signOp(token, signable),
        };
      }),
      cancel: [...outcome.cancel, ...outcome.assist.cancel],
      revoked: outcome.revoked,
      paired: !outcome.revoked && Boolean(helper.request_id),
      // 機能が無効なら応答の形を変えない。
      ...(outcome.assist.enabled
        ? {
            skillOps: outcome.assist.skillOps.map((op) => ({
              ...op,
              sig: signSkillRun(token, op),
            })),
            ...(outcome.assist.nextPollSeconds
              ? { nextPollSeconds: outcome.assist.nextPollSeconds }
              : {}),
          }
        : {}),
    };
  });

  // アンインストール時の失効通知。紐づく同意があれば helper_revoked で終了する。
  app.post('/device/agent/folder-helper/revoke', { bodyLimit: 1024 }, async (request) => {
    const token = helperToken(request);
    if (!checkAddressLimit(`poll:${clientAddress(request)}`, 600, 60_000)) {
      throw new ApiError(429, 'RATE_LIMITED', 'リクエストが多すぎます。');
    }
    const helper = await findHelper(token);
    await sql.begin(async (tx) => {
      if (helper.request_id) {
        const ctx = await loadContext(tx, helper.request_id);
        if (ctx && ctx.helper_id === helper.id) {
          await endRequestTx(tx, ctx, 'helper_revoked', HELPER_ACTOR);
        }
      }
      await tx`
        UPDATE folder_access_helpers
        SET revoked_at = COALESCE(revoked_at, now()), user_name = NULL, pairing_code_hash = NULL
        WHERE id = ${helper.id}
      `;
    });
    return { ok: true };
  });

  // 上限（64KB）を超える本文は Fastify が 413 で拒否する。
  app.post(
    '/device/agent/folder-helper/ops/:id/result',
    { bodyLimit: 64 * 1024 },
    async (request) => {
      const helper = await findHelper(helperToken(request));
      if (!helper.request_id) {
        throw new ApiError(403, 'HELPER_NOT_PAIRED', 'ペアリングされていません。');
      }
      if (!checkRateLimit(`folder-helper-result:${helper.id}`, 30, 60_000)) {
        throw new ApiError(429, 'RATE_LIMITED', 'リクエストが多すぎます。');
      }
      const { id: opId } = OpParams.parse(request.params);
      const body = ResultBodySchema.parse(request.body);

      const outcome = await sql.begin(async (tx): Promise<ResultOutcome> => {
        const ops = await tx<
          {
            id: string;
            request_id: string;
            consent_id: string;
            root: string;
            status: string;
            expired: boolean;
          }[]
        >`
        SELECT id, request_id, consent_id, root, status, (expires_at <= now()) AS expired
        FROM folder_access_ops
        WHERE id = ${opId} AND helper_id = ${helper.id}
      `;
        const op = ops[0];
        if (!op) return { kind: 'missing' };
        const ctx = await loadContext(tx, op.request_id);
        if (!ctx) return { kind: 'missing' };

        const discard = async (reason: string, endReason?: EndReason): Promise<ResultOutcome> => {
          if (endReason) await endRequestTx(tx, ctx, endReason, HELPER_ACTOR);
          // 破棄した内容は保存しない。監査は件数と理由だけ。
          await appendFolderAudit(tx, 'folder_access.result_discarded', ctx, HELPER_ACTOR, {
            opId,
            reason,
            count: body.entries.length,
          });
          return { kind: 'discarded', reason };
        };

        if (ctx.status !== 'active' || op.consent_id !== ctx.consent_id) {
          return discard('CONSENT_NOT_ACTIVE');
        }
        if (ctx.helper_id !== helper.id || helper.revoked_at) return discard('HELPER_REVOKED');
        const violation = activeViolation(ctx);
        if (violation) return discard('BINDING_VIOLATION', violation);
        if (body.actorSid !== ctx.sid) return discard('SID_MISMATCH', 'sid_mismatch');
        if (body.sessionId !== ctx.session_id)
          return discard('SESSION_MISMATCH', 'session_changed');
        if (op.status !== 'delivered') return discard('OP_NOT_DELIVERED');
        if (op.expired) {
          await tx`
          UPDATE folder_access_ops SET status = 'expired', completed_at = now() WHERE id = ${opId}
        `;
          return discard('OP_EXPIRED');
        }
        if (body.root !== op.root) {
          await tx`
          UPDATE folder_access_ops SET status = 'failed', completed_at = now() WHERE id = ${opId}
        `;
          return discard('ROOT_MISMATCH');
        }

        const failed = body.status === 'error';
        const normalized = failed
          ? { entries: [], truncated: false }
          : normalizeEntries(body.entries, LIMITS);
        const truncated = body.truncated || normalized.truncated;
        const status = failed ? 'error' : truncated || body.status === 'partial' ? 'partial' : 'ok';

        await tx`DELETE FROM folder_access_results WHERE request_id = ${ctx.id}`;
        await tx`
        INSERT INTO folder_access_results (
          request_id, op_id, consent_id, status, reason, truncated, entry_count, elapsed_ms, entries
        ) VALUES (
          ${ctx.id}, ${opId}, ${op.consent_id}, ${status}, ${body.reason ?? null}, ${truncated},
          ${normalized.entries.length}, ${body.elapsedMs}, ${jsonbValue(normalized.entries)}
        )
      `;
        await tx`
        UPDATE folder_access_ops
        SET status = ${failed ? 'failed' : 'done'}, completed_at = now()
        WHERE id = ${opId}
      `;
        // 成功ログだけを実アクセス成功として扱わない（端末の自己申告。docs/62 §6）。
        await appendFolderAudit(tx, 'folder_access.list_result', ctx, HELPER_ACTOR, {
          opId,
          result: status,
          reason: body.reason ?? null,
          count: normalized.entries.length,
          truncated,
          elapsedMs: body.elapsedMs,
          selfReported: true,
        });
        return { kind: 'stored', truncated, count: normalized.entries.length };
      });

      if (outcome.kind === 'missing') {
        throw new ApiError(404, 'NOT_FOUND', '対象の操作が見つかりません。');
      }
      if (outcome.kind === 'discarded') {
        return { ok: true, discarded: true, reason: outcome.reason };
      }
      return { ok: true, discarded: false, truncated: outcome.truncated, count: outcome.count };
    },
  );
}
