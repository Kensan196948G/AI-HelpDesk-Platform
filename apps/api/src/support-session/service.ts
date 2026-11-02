import { randomBytes } from 'node:crypto';
import { sql } from '../db.js';
import {
  activeViolation,
  endRequestTx,
  loadContext,
  type RequestContext,
  type Tx,
} from '../folder-access/service.js';
import { hashSid } from '../folder-access/sign.js';
import { isTerminal } from '../folder-access/state.js';
import { appendAudit } from '../lib/audit-log.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { approvalHashMatches } from '../resolve/approval.js';
import type { ApprovalManifest } from '../resolve/skills.js';
import { evaluateVerify } from '../resolve/verify.js';
import {
  type AssistApprovalPayload,
  type AssistVerifyDefinition,
  computeAssistApprovalHash,
} from './approval.js';
import {
  ASSIST_SKILL_SUCCESS_CODES,
  canonicalParamsJson,
  HELPER_FAILURE_CODES,
  HELPER_REJECT_CODES,
  type SignableSkillRun,
  SKILL_RUN_CANON,
  SKILL_RUN_OPERATION,
  type SkillResultBody,
  type StartBody,
  type StartRejectCode,
} from './contract.js';
import { assistEnabled, terminateSessionTx } from './propagate.js';
import { loadApprovalManifest } from './skill-source.js';

export { assistEnabled };

import {
  type ApprovedAssistSkill,
  findAssistSkill,
  normalizeSkillOutput,
  resolveApprovedSkill,
} from './skills.js';
import {
  ASSIST_LIMITS,
  FOLDER_CONSENT_VERSION,
  folderReasonForSessionEnd,
  isNoProgress,
  isOpenSession,
  progressFingerprint,
  type SessionEndReason,
} from './state.js';

/**
 * 共通支援セッションの中核（docs/63）。すべて sql.begin の中から呼ぶ。
 * ロック順は「依頼 → セッション → 提案 → 実行」に固定する。
 * 実行器はヘルパーだけで、ここから device_commands / RSP へ配送しない（§6）。
 */

export const REQUIRED_PRIVILEGE = 'standard_user';

export interface SessionRow {
  id: string;
  handover_id: string;
  case_id: string;
  requester_email: string;
  assignee_email: string;
  folder_request_id: string;
  folder_consent_id: string | null;
  lease_status: string;
  lease_source: string | null;
  lease_fetched_at: Date | null;
  rsp_device_id: string | null;
  mesh_node_id: string | null;
  machine_guid: string | null;
  sid: string | null;
  windows_session_id: number | null;
  helper_id: string | null;
  operation_consent_id: string | null;
  operation_consent_version: string | null;
  operation_consent_scope: string | null;
  operation_consent_expires_at: Date | null;
  ai_input_consent_id: string | null;
  ai_input_consent_version: string | null;
  ai_input_consent_expires_at: Date | null;
  proposal_count: number;
  status: string;
  end_reason: SessionEndReason | null;
  expires_at: Date;
  ended_at: Date | null;
  created_at: Date;
  session_expired: boolean;
  operation_consent_expired: boolean;
  proposing_expired: boolean;
  ai_consent_live: boolean;
}

export interface ProposalRow {
  id: string;
  support_session_id: string;
  step_seq: number;
  skill_id: string;
  skill_version: string;
  content_hash: string;
  script_hash: string;
  params: Record<string, unknown>;
  effect: 'read' | 'modify';
  required_privilege: string;
  risk_level: number;
  target_ref: string | null;
  title: string;
  purpose: string;
  impact: string;
  success_criteria: string;
  failure_action: string;
  rollback_scope: string;
  rationale: string | null;
  reason_codes: string[];
  proposal_source: 'deepseek' | 'rule';
  verify: AssistVerifyDefinition;
  approval_hash: string;
  nonce: string;
  nonce_consumed_at: Date | null;
  approval_expires_at: Date;
  status: string;
  decision: string | null;
  verify_ok: boolean | null;
  verify_reason: string | null;
  created_at: Date;
}

export interface ExecutionRow {
  id: string;
  proposal_id: string;
  support_session_id: string;
  step_seq: number;
  role: 'main' | 'verify';
  verify_index: number;
  helper_id: string | null;
  sid: string | null;
  windows_session_id: number | null;
  skill_id: string;
  skill_version: string;
  content_hash: string;
  script_hash: string;
  params: Record<string, unknown>;
  check_definition: Record<string, unknown>;
  max_seconds: number;
  max_output_bytes: number;
  status: string;
  expires_at: Date;
  start_nonce: string;
  start_nonce_consumed_at: Date | null;
  started_at: Date | null;
  deadline_at: Date | null;
  execution_mode: string | null;
  result_source: string | null;
  result_status: string | null;
  result_code: string | null;
  normalized_output: Record<string, unknown> | null;
  evidence: boolean;
  verify_ok: boolean | null;
  verify_reason: string | null;
  result_received_at: Date | null;
  late_result: boolean;
  stop_requested_at: Date | null;
  stopped_at: Date | null;
  stop_outcome: string | null;
  report_expired_at: Date | null;
  partial_effect: string[] | null;
  created_at: Date;
  op_expired: boolean;
  run_overdue: boolean;
}

/** 期限の判定は DB の now() で行う。ロック付きの読み取りと一括の読み取りで共有する。 */
const SESSION_FLAGS = sql`
  (s.expires_at <= now()) AS session_expired,
  (s.operation_consent_expires_at IS NOT NULL AND s.operation_consent_expires_at <= now())
    AS operation_consent_expired,
  (s.status = 'proposing' AND s.proposing_expires_at <= now()) AS proposing_expired,
  (s.ai_input_consent_id IS NOT NULL AND s.ai_input_consent_expires_at > now()) AS ai_consent_live
`;

