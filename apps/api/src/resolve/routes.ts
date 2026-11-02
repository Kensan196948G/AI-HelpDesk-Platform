import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { canonicalEmail } from '../auth/email-alias.js';
import { authenticateUi } from '../auth/ui.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { stableStringify } from '../domain/audit.js';
import { redactPII } from '../domain/pii.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { appendAudit } from '../lib/audit-log.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import { isResolveAdmin } from './admin.js';
import {
  type AdminApprovalPayload,
  type ApprovalChallenge,
  approvalHashMatches,
  buildAdminApprovalPayload,
  buildApprovalPayload,
  computeAdminApprovalHash,
  computeApprovalHash,
  newNonce,
} from './approval.js';
import { type ExecutionSource, executionSourceOf, resultShapeOk } from './execution-source.js';
import {
  escalationReasonForDecision,
  type Proposal,
  type ProposalHistoryEntry,
  proposeNext,
} from './proposer.js';
import {
  listApprovedSkills,
  normalizeJsonValue,
  type SkillRecord,
  type SkillRow,
  toSkillRecord,
  validateParams,
} from './skills.js';
import {
  evaluateFollowupVerify,
  evaluateVerify,
  type FollowupVerifyOutcome,
  type VerifyOutcome,
} from './verify.js';

const SESSION_TTL_SQL = sql`now() + interval '30 minutes'`;
const SESSION_MAX_STEPS = 6;
const STEP_APPROVAL_TTL_SQL = sql`now() + interval '5 minutes'`;
/** リスク 4 以上の管理者承認の有効期限（依頼者側の 5 分と揃える）。 */
const ADMIN_APPROVAL_TTL_SQL = sql`now() + interval '5 minutes'`;
/** Skill に timeoutSec が無い場合の実行期限（秒）。 */
const DEFAULT_STEP_TIMEOUT_SEC = 60;
const TERMINAL_SESSION_STATUSES = new Set(['resolved', 'escalated', 'stopped', 'expired']);

const SessionIdParamsSchema = z.object({ id: z.string().uuid() });
const StepIdParamsSchema = z.object({ id: z.string().uuid() });
const CreateSessionSchema = z.object({
  caseId: z.string().trim().min(1).max(120),
  deviceId: z.string().trim().min(1).max(120),
});
const ApproveSchema = z.object({
  decision: z.enum(['Y', 'N']),
  approvalHash: z.string().trim().max(128).optional(),
});
const ContinueSchema = z.object({ decision: z.enum(['Y', 'N']) });
/** IT 管理者承認（リスク 4 以上）。利用者側とは別 payload / 別ハッシュ。 */
const AdminApproveSchema = z.object({
  decision: z.enum(['Y', 'N']),
  approvalHash: z.string().trim().max(128).optional(),
});
const ManualCloseSchema = z.object({ reason: z.string().trim().max(500).optional() }).default({});
const DeviceStatusQuerySchema = z.object({ deviceId: z.string().trim().min(1).max(120) });

