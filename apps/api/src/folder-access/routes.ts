import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireHelpdeskActor } from '../auth/helpdesk-scope.js';
import { authenticateUi } from '../auth/ui.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { ApiError, forbidden, notFound } from '../errors.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import {
  activeViolation,
  appendFolderAudit,
  applyExpiryAndBinding,
  endRequestTx,
  loadContext,
  type RequestContext,
  reconcileProbe,
  resolveDevice,
  revalidateLease,
  type Tx,
} from './service.js';
import { hashPairingCode } from './sign.js';
import { ConsentBodySchema, isTerminal, LIMITS } from './state.js';

const IdParams = z.object({ id: z.string().uuid() });
const CreateBody = z.object({
  handoverId: z.string().uuid(),
  rspDeviceId: z.string().uuid().optional(),
  // 検証専用モード（FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE）の担当者指定端末。
  hostname: z.string().trim().min(1).max(128).optional(),
});
const HandoverQuery = z.object({ handoverId: z.string().uuid() });
const MineQuery = z.object({ handoverId: z.string().uuid().optional() });
const PairBody = z.object({ code: z.string().regex(/^\d{8}$/) });
const LookupQuery = z.object({ ref: z.string().trim().min(1).max(200) });

export function requireFolderAccessEnabled(): void {
  // 無効時は存在しないルートと同じ応答にする（機能の有無を漏らさない）。
  if (!config.FOLDER_ACCESS_ENABLED) throw notFound('パスは存在しません。');
}

function requireEmail(request: FastifyRequest): string {
  if (!request.uiEmail) throw forbidden('ログイン情報を確認できません。');
  return request.uiEmail;
}

/** 担当者の共通判定。approver ロールだけでは `requireHelpdeskActor` を通らない。 */
async function requireAssignee(request: FastifyRequest): Promise<string> {
  const email = requireEmail(request);
  await requireHelpdeskActor(email);
  return email;
}

function assertAssignee(ctx: Pick<RequestContext, 'assignee_email'>, email: string): void {
  if (ctx.assignee_email !== email) {
    throw new ApiError(403, 'NOT_ASSIGNEE', 'この依頼を開始した担当者本人のみ操作できます。');
  }
}

function assertRequester(
  ctx: Pick<RequestContext, 'owner_email' | 'requester_email'>,
  email: string,
): void {
  if (ctx.owner_email !== email || ctx.requester_email !== email) {
    throw new ApiError(403, 'NOT_REQUESTER', '相談者本人のみ操作できます。');
  }
}

type Ownership = Pick<RequestContext, 'assignee_email' | 'requester_email' | 'owner_email'>;

/** 権限確認用の読み取り。状態を更新する処理（refresh）より前に呼ぶ。 */
async function loadOwnership(id: string): Promise<Ownership> {
  const rows = await sql<Ownership[]>`
    SELECT r.assignee_email, r.requester_email, h.owner_email
    FROM folder_access_requests r
    JOIN case_handovers h ON h.id = r.handover_id
    WHERE r.id = ${id}
  `;
  const row = rows[0];
  if (!row) throw notFound('依頼が見つかりません。');
  return row;
}

function dto(ctx: RequestContext, view: 'assignee' | 'requester') {
  return {
    id: ctx.id,
    handoverId: ctx.handover_id,
    caseId: ctx.case_id,
    status: ctx.status,
    endReason: ctx.end_reason,
    reasonCode: ctx.reason_code,
    leaseStatus: ctx.lease_status,
    paired: Boolean(ctx.helper_id),
    pairingLocked: ctx.pair_attempts >= LIMITS.maxPairAttempts,
    probeStatus: ctx.rsp_probe_status,
    device: {
      hostname: ctx.rsp_hostname,
      helperHostname: ctx.helper_hostname,
      ...(view === 'assignee'
        ? { rspDeviceId: ctx.rsp_device_id, meshNodeId: ctx.mesh_node_id }
        : {}),
    },
    windowsUser: ctx.windows_user,
    scope:
      ctx.status === 'active'
        ? {
            root: ctx.consent_root,
            segments: ctx.consent_segments,
            operation: ctx.consent_operation,
            expiresAt: ctx.consent_expires_at?.toISOString() ?? null,
          }
        : null,
    assigneeEmail: ctx.assignee_email,
    createdAt: ctx.created_at.toISOString(),
    endedAt: ctx.ended_at?.toISOString() ?? null,
  };
}