async function selectSessionForUpdate(tx: Tx, id: string): Promise<SessionRow | null> {
  const rows = await tx<SessionRow[]>`
    SELECT s.*, ${SESSION_FLAGS}
    FROM support_sessions s
    WHERE s.id = ${id}
    FOR UPDATE OF s
  `;
  return rows[0] ?? null;
}

/** ロックなしの一括読み取り（一覧の表示用）。 */
export async function selectSessions(ids: readonly string[]): Promise<SessionRow[]> {
  return sql<SessionRow[]>`
    SELECT s.*, ${SESSION_FLAGS}
    FROM support_sessions s
    WHERE s.id = ANY(${[...ids]}::uuid[])
  `;
}

/** 依頼 → セッションの順にロックして読む。 */
export async function lockSession(
  tx: Tx,
  id: string,
): Promise<{ ctx: RequestContext; session: SessionRow } | null> {
  const keys = await tx<{ folder_request_id: string }[]>`
    SELECT folder_request_id FROM support_sessions WHERE id = ${id}
  `;
  const key = keys[0];
  if (!key) return null;
  const ctx = await loadContext(tx, key.folder_request_id);
  if (!ctx) return null;
  const session = await selectSessionForUpdate(tx, id);
  return session ? { ctx, session } : null;
}

async function reload(tx: Tx, session: SessionRow): Promise<void> {
  const fresh = await selectSessionForUpdate(tx, session.id);
  if (fresh) Object.assign(session, fresh);
}

export function sessionAudit(
  tx: Tx,
  action: string,
  session: SessionRow,
  actorEmail: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  // パス・名前・端末の自由文・SID の平文を入れない。
  return appendAudit(tx, {
    actorId: null,
    action,
    targetType: 'support_session',
    targetId: session.id,
    detail: {
      actorEmail,
      caseId: session.case_id,
      assigneeEmail: session.assignee_email,
      sidHash: session.sid ? hashSid(session.sid) : null,
      windowsSessionId: session.windows_session_id,
      operationConsentId: session.operation_consent_id,
      ...extra,
    },
  });
}

/** セッションを止め、フォルダ同意とヘルパーのトークンも失効させる（§10）。 */
export async function stopSessionTx(
  tx: Tx,
  ctx: RequestContext,
  session: SessionRow,
  reason: SessionEndReason,
  actorEmail: string,
): Promise<void> {
  await terminateSessionTx(tx, session, reason, actorEmail);
  if (!isTerminal(ctx.status)) {
    await endRequestTx(tx, ctx, folderReasonForSessionEnd(reason), actorEmail);
  }
  await reload(tx, session);
}

/** 束縛・期限を確認し、違反があれば同じトランザクションで止める（毎操作）。 */
export async function applyLiveness(
  tx: Tx,
  ctx: RequestContext,
  session: SessionRow,
  actorEmail: string,
): Promise<void> {
  if (!isOpenSession(session.status)) return;
  if (ctx.status !== 'active') {
    await stopSessionTx(tx, ctx, session, 'binding_changed', actorEmail);
    return;
  }
  const violation = activeViolation(ctx);
  if (violation) {
    // endRequestTx が伝搬でセッションも終わらせる。
    await endRequestTx(tx, ctx, violation, actorEmail);
    await reload(tx, session);
    return;
  }
  const bindingChanged =
    ctx.consent_id !== session.folder_consent_id ||
    ctx.helper_id !== session.helper_id ||
    ctx.sid !== session.sid ||
    ctx.session_id !== session.windows_session_id ||
    ctx.machine_guid !== session.machine_guid ||
    ctx.assignee_email !== session.assignee_email ||
    ctx.requester_email !== session.requester_email;
  if (bindingChanged) {
    await stopSessionTx(tx, ctx, session, 'binding_changed', actorEmail);
    return;
  }
  if (session.session_expired || session.operation_consent_expired) {
    await stopSessionTx(tx, ctx, session, 'expired', actorEmail);
    return;
  }
  // 提案の生成中にプロセスが止まると proposing のまま残る。止めて次へ進めないようにする。
  if (session.proposing_expired) {
    await stopSessionTx(tx, ctx, session, 'proposing_timeout', actorEmail);
    return;
  }
  const overdueProposals = await tx<{ id: string }[]>`
    SELECT id FROM assist_proposals
    WHERE support_session_id = ${session.id} AND status = 'proposed'
      AND approval_expires_at <= now()
    LIMIT 1
  `;
  if (overdueProposals[0]) {
    await stopSessionTx(tx, ctx, session, 'approval_expired', actorEmail);
    return;
  }
  const lapsed = await tx<{ id: string }[]>`
    UPDATE assist_executions
    SET status = 'expired'
    WHERE support_session_id = ${session.id}
      AND status IN ('queued', 'delivered') AND expires_at <= now()
    RETURNING id
  `;
  if (lapsed[0]) {
    await stopSessionTx(tx, ctx, session, 'execution_expired', actorEmail);
    return;
  }
  const overdue = await tx<{ id: string }[]>`
    UPDATE assist_executions
    SET status = 'timed_out'
    WHERE support_session_id = ${session.id}
      AND status = 'executing' AND deadline_at <= now()
    RETURNING id
  `;
  if (overdue[0]) {
    // 結果が届かなかった。止まったかどうかは分からないので stop_requested だけを記録する。
    await tx`
      UPDATE assist_executions
      SET stop_requested_at = COALESCE(stop_requested_at, now())
      WHERE id = ANY(${overdue.map((row) => row.id)}::uuid[])
    `;
    await stopSessionTx(tx, ctx, session, 'execution_timeout', actorEmail);
  }
}

// ── 承認ハッシュ ─────────────────────────────────────────────────

