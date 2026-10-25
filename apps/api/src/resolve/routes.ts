import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticateUi } from '../auth/ui.js';
import { sql } from '../db.js';
import { stableStringify } from '../domain/audit.js';
import { redactPII } from '../domain/pii.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { appendAudit } from '../lib/audit-log.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { checkRateLimit } from '../lib/rate-limit.js';
import {
  type ApprovalChallenge,
  approvalHashMatches,
  buildApprovalPayload,
  computeApprovalHash,
  newNonce,
} from './approval.js';
import { type Proposal, type ProposalHistoryEntry, proposeNext } from './proposer.js';
import {
  listApprovedSkills,
  normalizeJsonValue,
  type SkillRecord,
  type SkillRow,
  toSkillRecord,
  validateParams,
} from './skills.js';

const SESSION_TTL_SQL = sql`now() + interval '30 minutes'`;
const SESSION_MAX_STEPS = 6;
const STEP_APPROVAL_TTL_SQL = sql`now() + interval '5 minutes'`;
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
  error: string | null;
  created_at: Date | string;
  executed_at: Date | string | null;
  approval_expires_at: Date | string;
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
    resultFull: jsonObjectOrNull(row.result_full),
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
  const rows = await tx<{ id: string }[]>`
    INSERT INTO resolution_steps (
      session_id, seq, skill_id, skill_version, skill_content_hash, params, rationale,
      risk_level, status, nonce, approval_expires_at
    ) VALUES (
      ${session.id}, ${seq}, ${skill.id}, ${skill.version}, ${skill.contentHash ?? 'sha256:unknown'},
      ${jsonbValue(proposal.params)}, ${proposal.rationale}, ${skill.riskLevel}, 'proposed',
      ${nonce}, ${STEP_APPROVAL_TTL_SQL}
    )
    RETURNING id
  `;
  const stepId = rows[0]?.id;
  if (!stepId) throw new Error('resolution step insert failed');
  return stepId;
}

/**
 * 端末コマンドの結果を取り込み、step / session を完了状態へ進める。
 * GET から何度呼ばれても二重更新しない（条件付き UPDATE + RETURNING で判定）。
 */