/** 期限・束縛を反映して読み直す。違反で終了した場合も commit してから結果を返す。 */
async function refresh(id: string, actorEmail: string): Promise<RequestContext> {
  const ctx = await sql.begin(async (tx) => {
    const row = await loadContext(tx, id);
    if (row) await applyExpiryAndBinding(tx, row, actorEmail);
    return row;
  });
  if (!ctx) throw notFound('依頼が見つかりません。');
  return ctx;
}

/** 状態確認の延長で RSP の結果を取りに行き、読み直す。 */
async function refreshWithProbe(id: string, actorEmail: string): Promise<RequestContext> {
  const ctx = await refresh(id, actorEmail);
  if (ctx.status !== 'helper_pending') return ctx;
  await reconcileProbe(id, actorEmail);
  return refresh(id, actorEmail);
}

function notActive(ctx: RequestContext): ApiError {
  return new ApiError(409, 'CONSENT_NOT_ACTIVE', '有効な同意がありません。', {
    status: ctx.status,
    endReason: ctx.end_reason,
  });
}

async function latestForHandover(handoverId: string): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM folder_access_requests
    WHERE handover_id = ${handoverId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

interface HandoverOwnerRow {
  id: string;
  case_id: string;
  owner_email: string;
  claimed_by: string | null;
  status: string;
}

async function loadHandover(id: string): Promise<HandoverOwnerRow> {
  const rows = await sql<HandoverOwnerRow[]>`
    SELECT id, case_id, owner_email, claimed_by, status FROM case_handovers WHERE id = ${id}
  `;
  const row = rows[0];
  if (!row) throw notFound('引継ぎが見つかりません。');
  return row;
}

async function assignRoutes(app: FastifyInstance): Promise<void> {
  // 依頼の開始。確定できずに留まっている依頼へ再度送ると照合をやり直す。
  app.post(
    '/folder-access/requests',
    { preHandler: authenticateUi, bodyLimit: 8 * 1024 },
    async (request) => {
      const email = await requireAssignee(request);
      if (!checkRateLimit(`folder-access-create:${email}`, 10, 60_000)) {
        throw new ApiError(429, 'RATE_LIMITED', '操作が多すぎます。少し待ってください。');
      }
      const body = CreateBody.parse(request.body);
      const handover = await loadHandover(body.handoverId);
      // claim した本人だけ（docs/62 §5）。approver や他の担当者は開始できない。
      if (handover.claimed_by !== email || !['claimed', 'resolved'].includes(handover.status)) {
        throw new ApiError(403, 'NOT_ASSIGNEE', '引継ぎを引き受けた担当者本人のみ開始できます。');
      }

      const previous = await latestForHandover(body.handoverId);
      let id: string | null = null;
      if (previous) {
        const ctx = await refresh(previous, email);
        if (!isTerminal(ctx.status)) {
          assertAssignee(ctx, email);
          id = ctx.id;
          const retryable =
            ctx.status === 'device_pending' ||
            (ctx.status === 'helper_pending' && ctx.rsp_probe_status !== 'pending');
          if (!retryable) return { ok: true, request: dto(ctx, 'assignee') };
        }
      }
      if (!id) {
        try {
          const rows = await sql<{ id: string }[]>`
            INSERT INTO folder_access_requests (
              handover_id, case_id, requester_email, assignee_email, request_expires_at
            ) VALUES (
              ${handover.id}, ${handover.case_id}, ${handover.owner_email}, ${email},
              now() + (${LIMITS.requestMinutes}::int * interval '1 minute')
            )
            RETURNING id
          `;
          id = rows[0]?.id ?? null;
        } catch (error) {
          // 同じ引継ぎへの同時送信（部分一意インデックス違反）は、先に作られた依頼を返す。
          if ((error as { code?: string }).code !== '23505') throw error;
          const existing = await latestForHandover(body.handoverId);
          if (!existing) throw error;
          const ctx = await refresh(existing, email);
          assertAssignee(ctx, email);
          return { ok: true, request: dto(ctx, 'assignee') };
        }
      }
      if (!id) throw new Error('依頼の作成に失敗しました。');
      await resolveDevice(id, { rspDeviceId: body.rspDeviceId, hostname: body.hostname }, email);
      const ctx = await refresh(id, email);
      return { ok: true, request: dto(ctx, 'assignee') };
    },
  );

  // 画面の案件（caseId / INC / チケット番号）から、自分が引き受けた引継ぎの ID だけを引く。
  // 受信箱は pending / claimed の最新 50 件なので、resolved や古い案件を引けない。
  app.get('/folder-access/handovers/lookup', { preHandler: authenticateUi }, async (request) => {
    const email = await requireAssignee(request);
    const { ref } = LookupQuery.parse(request.query);
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM case_handovers
      WHERE claimed_by = ${email}
        AND status IN ('claimed', 'resolved')
        AND (
          case_id = ${ref}
          OR snapshot #>> '{inc,id}' = ${ref}
          OR snapshot #>> '{ticket,id}' = ${ref}
        )
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return { ok: true, handoverId: rows[0]?.id ?? null };
  });

  // 画面の再読込時に既存の依頼を引くための読み取り（docs/62 §5 への追加）。
  app.get('/folder-access/requests', { preHandler: authenticateUi }, async (request) => {
    const email = await requireAssignee(request);
    const { handoverId } = HandoverQuery.parse(request.query);
    const handover = await loadHandover(handoverId);
    if (handover.claimed_by !== email) {
      throw new ApiError(403, 'NOT_ASSIGNEE', '引継ぎを引き受けた担当者本人のみ参照できます。');
    }
    const id = await latestForHandover(handoverId);
    if (!id) return { ok: true, request: null };
    // 前任の担当者の依頼は返さない（権限確認を状態更新より先に行う）。
    if ((await loadOwnership(id)).assignee_email !== email) return { ok: true, request: null };
    const ctx = await refreshWithProbe(id, email);
    return { ok: true, request: dto(ctx, 'assignee') };
  });

  app.get('/folder-access/requests/:id', { preHandler: authenticateUi }, async (request) => {
    const email = await requireAssignee(request);
    const { id } = IdParams.parse(request.params);
    assertAssignee(await loadOwnership(id), email);
    const fresh = await refreshWithProbe(id, email);
    return { ok: true, request: dto(fresh, 'assignee') };
  });

  // 一覧の取得を投入する。範囲は同意に固定で、担当者からパスを受け取らない。
  app.post(
    '/folder-access/requests/:id/list',
    { preHandler: authenticateUi, bodyLimit: 1024 },
    async (request) => {
      const email = await requireAssignee(request);
      if (!checkRateLimit(`folder-access-list:${email}`, 20, 60_000)) {
        throw new ApiError(429, 'RATE_LIMITED', '操作が多すぎます。少し待ってください。');
      }
      const { id } = IdParams.parse(request.params);
      const outcome = await sql.begin(async (tx) => {
        const ctx = await loadContext(tx, id);
        if (!ctx) return { kind: 'missing' as const };
        if (ctx.assignee_email !== email) return { kind: 'forbidden' as const };
        await applyExpiryAndBinding(tx, ctx, email);
        if (ctx.status !== 'active') return { kind: 'inactive' as const, ctx };
        if (ctx.helper_session_state !== 'active') return { kind: 'session' as const };
        const open = await tx<{ id: string }[]>`
          SELECT id FROM folder_access_ops
          WHERE request_id = ${id} AND status IN ('queued', 'delivered') AND expires_at > now()
          ORDER BY created_at DESC
          LIMIT 1
        `;
        if (open[0]) return { kind: 'ok' as const, opId: open[0].id, created: false };
        const rows = await tx<{ id: string }[]>`
          INSERT INTO folder_access_ops (
            request_id, helper_id, consent_id, sid, session_id, root, segments, operation,
            expires_at, max_entries, max_bytes, max_seconds, requested_by
          ) VALUES (
            ${id}, ${ctx.helper_id ?? ''}, ${ctx.consent_id ?? ''}, ${ctx.sid ?? ''},
            ${ctx.session_id ?? 0}, ${ctx.consent_root ?? ''},
            ${jsonbValue(ctx.consent_segments)}, 'list_metadata',
            LEAST(
              now() + (${LIMITS.opSeconds}::int * interval '1 second'),
              ${ctx.consent_expires_at}::timestamptz
            ),
            ${LIMITS.maxEntries}, ${LIMITS.maxBytes}, ${LIMITS.maxSeconds}, ${email}
          )
          RETURNING id
        `;
        const opId = rows[0]?.id ?? '';
        await appendFolderAudit(tx, 'folder_access.list_requested', ctx, email, { opId });
        return { kind: 'ok' as const, opId, created: true };
      });
      if (outcome.kind === 'missing') throw notFound('依頼が見つかりません。');
      if (outcome.kind === 'forbidden') {
        throw new ApiError(403, 'NOT_ASSIGNEE', 'この依頼を開始した担当者本人のみ操作できます。');
      }
      if (outcome.kind === 'inactive') throw notActive(outcome.ctx);
      if (outcome.kind === 'session') {
        throw new ApiError(409, 'SESSION_NOT_ACTIVE', '相談者の Windows セッションが切断中です。');
      }
      return { ok: true, opId: outcome.opId, created: outcome.created };
    },
  );

  // 結果は active の間だけ返す。画面はメモリ上でのみ保持する。
  app.get('/folder-access/requests/:id/result', { preHandler: authenticateUi }, async (request) => {
    const email = await requireAssignee(request);
    const { id } = IdParams.parse(request.params);
    assertAssignee(await loadOwnership(id), email);
    const ctx = await refresh(id, email);
    if (ctx.status !== 'active') throw notActive(ctx);
    const rows = await sql<
      {
        op_id: string;
        status: string;
        reason: string | null;
        truncated: boolean;
        entry_count: number;
        elapsed_ms: number | null;
        entries: unknown;
        received_at: Date;
      }[]
    >`
      SELECT op_id, status, reason, truncated, entry_count, elapsed_ms, entries, received_at
      FROM folder_access_results
      WHERE request_id = ${id} AND consent_id = ${ctx.consent_id}
      ORDER BY received_at DESC
      LIMIT 1
    `;
    const row = rows[0];
    return {
      ok: true,
      result: row
        ? {
            opId: row.op_id,
            status: row.status,
            reason: row.reason,
            truncated: row.truncated,
            count: row.entry_count,
            elapsedMs: row.elapsed_ms,
            receivedAt: row.received_at.toISOString(),
            entries: row.entries,
          }
        : null,
    };
  });

  app.post(
    '/folder-access/requests/:id/end',
    { preHandler: authenticateUi, bodyLimit: 1024 },
    async (request) => {
      const email = await requireAssignee(request);
      const { id } = IdParams.parse(request.params);
      const ctx = await sql.begin(async (tx) => {
        const row = await loadContext(tx, id);
        if (row && row.assignee_email === email) await endRequestTx(tx, row, 'operator_end', email);
        return row;
      });
      if (!ctx) throw notFound('依頼が見つかりません。');
      assertAssignee(ctx, email);
      return { ok: true, request: dto(ctx, 'assignee') };
    },
  );
}

async function pairTx(
  tx: Tx,
  id: string,
  email: string,
  code: string,
): Promise<
  | { kind: 'paired'; ctx: RequestContext }
  | { kind: 'invalid'; remaining: number }
  | { kind: 'locked' }
  | { kind: 'state'; ctx: RequestContext }
  | { kind: 'session' }
> {
  const ctx = await loadContext(tx, id);
  if (!ctx) throw notFound('依頼が見つかりません。');
  assertRequester(ctx, email);
  await applyExpiryAndBinding(tx, ctx, email);
  if (ctx.status !== 'helper_pending' || ctx.helper_id) return { kind: 'state', ctx };
  // 失敗も監査する（誤コード・ロックアウト・セッション不一致）。コードは残さない。
  const auditFailure = (result: 'invalid' | 'locked' | 'session', extra = {}) =>
    appendFolderAudit(tx, 'folder_access.pair_failed', ctx, email, { result, ...extra });
  if (ctx.pair_attempts >= LIMITS.maxPairAttempts) {
    await auditFailure('locked');
    return { kind: 'locked' };
  }

  const helpers = await tx<
    {
      id: string;
      machine_guid: string;
      sid: string;
      session_id: number;
      session_state: string;
      user_name: string | null;
      hostname: string | null;
    }[]
  >`
    UPDATE folder_access_helpers
    SET pairing_used_at = now(), pairing_code_hash = NULL, request_id = ${id}, paired_at = now()
    WHERE pairing_code_hash = ${hashPairingCode(code)}
      AND pairing_used_at IS NULL
      AND revoked_at IS NULL
      AND request_id IS NULL
      AND pairing_expires_at > now()
      AND last_seen_at > now() - (${LIMITS.helperStaleSeconds}::int * interval '1 second')
    RETURNING id, machine_guid, sid, session_id, session_state, user_name, hostname
  `;
  const helper = helpers[0];
  if (!helper) {
    await tx`
      UPDATE folder_access_requests
      SET pair_attempts = pair_attempts + 1, updated_at = now()
      WHERE id = ${id}
    `;
    const remaining = LIMITS.maxPairAttempts - ctx.pair_attempts - 1;
    await auditFailure('invalid', { remaining });
    return { kind: 'invalid', remaining };
  }
  if (helper.session_state !== 'active') {
    await tx`UPDATE folder_access_helpers SET revoked_at = now() WHERE id = ${helper.id}`;
    await auditFailure('session');
    return { kind: 'session' };
  }
  await tx`
    UPDATE folder_access_requests
    SET helper_id = ${helper.id}, machine_guid = ${helper.machine_guid}, sid = ${helper.sid},
        session_id = ${helper.session_id}, windows_user = ${helper.user_name},
        helper_hostname = ${helper.hostname}, updated_at = now()
    WHERE id = ${id}
  `;
  ctx.helper_id = helper.id;
  ctx.sid = helper.sid;
  ctx.session_id = helper.session_id;
  await appendFolderAudit(tx, 'folder_access.pair', ctx, email, {
    status: ctx.status,
    result: 'paired',
  });
  return { kind: 'paired', ctx };
}

async function requesterRoutes(app: FastifyInstance): Promise<void> {
  // 相談者の状態確認。handoverId を省くと、進行中の依頼すべてと直近に終了した依頼を返す。
  // 古い同意も確認・取消できるように 1 件に絞らない。
  app.get('/folder-access/mine', { preHandler: authenticateUi }, async (request) => {
    const email = requireEmail(request);
    const { handoverId } = MineQuery.parse(request.query);
    let ids: string[];
    if (handoverId) {
      const handover = await loadHandover(handoverId);
      if (handover.owner_email !== email) {
        throw new ApiError(403, 'NOT_REQUESTER', '相談者本人のみ参照できます。');
      }
      const latest = await latestForHandover(handoverId);
      ids = latest ? [latest] : [];
    } else {
      const open = await sql<{ id: string }[]>`
        SELECT id FROM folder_access_requests
        WHERE requester_email = ${email} AND ended_at IS NULL
        ORDER BY created_at DESC
      `;
      const recent = await sql<{ id: string }[]>`
        SELECT id FROM folder_access_requests
        WHERE requester_email = ${email} AND ended_at > now() - interval '10 minutes'
        ORDER BY ended_at DESC
        LIMIT ${LIMITS.maxRecentEnded}
      `;
      ids = [...open, ...recent].map((row) => row.id);
    }
    const requests = [];
    for (const id of ids) {
      requests.push(dto(await refreshWithProbe(id, email), 'requester'));
    }
    return { ok: true, requests, request: requests[0] ?? null };
  });

  app.post(
    '/folder-access/requests/:id/pair',
    { preHandler: authenticateUi, bodyLimit: 1024 },
    async (request) => {
      const email = requireEmail(request);
      if (!checkRateLimit(`folder-access-pair:${email}`, 10, 60_000)) {
        throw new ApiError(429, 'RATE_LIMITED', '試行が多すぎます。少し待ってください。');
      }
      const { id } = IdParams.parse(request.params);
      const { code } = PairBody.parse(request.body);
      // 失敗回数は commit する必要があるので、トランザクションの外で例外にする。
      const outcome = await sql.begin((tx) => pairTx(tx, id, email, code));
      if (outcome.kind === 'locked') {
        throw new ApiError(
          429,
          'PAIRING_LOCKED',
          '試行回数の上限に達しました。担当者に依頼のやり直しを伝えてください。',
        );
      }
      if (outcome.kind === 'invalid') {
        throw new ApiError(400, 'PAIRING_INVALID', 'コードが正しくないか、期限が切れています。', {
          remaining: outcome.remaining,
        });
      }
      if (outcome.kind === 'session') {
        throw new ApiError(
          409,
          'NOT_LOGGED_ON',
          'Windows のセッションがアクティブではありません。',
        );
      }
      if (outcome.kind === 'state') {
        throw new ApiError(409, 'INVALID_STATE', '現在の状態ではコードを入力できません。', {
          status: outcome.ctx.status,
          endReason: outcome.ctx.end_reason,
        });
      }
      await reconcileProbe(id, email, { force: true });
      const ctx = await refresh(id, email);
      return { ok: true, request: dto(ctx, 'requester') };
    },
  );

  app.post(
    '/folder-access/requests/:id/consent',
    { preHandler: authenticateUi, bodyLimit: 8 * 1024 },
    async (request) => {
      const email = requireEmail(request);
      const { id } = IdParams.parse(request.params);
      const body = ConsentBodySchema.parse(request.body);
      assertRequester(await loadOwnership(id), email);
      const before = await refreshWithProbe(id, email);
      if (before.status !== 'consent_pending') {
        throw new ApiError(409, 'INVALID_STATE', '現在の状態では同意できません。', {
          status: before.status,
          endReason: before.end_reason,
          reasonCode: before.reason_code,
        });
      }
      // 同意の直前に貸与情報を取り直す（外部通信なのでトランザクションの外）。
      const lease = await revalidateLease(before);
      const outcome = await sql.begin(async (tx) => {
        const ctx = await loadContext(tx, id);
        if (!ctx) throw notFound('依頼が見つかりません。');
        await applyExpiryAndBinding(tx, ctx, email);
        if (ctx.status !== 'consent_pending') return { kind: 'state' as const, ctx };
        if (lease === 'conflict') {
          await endRequestTx(tx, ctx, 'lease_conflict', email);
          return { kind: 'state' as const, ctx };
        }
        if (lease) return { kind: 'lease' as const, code: lease };
        const violation = activeViolation({ ...ctx, consent_expired: false });
        if (violation) {
          await endRequestTx(tx, ctx, violation, email);
          return { kind: 'state' as const, ctx };
        }
        if (ctx.helper_session_state !== 'active') return { kind: 'session' as const };
        const rows = await tx<{ consent_id: string; consent_expires_at: Date }[]>`
          UPDATE folder_access_requests
          SET status = 'active',
              reason_code = NULL,
              consent_id = gen_random_uuid(),
              consent_root = ${body.root},
              consent_segments = ${jsonbValue(body.segments)},
              consent_operation = 'list_metadata',
              consented_at = now(),
              consent_expires_at = now() + (${body.ttlMinutes}::int * interval '1 minute'),
              updated_at = now()
          WHERE id = ${id} AND status = 'consent_pending'
          RETURNING consent_id, consent_expires_at
        `;
        const updated = rows[0];
        if (!updated) return { kind: 'state' as const, ctx };
        ctx.consent_id = updated.consent_id;
        ctx.consent_operation = 'list_metadata';
        // ルートとサブフォルダは監査へ入れない（パスの一部になるため）。
        await appendFolderAudit(tx, 'folder_access.consent', ctx, email, {
          ttlMinutes: body.ttlMinutes,
          expiresAt: updated.consent_expires_at.toISOString(),
        });
        return { kind: 'ok' as const };
      });
      if (outcome.kind === 'lease') {
        throw new ApiError(409, outcome.code, '貸与情報を確認できないため同意を進められません。');
      }
      if (outcome.kind === 'session') {
        throw new ApiError(
          409,
          'NOT_LOGGED_ON',
          'Windows のセッションがアクティブではありません。',
        );
      }
      if (outcome.kind === 'state') {
        throw new ApiError(409, 'INVALID_STATE', '現在の状態では同意できません。', {
          status: outcome.ctx.status,
          endReason: outcome.ctx.end_reason,
        });
      }
      const ctx = await refresh(id, email);
      return { ok: true, request: dto(ctx, 'requester') };
    },
  );

  // 本人の取消・拒否。同意前でも同意後でも使える。
  app.post(
    '/folder-access/requests/:id/revoke',
    { preHandler: authenticateUi, bodyLimit: 1024 },
    async (request) => {
      const email = requireEmail(request);
      const { id } = IdParams.parse(request.params);
      const ctx = await sql.begin(async (tx) => {
        const row = await loadContext(tx, id);
        if (row && row.owner_email === email && row.requester_email === email) {
          await endRequestTx(tx, row, 'requester_revoked', email);
        }
        return row;
      });
      if (!ctx) throw notFound('依頼が見つかりません。');
      assertRequester(ctx, email);
      return { ok: true, request: dto(ctx, 'requester') };
    },
  );
}

export async function folderAccessRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (_request: FastifyRequest, _reply: FastifyReply) => {
    requireFolderAccessEnabled();
  });
  await assignRoutes(app);
  await requesterRoutes(app);
}