/** いまの値から payload を組み立てる。保存済みの payload は持たない。 */
export function buildApprovalPayload(
  ctx: RequestContext,
  session: SessionRow,
  proposal: Pick<
    ProposalRow,
    | 'id'
    | 'step_seq'
    | 'skill_id'
    | 'skill_version'
    | 'content_hash'
    | 'script_hash'
    | 'params'
    | 'required_privilege'
    | 'nonce'
    | 'approval_expires_at'
    | 'verify'
  >,
): AssistApprovalPayload {
  return {
    supportSessionId: session.id,
    caseId: session.case_id,
    proposalId: proposal.id,
    stepSeq: proposal.step_seq,
    requesterEmail: ctx.requester_email,
    assigneeEmail: ctx.claimed_by ?? '',
    machineGuid: ctx.machine_guid ?? '',
    sid: ctx.sid ?? '',
    windowsSessionId: ctx.session_id ?? -1,
    helperId: ctx.helper_id ?? '',
    folderConsent: {
      id: ctx.consent_id ?? '',
      version: FOLDER_CONSENT_VERSION,
      root: ctx.consent_root ?? '',
      segments: ctx.consent_segments,
      operation: ctx.consent_operation ?? '',
      expiresAt: ctx.consent_expires_at?.toISOString() ?? '',
    },
    operationConsent: {
      id: session.operation_consent_id ?? '',
      version: session.operation_consent_version ?? '',
      scope: session.operation_consent_scope ?? '',
      expiresAt: session.operation_consent_expires_at?.toISOString() ?? '',
    },
    skillId: proposal.skill_id,
    skillVersion: proposal.skill_version,
    contentHash: proposal.content_hash,
    scriptHash: proposal.script_hash,
    params: proposal.params,
    requiredPrivilege: proposal.required_privilege,
    nonce: proposal.nonce,
    expiresAt: proposal.approval_expires_at.toISOString(),
    verify: proposal.verify,
  };
}

export function newNonce(): string {
  return randomBytes(16).toString('base64url');
}

/** 同意の正本（operation_consents）が、セッションの写しと一致して有効か。 */
async function operationConsentLive(tx: Tx, session: SessionRow): Promise<boolean> {
  if (!session.operation_consent_id) return false;
  const rows = await tx<{ id: string }[]>`
    SELECT id FROM operation_consents
    WHERE id = ${session.operation_consent_id}
      AND support_session_id = ${session.id}
      AND requester_email = ${session.requester_email}
      AND scope = ${session.operation_consent_scope ?? ''}
      AND version = ${session.operation_consent_version ?? ''}
      AND expires_at = ${session.operation_consent_expires_at}
      AND revoked_at IS NULL
      AND expires_at > now()
  `;
  return Boolean(rows[0]);
}

function skillStillApproved(
  skillId: string,
  version: string,
  contentHash: string,
  scriptHash: string,
  manifest: ApprovalManifest,
): ApprovedAssistSkill | null {
  const approved = resolveApprovedSkill(skillId, manifest);
  if (!approved) return null;
  if (
    approved.version !== version ||
    approved.contentHash !== contentHash ||
    approved.scriptHash !== scriptHash
  ) {
    return null;
  }
  return approved;
}

/** 提案の束縛がいまも成り立つか（Y と /start の共通の再検証）。 */
async function approvalStillValid(
  tx: Tx,
  ctx: RequestContext,
  session: SessionRow,
  proposal: ProposalRow,
): Promise<'ok' | 'consent' | 'approval' | 'skill'> {
  if (!(await operationConsentLive(tx, session))) return 'consent';
  // manifest は 1 回の再検証で 1 度だけ読む（ロックを持ったまま読み直さない）。
  const manifest = loadApprovalManifest();
  const skill = skillStillApproved(
    proposal.skill_id,
    proposal.skill_version,
    proposal.content_hash,
    proposal.script_hash,
    manifest,
  );
  if (!skill) return 'skill';
  for (const op of proposal.verify.ops) {
    if (!skillStillApproved(op.skillId, op.skillVersion, op.contentHash, op.scriptHash, manifest)) {
      return 'skill';
    }
  }
  const expected = computeAssistApprovalHash(buildApprovalPayload(ctx, session, proposal));
  return approvalHashMatches(proposal.approval_hash, expected) ? 'ok' : 'approval';
}

export type DecisionOutcome =
  | { kind: 'ok' }
  | { kind: 'state' }
  | { kind: 'invalid'; code: 'APPROVAL_INVALID' | 'CONSENT_INVALID' | 'SKILL_NOT_APPROVED' };

async function selectProposalForUpdate(tx: Tx, id: string): Promise<ProposalRow | null> {
  const rows = await tx<ProposalRow[]>`SELECT * FROM assist_proposals WHERE id = ${id} FOR UPDATE`;
  return rows[0] ?? null;
}

