import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireHelpdeskActor } from '../auth/helpdesk-scope.js';
import { authenticateUi } from '../auth/ui.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { redactPII } from '../domain/pii.js';
import { ApiError, forbidden, notFound } from '../errors.js';
import { loadContext, type RequestContext } from '../folder-access/service.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import type { ProposalHistoryEntry } from '../resolve/proposer.js';
import { validateParams } from '../resolve/skills.js';
import {
  type AiCandidate,
  type AiStepFact,
  aiConfigured,
  askAiForCandidate,
  buildAiInput,
  rulePropose,
} from './ai-input.js';
import { type AssistVerifyDefinition, computeAssistApprovalHash } from './approval.js';
import {
  applyLiveness,
  assistEnabled,
  buildApprovalPayload,
  decideProposalTx,
  type ExecutionRow,
  lockSession,
  newNonce,
  type ProposalRow,
  REQUIRED_PRIVILEGE,
  type SessionRow,
  sessionAudit,
  setSessionStatus,
  stopSessionTx,
} from './service.js';
import {
  type ApprovedAssistSkill,
  findAssistSkill,
  isWithinScope,
  proposableSkills,
  resolveApprovedSkill,
} from './skills.js';
import {
  AI_INPUT_CONSENT_VERSION,
  ASSIST_LIMITS,
  FOLDER_CONSENT_VERSION,
  isOpenSession,
  OPERATION_CONSENT_VERSION,
  OPERATION_SCOPES,
  type OperationScope,
} from './state.js';

/**
 * 共通支援セッションの API（docs/63）。担当者は claim 本人、本人は案件の owner のみ。
 * 任意文字列を実行する API を作らない（Skill と型付き params の候補だけ）。
 */

const IdParams = z.object({ id: z.string().uuid() });
const ProposalParams = z.object({ id: z.string().uuid(), proposalId: z.string().uuid() });
const CreateBody = z.object({ handoverId: z.string().uuid() });
const HandoverQuery = z.object({ handoverId: z.string().uuid() });
const OperationConsentBody = z.object({
  scope: z.enum(OPERATION_SCOPES),
  version: z.literal(OPERATION_CONSENT_VERSION),
  ttlMinutes: z.number().int().min(1).max(ASSIST_LIMITS.maxConsentTtlMinutes),
});
const AiConsentBody = z.object({
  version: z.literal(AI_INPUT_CONSENT_VERSION),
  ttlMinutes: z.number().int().min(1).max(ASSIST_LIMITS.maxConsentTtlMinutes),
});
const DecisionBody = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('Y'), approvalHash: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.object({ decision: z.literal('N') }),
]);
const ResolutionBody = z.object({ resolved: z.boolean() });

function requireEmail(request: FastifyRequest): string {
  if (!request.uiEmail) throw forbidden('ログイン情報を確認できません。');
  return request.uiEmail;
}

async function requireAssignee(request: FastifyRequest): Promise<string> {
  const email = requireEmail(request);
  await requireHelpdeskActor(email);
  return email;
}

function assertRequester(ctx: RequestContext, session: SessionRow, email: string): void {
  if (session.requester_email !== email || ctx.owner_email !== email) {
    throw new ApiError(403, 'NOT_REQUESTER', '相談者本人のみ操作できます。');
  }
}

function assertAssignee(session: SessionRow, email: string): void {
  if (session.assignee_email !== email) {
    throw new ApiError(403, 'NOT_ASSIGNEE', 'このセッションを開始した担当者本人のみ操作できます。');
  }
}

/** 状態を変える前に権限を確かめるための読み取り。 */
async function loadOwnership(id: string) {
  const rows = await sql<
    { requester_email: string; assignee_email: string; owner_email: string }[]
  >`
    SELECT s.requester_email, s.assignee_email, h.owner_email
    FROM support_sessions s
    JOIN case_handovers h ON h.id = s.handover_id
    WHERE s.id = ${id}
  `;
  const row = rows[0];
  if (!row) throw notFound('セッションが見つかりません。');
  return row;
}

async function assertRequesterBefore(id: string, email: string): Promise<void> {
  const row = await loadOwnership(id);
  if (row.requester_email !== email || row.owner_email !== email) {
    throw new ApiError(403, 'NOT_REQUESTER', '相談者本人のみ操作できます。');
  }
}

async function assertAssigneeBefore(request: FastifyRequest, id: string): Promise<string> {
  const email = await requireAssignee(request);
  const row = await loadOwnership(id);
  if (row.assignee_email !== email) {
    throw new ApiError(403, 'NOT_ASSIGNEE', 'このセッションを開始した担当者本人のみ操作できます。');
  }
  return email;
}