async function applyCommandOutcome(email: string, stepId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const stepRows = await tx<StepRow[]>`
      SELECT * FROM resolution_steps WHERE id = ${stepId} FOR UPDATE
    `;
    const step = stepRows[0];
    if (!step || !step.command_id) return;
    const sessionRows = await tx<SessionRow[]>`
      SELECT * FROM resolution_sessions
      WHERE id = ${step.session_id} AND user_email = ${email}
      FOR UPDATE
    `;
    const session = sessionRows[0];
    if (!session) return;

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
      const { summary, full } = buildResultPayload(command.result, command.error, true);
      const updated = await tx<{ id: string }[]>`
        UPDATE resolution_steps
        SET status = 'done', executed_at = COALESCE(executed_at, now()),
            result_summary = ${jsonbValue(summary)}, result_full = ${jsonbValue(full)},
            error = ${command.error ? redactPII(command.error).text.slice(0, 2000) : null}
        WHERE id = ${step.id} AND status IN ('approved', 'executing')
        RETURNING id
      `;
      if (!updated[0]) return;
      await tx`
        UPDATE resolution_sessions
        SET status = 'waiting_continue', last_summary = ${jsonbValue(summary)}, updated_at = now()
        WHERE id = ${session.id} AND status = 'executing'
      `;
      await appendResolveAudit(tx, {
        action: 'resolution.result',
        sessionId: session.id,
        actorEmail: email,
        stepId: step.id,
        detail: { commandId: step.command_id, ok: true },
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
      const updated = await tx<{ id: string }[]>`
        UPDATE resolution_steps
        SET status = 'failed', executed_at = COALESCE(executed_at, now()),
            result_summary = ${jsonbValue(summary)}, error = ${redactedError}
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

/** 端末結果を要約（AI/画面向け）と全文（伏せ字・上限つき）に分ける。 */
function buildResultPayload(
  result: unknown,
  error: string | null,
  ok: boolean,
): { summary: Record<string, unknown>; full: Record<string, unknown> } {
  const raw = normalizeJsonValue(result);
  const record = jsonObjectOrNull(raw);
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
    ok,
    exitCode,
    summary: redactedSummary,
    normalized: redactJsonValue(normalized),
  };
  const full: Record<string, unknown> = {
    result: redactJsonValue(raw),
    error: error ? redactPII(error).text.slice(0, 4000) : null,
  };
  return { summary, full };
}

function summaryToText(summary: unknown): string {
  const record = jsonObjectOrNull(summary);
  if (!record) return '';
  try {
    return JSON.stringify(record).slice(0, 1000);
  } catch {
    return '';
  }
}

async function loadProposalHistory(sessionId: string): Promise<ProposalHistoryEntry[]> {
  const rows = await sql<{ skill_id: string; params: unknown; status: string }[]>`
    SELECT skill_id, params, status FROM resolution_steps
    WHERE session_id = ${sessionId} AND status NOT IN ('rejected', 'cancelled', 'skipped')
    ORDER BY seq ASC
  `;
  return rows.map((row) => ({ skillId: row.skill_id, params: jsonObject(row.params) }));
}

export async function resolveRoutes(app: FastifyInstance): Promise<void> {
  // TODO(Phase B): 緊急停止（estop）は既存 helpdesk の状態（prototype_states.helpdesk）を
  // 参照できないため未接続。Phase C で estop と接続し、ON のときはセッション開始・承認・
  // 実行をすべて ESTOP_ACTIVE で拒否する（設計 §4-3）。
  // TODO(Phase B): 端末オフライン / 結果タイムアウト（RESULT_TIMEOUT）の監視は未実装。
  // 現状は device_commands の status（done/failed）だけで完了判定する。
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
      const ownedCase = await findOwnedCase(email, input.caseId);
      if (!ownedCase) throw notFound('案件が見つかりません。');

      const skills = await listApprovedSkills();
      const proposal = await proposeNext({
        text: caseText(ownedCase),
        lastSummary: null,
        history: [],
        skills,
      });
      if (!proposal) {
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

      const outcome = await sql.begin(async (tx) => {
        const stepRows = await tx<StepRow[]>`
          SELECT * FROM resolution_steps WHERE id = ${stepId} FOR UPDATE
        `;
        const step = stepRows[0];
        if (!step) return { failure: notFound('ステップが見つかりません。') };
        const sessionRows = await tx<SessionRow[]>`
          SELECT * FROM resolution_sessions
          WHERE id = ${step.session_id} AND user_email = ${email}
          FOR UPDATE
        `;
        const session = sessionRows[0];
        if (!session) return { failure: notFound('ステップが見つかりません。') };

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

        if (Number(step.risk_level) >= 4) {
          return {
            failure: new ApiError(
              403,
              'ADMIN_APPROVAL_REQUIRED',
              'リスクレベル 4 以上の Skill は IT 管理者の承認が必要です（自己承認はできません）。',
            ),
          };
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
            user_email, device_id, op_id, params, skill_id, skill_version, session_id, step_id
          ) VALUES (
            ${session.user_email}, ${session.device_id}, ${step.skill_id},
            ${jsonbValue(params)}, ${step.skill_id}, ${step.skill_version},
            ${session.id}, ${step.id}
          )
          RETURNING id, op_id, params, status, device_id, skill_id, skill_version,
                    session_id, step_id, created_at
        `;
        const command = commandRows[0];
        if (!command) throw new Error('device command insert failed');

        const updated = await tx<{ id: string }[]>`
          UPDATE resolution_steps
          SET status = 'approved', approval_hash = ${expectedHash},
              approved_by = ${email}, approved_at = now(), command_id = ${command.id}
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
    const current = await loadStepAndSession(email, stepId);
    if (current.step.command_id) {
      await applyCommandOutcome(email, stepId);
    }
    const { step, session } = await loadStepAndSession(email, stepId);
    return { ok: true, step: stepDto(step, session), session: sessionDto(session) };
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
          await tx`
            UPDATE resolution_steps SET status = 'cancelled'
            WHERE session_id = ${session.id} AND status = 'proposed'
          `;
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

      // 次提案の材料（case 本文・直近結果・実行履歴）。提案生成は DB ロックの外で行う。
      const ownedCase = await findOwnedCase(email, current.session.case_id);
      const [skills, history] = await Promise.all([
        listApprovedSkills(),
        loadProposalHistory(current.session.id),
      ]);
      const proposal = await proposeNext({
        text: caseText(ownedCase),
        lastSummary: summaryToText(current.session.last_summary),
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
        // これ以上安全に試せる Skill が無い / 進捗なし。セッションを escalated にして理由を返す。
        return {
          ok: true,
          session: sessionDto(session),
          step: null,
          reason: outcome.reason === 'no_progress' ? 'NO_PROGRESS' : 'NO_SKILL',
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
        await tx`
          UPDATE resolution_steps SET status = 'cancelled'
          WHERE session_id = ${session.id} AND status = 'proposed'
        `;
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

  // セッション詳細（状態 + ステップ概要）。
  app.get('/resolve/sessions/:id', { preHandler: authenticateUi }, async (request) => {
    const email = requireEmail(request);
    enforceRateLimit(`resolve-session-get:${email}`, 120, '状態確認が多すぎます。');
    const { id: sessionId } = SessionIdParamsSchema.parse(request.params);
    const session = await loadSession(email, sessionId);
    const steps = await loadStepsForSession(session.id);
    return {
      ok: true,
      session: sessionDto(session),
      steps: steps.map(stepSummaryDto),
    };
  });
}