/** 本人の Y/N（§5）。N は副作用なしで stopped。 */
export async function decideProposalTx(
  tx: Tx,
  ctx: RequestContext,
  session: SessionRow,
  proposalId: string,
  decision: 'Y' | 'N',
  approvalHash: string | undefined,
  actorEmail: string,
): Promise<DecisionOutcome> {
  await applyLiveness(tx, ctx, session, actorEmail);
  if (session.status !== 'awaiting_approval') return { kind: 'state' };
  const proposal = await selectProposalForUpdate(tx, proposalId);
  if (
    !proposal ||
    proposal.support_session_id !== session.id ||
    proposal.status !== 'proposed' ||
    proposal.nonce_consumed_at
  ) {
    return { kind: 'state' };
  }

  if (decision === 'N') {
    await tx`
      UPDATE assist_proposals
      SET status = 'rejected', decision = 'N', decided_by = ${actorEmail}, decided_at = now(),
          nonce_consumed_at = now()
      WHERE id = ${proposal.id}
    `;
    await sessionAudit(tx, 'support_session.decision', session, actorEmail, {
      proposalId: proposal.id,
      skillId: proposal.skill_id,
      decision: 'N',
    });
    await stopSessionTx(tx, ctx, session, 'requester_declined', actorEmail);
    return { kind: 'ok' };
  }

  const validity = await approvalStillValid(tx, ctx, session, proposal);
  const submittedOk =
    typeof approvalHash === 'string' && approvalHashMatches(approvalHash, proposal.approval_hash);
  if (validity !== 'ok' || !submittedOk) {
    await tx`UPDATE assist_proposals SET status = 'invalidated' WHERE id = ${proposal.id}`;
    await sessionAudit(tx, 'support_session.approval_invalid', session, actorEmail, {
      proposalId: proposal.id,
      reason: validity === 'ok' ? 'hash_mismatch' : validity,
    });
    await stopSessionTx(tx, ctx, session, 'binding_changed', actorEmail);
    if (validity === 'consent') return { kind: 'invalid', code: 'CONSENT_INVALID' };
    if (validity === 'skill') return { kind: 'invalid', code: 'SKILL_NOT_APPROVED' };
    return { kind: 'invalid', code: 'APPROVAL_INVALID' };
  }

  // nonce はここで 1 回だけ消費する（Y の再送を受けない）。
  const consumed = await tx<{ id: string }[]>`
    UPDATE assist_proposals
    SET status = 'approved', decision = 'Y', decided_by = ${actorEmail}, decided_at = now(),
        nonce_consumed_at = now()
    WHERE id = ${proposal.id} AND status = 'proposed' AND nonce_consumed_at IS NULL
    RETURNING id
  `;
  if (!consumed[0]) return { kind: 'state' };
  await enqueueExecutionTx(tx, ctx, session, proposal, 'main', 0);
  await setSessionStatus(tx, session, 'approved');
  await sessionAudit(tx, 'support_session.decision', session, actorEmail, {
    proposalId: proposal.id,
    skillId: proposal.skill_id,
    effect: proposal.effect,
    decision: 'Y',
  });
  return { kind: 'ok' };
}

export async function setSessionStatus(tx: Tx, session: SessionRow, status: string): Promise<void> {
  await tx`
    UPDATE support_sessions SET status = ${status}, updated_at = now() WHERE id = ${session.id}
  `;
  session.status = status;
}

/** ヘルパーのキューへ積む。配送先はヘルパーだけ（§6）。 */
async function enqueueExecutionTx(
  tx: Tx,
  ctx: RequestContext,
  session: SessionRow,
  proposal: ProposalRow,
  role: 'main' | 'verify',
  verifyIndex: number,
): Promise<void> {
  const target =
    role === 'main'
      ? {
          skillId: proposal.skill_id,
          version: proposal.skill_version,
          contentHash: proposal.content_hash,
          scriptHash: proposal.script_hash,
          params: proposal.params,
          check: proposal.verify.mainCheck,
        }
      : (() => {
          const op = proposal.verify.ops[verifyIndex];
          if (!op) throw new Error('確認操作の定義がありません。');
          return {
            skillId: op.skillId,
            version: op.skillVersion,
            contentHash: op.contentHash,
            scriptHash: op.scriptHash,
            params: op.params,
            check: op.check,
          };
        })();
  const skill = findAssistSkill(target.skillId);
  if (!skill) throw new Error('Skill が見つかりません。');
  await tx`
    INSERT INTO assist_executions (
      proposal_id, support_session_id, step_seq, role, verify_index, helper_id, sid,
      windows_session_id, skill_id, skill_version, content_hash, script_hash, params,
      check_definition, max_seconds, max_output_bytes, expires_at, start_nonce
    ) VALUES (
      ${proposal.id}, ${session.id}, ${proposal.step_seq}, ${role}, ${verifyIndex},
      ${ctx.helper_id}, ${ctx.sid}, ${ctx.session_id}, ${target.skillId}, ${target.version},
      ${target.contentHash}, ${target.scriptHash}, ${jsonbValue(target.params)},
      ${jsonbValue(target.check)}, ${skill.definition.timeoutSec}, ${ASSIST_LIMITS.maxOutputBytes},
      LEAST(
        now() + (${ASSIST_LIMITS.opSeconds}::int * interval '1 second'),
        ${session.expires_at}::timestamptz,
        ${session.operation_consent_expires_at}::timestamptz,
        ${ctx.consent_expires_at}::timestamptz
      ),
      ${newNonce()}
    )
  `;
}

// ── poll ─────────────────────────────────────────────────────────

export interface AssistPollInput {
  helperId: string;
  requestId: string | null;
  revoked: boolean;
  capable: boolean;
  sessionActive: boolean;
}

export interface AssistPollOutcome {
  enabled: boolean;
  skillOps: SignableSkillRun[];
  cancel: string[];
  nextPollSeconds: number | null;
}

/** 停止要求をまだ伝えていない実行を cancel として渡す。 */
async function drainExecutionCancels(tx: Tx, helperId: string): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    UPDATE assist_executions
    SET cancel_acked_at = now()
    WHERE helper_id = ${helperId}
      AND stop_requested_at IS NOT NULL
      AND cancel_acked_at IS NULL
      AND status IN ('delivered', 'executing', 'timed_out', 'expired')
    RETURNING id
  `;
  return rows.map((row) => row.id);
}

/**
 * poll の延長（pollTx と同じトランザクション。依頼の行は pollTx が既にロックしている）。
 * 配送は queued → delivered の条件付き更新なので、同じ操作を 2 回配らない。
 */
export async function assistPollTx(tx: Tx, input: AssistPollInput): Promise<AssistPollOutcome> {
  const enabled = assistEnabled();
  const outcome: AssistPollOutcome = { enabled, skillOps: [], cancel: [], nextPollSeconds: null };
  // 無効なら新テーブルに触らない（030 未適用の DB でも poll を失敗させない）。
  if (!enabled) return outcome;
  if (!input.revoked && input.requestId) {
    const ctx = await loadContext(tx, input.requestId);
    const keys = await tx<{ id: string }[]>`
      SELECT id FROM support_sessions
      WHERE folder_request_id = ${input.requestId} AND helper_id = ${input.helperId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const key = keys[0];
    const session = key ? await selectSessionForUpdate(tx, key.id) : null;
    if (ctx && session && isOpenSession(session.status)) {
      await applyLiveness(tx, ctx, session, 'system:assist-poll');
      if (isOpenSession(session.status)) {
        outcome.nextPollSeconds = ASSIST_LIMITS.activePollSeconds;
        if (input.capable && input.sessionActive) {
          outcome.skillOps = await deliverQueuedTx(tx, ctx, session, input.helperId);
        }
      }
    }
  }
  outcome.cancel = await drainExecutionCancels(tx, input.helperId);
  return outcome;
}