function proposalDto(row: ProposalRow) {
  return {
    id: row.id,
    stepSeq: row.step_seq,
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    title: row.title,
    effect: row.effect,
    executor: 'user_session',
    target: row.target_ref,
    purpose: row.purpose,
    impact: row.impact,
    successCriteria: row.success_criteria,
    failureAction: row.failure_action,
    rollbackScope: row.rollback_scope,
    rationale: row.rationale,
    proposalSource: row.proposal_source,
    verifyOps: row.verify.ops.map((op) => ({
      skillId: op.skillId,
      title: findAssistSkill(op.skillId)?.definition.title ?? op.skillId,
      description: (op.check as { description?: string }).description ?? '',
    })),
    status: row.status,
    decision: row.decision,
    // Y の照合にだけ使う。payload（SID などを含む）は返さない。
    approvalHash: row.status === 'proposed' ? row.approval_hash : null,
    approvalExpiresAt: row.approval_expires_at.toISOString(),
    verifyOk: row.verify_ok,
    verifyReason: row.verify_reason,
  };
}

function executionDto(row: ExecutionRow) {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    stepSeq: row.step_seq,
    role: row.role,
    skillId: row.skill_id,
    status: row.status,
    executionMode: row.execution_mode,
    resultSource: row.result_source,
    resultCode: row.result_code,
    output: row.normalized_output,
    evidence: row.evidence,
    verifyOk: row.verify_ok,
    verifyReason: row.verify_reason,
    lateResult: row.late_result,
    stopRequestedAt: row.stop_requested_at?.toISOString() ?? null,
    stoppedAt: row.stopped_at?.toISOString() ?? null,
    stopOutcome: row.stop_outcome,
    partialEffect: row.partial_effect,
  };
}

async function sessionDto(
  session: SessionRow,
  ctx: RequestContext | null,
  view: 'assignee' | 'requester',
) {
  const proposals = await sql<ProposalRow[]>`
    SELECT * FROM assist_proposals WHERE support_session_id = ${session.id} ORDER BY step_seq
  `;
  const executions = await sql<ExecutionRow[]>`
    SELECT * FROM assist_executions WHERE support_session_id = ${session.id} ORDER BY created_at
  `;
  return {
    id: session.id,
    handoverId: session.handover_id,
    caseId: session.case_id,
    status: session.status,
    endReason: session.end_reason,
    expiresAt: session.expires_at.toISOString(),
    endedAt: session.ended_at?.toISOString() ?? null,
    proposalCount: session.proposal_count,
    maxProposals: ASSIST_LIMITS.maxProposals,
    leaseStatus: session.lease_status,
    assigneeEmail: session.assignee_email,
    device:
      view === 'requester' && ctx
        ? { hostname: ctx.helper_hostname, windowsUser: ctx.windows_user }
        : null,
    operationConsent: session.operation_consent_id
      ? {
          scope: session.operation_consent_scope,
          version: session.operation_consent_version,
          expiresAt: session.operation_consent_expires_at?.toISOString() ?? null,
        }
      : null,
    aiInputConsent: session.ai_consent_live
      ? {
          version: session.ai_input_consent_version,
          expiresAt: session.ai_input_consent_expires_at?.toISOString() ?? null,
        }
      : null,
    consentVersions: {
      operation: OPERATION_CONSENT_VERSION,
      aiInput: AI_INPUT_CONSENT_VERSION,
    },
    proposals: proposals.map(proposalDto),
    executions: executions.map(executionDto),
  };
}

/** 期限・束縛を反映して読み直す。違反で止めた場合も commit してから返す。 */
async function refresh(id: string, actorEmail: string) {
  const locked = await sql.begin(async (tx) => {
    const row = await lockSession(tx, id);
    if (row) await applyLiveness(tx, row.ctx, row.session, actorEmail);
    return row;
  });
  if (!locked) throw notFound('セッションが見つかりません。');
  return locked;
}

function invalidState(session: SessionRow, message: string): ApiError {
  return new ApiError(409, 'INVALID_STATE', message, {
    status: session.status,
    endReason: session.end_reason,
  });
}

// ── 提案の生成 ───────────────────────────────────────────────────

interface ProposingSnapshot {
  /** AI へ問い合わせた時点の同意。応答の採用時に一致を確かめる。 */
  aiConsentId: string | null;
  scope: OperationScope;
  rootKind: string | null;
  useAi: boolean;
  usedProposals: number;
  history: ProposalHistoryEntry[];
  steps: AiStepFact[];
  lastVerified: boolean;
}