interface SessionRow {
  id: string;
  user_email: string;
  case_id: string;
  device_id: string;
  status: string;
  step_count: number;
  max_steps: number;
  started_at: Date | string;
  expires_at: Date | string;
  last_summary: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

interface StepRow {
  id: string;
  session_id: string;
  seq: number;
  skill_id: string;
  skill_version: string;
  skill_content_hash: string;
  params: unknown;
  rationale: string;
  risk_level: number;
  status: string;
  nonce: string;
  approval_hash: string | null;
  admin_approval_hash: string | null;
  approved_by: string | null;
  approved_at: Date | string | null;
  command_id: string | null;
  result_summary: unknown;
  result_full: unknown;
  result_ai: unknown;
  /** サーバが評価した verify の結果（migration 017）。ok=null は評価不能。 */
  verify_result: unknown;
  /** 親ステップ ID（migration 018）。script 形態 verify の追撃実行だけに入る。 */
  verify_for_step_id: string | null;
  error: string | null;
  created_at: Date | string;
  executed_at: Date | string | null;
  approval_expires_at: Date | string;
  timeout_sec: number | null;
  deadline_at: Date | string | null;
  admin_nonce: string | null;
  admin_expires_at: Date | string | null;
  admin_approved_by: string | null;
  admin_approved_at: Date | string | null;
  sk_title: string | null;
  sk_summary: string | null;
  sk_symptoms: unknown;
  sk_os: unknown;
  sk_requires: unknown;
  sk_params_schema: unknown;
  sk_script_path: string | null;
  sk_args: unknown;
  sk_verify: unknown;
  sk_rollback: unknown;
  sk_timeout_sec: number | null;
  sk_result_schema: unknown;
  sk_output_policy: unknown;
}

interface CommandRow {
  id: string;
  op_id: string;
  params: unknown;
  status: string;
  device_id: string | null;
  skill_id: string | null;
  skill_version: string | null;
  session_id: string | null;
  step_id: string | null;
  created_at: Date | string;
}

interface FailureResult {
  failure: ApiError;
}

function isFailure(value: unknown): value is FailureResult {
  return typeof value === 'object' && value !== null && 'failure' in value;
}

function requireEmail(request: FastifyRequest): string {
  if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
  return request.uiEmail;
}

function enforceRateLimit(key: string, limit: number, message: string): void {
  if (!checkRateLimit(key, limit, 60_000)) {
    throw new ApiError(429, 'RATE_LIMITED', message);
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return toIso(value);
}

function jsonObjectOrNull(value: unknown): Record<string, unknown> | null {
  const normalized = normalizeJsonValue(value);
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    return normalized as Record<string, unknown>;
  }
  return null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return jsonObjectOrNull(value) ?? {};
}

function jsonArray(value: unknown): unknown[] {
  const normalized = normalizeJsonValue(value);
  return Array.isArray(normalized) ? normalized : [];
}

function stringArray(value: unknown): string[] {
  const normalized = normalizeJsonValue(value);
  if (Array.isArray(normalized)) return normalized.map((item) => String(item));
  return [];
}

function sessionExpired(session: SessionRow): boolean {
  const expiresAt = new Date(session.expires_at).getTime();
  return !Number.isFinite(expiresAt) || Date.now() > expiresAt;
}

function sessionDto(session: SessionRow) {
  return {
    id: session.id,
    status: session.status,
    caseId: session.case_id,
    deviceId: session.device_id,
    stepCount: Number(session.step_count),
    maxSteps: Number(session.max_steps),
    startedAt: toIso(session.started_at),
    expiresAt: toIso(session.expires_at),
    lastSummary: jsonObjectOrNull(session.last_summary),
    // Phase C: ステップ実行の既定タイムアウト（Skill 側の timeoutSec が優先）。
    stepTimeoutSec: DEFAULT_STEP_TIMEOUT_SEC,
    createdAt: toIso(session.created_at),
    updatedAt: toIso(session.updated_at),
  };
}

function skillFromStep(row: StepRow): SkillRecord | null {
  if (!row.sk_title) return null;
  return {
    id: row.skill_id,
    version: row.skill_version,
    title: row.sk_title,
    summary: row.sk_summary ?? '',
    symptoms: stringArray(row.sk_symptoms),
    os: Array.isArray(row.sk_os) ? row.sk_os.map((item) => String(item)) : stringArray(row.sk_os),
    riskLevel: Number(row.risk_level),
    requires: jsonObject(row.sk_requires),
    paramsSchema: jsonObject(row.sk_params_schema),
    scriptPath: row.sk_script_path ?? '',
    args: jsonArray(row.sk_args),
    verify: normalizeJsonValue(row.sk_verify),
    rollback: normalizeJsonValue(row.sk_rollback),
    timeoutSec: Number(row.sk_timeout_sec ?? 60),
    resultSchema: normalizeJsonValue(row.sk_result_schema),
    outputPolicy: normalizeJsonValue(row.sk_output_policy),
    status: 'approved',
    contentHash: row.skill_content_hash,
    approvedBy: null,
    approvedAt: null,
    createdAt: '',
  };
}

function approvalChallengeFor(row: StepRow, session: SessionRow): ApprovalChallenge | null {
  if (row.status !== 'proposed') return null;
  const payload = buildApprovalPayload({
    sessionId: session.id,
    stepId: row.id,
    seq: Number(row.seq),
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    skillContentHash: row.skill_content_hash,
    params: jsonObject(row.params),
    deviceId: session.device_id,
    userEmail: session.user_email,
    riskLevel: Number(row.risk_level),
    nonce: row.nonce,
    expiresAt: row.approval_expires_at,
  });
  return { payload, nonce: payload.nonce, expiresAt: payload.expiresAt };
}

/**
 * リスク 4 以上の管理者承認 payload を step / session から組み立てる。
 * 依頼者向けの承認 payload（12 キー）とは分離し、既存画面のハッシュ計算を壊さない。
 */
function adminApprovalPayloadFor(
  row: StepRow,
  session: SessionRow,
  adminEmail: string,
): AdminApprovalPayload | null {
  if (row.status !== 'proposed' || Number(row.risk_level) < 4) return null;
  if (!row.admin_nonce || !row.admin_expires_at) return null;
  return buildAdminApprovalPayload({
    stepId: row.id,
    sessionId: session.id,
    seq: Number(row.seq),
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    skillContentHash: row.skill_content_hash,
    params: jsonObject(row.params),
    deviceId: session.device_id,
    userEmail: session.user_email,
    riskLevel: Number(row.risk_level),
    adminEmail,
    nonce: row.admin_nonce,
    expiresAt: row.admin_expires_at,
  });
}

/** 端末エージェントの最終応答時刻（device_tokens.last_used_at の最大）。 */
async function deviceLastSeenAt(email: string, deviceId: string): Promise<number | null> {
  const rows = await sql<{ last_seen: Date | string | null }[]>`
    SELECT max(last_used_at) AS last_seen
    FROM device_tokens
    WHERE user_email = ${email} AND device_id = ${deviceId} AND revoked_at IS NULL
  `;
  const raw = rows[0]?.last_seen ?? null;
  if (!raw) return null;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/** 読み取り Skill を受け取る standard エージェントの最終応答。admin だけでは実行できない。 */
async function standardAgentLastSeenAt(email: string, deviceId: string): Promise<number | null> {
  const rows = await sql<{ last_seen: Date | string | null }[]>`
    SELECT max(last_used_at) AS last_seen
    FROM device_tokens
    WHERE user_email = ${email} AND device_id = ${deviceId}
      AND revoked_at IS NULL AND privilege = 'standard'
  `;
  const raw = rows[0]?.last_seen ?? null;
  if (!raw) return null;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/** 設計 §4-3「端末オフライン（2 分応答なし）」。最終応答が無い端末は offline 扱い。 */
function isDeviceOnline(lastSeenAt: number | null): boolean {
  if (lastSeenAt === null) return false;
  return Date.now() - lastSeenAt <= config.RESOLVE_DEVICE_OFFLINE_SEC * 1000;
}

/**
 * outputPolicy.fieldsToAi を厳密に適用する（設計 §6 / §8-3）。
 * - outputPolicy 欠落 / fieldsToAi が配列でない / normalized が object でない → 何も渡さない。
 * - 宣言されたキーだけをサブツリーごと通す（未知・未宣言キーは落とす）。
 */
function applyFieldsToAi(
  normalized: unknown,
  outputPolicy: unknown,
): Record<string, unknown> | null {
  const policy = jsonObjectOrNull(outputPolicy);
  const fields = policy?.fieldsToAi;
  if (!Array.isArray(fields)) return null;
  const record = jsonObjectOrNull(normalized);
  if (!record) return null;
  const allowed = new Set(fields.filter((field): field is string => typeof field === 'string'));
  const filtered: Record<string, unknown> = {};
  for (const field of allowed) {
    if (Object.hasOwn(record, field)) {
      filtered[field] = record[field];
    }
  }
  return filtered;
}

/** 直近の done ステップの result_ai（fieldsToAi 適用済み）を次提案の材料にする。 */
async function loadLastResultAi(sessionId: string): Promise<unknown | null> {
  const rows = await sql<{ result_ai: unknown }[]>`
    SELECT result_ai FROM resolution_steps
    WHERE session_id = ${sessionId} AND status = 'done' AND result_ai IS NOT NULL
    ORDER BY seq DESC
    LIMIT 1
  `;
  return rows[0]?.result_ai ?? null;
}

/**
 * AI に渡す「直近の verify 評価」を選ぶ。
 *
 * script 形態 verify の追撃ステップ（verify_for_step_id あり）は、自身の verify を
 * 持たない（no_verify_definition）代わりに、**親ステップの verify_result が更新**される。
 * 追撃ステップの値をそのまま渡すと、AI は「評価不能」しか見られず再提案できない。
 */
export function effectiveVerifyForAi(
  last: { verify_result: unknown; verify_for_step_id: string | null } | undefined,
  parent: { verify_result: unknown } | undefined,
): unknown | null {
  if (!last) return null;
  if (last.verify_for_step_id && parent) return parent.verify_result ?? last.verify_result;
  return last.verify_result ?? null;
}

/** 直近の done ステップの verify 評価結果を、AI の終了宣言の材料として読む。 */
async function loadLastVerifyResult(sessionId: string): Promise<unknown | null> {
  const rows = await sql<
    { verify_result: unknown; verify_for_step_id: string | null; parent_verify_result: unknown }[]
  >`
    SELECT st.verify_result, st.verify_for_step_id, parent.verify_result AS parent_verify_result
    FROM resolution_steps st
    LEFT JOIN resolution_steps parent ON parent.id = st.verify_for_step_id
    WHERE st.session_id = ${sessionId} AND st.status = 'done'
    ORDER BY st.seq DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return effectiveVerifyForAi(row, { verify_result: row.parent_verify_result });
}

/** result_summary の出所。結果が無いステップは null、申告の無い古い結果は unknown。 */
function resultExecutionSource(row: StepRow): ExecutionSource | null {
  const summary = jsonObjectOrNull(row.result_summary);
  return summary ? executionSourceOf(summary) : null;
}

function stepDto(row: StepRow, session: SessionRow) {
  const skill = skillFromStep(row);
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: Number(row.seq),
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    skill: skill
      ? {
          id: skill.id,
          version: skill.version,
          title: skill.title,
          summary: skill.summary,
          script: skill.scriptPath,
          args: skill.args,
          riskLevel: skill.riskLevel,
          paramsSchema: skill.paramsSchema,
          requires: skill.requires,
          verify: skill.verify,
          rollback: skill.rollback,
          resultSchema: skill.resultSchema,
          outputPolicy: skill.outputPolicy,
          timeoutSec: skill.timeoutSec,
          contentHash: skill.contentHash,
        }
      : null,
    params: jsonObject(row.params),
    rationale: row.rationale,
    riskLevel: Number(row.risk_level),
    status: row.status,
    approvalChallenge: approvalChallengeFor(row, session),
    commandId: row.command_id,
    resultSummary: jsonObjectOrNull(row.result_summary),
    // 結果の出所（endpoint_agent / mock / unknown）。結果が無ければ null。
    executionSource: resultExecutionSource(row),
    resultFull: jsonObjectOrNull(row.result_full),
    // fieldsToAi を適用した AI 入力用の結果（生ログは含めない）。
    resultAi: jsonObjectOrNull(row.result_ai),
    // サーバが評価した verify（ok=null は評価不能。成功と見なさない）。
    verifyResult: jsonObjectOrNull(row.verify_result),
    timeoutSec: row.timeout_sec === null ? DEFAULT_STEP_TIMEOUT_SEC : Number(row.timeout_sec),
    deadlineAt: toIsoOrNull(row.deadline_at),
    requiresAdminApproval: Number(row.risk_level) >= 4,
    adminApprovedBy: row.admin_approved_by,
    adminApprovedAt: toIsoOrNull(row.admin_approved_at),
    error: row.error,
    approvedBy: row.approved_by,
    approvedAt: toIsoOrNull(row.approved_at),
    executedAt: toIsoOrNull(row.executed_at),
    createdAt: toIso(row.created_at),
  };
}

function stepSummaryDto(row: StepRow) {
  return {
    id: row.id,
    seq: Number(row.seq),
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    skillTitle: row.sk_title ?? row.skill_id,
    riskLevel: Number(row.risk_level),
    status: row.status,
    commandId: row.command_id,
    resultSummary: jsonObjectOrNull(row.result_summary),
    executionSource: resultExecutionSource(row),
    verifyResult: jsonObjectOrNull(row.verify_result),
    error: row.error,
    createdAt: toIso(row.created_at),
    executedAt: toIsoOrNull(row.executed_at),
  };
}

function commandDto(row: CommandRow) {
  return {
    id: row.id,
    opId: row.op_id,
    params: jsonObject(row.params),
    status: row.status,
    deviceId: row.device_id,
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    sessionId: row.session_id,
    stepId: row.step_id,
    createdAt: toIso(row.created_at),
  };
}

/** 監査ログの追記。本文・PII は detail に含めない（設計 §13）。 */
async function appendResolveAudit(
  tx: any,
  input: {
    action: string;
    sessionId: string;
    actorEmail: string;
    stepId?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const users = await tx<{ id: string }[]>`
    SELECT id FROM users WHERE lower(email) = lower(${input.actorEmail}) LIMIT 1
  `;
  await appendAudit(tx, {
    actorId: users[0]?.id ?? null,
    action: input.action,
    targetType: 'resolution_session',
    targetId: input.sessionId,
    detail: {
      actorEmail: input.actorEmail,
      ...(input.stepId ? { stepId: input.stepId } : {}),
      ...(input.detail ?? {}),
    },
  });
}

interface OwnedCase {
  id: string;
  subject: string;
  body: string;
  source: 'prototype' | 'relational';
}

/**
 * caseId は本人のプロトタイプ状態（cowork.cases[]）を正とし、
 * リレーショナル cases に存在する場合は許容する（Lead 追補）。
 */
async function findOwnedCase(email: string, caseId: string): Promise<OwnedCase | null> {
  const stateRows = await sql<{ data: unknown }[]>`
    SELECT data FROM prototype_states
    WHERE user_email = ${email} AND name = 'cowork'
    LIMIT 1
  `;
  const state = jsonObjectOrNull(stateRows[0]?.data);
  for (const item of jsonArray(state?.cases)) {
    const record = jsonObjectOrNull(item);
    if (record && String(record.id ?? '') === caseId) {
      return {
        id: caseId,
        subject: typeof record.subject === 'string' ? record.subject : '',
        body: typeof record.body === 'string' ? record.body : '',
        source: 'prototype',
      };
    }
  }

  const rows = await sql<{ subject: string | null; body: string | null }[]>`
    SELECT c.subject, c.body
    FROM cases c
    JOIN users u ON u.id = c.requester_id
    WHERE c.id::text = ${caseId} AND lower(u.email) = lower(${email})
    LIMIT 1
  `;
  const row = rows[0];
  if (row) {
    return { id: caseId, subject: row.subject ?? '', body: row.body ?? '', source: 'relational' };
  }
  return null;
}

function caseText(ownedCase: OwnedCase | null): string {
  if (!ownedCase) return '';
  return `${ownedCase.subject}\n${ownedCase.body}`.slice(0, 8000);
}

async function loadSession(email: string, sessionId: string): Promise<SessionRow> {
  const rows = await sql<SessionRow[]>`
    SELECT * FROM resolution_sessions
    WHERE id = ${sessionId} AND user_email = ${email}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw notFound('解決セッションが見つかりません。');
  return row;
}

async function loadStepsForSession(sessionId: string): Promise<StepRow[]> {
  return sql<StepRow[]>`
    SELECT
      st.*,
      sk.title AS sk_title,
      sk.summary AS sk_summary,
      sk.symptoms AS sk_symptoms,
      sk.os AS sk_os,
      sk.requires AS sk_requires,
      sk.params_schema AS sk_params_schema,
      sk.script_path AS sk_script_path,
      sk.args AS sk_args,
      sk.verify AS sk_verify,
      sk.rollback AS sk_rollback,
      sk.timeout_sec AS sk_timeout_sec,
      sk.result_schema AS sk_result_schema,
      sk.output_policy AS sk_output_policy
    FROM resolution_steps st
    LEFT JOIN skills sk ON sk.id = st.skill_id AND sk.version = st.skill_version
    WHERE st.session_id = ${sessionId}
    ORDER BY st.seq ASC
  `;
}

async function loadStepAndSession(
  email: string,
  stepId: string,
): Promise<{ step: StepRow; session: SessionRow }> {
  const stepRows = await sql<StepRow[]>`
    SELECT
      st.*,
      sk.title AS sk_title,
      sk.summary AS sk_summary,
      sk.symptoms AS sk_symptoms,
      sk.os AS sk_os,
      sk.requires AS sk_requires,
      sk.params_schema AS sk_params_schema,
      sk.script_path AS sk_script_path,
      sk.args AS sk_args,
      sk.verify AS sk_verify,
      sk.rollback AS sk_rollback,
      sk.timeout_sec AS sk_timeout_sec,
      sk.result_schema AS sk_result_schema,
      sk.output_policy AS sk_output_policy
    FROM resolution_steps st
    LEFT JOIN skills sk ON sk.id = st.skill_id AND sk.version = st.skill_version
    WHERE st.id = ${stepId}
    LIMIT 1
  `;
  const step = stepRows[0];
  if (!step) throw notFound('ステップが見つかりません。');
  const session = await loadSession(email, step.session_id);
  return { step, session };
}

function skillForProposal(proposal: Proposal, skills: SkillRecord[]): SkillRecord {
  const skill = skills.find((candidate) => candidate.id === proposal.skillId);
  if (!skill)
    throw new ApiError(409, 'SKILL_NOT_ALLOWED', '提案された Skill は承認されていません。');
  // リスク 5 は「禁止（実行不可）」。承認済みカタログに入っていても実行させない。
  if (skill.riskLevel >= 5) {
    throw new ApiError(409, 'SKILL_RISK_FORBIDDEN', 'リスクレベル 5 の Skill は実行できません。');
  }
  return skill;
}

async function insertProposedStep(
  tx: any,
  session: SessionRow,
  proposal: Proposal,
  skill: SkillRecord,
  seq: number,
): Promise<string> {
  const nonce = newNonce();
  // リスク 4 以上は IT 管理者の承認が必要（設計 §4-3）。承認 payload は
  // 依頼者向けとは別 nonce / 期限で組み立てる。リスク 1-3 でも列は埋めるが使わない。
  const adminNonce = newNonce();
  const rows = await tx<{ id: string }[]>`
    INSERT INTO resolution_steps (
      session_id, seq, skill_id, skill_version, skill_content_hash, params, rationale,
      risk_level, status, nonce, approval_expires_at, admin_nonce, admin_expires_at
    ) VALUES (
      ${session.id}, ${seq}, ${skill.id}, ${skill.version}, ${skill.contentHash ?? 'sha256:unknown'},
      ${jsonbValue(proposal.params)}, ${proposal.rationale}, ${skill.riskLevel}, 'proposed',
      ${nonce}, ${STEP_APPROVAL_TTL_SQL}, ${adminNonce}, ${ADMIN_APPROVAL_TTL_SQL}
    )
    RETURNING id
  `;
  const stepId = rows[0]?.id;
  if (!stepId) throw new Error('resolution step insert failed');
  return stepId;
}

/**
 * 変更系（修復）Skill か。
 *
 * rollback の有無だけでは判定できない。Phase 2 で追加した読み取り専用の
 * `bitlocker.status` は「元に戻すものが無い」ことを説明するため rollback に
 * 説明文を持つ（script: null）。これを変更系と誤認すると、状態を読んだだけで
 * 「解決候補」になってしまう（2026-10-25 の実測で 16 件中 3 件がこれだった）。
 *
 * そのため **リスク 2 以上 かつ rollback 定義あり** を変更系とする。
 * 読み取り専用 5 件はすべてリスク 1、修復 4 件（spooler.restart / spooler.queue.purge /
 * service.start / temp.cleanup）はリスク 2 以上である。
 * なお dns.flush と defender.quickscan はリスク 1 のため、verify が通っても
 * 「解決」とは見なさない（状態を変えるが、問題の解決を意味しない）。
 */
export function isChangeSkillRow(
  row: { rollback: unknown; risk_level?: unknown } | undefined,
): boolean {
  if (!row) return false;
  const hasRollback = row.rollback !== null && row.rollback !== undefined;
  const riskLevel = typeof row.risk_level === 'number' ? row.risk_level : Number(row.risk_level);
  return hasRollback && Number.isFinite(riskLevel) && riskLevel >= 2;
}

/**
 * verify の評価対象を result_summary から取り出す。
 * verify.resultField は端末スクリプトが返す JSON のトップレベルキーなので、
 * result_summary.normalized のキーを優先しつつ、result_summary のトップレベル
 * （ok / exitCode 等）も見えるようにする（ドットパスは解釈しない）。
 */
function verifyTargetFromSummary(summary: Record<string, unknown>): unknown {
  const normalized = jsonObjectOrNull(summary.normalized);
  return normalized ? { ...summary, ...normalized } : summary;
}

/** verify.ok で停止したセッションか（last_summary.outcome === 'verified'）。 */
function isVerifiedSession(session: { last_summary: unknown }): boolean {
  return jsonObjectOrNull(session.last_summary)?.outcome === 'verified';
}

/**
 * verify の args に含まれる `{{name}}` を親ステップの params で埋める。
 * `service.start` の verify.args は `['-Service', '{{name}}']` のように
 * 親のパラメータを参照するため、追撃 enqueue 前に解決する。
 */
function fillParamTemplates(token: string, sourceParams: Record<string, unknown>): string {
  return token.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key: string) => {
    const value = sourceParams[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return match;
  });
}

/**
 * verify.args（PowerShell 形式のフラグ列）を params オブジェクトへ変換する。
 *
 * 例: `['-Service', 'Spooler']` → `{ service: 'Spooler' }`
 * - 先頭の `-` を除いて小文字化したキーに、次の要素を値として入れる。
 * - 値が無い・次の要素もフラグ・フラグ以外の要素がある場合は null（安全側で追撃しない）。
 */
function argsToParams(
  args: unknown,
  sourceParams: Record<string, unknown>,
): Record<string, unknown> | null {
  const list = normalizeJsonValue(args);
  if (!Array.isArray(list)) return {};
  const params: Record<string, unknown> = {};
  let index = 0;
  while (index < list.length) {
    const flag = list[index];
    if (typeof flag !== 'string') return null;
    const resolvedFlag = fillParamTemplates(flag, sourceParams);
    if (!resolvedFlag.startsWith('-')) return null;
    const key = resolvedFlag.replace(/^-+/, '').toLowerCase();
    if (!key) return null;
    const rawValue = list[index + 1];
    if (typeof rawValue !== 'string') return null;
    const value = fillParamTemplates(rawValue, sourceParams);
    // `-Flag -Next` のような値なしフラグは、この変換では扱わない。
    if (value.startsWith('-')) return null;
    params[key] = value;
    index += 2;
  }
  return params;
}

/**
 * 追撃ステップの結果を親ステップの verify_result へ反映する（Phase 6a）。
 *
 * - 親 Skill の verify.expect をサブセット一致で評価する。
 * - 承認後に Skill 定義が変わっていたら（content_hash 不一致）評価しない（fail-closed）。
 * - 評価できたら親の verify_result を更新し、監査 `resolution.verify_result` を残す。
 * - 追撃の追撃は作らない（この関数は enqueue を行わない）。
 */
async function applyVerifyFollowupOutcome(
  tx: any,
  input: {
    session: SessionRow;
    step: StepRow;
    summary: Record<string, unknown>;
    actorEmail: string;
  },
): Promise<FollowupVerifyOutcome | null> {
  const parentId = input.step.verify_for_step_id;
  if (!parentId) return null;
  const parentRows = await tx<StepRow[]>`
    SELECT * FROM resolution_steps WHERE id = ${parentId} FOR UPDATE
  `;
  const parent = parentRows[0];
  if (!parent) return null;
  const skillRows = await tx<{ verify: unknown; content_hash: string | null }[]>`
    SELECT verify, content_hash FROM skills
    WHERE id = ${parent.skill_id} AND version = ${parent.skill_version} AND status = 'approved'
    LIMIT 1
  `;
  const skill = skillRows[0];
  if (!skill || skill.content_hash !== parent.skill_content_hash) return null;

  const outcome = evaluateFollowupVerify(skill.verify, verifyTargetFromSummary(input.summary));
  if (!outcome) return null;

  await tx`
    UPDATE resolution_steps SET verify_result = ${jsonbValue(outcome)} WHERE id = ${parent.id}
  `;
  await appendResolveAudit(tx, {
    action: 'resolution.verify_result',
    sessionId: input.session.id,
    actorEmail: input.actorEmail,
    stepId: input.step.id,
    detail: { parentStepId: parent.id, ok: outcome.ok },
  });
  return outcome;
}

/**
 * script 形態 verify の追撃ステップを自動承認で積む（Phase 6a）。
 *
 * 前提（呼び出し側で確認済み）: 親が変更系・verify が requires_followup・
 * このステップ自身が追撃ではないこと。
 *
 * - `verify.script` と完全一致する script_path を持つ **approved / risk_level=1** の
 *   Skill を 1 件だけ探す。無ければ何もしない（従来どおり requires_followup のまま）。
 * - risk 2 以上の自動承認は行わない（設計 §4-3 の人間承認を迂回しない）。
 * - args → params 変換と `validateParams` を通せない場合は追撃しない。
 * - 追撃ステップは status='approved' / approved_by='system:verify' で INSERT し、
 *   通常の承認パスと同じ形で device_commands を enqueue する。
 */
async function enqueueVerifyFollowup(
  tx: any,
  input: {
    session: SessionRow;
    step: StepRow;
    verify: unknown;
    actorEmail: string;
  },
): Promise<{ stepId: string; seq: number } | null> {
  const verify = jsonObjectOrNull(input.verify);
  const scriptPath = typeof verify?.script === 'string' ? verify.script.trim() : '';
  if (!scriptPath) return null;

  // 同一親に追撃は 1 回だけ（部分 UNIQUE インデックスと合わせて二重 enqueue を防ぐ）。
  const existing = await tx<{ id: string }[]>`
    SELECT id FROM resolution_steps WHERE verify_for_step_id = ${input.step.id} LIMIT 1
  `;
  if (existing[0]) return null;

  const skillRows = await tx<
    {
      id: string;
      version: string;
      content_hash: string;
      params_schema: unknown;
      risk_level: number;
      timeout_sec: number;
    }[]
  >`
    SELECT id, version, content_hash, params_schema, risk_level, timeout_sec
    FROM skills
    WHERE status = 'approved'
      AND risk_level = 1
      AND script_path = ${scriptPath}
      AND content_hash IS NOT NULL
      AND 'windows' = ANY(os)
    ORDER BY id ASC, version DESC
    LIMIT 1
  `;
  const skill = skillRows[0];
  if (!skill) return null;

  const params = argsToParams(verify?.args, jsonObject(input.step.params));
  if (!params) return null;
  if (!validateParams(skill.params_schema, params).ok) return null;

  const seq = Number(input.session.step_count) + 1;
  const nonce = newNonce();
  const timeoutSec =
    Number(skill.timeout_sec) > 0 ? Number(skill.timeout_sec) : DEFAULT_STEP_TIMEOUT_SEC;
  // 追撃の追撃は作らない（ON CONFLICT DO NOTHING で seq 競合時も何もしない）。
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO resolution_steps (
      session_id, seq, skill_id, skill_version, skill_content_hash, params, rationale,
      risk_level, status, nonce, approval_expires_at, approved_by, approved_at,
      verify_for_step_id, timeout_sec, deadline_at
    ) VALUES (
      ${input.session.id}, ${seq}, ${skill.id}, ${skill.version}, ${skill.content_hash},
      ${jsonbValue(params)}, ${`verify の追撃確認（${input.step.skill_id}）`},
      ${Number(skill.risk_level)}, 'approved', ${nonce}, ${STEP_APPROVAL_TTL_SQL},
      ${'system:verify'}, now(), ${input.step.id}, ${timeoutSec},
      now() + make_interval(secs => ${timeoutSec})
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  const followupStepId = inserted[0]?.id;
  if (!followupStepId) return null;

  const commandRows = await tx<{ id: string }[]>`
    INSERT INTO device_commands (
      user_email, device_id, op_id, params, skill_id, skill_version,
      skill_content_hash, session_id, step_id
    ) VALUES (
      ${input.session.user_email}, ${input.session.device_id}, ${skill.id},
      ${jsonbValue(params)}, ${skill.id}, ${skill.version},
      ${skill.content_hash}, ${input.session.id}, ${followupStepId}
    )
    RETURNING id
  `;
  const commandId = commandRows[0]?.id;
  if (!commandId) throw new Error('followup device command insert failed');
  await tx`UPDATE resolution_steps SET command_id = ${commandId} WHERE id = ${followupStepId}`;

  await appendResolveAudit(tx, {
    action: 'resolution.verify_enqueued',
    sessionId: input.session.id,
    actorEmail: input.actorEmail,
    stepId: followupStepId,
    detail: { parentStepId: input.step.id, verifySkillId: skill.id, scriptPath },
  });
  return { stepId: followupStepId, seq };
}

/**
 * 端末コマンドの結果を取り込み、step / session を完了状態へ進める。
 * GET から何度呼ばれても二重更新しない（条件付き UPDATE + RETURNING で判定）。
 */
async function applyCommandOutcome(email: string, stepId: string): Promise<void> {
  await sql.begin(async (tx) => {
    // ロック順は session → step に固定する（承認・停止・スイープとのデッドロック回避）。
    const preRows = await tx<{ session_id: string; command_id: string | null }[]>`
      SELECT session_id, command_id FROM resolution_steps WHERE id = ${stepId}
    `;
    if (!preRows[0]?.command_id) return;
    const sessionRows = await tx<SessionRow[]>`
      SELECT * FROM resolution_sessions
      WHERE id = ${preRows[0].session_id} AND user_email = ${email}
      FOR UPDATE
    `;
    const session = sessionRows[0];
    if (!session) return;
    const stepRows = await tx<StepRow[]>`
      SELECT * FROM resolution_steps WHERE id = ${stepId} FOR UPDATE
    `;
    const step = stepRows[0];
    if (!step || !step.command_id) return;
    // 停止・期限切れ・解決済みのセッションでは、結果が届いても状態を進めない（H-3）。
    if (['stopped', 'expired', 'resolved', 'escalated'].includes(session.status)) {
      if (step.status === 'approved' || step.status === 'executing' || step.status === 'proposed') {
        await tx`UPDATE resolution_steps SET status = 'cancelled' WHERE id = ${step.id}`;
      }
      return;
    }

    const commandRows = await tx<
      { id: string; status: string; result: unknown; error: string | null }[]
    >`
      SELECT id, status, result, error FROM device_commands WHERE id = ${step.command_id} LIMIT 1
    `;
    const command = commandRows[0];
    if (!command) return;

    // 実行中への遷移（エージェントが取得した時点）。状態変化のみで結果はまだ無い。
    if (command.status === 'delivered' && step.status === 'approved') {
      const updated = await tx<{ id: string }[]>`
        UPDATE resolution_steps
        SET status = 'executing', executed_at = COALESCE(executed_at, now())
        WHERE id = ${step.id} AND status = 'approved'
        RETURNING id
      `;
      if (updated[0]) {
        await appendResolveAudit(tx, {
          action: 'resolution.executed',
          sessionId: session.id,
          actorEmail: email,
          stepId: step.id,
          detail: { commandId: step.command_id },
        });
      }
      return;
    }

    if (command.status === 'done' && (step.status === 'approved' || step.status === 'executing')) {
      // fieldsToAi の厳密適用には、このステップの Skill の outputPolicy が要る。
      // 承認後に Skill 定義が変わっていたら、そのポリシーは使わない（content_hash で束縛）。
      const policyRows = await tx<
        {
          output_policy: unknown;
          content_hash: string | null;
          verify: unknown;
          rollback: unknown;
          risk_level: number;
          result_schema: unknown;
        }[]
      >`
        SELECT output_policy, content_hash, verify, rollback, risk_level, result_schema FROM skills
        WHERE id = ${step.skill_id} AND version = ${step.skill_version} AND status = 'approved'
        LIMIT 1
      `;
      const policyRow = policyRows[0];
      const policyMatches = Boolean(
        policyRow && policyRow.content_hash === step.skill_content_hash,
      );
      const { summary, full, ai } = buildResultPayload(
        command.result,
        command.error,
        true,
        policyMatches ? policyRow?.output_policy : null,
      );
      // 結果の形の機械検証（下限）。解決の判定には使わない。
      summary.resultShapeOk = policyMatches
        ? resultShapeOk(normalizeJsonValue(policyRow?.result_schema), summary.normalized)
        : null;
      // verify はサーバが決定的に評価する（AI には判定させない）。ok=null も「評価不能」の
      // 情報として必ず保存する。script 形態の verify は追加実行が要るため評価不能のまま。
      const verifyResult = evaluateVerify(
        policyRow?.verify ?? null,
        verifyTargetFromSummary(summary),
      );
      // 「解決候補」として止めるのは変更系（修復）ステップの成功だけ。
      // 読み取りステップの verify 成功や、未評価（null）では止めない。
      let verified = isChangeSkillRow(policyRow) && verifyResult.ok === true;
      let verifyForSummary: VerifyOutcome | FollowupVerifyOutcome = verifyResult;
      // 追撃ステップ（verify_for_step_id 付き）の完了時は、親の verify.expect を
      // サブセット一致で評価して親の verify_result を更新する（Phase 6a）。
      if (step.verify_for_step_id) {
        const parentOutcome = await applyVerifyFollowupOutcome(tx, {
          session,
          step,
          summary,
          actorEmail: email,
        });
        if (parentOutcome?.ok === true) {
          verified = true;
          verifyForSummary = parentOutcome;
        }
      }
      // 停止時は結果サマリを残したまま outcome=verified を付ける（UI の既存表示を壊さない）。
      const lastSummary = verified
        ? {
            ...summary,
            outcome: 'verified' as const,
            stepId: step.id,
            skillId: step.skill_id,
            verify: verifyForSummary,
          }
        : summary;
      const updated = await tx<{ id: string }[]>`
        UPDATE resolution_steps
        SET status = 'done', executed_at = COALESCE(executed_at, now()),
            result_summary = ${jsonbValue(summary)}, result_full = ${jsonbValue(full)},
            result_ai = ${jsonbValue(ai)}, verify_result = ${jsonbValue(verifyResult)},
            error = ${command.error ? redactPII(command.error).text.slice(0, 2000) : null}
        WHERE id = ${step.id} AND status IN ('approved', 'executing')
        RETURNING id
      `;
      if (!updated[0]) return;
      // 親が変更系で verify が requires_followup のときだけ、読み取り Skill の
      // 追撃ステップを自動承認で積む（追撃の追撃は作らない）。
      // 承認後に Skill 定義が変わっていたら（content_hash 不一致）は積まない（fail-closed）。
      const followup =
        verifyResult.reason === 'requires_followup' &&
        !step.verify_for_step_id &&
        !sessionExpired(session) &&
        policyMatches &&
        isChangeSkillRow(policyRow)
          ? await enqueueVerifyFollowup(tx, {
              session,
              step,
              verify: policyRow?.verify ?? null,
              actorEmail: email,
            })
          : null;
      await tx`
        UPDATE resolution_sessions
        SET status = ${followup ? 'executing' : 'waiting_continue'},
            step_count = ${followup ? followup.seq : Number(session.step_count)},
            last_summary = ${jsonbValue(lastSummary)}, updated_at = now()
        WHERE id = ${session.id} AND status = 'executing'
      `;
      await appendResolveAudit(tx, {
        action: 'resolution.result',
        sessionId: session.id,
        actorEmail: email,
        stepId: step.id,
        detail: {
          commandId: step.command_id,
          ok: true,
          verifyOk: verifyResult.ok,
          verifyEvaluated: verifyResult.evaluated,
          ...(verified ? { awaitingResolution: true } : {}),
        },
      });
      return;
    }

    if (
      (command.status === 'failed' || command.status === 'expired') &&
      (step.status === 'approved' || step.status === 'executing')
    ) {
      const redactedError = redactPII(
        command.error ?? '端末での実行に失敗しました。担当者へ引き継ぎます。',
      ).text.slice(0, 2000);
      const summary = { ok: false, exitCode: null, summary: redactedError, normalized: null };
      const ai = { ok: false, exitCode: null, summary: redactedError, normalized: null };
      const updated = await tx<{ id: string }[]>`
        UPDATE resolution_steps
        SET status = 'failed', executed_at = COALESCE(executed_at, now()),
            result_summary = ${jsonbValue(summary)}, result_ai = ${jsonbValue(ai)},
            error = ${redactedError}
        WHERE id = ${step.id} AND status IN ('approved', 'executing')
        RETURNING id
      `;
      if (!updated[0]) return;

      // Phase B は安全側に倒し、最初の失敗で即エスカレーションする
      // （設計 §4-3 の「連続失敗 2 回」より厳しい。連続回数は監査 detail に残す）。
      const history = await tx<{ status: string }[]>`
        SELECT status FROM resolution_steps WHERE session_id = ${session.id} ORDER BY seq ASC
      `;
      let consecutiveFailures = 0;
      for (let index = history.length - 1; index >= 0; index -= 1) {
        if (history[index]?.status !== 'failed') break;
        consecutiveFailures += 1;
      }
      await tx`
        UPDATE resolution_sessions
        SET status = 'escalated', last_summary = ${jsonbValue(summary)}, updated_at = now()
        WHERE id = ${session.id} AND status NOT IN ('stopped', 'resolved', 'expired')
      `;
      await appendResolveAudit(tx, {
        action: 'resolution.escalated',
        sessionId: session.id,
        actorEmail: email,
        stepId: step.id,
        detail: { commandId: step.command_id, ok: false, consecutiveFailures },
      });
    }
  });
}

/**
 * verify.ok で停止したセッションの continue を処理する（AI も次提案も呼ばない）。
 *
 * - 1 回目: 200 `{ ok: true, awaitingResolution: true, session, step: null }` を返せるよう、
 *   last_summary に `awaitingDecision: true` を記録する。
 * - 2 回目以降: 409 `AWAITING_DECISION`。利用者が「解決した」(/resolve) か
 *   「担当者へ」(/escalate) を選ぶまでループを再開しない。
 *
 * resolved への自動遷移は決して行わない（利用者の確認が必須。docs/30 §4）。
 */
async function awaitResolutionDecision(
  email: string,
  sessionId: string,
  stepId: string,
): Promise<{ awaiting: true } | { failure: ApiError }> {
  return sql.begin(async (tx) => {
    const sessionRows = await tx<SessionRow[]>`
      SELECT * FROM resolution_sessions
      WHERE id = ${sessionId} AND user_email = ${email}
      FOR UPDATE
    `;
    const session = sessionRows[0];
    if (!session) return { failure: notFound('解決セッションが見つかりません。') };
    if (session.status !== 'waiting_continue') {
      return {
        failure: new ApiError(
          409,
          'STEP_NOT_CONTINUABLE',
          'このセッションは継続待ちではありません。',
        ),
      };
    }
    const summary = jsonObjectOrNull(session.last_summary);
    if (!summary || summary.outcome !== 'verified') {
      // 直前に状態が変わった（競合）。ここから提案を続けることはしない。
      return {
        failure: new ApiError(
          409,
          'AWAITING_DECISION',
          '実行結果の確認が完了しています。「解決した」か「担当者へ」を選んでください。',
        ),
      };
    }
    if (summary.awaitingDecision === true) {
      return {
        failure: new ApiError(
          409,
          'AWAITING_DECISION',
          'このセッションは最終判断待ちです。「解決した」か「担当者へ」を選んでください。',
        ),
      };
    }
    await tx`
      UPDATE resolution_sessions
      SET last_summary = ${jsonbValue({ ...summary, awaitingDecision: true })}, updated_at = now()
      WHERE id = ${session.id}
    `;
    await appendResolveAudit(tx, {
      action: 'resolution.awaiting_decision',
      sessionId: session.id,
      actorEmail: email,
      stepId,
      detail: {
        reason: 'verify_ok',
        ...(typeof summary.skillId === 'string' ? { skillId: summary.skillId } : {}),
      },
    });
    return { awaiting: true as const };
  });
}

function redactJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === 'string') return redactPII(value).text.slice(0, 4000);
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redactJsonValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      // 秘密らしいキーは値を残さない（出力全文の保持方針）。
      if (/password|passwd|secret|token|credential/i.test(key)) {
        out[key] = '[伏せ字]';
      } else {
        out[key] = redactJsonValue(item, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function isStructuredJsonText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Boolean(parsed && typeof parsed === 'object');
  } catch {
    return false;
  }
}

/** 端末結果を要約（画面向け）と全文、AI 入力用（fieldsToAi 適用）に分ける。 */
function buildResultPayload(
  result: unknown,
  error: string | null,
  ok: boolean,
  outputPolicy?: unknown,
): {
  summary: Record<string, unknown>;
  full: Record<string, unknown>;
  ai: Record<string, unknown>;
} {
  const raw = normalizeJsonValue(result);
  const record = jsonObjectOrNull(raw);
  const executionSource = executionSourceOf(record);
  const exitCode = typeof record?.exitCode === 'number' ? record.exitCode : null;
  const normalized = record?.normalized ?? null;
  const summaryText =
    typeof record?.stdoutSummary === 'string'
      ? record.stdoutSummary
      : typeof record?.summary === 'string'
        ? record.summary
        : typeof raw === 'string'
          ? raw
          : '';
  const redactedSummary = redactPII(summaryText).text.slice(0, 2000);
  const summary: Record<string, unknown> = {
    executionSource,
    ok,
    exitCode,
    summary: redactedSummary,
    normalized: redactJsonValue(normalized),
  };
  const full: Record<string, unknown> = {
    result: redactJsonValue(raw),
    error: error ? redactPII(error).text.slice(0, 4000) : null,
  };

  // AI 入力は outputPolicy が宣言されている場合だけ作る（既定拒否）。
  const policy = jsonObjectOrNull(outputPolicy);
  const declared = Array.isArray(policy?.fieldsToAi);
  const filteredNormalized = declared ? applyFieldsToAi(redactJsonValue(normalized), policy) : null;
  // stdoutSummary が JSON 全体（os-info 等）の場合は宣言外フィールドを含むため AI に渡さず、
  // fieldsToAi で絞った normalized から要約を作り直す。
  const aiSummary = !declared
    ? ''
    : isStructuredJsonText(summaryText)
      ? JSON.stringify(filteredNormalized ?? {}).slice(0, 2000)
      : redactedSummary;
  // 出所は先頭に置く（次提案へ渡す際に 1000 字で切っても必ず残す）。
  const ai: Record<string, unknown> = {
    executionSource,
    ok,
    exitCode,
    summary: aiSummary,
    normalized: filteredNormalized,
  };
  // outputPolicy.maxBytes を超える AI 入力は要約を削り、それでも超えるなら normalized を落とす。
  const maxBytesRaw = Number(policy?.maxBytes);
  const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? maxBytesRaw : 8192;
  if (Buffer.byteLength(JSON.stringify(ai)) > maxBytes) {
    ai.summary = String(ai.summary ?? '').slice(0, Math.max(0, Math.floor(maxBytes / 4)));
    if (Buffer.byteLength(JSON.stringify(ai)) > maxBytes) ai.normalized = null;
  }
  return { summary, full, ai };
}

async function loadProposalHistory(sessionId: string): Promise<ProposalHistoryEntry[]> {
  const rows = await sql<{ skill_id: string; params: unknown; status: string }[]>`
    SELECT skill_id, params, status FROM resolution_steps
    WHERE session_id = ${sessionId} AND status NOT IN ('rejected', 'cancelled', 'skipped')
    ORDER BY seq ASC
  `;
  return rows.map((row) => ({ skillId: row.skill_id, params: jsonObject(row.params) }));
}

/** 緊急停止（画面の estop）を cowork 状態から読む。読めない場合は安全側で false。 */
async function isEstopOn(email: string): Promise<boolean> {
  const rows = await sql<{ data: unknown }[]>`
    SELECT data FROM prototype_states
    WHERE user_email = ${email} AND name = 'cowork'
    LIMIT 1
  `;
  const raw = rows[0]?.data;
  let state: unknown = raw;
  if (typeof raw === 'string') {
    try {
      state = JSON.parse(raw) as unknown;
    } catch {
      return false;
    }
  }
  return Boolean(
    state && typeof state === 'object' && (state as { estop?: unknown }).estop === true,
  );
}

/** セッションの deviceId が本人の端末在庫に存在するか（端末バインド）。 */
async function ownsDevice(email: string, deviceId: string): Promise<boolean> {
  const rows = await sql<{ n: number }[]>`
    SELECT 1 AS n FROM device_inventories
    WHERE user_email = ${email} AND device_id = ${deviceId}
    LIMIT 1
  `;
  return Boolean(rows[0]);
}

/**
 * セッションを停止/期限切れにし、未実行の step と queued の端末コマンドを無効化する。
 * 承認済みでも、端末がまだ取得していないコマンドは実行させない（H-3）。
 */
async function cancelSessionWork(
  tx: any,
  sessionId: string,
  stepStatus: 'cancelled' | 'failed' = 'cancelled',
): Promise<void> {
  await tx`
    UPDATE resolution_steps SET status = ${stepStatus}
    WHERE session_id = ${sessionId} AND status IN ('proposed', 'approved', 'executing')
  `;
  await tx`
    UPDATE device_commands SET status = 'expired', completed_at = now()
    WHERE session_id = ${sessionId} AND status = 'queued'
  `;
}

/**
 * 実行期限を過ぎたステップを failed にし、セッションをエスカレーションする（設計 §4-3）。
 * GET からの遅延呼び出しと、resolveRoutes の定期実行の両方から使う。
 * 期限後に届いた結果は step が failed のため applyCommandOutcome が状態を進めない。
 */
export async function sweepResolveTimeouts(): Promise<number> {
  let swept = 0;
  // 対象セッションを先に特定し、session → step の固定順でロックする。
  const candidates = await sql<{ session_id: string }[]>`
    SELECT DISTINCT session_id FROM resolution_steps
    WHERE status IN ('approved', 'executing')
      AND deadline_at IS NOT NULL
      AND deadline_at < now()
    LIMIT 50
  `;
  for (const candidate of candidates) {
    await sql.begin(async (tx) => {
      const sessionRows = await tx<SessionRow[]>`
        SELECT * FROM resolution_sessions WHERE id = ${candidate.session_id} FOR UPDATE
      `;
      const session = sessionRows[0];
      if (!session) return;
      const rows = await tx<StepRow[]>`
        SELECT * FROM resolution_steps
        WHERE session_id = ${candidate.session_id}
          AND status IN ('approved', 'executing')
          AND deadline_at IS NOT NULL
          AND deadline_at < now()
        FOR UPDATE
      `;
      for (const step of rows) {
        const message = '端末から結果が返りませんでした（タイムアウト）。担当者へ引き継ぎます。';
        const summary = { ok: false, exitCode: null, summary: message, normalized: null };
        const ai = { ok: false, exitCode: null, summary: message, normalized: null };
        const updated = await tx<{ id: string }[]>`
          UPDATE resolution_steps
          SET status = 'failed', executed_at = COALESCE(executed_at, now()),
              result_summary = ${jsonbValue(summary)}, result_ai = ${jsonbValue(ai)},
              error = 'RESULT_TIMEOUT'
          WHERE id = ${step.id} AND status IN ('approved', 'executing')
          RETURNING id
        `;
        if (!updated[0]) continue;
        await tx`
          UPDATE device_commands SET status = 'expired', completed_at = now()
          WHERE step_id = ${step.id} AND status = 'queued'
        `;
        if (session.status === 'executing') {
          await tx`
            UPDATE resolution_sessions SET status = 'escalated', updated_at = now()
            WHERE id = ${session.id}
          `;
        }
        await appendResolveAudit(tx, {
          action: 'resolution.timeout',
          sessionId: step.session_id,
          actorEmail: session.user_email,
          stepId: step.id,
          detail: { by: 'system', reason: 'result_timeout' },
        });
        swept += 1;
      }
    });
  }
  return swept;
}

/** 本人操作による「解決した」「担当者へ」。監査に理由を残し、未実行の作業を止める。 */
async function manualCloseSession(
  email: string,
  sessionId: string,
  status: 'resolved' | 'escalated',
  reason: string | undefined,
): Promise<void> {
  await sql.begin(async (tx) => {
    const sessionRows = await tx<SessionRow[]>`
      SELECT * FROM resolution_sessions
      WHERE id = ${sessionId} AND user_email = ${email}
      FOR UPDATE
    `;
    const session = sessionRows[0];
    if (!session) throw notFound('解決セッションが見つかりません。');
    if (TERMINAL_SESSION_STATUSES.has(session.status)) {
      throw new ApiError(409, 'SESSION_TERMINAL', 'このセッションはすでに終了しています。');
    }
    await tx`
      UPDATE resolution_sessions SET status = ${status}, updated_at = now()
      WHERE id = ${session.id}
    `;
    await cancelSessionWork(tx, session.id);
    // 理由は自由入力なので、監査へ書く前に PII を伏せ字にする。
    const safeReason = reason ? redactPII(reason).text.slice(0, 500) : undefined;
    await appendResolveAudit(tx, {
      action: status === 'resolved' ? 'resolution.resolved' : 'resolution.escalated',
      sessionId: session.id,
      actorEmail: email,
      detail: { by: 'manual', ...(safeReason ? { reason: safeReason } : {}) },
    });
  });
}

export async function resolveRoutes(app: FastifyInstance): Promise<void> {
  // 期限切れの実行を放置しない（設計 §4-3）。テストがハングしないよう unref する。
  const timeoutTimer = setInterval(() => {
    // 失敗を握りつぶすと自動失敗機能が止まったことに気付けないため、ログには残す。
    void sweepResolveTimeouts().catch((error: unknown) => {
      console.warn('[resolve] タイムアウトのスイープに失敗しました', error);
    });
  }, 30_000);
  timeoutTimer.unref?.();
  app.addHook('onClose', async () => {
    clearInterval(timeoutTimer);
  });
  // Phase C: estop は開始・承認の各入口で ESTOP_ACTIVE として拒否する。
  // 端末オフラインは承認時に DEVICE_OFFLINE、結果タイムアウトは sweepResolveTimeouts が処理する。
  // 承認済み Skill の一覧（要約のみ）。UI は Skill 名・リスク・パラメータスキーマを表示する。
  app.get('/resolve/skills', { preHandler: authenticateUi }, async (request) => {
    const email = requireEmail(request);
    enforceRateLimit(`resolve-skills:${email}`, 60, 'Skill 一覧の取得が多すぎます。');
    const skills = await listApprovedSkills();
    return {
      ok: true,
      skills: skills.map((skill) => ({
        id: skill.id,
        version: skill.version,
        title: skill.title,
        summary: skill.summary,
        symptoms: skill.symptoms,
        os: skill.os,
        riskLevel: skill.riskLevel,
        requires: skill.requires,
        paramsSchema: skill.paramsSchema,
        script: skill.scriptPath,
        args: skill.args,
        verify: skill.verify,
        rollback: skill.rollback,
        timeoutSec: skill.timeoutSec,
        resultSchema: skill.resultSchema,
        outputPolicy: skill.outputPolicy,
        status: skill.status,
        contentHash: skill.contentHash,
        approvedBy: skill.approvedBy,
        approvedAt: skill.approvedAt,
      })),
    };
  });

  // 相談者の導線の分岐に使う（docs/25 §20）。本人の端末だけを返し、トークンの情報は返さない。
  // 実行の可否は承認時に改めて DEVICE_OFFLINE で判定する（ここは案内のための参考値）。
  app.get('/resolve/device-status', { preHandler: authenticateUi }, async (request) => {
    const email = requireEmail(request);
    enforceRateLimit(`resolve-device-status:${email}`, 120, '端末の状態確認が多すぎます。');
    const { deviceId } = DeviceStatusQuerySchema.parse(request.query);
    const owned = await ownsDevice(email, deviceId);
    const lastSeen = owned ? await standardAgentLastSeenAt(email, deviceId) : null;
    return { ok: true, deviceId, owned, agentConnected: isDeviceOnline(lastSeen) };
  });

  // IT 管理者の承認待ち（リスク 4 以上）。管理者以外には存在を返さない。
  app.get('/resolve/admin/pending', { preHandler: authenticateUi }, async (request) => {
    const email = requireEmail(request);
    enforceRateLimit(`resolve-admin:${email}`, 60, '承認待ちの確認が多すぎます。');
    if (!isResolveAdmin(email)) {
      throw new ApiError(403, 'FORBIDDEN', 'IT 管理者のみ承認できます。');
    }
    const rows = await sql<StepRow[]>`
      SELECT s.*, sk.title AS sk_title
      FROM resolution_steps s
      JOIN resolution_sessions rs ON rs.id = s.session_id
      LEFT JOIN skills sk ON sk.id = s.skill_id AND sk.version = s.skill_version
      WHERE s.status = 'proposed'
        AND s.risk_level >= 4
        AND s.admin_approval_hash IS NULL
        AND (s.admin_expires_at IS NULL OR s.admin_expires_at > now())
        AND rs.status IN ('active', 'waiting_execute')
        AND rs.expires_at > now()
      ORDER BY s.created_at ASC
      LIMIT 50
    `;
    const items = [];
    for (const step of rows) {
      const sessionRows = await sql<SessionRow[]>`
        SELECT * FROM resolution_sessions WHERE id = ${step.session_id} LIMIT 1
      `;
      const session = sessionRows[0];
      if (!session) continue;
      // 自己承認は表示もしない（依頼者本人には承認させない）。
      if (canonicalEmail(session.user_email) === canonicalEmail(email)) continue;
      const payload = adminApprovalPayloadFor(step, session, canonicalEmail(email));
      if (!payload) continue;
      items.push({
        stepId: step.id,
        sessionId: session.id,
        seq: Number(step.seq),
        skillId: step.skill_id,
        skillTitle: step.sk_title ?? step.skill_id,
        riskLevel: Number(step.risk_level),
        requester: session.user_email,
        deviceId: session.device_id,
        createdAt: toIso(step.created_at),
        adminApprovalChallenge: {
          payload,
          nonce: payload.nonce,
          expiresAt: payload.expiresAt,
        },
      });
    }
    return { ok: true, items };
  });

  // IT 管理者によるリスク 4 以上の承認。承認しても step は proposed のまま
  // （依頼者本人の Y が別途必要。二段階を維持する）。
  app.post(
    '/resolve/steps/:id/admin-approve',
    { preHandler: authenticateUi, bodyLimit: 8 * 1024 },
    async (request) => {
      const email = requireEmail(request);
      enforceRateLimit(`resolve-admin-approve:${email}`, 20, '承認の操作が多すぎます。');
      if (!isResolveAdmin(email)) {
        throw new ApiError(403, 'FORBIDDEN', 'IT 管理者のみ承認できます。');
      }
      const { id: stepId } = StepIdParamsSchema.parse(request.params);
      const input = AdminApproveSchema.parse(request.body);

      const outcome = await sql.begin(async (tx) => {
        // ロック順は session → step に固定する（停止・スイープとのデッドロック回避）。
        const preRows = await tx<{ session_id: string }[]>`
          SELECT session_id FROM resolution_steps WHERE id = ${stepId}
        `;
        if (!preRows[0]) return { failure: notFound('ステップが見つかりません。') };
        const sessionRows = await tx<SessionRow[]>`
          SELECT * FROM resolution_sessions WHERE id = ${preRows[0].session_id} FOR UPDATE
        `;
        const session = sessionRows[0];
        if (!session) return { failure: notFound('解決セッションが見つかりません。') };
        const stepRows = await tx<StepRow[]>`
          SELECT * FROM resolution_steps WHERE id = ${stepId} FOR UPDATE
        `;
        const step = stepRows[0];
        if (!step) return { failure: notFound('ステップが見つかりません。') };
        if (canonicalEmail(session.user_email) === canonicalEmail(email)) {
          return {
            failure: new ApiError(
              403,
              'SELF_APPROVAL_FORBIDDEN',
              '自分自身の操作を承認することはできません。',
            ),
          };
        }
        if (TERMINAL_SESSION_STATUSES.has(session.status)) {
          return {
            failure: new ApiError(409, 'SESSION_TERMINAL', 'このセッションは終了しています。'),
          };
        }
        if (step.status !== 'proposed') {
          return {
            failure: new ApiError(
              409,
              'STEP_NOT_APPROVABLE',
              'このステップは承認待ちではありません。',
            ),
          };
        }
        if (Number(step.risk_level) >= 5) {
          return {
            failure: new ApiError(
              409,
              'SKILL_RISK_FORBIDDEN',
              'リスクレベル 5 の Skill は実行できません。',
            ),
          };
        }
        if (Number(step.risk_level) < 4) {
          return {
            failure: new ApiError(
              409,
              'ADMIN_APPROVAL_NOT_REQUIRED',
              'リスクレベル 4 未満の Skill に管理者承認は不要です。',
            ),
          };
        }
        const adminExpiresAt = step.admin_expires_at
          ? new Date(step.admin_expires_at).getTime()
          : Number.NaN;
        if (!Number.isFinite(adminExpiresAt) || Date.now() > adminExpiresAt) {
          return {
            failure: new ApiError(
              409,
              'ADMIN_APPROVAL_EXPIRED',
              '管理者承認の期限（5 分）が切れました。提案を取り直してください。',
            ),
          };
        }

        if (input.decision === 'N') {
          const rejected = await tx<{ id: string }[]>`
            UPDATE resolution_steps SET status = 'rejected'
            WHERE id = ${step.id} AND status = 'proposed' AND admin_approval_hash IS NULL
            RETURNING id
          `;
          if (!rejected[0]) {
            return {
              failure: new ApiError(
                409,
                'ADMIN_ALREADY_DECIDED',
                'このステップは既に管理者が承認または却下しています。',
              ),
            };
          }
          await tx`
            UPDATE resolution_sessions SET status = 'stopped', updated_at = now()
            WHERE id = ${session.id}
          `;
          await appendResolveAudit(tx, {
            action: 'resolution.admin_rejected',
            sessionId: session.id,
            actorEmail: email,
            stepId: step.id,
            detail: { seq: step.seq, skillId: step.skill_id, riskLevel: step.risk_level },
          });
          return { decision: 'N' as const };
        }

        const payload = adminApprovalPayloadFor(step, session, canonicalEmail(email));
        if (!payload) {
          return {
            failure: new ApiError(409, 'ADMIN_APPROVAL_INVALID', '承認対象を再構築できません。'),
          };
        }
        const expectedHash = computeAdminApprovalHash(payload);
        if (!input.approvalHash) {
          return {
            failure: new ApiError(400, 'ADMIN_APPROVAL_MISMATCH', '承認ハッシュが必要です。'),
          };
        }
        if (!approvalHashMatches(input.approvalHash, expectedHash)) {
          return {
            failure: new ApiError(
              400,
              'ADMIN_APPROVAL_MISMATCH',
              '承認ハッシュが一致しません。画面を再読み込みしてください。',
            ),
          };
        }
        const decided = await tx<{ id: string }[]>`
          UPDATE resolution_steps
          SET admin_approval_hash = ${expectedHash},
              admin_approved_by = ${canonicalEmail(email)},
              admin_approved_at = now()
          WHERE id = ${step.id} AND status = 'proposed' AND admin_approval_hash IS NULL
          RETURNING id
        `;
        if (!decided[0]) {
          return {
            failure: new ApiError(
              409,
              'ADMIN_ALREADY_DECIDED',
              'このステップは既に管理者が承認または却下しています。',
            ),
          };
        }
        await appendResolveAudit(tx, {
          action: 'resolution.admin_approved',
          sessionId: session.id,
          actorEmail: email,
          stepId: step.id,
          detail: {
            seq: step.seq,
            skillId: step.skill_id,
            riskLevel: step.risk_level,
            requester: session.user_email,
          },
        });
        return { decision: 'Y' as const };
      });

      if (isFailure(outcome)) throw outcome.failure;
      return { ok: true, decision: outcome.decision };
    },
  );

  // セッション開始 + 初回提案（承認待ちの step を返す）。
  app.post(
    '/resolve/sessions',
    { preHandler: authenticateUi, bodyLimit: 16 * 1024 },
    async (request) => {
      const email = requireEmail(request);
      enforceRateLimit(
        `resolve-sessions:${email}`,
        20,
        '解決ループの開始が多すぎます。少し待ってから再試行してください。',
      );
      const input = CreateSessionSchema.parse(request.body);
      if (await isEstopOn(email)) {
        throw new ApiError(409, 'ESTOP_ACTIVE', '緊急停止中です。解除してからやり直してください。');
      }
      if (!(await ownsDevice(email, input.deviceId))) {
        throw notFound('対象の端末が見つかりません。PC情報を取得してからやり直してください。');
      }
      const ownedCase = await findOwnedCase(email, input.caseId);
      if (!ownedCase) throw notFound('案件が見つかりません。');

      const skills = await listApprovedSkills();
      const proposal = await proposeNext({
        text: caseText(ownedCase),
        lastSummary: null,
        history: [],
        skills,
      });
      if (!proposal || proposal.decision) {
        // 初回提案で AI が終了宣言（stop / escalate）を返した場合も、新規セッションは
        // 作らない（自動で escalated にしない。従来どおり「適用できる Skill が無い」）。
        throw new ApiError(
          409,
          'NO_SKILL',
          'この相談に適用できる承認済み Skill がありません。担当者へ引き継いでください。',
        );
      }
      const skill = skillForProposal(proposal, skills);

      const stepId = await sql.begin(async (tx) => {
        const sessionRows = await tx<SessionRow[]>`
          INSERT INTO resolution_sessions (
            user_email, case_id, device_id, status, step_count, max_steps, expires_at
          ) VALUES (
            ${email}, ${input.caseId}, ${input.deviceId}, 'active', 0,
            ${SESSION_MAX_STEPS}, ${SESSION_TTL_SQL}
          )
          RETURNING *
        `;
        const session = sessionRows[0];
        if (!session) throw new Error('resolution session insert failed');
        const insertedStepId = await insertProposedStep(tx, session, proposal, skill, 1);
        await tx`
          UPDATE resolution_sessions
          SET status = 'waiting_execute', step_count = 1, updated_at = now()
          WHERE id = ${session.id}
        `;
        await appendResolveAudit(tx, {
          action: 'resolution.session_started',
          sessionId: session.id,
          actorEmail: email,
          detail: { caseId: input.caseId, deviceId: input.deviceId },
        });
        await appendResolveAudit(tx, {
          action: 'resolution.proposed',
          sessionId: session.id,
          actorEmail: email,
          stepId: insertedStepId,
          detail: {
            seq: 1,
            skillId: skill.id,
            riskLevel: skill.riskLevel,
            source: proposal.source,
          },
        });
        return insertedStepId;
      });

      const { step, session } = await loadStepAndSession(email, stepId);
      return { ok: true, session: sessionDto(session), step: stepDto(step, session) };
    },
  );

  // 実行前 Y/N。Y は承認ハッシュを再計算・照合し、実端末コマンドを queued で登録する。
  app.post(
    '/resolve/steps/:id/approve',
    { preHandler: authenticateUi, bodyLimit: 8 * 1024 },
    async (request) => {
      const email = requireEmail(request);
      enforceRateLimit(
        `resolve-approve:${email}`,
        10,
        '承認の操作が多すぎます。少し待ってから再試行してください。',
      );
      const { id: stepId } = StepIdParamsSchema.parse(request.params);
      const input = ApproveSchema.parse(request.body);
      if (await isEstopOn(email)) {
        throw new ApiError(409, 'ESTOP_ACTIVE', '緊急停止中です。解除してからやり直してください。');
      }

      const outcome = await sql.begin(async (tx) => {
        // ロック順は session → step に固定する（停止・スイープとのデッドロック回避）。
        const preRows = await tx<{ session_id: string }[]>`
          SELECT session_id FROM resolution_steps WHERE id = ${stepId}
        `;
        if (!preRows[0]) return { failure: notFound('ステップが見つかりません。') };
        const sessionRows = await tx<SessionRow[]>`
          SELECT * FROM resolution_sessions
          WHERE id = ${preRows[0].session_id} AND user_email = ${email}
          FOR UPDATE
        `;
        const session = sessionRows[0];
        if (!session) return { failure: notFound('ステップが見つかりません。') };
        const stepRows = await tx<StepRow[]>`
          SELECT * FROM resolution_steps WHERE id = ${stepId} FOR UPDATE
        `;
        const step = stepRows[0];
        if (!step) return { failure: notFound('ステップが見つかりません。') };

        if (TERMINAL_SESSION_STATUSES.has(session.status) || session.status === 'executing') {
          return {
            failure: new ApiError(
              409,
              'STEP_NOT_APPROVABLE',
              'このセッションは実行中または終了しています。',
            ),
          };
        }
        if (step.status !== 'proposed') {
          return {
            failure: new ApiError(
              409,
              'STEP_NOT_APPROVABLE',
              'このステップは承認待ちではありません（承認済みの承認ハッシュは再利用できません）。',
            ),
          };
        }

        if (sessionExpired(session)) {
          await tx`
            UPDATE resolution_sessions SET status = 'expired', updated_at = now()
            WHERE id = ${session.id}
          `;
          await tx`
            UPDATE resolution_steps SET status = 'cancelled' WHERE id = ${step.id}
          `;
          await appendResolveAudit(tx, {
            action: 'resolution.expired',
            sessionId: session.id,
            actorEmail: email,
            stepId: step.id,
            detail: { reason: 'session_expired' },
          });
          return {
            failure: new ApiError(
              409,
              'SESSION_EXPIRED',
              '解決セッションの有効期限（30 分）が切れました。もう一度相談からやり直してください。',
            ),
          };
        }

        if (input.decision === 'N') {
          await tx`
            UPDATE resolution_steps SET status = 'rejected'
            WHERE id = ${step.id} AND status = 'proposed'
          `;
          await tx`
            UPDATE resolution_sessions SET status = 'stopped', updated_at = now()
            WHERE id = ${session.id}
          `;
          await appendResolveAudit(tx, {
            action: 'resolution.rejected',
            sessionId: session.id,
            actorEmail: email,
            stepId: step.id,
            detail: { seq: step.seq, skillId: step.skill_id },
          });
          return { decision: 'N' as const };
        }

        // 端末オフライン（設計 §4-3）。最終応答が閾値以上前なら実行させない。
        const lastSeen = await deviceLastSeenAt(session.user_email, session.device_id);
        if (!isDeviceOnline(lastSeen)) {
          return {
            failure: new ApiError(
              409,
              'DEVICE_OFFLINE',
              '対象端末が応答していません（オフライン）。端末を起動してからやり直してください。',
            ),
          };
        }

        if (Number(step.risk_level) >= 4) {
          // リスク 4 以上は IT 管理者の承認が必須（自己承認不可）。承認は内容ハッシュに束縛する。
          const adminApprovedBy = step.admin_approved_by;
          if (!step.admin_approval_hash || !adminApprovedBy) {
            return {
              failure: new ApiError(
                403,
                'ADMIN_APPROVAL_REQUIRED',
                'リスクレベル 4 以上の Skill は IT 管理者の承認が必要です（自己承認はできません）。',
              ),
            };
          }
          if (canonicalEmail(adminApprovedBy) === canonicalEmail(session.user_email)) {
            return {
              failure: new ApiError(
                403,
                'SELF_APPROVAL_FORBIDDEN',
                '自分自身の操作を承認することはできません。',
              ),
            };
          }
          if (!isResolveAdmin(adminApprovedBy)) {
            return {
              failure: new ApiError(
                403,
                'ADMIN_APPROVAL_INVALID',
                '承認者が IT 管理者の許可リストにありません。',
              ),
            };
          }
          const adminPayload = adminApprovalPayloadFor(step, session, adminApprovedBy);
          if (!adminPayload) {
            return {
              failure: new ApiError(
                403,
                'ADMIN_APPROVAL_INVALID',
                '管理者承認の内容を再構築できません。承認を取り直してください。',
              ),
            };
          }
          const adminExpiresAt = new Date(adminPayload.expiresAt).getTime();
          if (!Number.isFinite(adminExpiresAt) || Date.now() > adminExpiresAt) {
            return {
              failure: new ApiError(
                409,
                'ADMIN_APPROVAL_EXPIRED',
                'IT 管理者の承認期限（5 分）が切れました。承認を取り直してください。',
              ),
            };
          }
          if (
            !approvalHashMatches(step.admin_approval_hash, computeAdminApprovalHash(adminPayload))
          ) {
            return {
              failure: new ApiError(
                400,
                'ADMIN_APPROVAL_MISMATCH',
                'IT 管理者の承認ハッシュが一致しません。承認を取り直してください。',
              ),
            };
          }
        }

        const challengeExpiresAt = new Date(step.approval_expires_at).getTime();
        if (!Number.isFinite(challengeExpiresAt) || Date.now() > challengeExpiresAt) {
          return {
            failure: new ApiError(
              409,
              'APPROVAL_EXPIRED',
              '承認ハッシュの有効期限（5 分）が切れました。提案を取り直してください。',
            ),
          };
        }

        const params = jsonObject(step.params);
        const payload = buildApprovalPayload({
          sessionId: session.id,
          stepId: step.id,
          seq: Number(step.seq),
          skillId: step.skill_id,
          skillVersion: step.skill_version,
          skillContentHash: step.skill_content_hash,
          params,
          deviceId: session.device_id,
          userEmail: session.user_email,
          riskLevel: Number(step.risk_level),
          nonce: step.nonce,
          expiresAt: step.approval_expires_at,
        });
        const expectedHash = computeApprovalHash(payload);
        if (!input.approvalHash) {
          return {
            failure: new ApiError(400, 'APPROVAL_MISMATCH', '承認ハッシュが必要です。'),
          };
        }
        if (!approvalHashMatches(input.approvalHash, expectedHash)) {
          return {
            failure: new ApiError(
              400,
              'APPROVAL_MISMATCH',
              '承認ハッシュが一致しません。画面を再読み込みしてやり直してください。',
            ),
          };
        }

        // 承認直前のポリシー再検証（設計 §7）。
        const skillRows = await tx<SkillRow[]>`
          SELECT * FROM skills
          WHERE id = ${step.skill_id} AND version = ${step.skill_version} AND status = 'approved'
          LIMIT 1
        `;
        const skill = skillRows[0] ? toSkillRecord(skillRows[0]) : null;
        if (Number(step.risk_level) >= 5 || (skill && skill.riskLevel >= 5)) {
          return {
            failure: new ApiError(
              409,
              'SKILL_RISK_FORBIDDEN',
              'リスクレベル 5 の Skill は実行できません。',
            ),
          };
        }
        if (
          !skill ||
          skill.contentHash !== step.skill_content_hash ||
          !skill.os.includes('windows')
        ) {
          return {
            failure: new ApiError(
              409,
              'SKILL_NOT_ALLOWED',
              'Skill が承認済みの状態ではありません。担当者へ引き継いでください。',
            ),
          };
        }
        const paramsCheck = validateParams(skill.paramsSchema, params);
        if (!paramsCheck.ok) {
          return {
            failure: new ApiError(400, 'PARAM_INVALID', paramsCheck.message),
          };
        }

        const commandRows = await tx<CommandRow[]>`
          INSERT INTO device_commands (
            user_email, device_id, op_id, params, skill_id, skill_version,
            skill_content_hash, session_id, step_id
          ) VALUES (
            ${session.user_email}, ${session.device_id}, ${step.skill_id},
            ${jsonbValue(params)}, ${step.skill_id}, ${step.skill_version},
            ${step.skill_content_hash}, ${session.id}, ${step.id}
          )
          RETURNING id, op_id, params, status, device_id, skill_id, skill_version,
                    skill_content_hash, session_id, step_id, created_at
        `;
        const command = commandRows[0];
        if (!command) throw new Error('device command insert failed');

        // 実行期限は承認時に確定する（設計 §4-3。Skill の timeoutSec を優先）。
        const timeoutSec =
          Number(skill.timeoutSec) > 0 ? Number(skill.timeoutSec) : DEFAULT_STEP_TIMEOUT_SEC;
        const updated = await tx<{ id: string }[]>`
          UPDATE resolution_steps
          SET status = 'approved', approval_hash = ${expectedHash},
              approved_by = ${email}, approved_at = now(), command_id = ${command.id},
              timeout_sec = ${timeoutSec},
              deadline_at = now() + make_interval(secs => ${timeoutSec})
          WHERE id = ${step.id} AND status = 'proposed'
          RETURNING id
        `;
        if (!updated[0]) {
          // ここまでの INSERT を残さないよう throw してロールバックする（通常は FOR UPDATE で起きない）。
          throw new ApiError(409, 'STEP_NOT_APPROVABLE', 'ステップの状態が変わりました。');
        }
        await tx`
          UPDATE resolution_sessions SET status = 'executing', updated_at = now()
          WHERE id = ${session.id}
        `;
        await appendResolveAudit(tx, {
          action: 'resolution.approved',
          sessionId: session.id,
          actorEmail: email,
          stepId: step.id,
          detail: {
            seq: step.seq,
            skillId: step.skill_id,
            skillVersion: step.skill_version,
            commandId: command.id,
            riskLevel: step.risk_level,
          },
        });
        return { decision: 'Y' as const, command };
      });

      if (isFailure(outcome)) throw outcome.failure;

      const { step, session } = await loadStepAndSession(email, stepId);
      if (outcome.decision === 'Y') {
        return {
          ok: true,
          step: stepDto(step, session),
          session: sessionDto(session),
          command: commandDto(outcome.command),
        };
      }
      return { ok: true, step: stepDto(step, session), session: sessionDto(session) };
    },
  );

  // 実行状態・結果の取得。端末コマンドが完了していれば step / session を進める。
  app.get('/resolve/steps/:id', { preHandler: authenticateUi }, async (request) => {
    const email = requireEmail(request);
    enforceRateLimit(`resolve-step-get:${email}`, 120, '状態確認が多すぎます。');
    const { id: stepId } = StepIdParamsSchema.parse(request.params);
    // 期限切れを先に確定させる（結果が来ないまま executing で固まらない）。
    await sweepResolveTimeouts();
    const current = await loadStepAndSession(email, stepId);
    if (current.step.command_id) {
      await applyCommandOutcome(email, stepId);
    }
    // script 形態 verify の追撃（Migration 018）は「親ステップが done のまま
    // セッションだけ executing」という中間状態を作る。クライアントは親ステップを
    // ポーリングし続けるため、ここでセッションの実行中ステップも同期する。
    // これをしないと追撃コマンドの結果が反映されず、セッションが executing で固まる
    // （2026-10-26 の 1 ケース実測で確認）。
    const activeRows = await sql<{ id: string }[]>`
      SELECT id FROM resolution_steps
      WHERE session_id = ${current.session.id}
        AND status IN ('proposed', 'approved', 'executing')
      ORDER BY seq DESC
      LIMIT 1
    `;
    const activeId = activeRows[0]?.id;
    if (activeId && activeId !== stepId) {
      try {
        await applyCommandOutcome(email, activeId);
      } catch {
        // 追撃の同期失敗で親の状態取得まで壊さない（次回のポーリングで再試行される）。
      }
    }
    const { step, session } = await loadStepAndSession(email, stepId);
    const active = activeId ? await loadStepAndSession(email, activeId).catch(() => null) : null;
    return {
      ok: true,
      step: stepDto(step, session),
      session: sessionDto(session),
      // 実行中の追撃ステップ（無ければ null）。UI の「確認中」表示とハーネスの追従に使う。
      activeStep: active ? stepDto(active.step, active.session) : null,
    };
  });

  // 結果後 Y/N。Y は次提案、N は停止。
  app.post(
    '/resolve/steps/:id/continue',
    { preHandler: authenticateUi, bodyLimit: 8 * 1024 },
    async (request) => {
      const email = requireEmail(request);
      enforceRateLimit(
        `resolve-continue:${email}`,
        20,
        '継続操作が多すぎます。少し待ってから再試行してください。',
      );
      const { id: stepId } = StepIdParamsSchema.parse(request.params);
      const input = ContinueSchema.parse(request.body);
      const current = await loadStepAndSession(email, stepId);
      if (current.step.status !== 'done') {
        throw new ApiError(
          409,
          'STEP_NOT_CONTINUABLE',
          '実行結果が揃ったステップだけ継続できます。',
        );
      }
      if (current.session.status !== 'waiting_continue') {
        throw new ApiError(409, 'STEP_NOT_CONTINUABLE', 'このセッションは継続待ちではありません。');
      }

      if (input.decision === 'N') {
        await sql.begin(async (tx) => {
          const sessionRows = await tx<SessionRow[]>`
            SELECT * FROM resolution_sessions
            WHERE id = ${current.session.id} AND user_email = ${email}
            FOR UPDATE
          `;
          const session = sessionRows[0];
          if (!session) return;
          if (TERMINAL_SESSION_STATUSES.has(session.status)) return;
          await tx`
            UPDATE resolution_sessions SET status = 'stopped', updated_at = now()
            WHERE id = ${session.id}
          `;
          await cancelSessionWork(tx, session.id);
          await appendResolveAudit(tx, {
            action: 'resolution.stopped',
            sessionId: session.id,
            actorEmail: email,
            stepId: current.step.id,
            detail: { reason: 'user_declined_continue' },
          });
        });
        const session = await loadSession(email, current.session.id);
        return { ok: true, session: sessionDto(session), step: null };
      }

      // verify.ok で停止したセッションでは、AI も次提案も呼ばずに最終判断を待つ。
      // （resolved への自動遷移はしない。利用者の /resolve か /escalate が必須）
      if (isVerifiedSession(current.session)) {
        const awaiting = await awaitResolutionDecision(email, current.session.id, current.step.id);
        if (isFailure(awaiting)) throw awaiting.failure;
        const session = await loadSession(email, current.session.id);
        return {
          ok: true,
          awaitingResolution: true,
          session: sessionDto(session),
          step: null,
        };
      }

      // 次提案の材料（case 本文・直近結果・verify・実行履歴）。提案生成は DB ロックの外で行う。
      const ownedCase = await findOwnedCase(email, current.session.case_id);
      const [skills, history, lastVerify] = await Promise.all([
        listApprovedSkills(),
        loadProposalHistory(current.session.id),
        loadLastVerifyResult(current.session.id),
      ]);
      // AI に渡すのは fieldsToAi 適用後の result_ai だけ。旧データ（result_ai なし）は
      // 未フィルターの last_summary へ退避せず、何も渡さない（fail-closed）。
      const lastResultAi = await loadLastResultAi(current.session.id);
      // jsonb はキー順を保たないので、1000 字で切っても出所が残るよう先頭へ置き直す。
      const lastResultAiText = lastResultAi
        ? JSON.stringify({
            executionSource: executionSourceOf(lastResultAi),
            ...jsonObject(lastResultAi),
          }).slice(0, 1000)
        : '';
      const proposal = await proposeNext({
        text: caseText(ownedCase),
        lastSummary: lastResultAiText,
        lastVerify,
        history,
        skills,
      });

      const outcome = await sql.begin(async (tx) => {
        const sessionRows = await tx<SessionRow[]>`
          SELECT * FROM resolution_sessions
          WHERE id = ${current.session.id} AND user_email = ${email}
          FOR UPDATE
        `;
        const session = sessionRows[0];
        if (!session) return { failure: notFound('解決セッションが見つかりません。') };
        if (sessionExpired(session)) {
          await tx`
            UPDATE resolution_sessions SET status = 'expired', updated_at = now()
            WHERE id = ${session.id}
          `;
          await appendResolveAudit(tx, {
            action: 'resolution.expired',
            sessionId: session.id,
            actorEmail: email,
            detail: { reason: 'session_expired', phase: 'continue' },
          });
          return {
            failure: new ApiError(409, 'SESSION_EXPIRED', '解決セッションの有効期限が切れました。'),
          };
        }
        if (session.status !== 'waiting_continue') {
          return {
            failure: new ApiError(
              409,
              'STEP_NOT_CONTINUABLE',
              'このセッションは継続待ちではありません。',
            ),
          };
        }
        // verify.ok で停止したセッションでは提案しない（直前に確定した場合の防御。
        // 正常系は事前チェックで AI を呼ばずに返している）。
        if (isVerifiedSession(session)) {
          return {
            failure: new ApiError(
              409,
              'AWAITING_DECISION',
              '実行結果の確認が完了しています。「解決した」か「担当者へ」を選んでください。',
            ),
          };
        }

        // 進捗なし（直近 2 回の結果サマリが同一）ならループを止めてエスカレーションする。
        const recentDone = await tx<{ seq: number; result_summary: unknown }[]>`
          SELECT seq, result_summary FROM resolution_steps
          WHERE session_id = ${session.id} AND status = 'done'
          ORDER BY seq DESC
          LIMIT 2
        `;
        const latestSummary = recentDone[0]?.result_summary;
        const previousSummary = recentDone[1]?.result_summary;
        if (
          latestSummary &&
          previousSummary &&
          stableStringify(jsonObject(latestSummary)) ===
            stableStringify(jsonObject(previousSummary))
        ) {
          await tx`
            UPDATE resolution_sessions SET status = 'escalated', updated_at = now()
            WHERE id = ${session.id}
          `;
          await appendResolveAudit(tx, {
            action: 'resolution.escalated',
            sessionId: session.id,
            actorEmail: email,
            stepId: current.step.id,
            detail: { reason: 'no_progress' },
          });
          return { escalated: true as const, reason: 'no_progress' as const };
        }

        if (Number(session.step_count) >= Number(session.max_steps)) {
          await tx`
            UPDATE resolution_sessions SET status = 'escalated', updated_at = now()
            WHERE id = ${session.id}
          `;
          await appendResolveAudit(tx, {
            action: 'resolution.escalated',
            sessionId: session.id,
            actorEmail: email,
            stepId: current.step.id,
            detail: {
              reason: 'step_limit',
              stepCount: session.step_count,
              maxSteps: session.max_steps,
            },
          });
          return {
            failure: new ApiError(
              409,
              'STEP_LIMIT',
              `ステップ数の上限（${session.max_steps} 回）に達しました。担当者へ引き継ぎます。`,
            ),
          };
        }

        // AI の終了宣言（stop / escalate）。既存の no_progress / step_limit の後、
        // 次提案より前に評価する。未検証のまま resolved にはしない（必ず escalated）。
        const decisionReason = escalationReasonForDecision(proposal?.decision);
        if (decisionReason) {
          await tx`
            UPDATE resolution_sessions SET status = 'escalated', updated_at = now()
            WHERE id = ${session.id}
          `;
          await appendResolveAudit(tx, {
            action: 'resolution.escalated',
            sessionId: session.id,
            actorEmail: email,
            stepId: current.step.id,
            detail: { reason: decisionReason },
          });
          return { escalated: true as const, reason: decisionReason };
        }

        if (!proposal) {
          await tx`
            UPDATE resolution_sessions SET status = 'escalated', updated_at = now()
            WHERE id = ${session.id}
          `;
          await appendResolveAudit(tx, {
            action: 'resolution.escalated',
            sessionId: session.id,
            actorEmail: email,
            stepId: current.step.id,
            detail: { reason: 'no_skill' },
          });
          return { escalated: true as const, reason: 'no_skill' as const };
        }

        const skill = skillForProposal(proposal, skills);
        const nextSeq = Number(session.step_count) + 1;
        let nextStepId: string;
        try {
          nextStepId = await insertProposedStep(tx, session, proposal, skill, nextSeq);
        } catch (error) {
          // UNIQUE(session_id, seq) 競合（二重送信）は 409 として返す。
          if ((error as { code?: string }).code === '23505') {
            return {
              failure: new ApiError(
                409,
                'STEP_NOT_CONTINUABLE',
                '別の操作でステップが進みました。画面を再読み込みしてください。',
              ),
            };
          }
          throw error;
        }
        await tx`
          UPDATE resolution_sessions
          SET status = 'waiting_execute', step_count = ${nextSeq}, updated_at = now()
          WHERE id = ${session.id}
        `;
        await appendResolveAudit(tx, {
          action: 'resolution.proposed',
          sessionId: session.id,
          actorEmail: email,
          stepId: nextStepId,
          detail: {
            seq: nextSeq,
            skillId: skill.id,
            riskLevel: skill.riskLevel,
            source: proposal.source,
          },
        });
        return { nextStepId };
      });

      if (isFailure(outcome)) throw outcome.failure;
      const session = await loadSession(email, current.session.id);
      if ('escalated' in outcome) {
        // これ以上安全に試せる Skill が無い / 進捗なし / AI の終了宣言。
        // セッションを escalated にして理由を返す（resolved にはしない）。
        const reasonCode =
          outcome.reason === 'no_progress'
            ? 'NO_PROGRESS'
            : outcome.reason === 'no_skill'
              ? 'NO_SKILL'
              : outcome.reason === 'ai_stop'
                ? 'AI_STOP'
                : 'AI_ESCALATED';
        return {
          ok: true,
          session: sessionDto(session),
          step: null,
          reason: reasonCode,
        };
      }
      const { step } = await loadStepAndSession(email, outcome.nextStepId);
      return { ok: true, session: sessionDto(session), step: stepDto(step, session) };
    },
  );

  // 中止（常時表示の「中止」ボタン）。
  app.post(
    '/resolve/sessions/:id/stop',
    { preHandler: authenticateUi, bodyLimit: 4 * 1024 },
    async (request) => {
      const email = requireEmail(request);
      enforceRateLimit(`resolve-stop:${email}`, 10, '中止の操作が多すぎます。');
      const { id: sessionId } = SessionIdParamsSchema.parse(request.params);
      await sql.begin(async (tx) => {
        const sessionRows = await tx<SessionRow[]>`
          SELECT * FROM resolution_sessions
          WHERE id = ${sessionId} AND user_email = ${email}
          FOR UPDATE
        `;
        const session = sessionRows[0];
        if (!session) throw notFound('解決セッションが見つかりません。');
        if (TERMINAL_SESSION_STATUSES.has(session.status)) return;
        await tx`
          UPDATE resolution_sessions SET status = 'stopped', updated_at = now()
          WHERE id = ${session.id}
        `;
        await cancelSessionWork(tx, session.id);
        await appendResolveAudit(tx, {
          action: 'resolution.stopped',
          sessionId: session.id,
          actorEmail: email,
          detail: { reason: 'user_stop' },
        });
      });
      const session = await loadSession(email, sessionId);
      return { ok: true, session: sessionDto(session) };
    },
  );

  // 本人による「解決した」。設計 §4-4 の本人確認。
  app.post(
    '/resolve/sessions/:id/resolve',
    { preHandler: authenticateUi, bodyLimit: 4 * 1024 },
    async (request) => {
      const email = requireEmail(request);
      enforceRateLimit(`resolve-manual:${email}`, 20, '操作が多すぎます。');
      const { id: sessionId } = SessionIdParamsSchema.parse(request.params);
      const input = ManualCloseSchema.parse(request.body ?? {});
      if (await isEstopOn(email)) {
        throw new ApiError(409, 'ESTOP_ACTIVE', '緊急停止中です。解除してからやり直してください。');
      }
      await manualCloseSession(email, sessionId, 'resolved', input.reason);
      const session = await loadSession(email, sessionId);
      return { ok: true, session: sessionDto(session) };
    },
  );

  // 本人による「担当者へ」。監査に理由を残してエスカレーションする。
  app.post(
    '/resolve/sessions/:id/escalate',
    { preHandler: authenticateUi, bodyLimit: 4 * 1024 },
    async (request) => {
      const email = requireEmail(request);
      enforceRateLimit(`resolve-manual:${email}`, 20, '操作が多すぎます。');
      const { id: sessionId } = SessionIdParamsSchema.parse(request.params);
      const input = ManualCloseSchema.parse(request.body ?? {});
      await manualCloseSession(email, sessionId, 'escalated', input.reason);
      const session = await loadSession(email, sessionId);
      return { ok: true, session: sessionDto(session) };
    },
  );

  // セッション詳細（状態 + ステップ概要）。
  app.get('/resolve/sessions/:id', { preHandler: authenticateUi }, async (request) => {
    const email = requireEmail(request);
    enforceRateLimit(`resolve-session-get:${email}`, 120, '状態確認が多すぎます。');
    const { id: sessionId } = SessionIdParamsSchema.parse(request.params);
    await sweepResolveTimeouts();
    const session = await loadSession(email, sessionId);
    const steps = await loadStepsForSession(session.id);
    return {
      ok: true,
      session: sessionDto(session),
      steps: steps.map(stepSummaryDto),
    };
  });
}