async function deliverQueuedTx(
  tx: Tx,
  ctx: RequestContext,
  session: SessionRow,
  helperId: string,
): Promise<SignableSkillRun[]> {
  const rows = await tx<ExecutionRow[]>`
    UPDATE assist_executions
    SET status = 'delivered', delivered_at = now()
    WHERE support_session_id = ${session.id}
      AND helper_id = ${helperId}
      AND status = 'queued'
      AND stop_requested_at IS NULL
      AND expires_at > now()
    RETURNING *
  `;
  return rows.map((row) => {
    const skill = findAssistSkill(row.skill_id);
    const isFolder = skill?.targetKind === 'folder';
    return {
      canon: SKILL_RUN_CANON,
      opId: row.id,
      requestId: ctx.id,
      supportSessionId: session.id,
      proposalId: row.proposal_id,
      stepSeq: row.step_seq,
      role: row.role,
      sid: session.sid ?? '',
      sessionId: session.windows_session_id ?? -1,
      machineGuid: session.machine_guid ?? '',
      operation: SKILL_RUN_OPERATION,
      skillId: row.skill_id,
      skillVersion: row.skill_version,
      contentHash: row.content_hash,
      scriptHash: row.script_hash,
      paramsJson: canonicalParamsJson(row.params),
      // 実パスは送らない。種別と相対セグメントからヘルパーが解決する（§4）。
      targetRoot: isFolder ? ctx.consent_root : null,
      targetSegments: isFolder ? ctx.consent_segments : [],
      startNonce: row.start_nonce,
      expiresAt: row.expires_at.toISOString(),
      maxSeconds: row.max_seconds,
      maxOutputBytes: row.max_output_bytes,
    };
  });
}

// ── /start ───────────────────────────────────────────────────────

export type StartOutcome =
  | { kind: 'started'; deadlineAt: Date }
  | { kind: 'rejected'; reason: StartRejectCode }
  | { kind: 'missing' };

async function selectExecutionForUpdate(tx: Tx, id: string): Promise<ExecutionRow | null> {
  const rows = await tx<ExecutionRow[]>`
    SELECT e.*, (e.expires_at <= now()) AS op_expired,
      (e.deadline_at IS NOT NULL AND e.deadline_at <= now()) AS run_overdue
    FROM assist_executions e
    WHERE e.id = ${id}
    FOR UPDATE OF e
  `;
  return rows[0] ?? null;
}

const HELPER_ACTOR = 'system:assist-helper';

function rejectCodeForSession(session: SessionRow): StartRejectCode {
  switch (session.end_reason) {
    case 'assignee_changed':
      return 'ASSIGNEE_CHANGED';
    case 'sid_mismatch':
      return 'SID_MISMATCH';
    case 'session_changed':
      return 'SESSION_MISMATCH';
    case 'device_mismatch':
      return 'DEVICE_MISMATCH';
    case 'expired':
    case 'execution_expired':
      return 'OP_EXPIRED';
    default:
      return 'SESSION_ENDED';
  }
}

/**
 * 実行直前の再検証（§6）。応答が started でなければヘルパーは実行しない。
 * 同じトランザクションで同意・承認・担当・SID・セッション・期限・nonce を確かめて executing へ進める。
 */