async function snapshotForProposing(
  tx: Parameters<Parameters<typeof sql.begin>[1]>[0],
  ctx: RequestContext,
  session: SessionRow,
): Promise<ProposingSnapshot> {
  const proposals = await tx<ProposalRow[]>`
    SELECT * FROM assist_proposals WHERE support_session_id = ${session.id} ORDER BY step_seq
  `;
  const mains = await tx<ExecutionRow[]>`
    SELECT * FROM assist_executions
    WHERE support_session_id = ${session.id} AND role = 'main'
    ORDER BY step_seq
  `;
  const byProposal = new Map(mains.map((row) => [row.proposal_id, row]));
  return {
    scope: session.operation_consent_scope as OperationScope,
    rootKind: ctx.consent_root,
    useAi: session.ai_consent_live && aiConfigured(),
    aiConsentId: session.ai_input_consent_id,
    usedProposals: session.proposal_count,
    history: proposals.map((row) => ({ skillId: row.skill_id, params: row.params })),
    steps: proposals.map((row) => {
      const execution = byProposal.get(row.id);
      return {
        skillId: row.skill_id,
        effect: row.effect,
        resultCode: execution?.result_code ?? null,
        verified: row.verify_ok,
        output: execution?.normalized_output ?? null,
        aiFields: findAssistSkill(row.skill_id)?.aiFields ?? [],
      };
    }),
    lastVerified: proposals.at(-1)?.verify_ok === true,
  };
}

type PickResult =
  | {
      kind: 'proposal';
      skillId: string;
      params: Record<string, unknown>;
      rationale: string;
      source: 'deepseek' | 'rule';
    }
  | { kind: 'stop'; reason: 'duplicate_proposal' | 'no_candidate' | 'ai_stop' | 'escalated' }
  | { kind: 'confirm' };

/** 候補を選ぶ（DB の外。AI の応答を待つ間ロックを持たない）。 */
async function pickCandidate(snapshot: ProposingSnapshot): Promise<PickResult> {
  const skills = proposableSkills(snapshot.scope);
  let candidate: AiCandidate = { kind: 'none' };
  if (snapshot.useAi && skills.length > 0) {
    candidate = await askAiForCandidate(
      buildAiInput({
        scope: snapshot.scope,
        rootKind: snapshot.rootKind,
        usedProposals: snapshot.usedProposals,
        steps: snapshot.steps,
      }),
      skills,
      snapshot.history,
    );
  }
  if (candidate.kind === 'duplicate') return { kind: 'stop', reason: 'duplicate_proposal' };
  if (candidate.kind === 'proposal') {
    return { ...candidate, kind: 'proposal', source: 'deepseek' };
  }
  if (candidate.kind === 'decision') {
    if (candidate.decision === 'escalate') return { kind: 'stop', reason: 'escalated' };
    // AI の判断で解決にしない。検証が通っている場合だけ本人の解決確認へ進める（§7）。
    return snapshot.lastVerified ? { kind: 'confirm' } : { kind: 'stop', reason: 'ai_stop' };
  }
  const rule = rulePropose(skills, snapshot.history);
  if (!rule) return { kind: 'stop', reason: 'no_candidate' };
  return { kind: 'proposal', ...rule, source: 'rule' };
}

function buildVerifyDefinition(
  approved: ApprovedAssistSkill,
  params: Record<string, unknown>,
): AssistVerifyDefinition | null {
  const ops: AssistVerifyDefinition['ops'] = [];
  for (const spec of approved.skill.verifyOps(params)) {
    const op = resolveApprovedSkill(spec.skillId);
    // 確認操作を実行できないなら、提案しない（検証不能のまま変更しない）。
    if (op?.skill.effect !== 'read') return null;
    ops.push({
      skillId: spec.skillId,
      skillVersion: op.version,
      contentHash: op.contentHash,
      scriptHash: op.scriptHash,
      params: spec.params,
      check: { ...spec.check },
    });
  }
  return { mainCheck: { ...approved.skill.mainCheck(params) }, ops };
}

function publicRationale(text: string): string {
  return redactPII(text).text.slice(0, 200);
}