export async function startExecutionTx(
  tx: Tx,
  helperId: string,
  opId: string,
  body: StartBody,
): Promise<StartOutcome> {
  const keys = await tx<{ support_session_id: string; proposal_id: string }[]>`
    SELECT support_session_id, proposal_id FROM assist_executions
    WHERE id = ${opId} AND helper_id = ${helperId}
  `;
  const key = keys[0];
  if (!key) return { kind: 'missing' };
  const locked = await lockSession(tx, key.support_session_id);
  if (!locked) return { kind: 'missing' };
  const { ctx, session } = locked;
  const proposal = await selectProposalForUpdate(tx, key.proposal_id);
  const execution = await selectExecutionForUpdate(tx, opId);
  if (!proposal || !execution) return { kind: 'missing' };

  // 既に開始済みの再送は状態を変えずに拒否する（nonce は 1 回限り）。
  if (execution.start_nonce_consumed_at) return { kind: 'rejected', reason: 'NONCE_CONSUMED' };

  const reject = async (
    reason: StartRejectCode,
    stop?: SessionEndReason,
  ): Promise<StartOutcome> => {
    await tx`
      UPDATE assist_executions
      SET status = CASE WHEN status = 'delivered' THEN 'rejected_at_start' ELSE status END,
          stop_outcome = COALESCE(stop_outcome, 'not_running'),
          stopped_at = COALESCE(stopped_at, now())
      WHERE id = ${opId}
    `;
    await sessionAudit(tx, 'support_session.start_rejected', session, HELPER_ACTOR, {
      opId,
      skillId: execution.skill_id,
      reason,
    });
    if (stop && isOpenSession(session.status)) {
      await stopSessionTx(tx, ctx, session, stop, HELPER_ACTOR);
    }
    return { kind: 'rejected', reason };
  };

  if (execution.status !== 'delivered') return reject('OP_NOT_DELIVERED');

  // 束縛と期限（違反ならセッションごと止める）。
  await applyLiveness(tx, ctx, session, HELPER_ACTOR);
  if (!isOpenSession(session.status)) return reject(rejectCodeForSession(session));
  if (execution.stop_requested_at) return reject('SESSION_ENDED');
  if (execution.op_expired) return reject('OP_EXPIRED', 'execution_expired');

  if (body.actorSid !== session.sid) {
    await endRequestTx(tx, ctx, 'sid_mismatch', HELPER_ACTOR);
    await reload(tx, session);
    return reject('SID_MISMATCH');
  }
  if (body.sessionId !== session.windows_session_id) {
    await endRequestTx(tx, ctx, 'session_changed', HELPER_ACTOR);
    await reload(tx, session);
    return reject('SESSION_MISMATCH');
  }
  if (body.machineGuid.toLowerCase() !== (session.machine_guid ?? '').toLowerCase()) {
    await endRequestTx(tx, ctx, 'device_mismatch', HELPER_ACTOR);
    await reload(tx, session);
    return reject('DEVICE_MISMATCH');
  }
  if (ctx.helper_session_state !== 'active') {
    return reject('SESSION_NOT_ACTIVE', 'session_not_active');
  }
  if (body.startNonce !== execution.start_nonce) {
    return reject('NONCE_MISMATCH', 'binding_changed');
  }
  if (body.scriptHash !== execution.script_hash) {
    return reject('SCRIPT_HASH_MISMATCH', 'binding_changed');
  }

  // 承認（Y の後に束縛値が変われば無効。§5）。
  const requiredProposalStatus = execution.role === 'main' ? 'approved' : 'verifying';
  if (proposal.status !== requiredProposalStatus || proposal.decision !== 'Y') {
    return reject('APPROVAL_INVALID', 'binding_changed');
  }
  const validity = await approvalStillValid(tx, ctx, session, proposal);
  if (validity === 'consent') return reject('CONSENT_INVALID', 'binding_changed');
  if (validity === 'skill') return reject('SKILL_NOT_APPROVED', 'binding_changed');
  if (validity === 'approval') return reject('APPROVAL_INVALID', 'binding_changed');

  const started = await tx<{ deadline_at: Date }[]>`
    UPDATE assist_executions
    SET status = 'executing', started_at = now(), start_nonce_consumed_at = now(),
        deadline_at = now() + ((max_seconds + ${ASSIST_LIMITS.runGraceSeconds}::int)
          * interval '1 second')
    WHERE id = ${opId} AND status = 'delivered' AND start_nonce_consumed_at IS NULL
    RETURNING deadline_at
  `;
  const row = started[0];
  if (!row) return { kind: 'rejected', reason: 'NONCE_CONSUMED' };
  if (execution.role === 'main') {
    await tx`UPDATE assist_proposals SET status = 'executing' WHERE id = ${proposal.id}`;
    await setSessionStatus(tx, session, 'executing');
  }
  await sessionAudit(tx, 'support_session.start', session, HELPER_ACTOR, {
    opId,
    proposalId: proposal.id,
    skillId: execution.skill_id,
    role: execution.role,
    effect: proposal.effect,
  });
  return { kind: 'started', deadlineAt: row.deadline_at };
}

// ── 結果 ─────────────────────────────────────────────────────────

export type ResultOutcome =
  | { kind: 'accepted' }
  | { kind: 'not_accepted'; reason: string }
  | { kind: 'missing' };

const COMMON_CODES = new Set<string>([...HELPER_FAILURE_CODES, ...HELPER_REJECT_CODES]);

function isAllowedFailureCode(code: string): boolean {
  return COMMON_CODES.has(code);
}

/**
 * 停止の報告を記録する（§10）。ヘルパー自身が kill した場合は停止要求がなくても残す。
 * 止まったと分かれば未確認を解消し、実行していないと分かれば変更の可能性も取り消す。
 */
async function recordStopReport(tx: Tx, execution: ExecutionRow, body: SkillResultBody) {
  const notRun = body.status === 'rejected';
  // 動いて ok を返した実行の not_running は、未実行ではなく「停止の前に完了」。
  const reported =
    body.status === 'ok' && body.stopOutcome === 'not_running'
      ? 'completed_before_stop'
      : body.stopOutcome;
  const outcome = notRun
    ? 'not_running'
    : (reported ?? (execution.stop_requested_at ? 'stop_unconfirmed' : null));
  if (!outcome) return;
  const stopped = outcome === 'stopped' || outcome === 'not_running';
  const settled = stopped || outcome === 'completed_before_stop';
  await tx`
    UPDATE assist_executions
    SET stop_outcome = ${outcome},
        stopped_at = CASE WHEN ${stopped} THEN now() ELSE stopped_at END,
        partial_effect = CASE
          WHEN ${notRun} THEN NULL
          WHEN ${settled} THEN NULLIF(partial_effect - 'STOP_UNCONFIRMED', '[]'::jsonb)
          ELSE partial_effect
        END
    WHERE id = ${execution.id}
  `;
}

async function mergePartialEffect(tx: Tx, executionId: string, codes: readonly string[]) {
  if (codes.length === 0) return;
  await tx`
    UPDATE assist_executions
    SET partial_effect = (
      SELECT jsonb_agg(DISTINCT value)
      FROM jsonb_array_elements(COALESCE(partial_effect, '[]'::jsonb) || ${jsonbValue([...codes])}) AS value
    )
    WHERE id = ${executionId}
  `;
}

/**
 * ヘルパーの結果報告（§7）。
 * real 以外は呼び出し側（ルート）が本番で拒否する。本番以外で記録しても証拠にしない。
 * 成功はサーバの固定条件だけで判定し、欠落・評価不能・改変は成功にしない。
 */
export async function recordResultTx(
  tx: Tx,
  helperId: string,
  opId: string,
  body: SkillResultBody,
): Promise<ResultOutcome> {
  const keys = await tx<{ support_session_id: string; proposal_id: string }[]>`
    SELECT support_session_id, proposal_id FROM assist_executions
    WHERE id = ${opId} AND helper_id = ${helperId}
  `;
  const key = keys[0];
  if (!key) return { kind: 'missing' };
  const locked = await lockSession(tx, key.support_session_id);
  if (!locked) return { kind: 'missing' };
  const { ctx, session } = locked;
  const proposal = await selectProposalForUpdate(tx, key.proposal_id);
  let execution = await selectExecutionForUpdate(tx, opId);
  if (!proposal || !execution) return { kind: 'missing' };
  // 以降のクロージャから参照するので、絞り込み済みの値として持つ。
  let current: ExecutionRow = execution;

  const audit = (action: string, extra: Record<string, unknown>) =>
    sessionAudit(tx, action, session, HELPER_ACTOR, {
      opId,
      proposalId: proposal.id,
      skillId: current.skill_id,
      role: current.role,
      executionMode: body.executionMode,
      resultCode: body.resultCode,
      selfReported: true,
      ...extra,
    });
  const notAccepted = async (reason: string): Promise<ResultOutcome> => {
    await audit('support_session.result_not_accepted', { reason });
    return { kind: 'not_accepted', reason };
  };

  // 二重報告は最初の記録を上書きしない。
  if (current.result_received_at) return notAccepted('DUPLICATE');

  const output = normalizeSkillOutput(current.skill_id, body.output);
  const store = async (fields: {
    status: string;
    evidence: boolean;
    late: boolean;
    resultCode: string;
    verifyOk?: boolean | null;
    verifyReason?: string | null;
  }) => {
    await tx`
      UPDATE assist_executions
      SET status = ${fields.status},
          execution_mode = ${body.executionMode},
          result_source = ${body.executionMode === 'real' ? 'helper_token' : 'unverified_report'},
          actor_sid = ${body.actorSid},
          result_status = ${body.status},
          result_code = ${fields.resultCode},
          exit_code = ${body.exitCode},
          reported_started_at = ${body.startedAt},
          reported_finished_at = ${body.finishedAt},
          elapsed_ms = ${body.elapsedMs},
          normalized_output = ${output === null ? null : jsonbValue(output)},
          evidence = ${fields.evidence},
          verify_ok = ${fields.verifyOk ?? null},
          verify_reason = ${fields.verifyReason ?? null},
          late_result = ${fields.late},
          result_received_at = now()
      WHERE id = ${opId}
    `;
    // 実行していない申告には変更の報告を付けない。
    if (body.status !== 'rejected') await mergePartialEffect(tx, opId, body.partialEffect ?? []);
    await recordStopReport(tx, current, body);
  };

  // 実行していないという申告（署名不正、/start の応答の喪失など）。証拠にならず、次へ進まない。
  // /start の応答を失うとサーバは executing のままで、停止後に届くこともある。
  if (body.status === 'rejected') {
    const reportable = ['delivered', 'executing', 'timed_out', 'expired', 'rejected_at_start'];
    if (!reportable.includes(current.status)) return notAccepted('NOT_DELIVERED');
    await store({
      status: 'rejected_by_helper',
      evidence: false,
      late: !isOpenSession(session.status),
      resultCode: body.resultCode,
    });
    await audit('support_session.result', { result: 'rejected_by_helper' });
    if (isOpenSession(session.status)) {
      await stopSessionTx(tx, ctx, session, 'execution_failed', HELPER_ACTOR);
    }
    return { kind: 'not_accepted', reason: 'REJECTED_BY_HELPER' };
  }

  // /start を通っていない結果は実行の証拠にならない（内容も保存しない）。
  if (!current.started_at) return notAccepted('NOT_STARTED');

  // 遅延結果: 保存するが次へ進めない（§10）。
  await applyLiveness(tx, ctx, session, HELPER_ACTOR);
  // 期限切れや停止を発火させた場合は状態と stop_requested_at が変わるので読み直す。
  execution = await selectExecutionForUpdate(tx, opId);
  if (!execution) return { kind: 'missing' };
  current = execution;
  const late =
    !isOpenSession(session.status) ||
    current.status !== 'executing' ||
    Boolean(current.stop_requested_at);
  if (late) {
    await store({
      status: current.status === 'executing' ? 'failed' : current.status,
      evidence: false,
      late: true,
      resultCode: body.resultCode,
    });
    // 遅れて届いても動いた実行なら、変更の可能性を隠さない。
    if (current.role === 'main') await markModifyUnknown(tx, current, proposal);
    await audit('support_session.late_result', { result: body.status });
    return { kind: 'not_accepted', reason: 'LATE_RESULT' };
  }

  // 本番以外で記録を許した mock / manual。出所を確認できないので次へ進めない。
  if (body.executionMode !== 'real') {
    await store({
      status: 'failed',
      evidence: false,
      late: false,
      resultCode: body.resultCode,
      verifyOk: null,
      verifyReason: 'not_real',
    });
    await audit('support_session.result', { result: 'not_real' });
    await markModifyUnknown(tx, current, proposal);
    await stopSessionTx(tx, ctx, session, 'unverifiable', HELPER_ACTOR);
    return { kind: 'not_accepted', reason: 'NOT_REAL' };
  }

  // OS の実行主体（自己申告）が束縛と違う。改ざんの可能性を固定コードで示し、報告値は残す。
  const identityMismatch =
    body.actorSid !== session.sid
      ? ({ endReason: 'sid_mismatch', reason: 'SID_MISMATCH' } as const)
      : body.sessionId !== session.windows_session_id
        ? ({ endReason: 'session_changed', reason: 'SESSION_MISMATCH' } as const)
        : null;
  if (identityMismatch) {
    await store({
      status: 'failed',
      evidence: false,
      late: false,
      resultCode: 'RESULT_MISMATCH',
      verifyOk: null,
      verifyReason: identityMismatch.endReason,
    });
    await markModifyUnknown(tx, current, proposal);
    await endRequestTx(tx, ctx, identityMismatch.endReason, HELPER_ACTOR);
    await reload(tx, session);
    await audit('support_session.result', { result: identityMismatch.endReason });
    return { kind: 'not_accepted', reason: identityMismatch.reason };
  }

  // 改変（op と別物の報告）。ハッシュ不一致で検証を通さない（resolve の取込処理は使わない）。
  const successCode = ASSIST_SKILL_SUCCESS_CODES[current.skill_id];
  const tampered =
    body.skillId !== current.skill_id ||
    body.skillVersion !== current.skill_version ||
    body.scriptHash !== current.script_hash ||
    (body.status === 'ok' && body.exitCode !== 0) ||
    (body.status === 'ok' && body.resultCode !== 'OK' && body.resultCode !== successCode) ||
    (body.status !== 'ok' && !isAllowedFailureCode(body.resultCode));
  if (tampered) {
    await store({
      status: 'failed',
      evidence: false,
      late: false,
      resultCode: 'RESULT_MISMATCH',
      verifyOk: null,
      verifyReason: 'result_mismatch',
    });
    await audit('support_session.result', { result: 'result_mismatch' });
    await markModifyUnknown(tx, current, proposal);
    await stopSessionTx(tx, ctx, session, 'result_mismatch', HELPER_ACTOR);
    return { kind: 'not_accepted', reason: 'RESULT_MISMATCH' };
  }

  // 実行の失敗・タイムアウト・中断（§8 の停止条件）。
  if (body.status !== 'ok') {
    await store({
      status: 'failed',
      evidence: true,
      late: false,
      resultCode: body.resultCode,
      verifyOk: false,
      verifyReason: 'execution_failed',
    });
    await audit('support_session.result', { result: body.status });
    await markModifyUnknown(tx, current, proposal);
    await tx`
      UPDATE assist_proposals SET status = 'failed', verify_ok = false,
        verify_reason = 'execution_failed'
      WHERE id = ${proposal.id}
    `;
    await stopSessionTx(tx, ctx, session, 'execution_failed', HELPER_ACTOR);
    return { kind: 'accepted' };
  }

  // 成功はサーバの固定条件で判定する（§7）。
  const evaluation = evaluateVerify(current.check_definition, output);
  const stored = {
    status: 'completed',
    evidence: true,
    late: false,
    resultCode: successCode ?? body.resultCode,
    verifyOk: evaluation.ok,
    verifyReason: evaluation.reason ?? null,
  };
  await store(stored);
  await audit('support_session.result', { result: 'ok', verifyOk: evaluation.ok });

  if (evaluation.ok !== true) {
    await markModifyUnknown(tx, current, proposal);
    const reason = evaluation.ok === false ? 'verify_failed' : 'unverifiable';
    await tx`
      UPDATE assist_proposals SET status = 'failed', verify_ok = ${evaluation.ok},
        verify_reason = ${reason}
      WHERE id = ${proposal.id}
    `;
    await stopSessionTx(tx, ctx, session, reason, HELPER_ACTOR);
    return { kind: 'accepted' };
  }

  // 次の確認操作（承認時に提示したものだけ。提案の枠を消費しない。§8）。
  const nextIndex = current.role === 'main' ? 0 : current.verify_index + 1;
  if (nextIndex < proposal.verify.ops.length) {
    await enqueueExecutionTx(tx, ctx, session, proposal, 'verify', nextIndex);
    await tx`UPDATE assist_proposals SET status = 'verifying' WHERE id = ${proposal.id}`;
    await setSessionStatus(tx, session, 'verifying');
    return { kind: 'accepted' };
  }

  await tx`
    UPDATE assist_proposals SET status = 'succeeded', verify_ok = true WHERE id = ${proposal.id}
  `;
  await afterProposalSucceeded(tx, ctx, session, proposal);
  return { kind: 'accepted' };
}