async function assignRoutes(app: FastifyInstance): Promise<void> {
  // 担当者のセッション開始。folder-access の active な依頼に紐付ける（§3）。
  app.post(
    '/support-sessions',
    { preHandler: authenticateUi, bodyLimit: 2 * 1024 },
    async (request) => {
      const email = await requireAssignee(request);
      if (!checkRateLimit(`assist-create:${email}`, 10, 60_000)) {
        throw new ApiError(429, 'RATE_LIMITED', '操作が多すぎます。少し待ってください。');
      }
      const { handoverId } = CreateBody.parse(request.body);
      const handovers = await sql<{ claimed_by: string | null; status: string }[]>`
      SELECT claimed_by, status FROM case_handovers WHERE id = ${handoverId}
    `;
      const handover = handovers[0];
      if (!handover) throw notFound('引継ぎが見つかりません。');
      if (handover.claimed_by !== email || !['claimed', 'resolved'].includes(handover.status)) {
        throw new ApiError(403, 'NOT_ASSIGNEE', '引継ぎを引き受けた担当者本人のみ開始できます。');
      }
      const latest = await sql<{ id: string }[]>`
      SELECT id FROM folder_access_requests
      WHERE handover_id = ${handoverId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
      const requestId = latest[0]?.id;
      if (!requestId) {
        throw new ApiError(409, 'FOLDER_REQUEST_NOT_ACTIVE', '有効なフォルダ同意がありません。');
      }
      const outcome = await sql
        .begin(async (tx) => {
          const ctx = await loadContext(tx, requestId);
          if (!ctx) return { kind: 'inactive' as const };
          const existing = await tx<{ id: string }[]>`
        SELECT id FROM support_sessions
        WHERE case_id = ${ctx.case_id} AND status IN (
          'binding_pending', 'consent_pending', 'ready', 'proposing', 'awaiting_approval',
          'approved', 'executing', 'verifying', 'awaiting_next', 'resolve_confirm'
        )
      `;
          if (existing[0]) return { kind: 'existing' as const, id: existing[0].id };
          if (
            ctx.status !== 'active' ||
            ctx.assignee_email !== email ||
            !ctx.helper_id ||
            !ctx.sid ||
            ctx.session_id === null ||
            !ctx.machine_guid ||
            !ctx.consent_id ||
            ctx.helper_session_state !== 'active'
          ) {
            return { kind: 'inactive' as const };
          }
          // 本番は貸与の照合が必須。未検証モードは本番では起動を拒否しているが二重に確かめる。
          if (config.isProduction && ctx.lease_status !== 'verified') {
            return { kind: 'inactive' as const };
          }
          const rows = await tx<{ id: string }[]>`
        INSERT INTO support_sessions (
          handover_id, case_id, requester_email, assignee_email, folder_request_id,
          folder_consent_id, folder_consent_version, folder_consent_expires_at, lease_status, lease_source, lease_fetched_at, rsp_device_id,
          mesh_node_id, machine_guid, sid, windows_session_id, helper_id, status, expires_at
        ) VALUES (
          ${ctx.handover_id}, ${ctx.case_id}, ${ctx.requester_email}, ${email}, ${ctx.id},
          ${ctx.consent_id}, ${FOLDER_CONSENT_VERSION}, ${ctx.consent_expires_at}, ${ctx.lease_status}, ${ctx.lease_source}, ${ctx.lease_fetched_at},
          ${ctx.rsp_device_id}, ${ctx.mesh_node_id}, ${ctx.machine_guid}, ${ctx.sid},
          ${ctx.session_id}, ${ctx.helper_id}, 'consent_pending',
          now() + (${ASSIST_LIMITS.sessionMinutes}::int * interval '1 minute')
        )
        RETURNING id
      `;
          const id = rows[0]?.id ?? '';
          const locked = await lockSession(tx, id);
          if (locked) {
            await sessionAudit(tx, 'support_session.start_session', locked.session, email, {
              folderRequestId: ctx.id,
              leaseStatus: ctx.lease_status,
            });
          }
          return { kind: 'created' as const, id };
        })
        .catch((error: unknown) => {
          // 同じ案件への同時開始（部分一意インデックス違反）。
          if ((error as { code?: string }).code === '23505') {
            throw new ApiError(409, 'SESSION_EXISTS', 'この案件には進行中のセッションがあります。');
          }
          throw error;
        });
      if (outcome.kind === 'inactive') {
        throw new ApiError(409, 'FOLDER_REQUEST_NOT_ACTIVE', '有効なフォルダ同意がありません。');
      }
      const { session, ctx } = await refresh(outcome.id, email);
      assertAssignee(session, email);
      return { ok: true, session: await sessionDto(session, ctx, 'assignee') };
    },
  );

  app.get('/support-sessions', { preHandler: authenticateUi }, async (request) => {
    const email = await requireAssignee(request);
    const { handoverId } = HandoverQuery.parse(request.query);
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM support_sessions
      WHERE handover_id = ${handoverId} AND assignee_email = ${email}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (!rows[0]) return { ok: true, session: null };
    const { session, ctx } = await refresh(rows[0].id, email);
    return { ok: true, session: await sessionDto(session, ctx, 'assignee') };
  });

  // 担当者の中止（§10）。stop_requested と停止の結果は実行ごとに別に残る。
  app.post(
    '/support-sessions/:id/stop',
    { preHandler: authenticateUi, bodyLimit: 1024 },
    async (request) => {
      const { id } = IdParams.parse(request.params);
      const email = await assertAssigneeBefore(request, id);
      const locked = await sql.begin(async (tx) => {
        const row = await lockSession(tx, id);
        if (row && isOpenSession(row.session.status)) {
          await stopSessionTx(tx, row.ctx, row.session, 'operator_stop', email);
        }
        return row;
      });
      if (!locked) throw notFound('セッションが見つかりません。');
      return { ok: true, session: await sessionDto(locked.session, locked.ctx, 'assignee') };
    },
  );
}

async function requesterRoutes(app: FastifyInstance): Promise<void> {
  // 本人の状態確認。進行中すべてと、直近に終了したものを返す。
  app.get('/support-sessions/mine', { preHandler: authenticateUi }, async (request) => {
    const email = requireEmail(request);
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM support_sessions
      WHERE requester_email = ${email}
        AND (ended_at IS NULL OR ended_at > now() - interval '10 minutes')
      ORDER BY created_at DESC
      LIMIT 10
    `;
    const sessions = [];
    for (const { id } of rows) {
      const owner = await loadOwnership(id);
      if (owner.requester_email !== email || owner.owner_email !== email) continue;
      const { session, ctx } = await refresh(id, email);
      sessions.push(await sessionDto(session, ctx, 'requester'));
    }
    return { ok: true, sessions };
  });

  // 操作範囲の同意。フォルダ同意から導出しない（§2）。
  app.post(
    '/support-sessions/:id/consents/operation',
    { preHandler: authenticateUi, bodyLimit: 1024 },
    async (request) => {
      const email = requireEmail(request);
      const { id } = IdParams.parse(request.params);
      const body = OperationConsentBody.parse(request.body);
      await assertRequesterBefore(id, email);
      const outcome = await sql.begin(async (tx) => {
        const locked = await lockSession(tx, id);
        if (!locked) return null;
        const { ctx, session } = locked;
        assertRequester(ctx, session, email);
        await applyLiveness(tx, ctx, session, email);
        if (session.status !== 'consent_pending') return { ok: false as const, session, ctx };
        const rows = await tx<{ id: string; expires_at: Date }[]>`
        INSERT INTO operation_consents (support_session_id, requester_email, scope, version, expires_at)
        VALUES (
          ${id}, ${email}, ${body.scope}, ${body.version},
          -- JS の Date（ミリ秒）へ写しても比較が一致するように丸める。
          date_trunc('milliseconds', LEAST(
            now() + (${body.ttlMinutes}::int * interval '1 minute'),
            ${session.expires_at}::timestamptz
          ))
        )
        RETURNING id, expires_at
      `;
        const consent = rows[0];
        if (!consent) throw new Error('同意の保存に失敗しました。');
        await tx`
        UPDATE support_sessions
        SET status = 'ready', operation_consent_id = ${consent.id},
            operation_consent_version = ${body.version},
            operation_consent_scope = ${body.scope},
            operation_consent_expires_at = ${consent.expires_at},
            updated_at = now()
        WHERE id = ${id}
      `;
        session.status = 'ready';
        session.operation_consent_id = consent.id;
        await sessionAudit(tx, 'support_session.operation_consent', session, email, {
          scope: body.scope,
          version: body.version,
          expiresAt: consent.expires_at.toISOString(),
        });
        return { ok: true as const, session, ctx };
      });
      if (!outcome) throw notFound('セッションが見つかりません。');
      if (!outcome.ok) throw invalidState(outcome.session, '現在の状態では同意できません。');
      const fresh = await refresh(id, email);
      return { ok: true, session: await sessionDto(fresh.session, fresh.ctx, 'requester') };
    },
  );

  // AI 入力の同意。無ければルールベースのみ（§2）。
  app.post(
    '/support-sessions/:id/consents/ai-input',
    { preHandler: authenticateUi, bodyLimit: 1024 },
    async (request) => {
      const email = requireEmail(request);
      const { id } = IdParams.parse(request.params);
      const body = AiConsentBody.parse(request.body);
      await assertRequesterBefore(id, email);
      const outcome = await sql.begin(async (tx) => {
        const locked = await lockSession(tx, id);
        if (!locked) return null;
        const { ctx, session } = locked;
        assertRequester(ctx, session, email);
        await applyLiveness(tx, ctx, session, email);
        if (!isOpenSession(session.status)) return { ok: false as const, session };
        const rows = await tx<{ id: string; expires_at: Date }[]>`
        INSERT INTO ai_input_consents (support_session_id, requester_email, version, expires_at)
        VALUES (
          ${id}, ${email}, ${body.version},
          -- JS の Date（ミリ秒）へ写しても比較が一致するように丸める。
          date_trunc('milliseconds', LEAST(
            now() + (${body.ttlMinutes}::int * interval '1 minute'),
            ${session.expires_at}::timestamptz
          ))
        )
        RETURNING id, expires_at
      `;
        const consent = rows[0];
        if (!consent) throw new Error('同意の保存に失敗しました。');
        await tx`
        UPDATE ai_input_consents SET revoked_at = now(), revoke_reason = 'replaced'
        WHERE support_session_id = ${id} AND revoked_at IS NULL AND id <> ${consent.id}
      `;
        await tx`
        UPDATE support_sessions
        SET ai_input_consent_id = ${consent.id}, ai_input_consent_version = ${body.version},
            ai_input_consent_expires_at = ${consent.expires_at}, updated_at = now()
        WHERE id = ${id}
      `;
        await sessionAudit(tx, 'support_session.ai_input_consent', session, email, {
          version: body.version,
          expiresAt: consent.expires_at.toISOString(),
        });
        return { ok: true as const, session };
      });
      if (!outcome) throw notFound('セッションが見つかりません。');
      if (!outcome.ok) throw invalidState(outcome.session, '現在の状態では同意できません。');
      const fresh = await refresh(id, email);
      return { ok: true, session: await sessionDto(fresh.session, fresh.ctx, 'requester') };
    },
  );

  app.post(
    '/support-sessions/:id/consents/ai-input/revoke',
    { preHandler: authenticateUi, bodyLimit: 1024 },
    async (request) => {
      const email = requireEmail(request);
      const { id } = IdParams.parse(request.params);
      await assertRequesterBefore(id, email);
      await sql.begin(async (tx) => {
        const locked = await lockSession(tx, id);
        if (!locked) return;
        await tx`
        UPDATE ai_input_consents SET revoked_at = now(), revoke_reason = 'requester_revoked'
        WHERE support_session_id = ${id} AND revoked_at IS NULL
      `;
        await tx`
        UPDATE support_sessions
        SET ai_input_consent_id = NULL, ai_input_consent_version = NULL,
            ai_input_consent_expires_at = NULL, updated_at = now()
        WHERE id = ${id}
      `;
        await sessionAudit(tx, 'support_session.ai_input_revoke', locked.session, email);
      });
      const fresh = await refresh(id, email);
      return { ok: true, session: await sessionDto(fresh.session, fresh.ctx, 'requester') };
    },
  );

  // 本人の Y/N（1 提案 1 回）。
  app.post(
    '/support-sessions/:id/proposals/:proposalId/decision',
    { preHandler: authenticateUi, bodyLimit: 1024 },
    async (request) => {
      const email = requireEmail(request);
      const { id, proposalId } = ProposalParams.parse(request.params);
      const body = DecisionBody.parse(request.body);
      await assertRequesterBefore(id, email);
      const outcome = await sql.begin(async (tx) => {
        const locked = await lockSession(tx, id);
        if (!locked) return null;
        assertRequester(locked.ctx, locked.session, email);
        const result = await decideProposalTx(
          tx,
          locked.ctx,
          locked.session,
          proposalId,
          body.decision,
          body.decision === 'Y' ? body.approvalHash : undefined,
          email,
        );
        return { result, session: locked.session };
      });
      if (!outcome) throw notFound('セッションが見つかりません。');
      // 無効化はトランザクションを commit してから伝える。
      if (outcome.result.kind === 'state') {
        throw invalidState(outcome.session, '現在の状態では判定できません。');
      }
      if (outcome.result.kind === 'invalid') {
        throw new ApiError(409, outcome.result.code, '承認の前提が変わったため無効です。');
      }
      const fresh = await refresh(id, email);
      return { ok: true, session: await sessionDto(fresh.session, fresh.ctx, 'requester') };
    },
  );

  // 本人の解決確認。AI の判断で解決にしない（§7）。
  app.post(
    '/support-sessions/:id/resolution',
    { preHandler: authenticateUi, bodyLimit: 1024 },
    async (request) => {
      const email = requireEmail(request);
      const { id } = IdParams.parse(request.params);
      const body = ResolutionBody.parse(request.body);
      await assertRequesterBefore(id, email);
      const outcome = await sql.begin(async (tx) => {
        const locked = await lockSession(tx, id);
        if (!locked) return null;
        const { ctx, session } = locked;
        assertRequester(ctx, session, email);
        await applyLiveness(tx, ctx, session, email);
        if (!['resolve_confirm', 'awaiting_next'].includes(session.status)) {
          return { ok: false as const, session };
        }
        await sessionAudit(tx, 'support_session.resolution', session, email, {
          resolved: body.resolved,
        });
        if (body.resolved) {
          await stopSessionTx(tx, ctx, session, 'resolved', email);
        } else {
          await setSessionStatus(tx, session, 'awaiting_next');
        }
        return { ok: true as const, session };
      });
      if (!outcome) throw notFound('セッションが見つかりません。');
      if (!outcome.ok) throw invalidState(outcome.session, '現在の状態では確認できません。');
      const fresh = await refresh(id, email);
      return { ok: true, session: await sessionDto(fresh.session, fresh.ctx, 'requester') };
    },
  );

  // 本人の取消（いつでも）。
  app.post(
    '/support-sessions/:id/revoke',
    { preHandler: authenticateUi, bodyLimit: 1024 },
    async (request) => {
      const email = requireEmail(request);
      const { id } = IdParams.parse(request.params);
      await assertRequesterBefore(id, email);
      const locked = await sql.begin(async (tx) => {
        const row = await lockSession(tx, id);
        if (row && isOpenSession(row.session.status)) {
          await stopSessionTx(tx, row.ctx, row.session, 'requester_revoked', email);
        }
        return row;
      });
      if (!locked) throw notFound('セッションが見つかりません。');
      return { ok: true, session: await sessionDto(locked.session, locked.ctx, 'requester') };
    },
  );
}