/** 変更系で成功を確認できなかったときは、変更が生じた可能性を隠さない（§10）。 */
async function markModifyUnknown(
  tx: Tx,
  execution: ExecutionRow,
  proposal: ProposalRow,
): Promise<void> {
  if (proposal.effect !== 'modify') return;
  await mergePartialEffect(tx, execution.id, ['POSSIBLE_CHANGE']);
}

async function afterProposalSucceeded(
  tx: Tx,
  ctx: RequestContext,
  session: SessionRow,
  proposal: ProposalRow,
): Promise<void> {
  const mains = await tx<
    {
      step_seq: number;
      skill_id: string;
      params: unknown;
      normalized_output: unknown;
    }[]
  >`
    SELECT step_seq, skill_id, params, normalized_output FROM assist_executions
    WHERE support_session_id = ${session.id} AND role = 'main' AND status = 'completed'
    ORDER BY step_seq
  `;
  const fingerprint = (row: (typeof mains)[number]) =>
    progressFingerprint(row.skill_id, row.params, row.normalized_output);
  const current = mains.find((row) => row.step_seq === proposal.step_seq);
  const previous = mains.filter((row) => row.step_seq !== proposal.step_seq).map(fingerprint);
  if (current && isNoProgress(previous, fingerprint(current))) {
    await stopSessionTx(tx, ctx, session, 'no_progress', HELPER_ACTOR);
    return;
  }
  await setSessionStatus(
    tx,
    session,
    proposal.effect === 'modify' ? 'resolve_confirm' : 'awaiting_next',
  );
}