async function sharedRoutes(app: FastifyInstance): Promise<void> {
  // 本人か担当者。それ以外には存在も見せない内容を返さない。
  app.get('/support-sessions/:id', { preHandler: authenticateUi }, async (request) => {
    const email = requireEmail(request);
    const { id } = IdParams.parse(request.params);
    const view = await viewOf(id, email);
    const { session, ctx } = await refresh(id, email);
    return { ok: true, session: await sessionDto(session, ctx, view) };
  });

  // 提案の生成（AI または固定のルール）。本人か担当者が要求できるが、実行は本人の Y が必要。
  app.post(
    '/support-sessions/:id/proposals',
    { preHandler: authenticateUi, bodyLimit: 1024 },
    async (request) => {
      const email = requireEmail(request);
      const { id } = IdParams.parse(request.params);
      const view = await viewOf(id, email);
      if (!checkRateLimit(`assist-propose:${id}`, 12, 60_000)) {
        throw new ApiError(429, 'RATE_LIMITED', '操作が多すぎます。少し待ってください。');
      }
      const begun = await sql.begin(async (tx) => {
        const locked = await lockSession(tx, id);
        if (!locked) return null;
        const { ctx, session } = locked;
        await applyLiveness(tx, ctx, session, email);
        if (!['ready', 'awaiting_next'].includes(session.status)) {
          return { kind: 'state' as const, session };
        }
        if (session.proposal_count >= ASSIST_LIMITS.maxProposals) {
          await stopSessionTx(tx, ctx, session, 'proposal_limit', email);
          return { kind: 'limit' as const, session };
        }
        const snapshot = await snapshotForProposing(tx, ctx, session);
        await setSessionStatus(tx, session, 'proposing');
        return { kind: 'ok' as const, snapshot };
      });
      if (!begun) throw notFound('セッションが見つかりません。');
      if (begun.kind === 'state')
        throw invalidState(begun.session, '現在の状態では提案できません。');
      if (begun.kind === 'limit') {
        throw new ApiError(
          409,
          'PROPOSAL_LIMIT',
          `提案の上限（${ASSIST_LIMITS.maxProposals} 件）に達しました。`,
        );
      }

      const pick = await pickCandidate(begun.snapshot);

      const outcome = await sql.begin(async (tx) => {
        const locked = await lockSession(tx, id);
        if (!locked) return null;
        const { ctx, session } = locked;
        await applyLiveness(tx, ctx, session, email);
        if (session.status !== 'proposing') return { kind: 'state' as const, session };
        if (pick.kind === 'stop') {
          await stopSessionTx(tx, ctx, session, pick.reason, email);
          return { kind: 'stopped' as const, reason: pick.reason };
        }
        if (pick.kind === 'confirm') {
          await setSessionStatus(tx, session, 'resolve_confirm');
          return { kind: 'ok' as const };
        }
        // AI の応答を待つ間に同意が取り消されたら、その候補を使わない。
        // 取り消して再同意した場合も、取消前の同意で得た応答は使わない（同意 ID で照合する）。
        if (
          pick.source === 'deepseek' &&
          (!session.ai_consent_live || session.ai_input_consent_id !== begun.snapshot.aiConsentId)
        ) {
          await stopSessionTx(tx, ctx, session, 'ai_consent_changed', email);
          return { kind: 'stopped' as const, reason: 'ai_consent_changed' };
        }
        // AI の候補も含め、この場で登録・型・範囲を再検証する（§5）。
        const approved = resolveApprovedSkill(pick.skillId);
        const scope = session.operation_consent_scope as OperationScope | null;
        if (
          !approved ||
          approved.skill.verifyOnly ||
          !scope ||
          !isWithinScope(approved.skill, scope) ||
          !validateParams(approved.skill.definition.paramsSchema, pick.params).ok
        ) {
          await stopSessionTx(tx, ctx, session, 'no_candidate', email);
          return { kind: 'stopped' as const, reason: 'no_candidate' };
        }
        const verify = buildVerifyDefinition(approved, pick.params);
        if (!verify) {
          await stopSessionTx(tx, ctx, session, 'no_candidate', email);
          return { kind: 'stopped' as const, reason: 'no_candidate' };
        }
        const proposalId =
          (await tx<{ id: string }[]>`SELECT gen_random_uuid() AS id`)[0]?.id ?? '';
        const nonce = newNonce();
        const expiry = await tx<{ expires_at: Date }[]>`
        SELECT LEAST(
          now() + (${ASSIST_LIMITS.approvalMinutes}::int * interval '1 minute'),
          ${session.expires_at}::timestamptz,
          ${session.operation_consent_expires_at}::timestamptz
        ) AS expires_at
      `;
        const approvalExpiresAt = expiry[0]?.expires_at;
        if (!approvalExpiresAt) throw new Error('期限の計算に失敗しました。');
        const stepSeq = session.proposal_count + 1;
        const hash = computeAssistApprovalHash(
          buildApprovalPayload(ctx, session, {
            id: proposalId,
            step_seq: stepSeq,
            skill_id: pick.skillId,
            skill_version: approved.version,
            content_hash: approved.contentHash,
            script_hash: approved.scriptHash,
            params: pick.params,
            required_privilege: REQUIRED_PRIVILEGE,
            nonce,
            approval_expires_at: approvalExpiresAt,
            verify,
          }),
        );
        const { skill } = approved;
        await tx`
        INSERT INTO assist_proposals (
          id, support_session_id, step_seq, skill_id, skill_version, content_hash, script_hash,
          params, effect, required_privilege, risk_level, target_ref, title, purpose, impact,
          success_criteria, failure_action, rollback_scope, rationale, proposal_source, verify,
          approval_hash, nonce, approval_expires_at
        ) VALUES (
          ${proposalId}, ${id}, ${stepSeq}, ${pick.skillId}, ${approved.version},
          ${approved.contentHash}, ${approved.scriptHash}, ${jsonbValue(pick.params)},
          ${skill.effect}, ${REQUIRED_PRIVILEGE}, ${skill.definition.riskLevel},
          ${skill.targetKind === 'folder' ? 'T1' : null}, ${skill.definition.title},
          ${skill.purpose}, ${skill.impact}, ${skill.successCriteria}, ${skill.failureAction},
          ${skill.rollbackScope}, ${publicRationale(pick.rationale)}, ${pick.source},
          ${jsonbValue(verify)}, ${hash}, ${nonce}, ${approvalExpiresAt}
        )
      `;
        await tx`
        UPDATE support_sessions
        SET status = 'awaiting_approval', proposal_count = ${stepSeq}, updated_at = now()
        WHERE id = ${id}
      `;
        session.status = 'awaiting_approval';
        await sessionAudit(tx, 'support_session.proposal', session, email, {
          proposalId,
          stepSeq,
          skillId: pick.skillId,
          effect: skill.effect,
          proposalSource: pick.source,
        });
        return { kind: 'ok' as const };
      });
      if (!outcome) throw notFound('セッションが見つかりません。');
      if (outcome.kind === 'state') {
        throw invalidState(outcome.session, 'セッションの状態が変わりました。');
      }
      const fresh = await refresh(id, email);
      return { ok: true, session: await sessionDto(fresh.session, fresh.ctx, view) };
    },
  );
}

/** 本人か、担当者本人か。それ以外は 403（状態更新より前に確かめる）。 */
async function viewOf(id: string, email: string): Promise<'assignee' | 'requester'> {
  const row = await loadOwnership(id);
  if (row.requester_email === email && row.owner_email === email) return 'requester';
  if (row.assignee_email === email) {
    await requireHelpdeskActor(email);
    return 'assignee';
  }
  throw forbidden('このセッションを参照できません。');
}

export async function supportSessionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async () => {
    // 無効時は存在しないルートと同じ応答にする。
    if (!assistEnabled()) throw notFound('パスは存在しません。');
  });
  await assignRoutes(app);
  await requesterRoutes(app);
  await sharedRoutes(app);
}
