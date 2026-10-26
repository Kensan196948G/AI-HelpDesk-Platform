import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stableStringify } from '../domain/audit.js';
import { redactPII } from '../domain/pii.js';

/** 1 セッションの最大ステップ数（設計 §2）。 */
export const MAX_STEPS = 20;
/** 1 ステップの出力の最大文字数。超えた分は切り詰めて明示する。 */
export const MAX_OUTPUT_CHARS = 20_000;
/** 実行コマンドの最大文字数。 */
export const MAX_COMMAND_CHARS = 8_000;
/** 補足・終了理由の最大文字数。 */
export const MAX_NOTE_CHARS = 1_000;
/** AI に渡す目的の最大文字数。 */
export const MAX_INTENT_CHARS = 500;
/** AI に渡す直近出力の最大文字数。 */
export const MAX_LAST_OUTPUT_CHARS = 4_000;
/** セッションの既定 TTL（分）。 */
export const DEFAULT_TTL_MINUTES = 30;
/** セッションの最大 TTL（分）。 */
export const MAX_TTL_MINUTES = 120;

/**
 * 実行記録の出力ソース。
 *
 * - `auto`: RSP のターミナルログからの自動取込（Phase 4・未対応）。
 * - `manual`: 担当者が実行して貼り付けた出力。
 * - `rsp_command`: RSP の W23 コマンドキューで実行した実出力の取込（Phase 2）。
 */
export type OutputSource = 'auto' | 'manual' | 'rsp_command';

/** 相関ID（RSP 側の command log_id / remote_session_id）の最大文字数。 */
export const MAX_CORRELATION_ID_CHARS = 64;

export const ConsentSchema = z.object({
  screenShare: z.boolean().default(false),
  // ターミナル操作は「操作支援」に含める。false ではセッションを作れない。
  remoteControl: z.boolean(),
});

export const CreateSessionSchema = z.object({
  consent: ConsentSchema,
  ttlMinutes: z.number().int().min(5).max(MAX_TTL_MINUTES).default(DEFAULT_TTL_MINUTES),
});

export const ProposeSchema = z.object({
  intent: z.string().trim().min(1).max(MAX_INTENT_CHARS),
  lastOutput: z.string().max(MAX_LAST_OUTPUT_CHARS).optional(),
});

export const RecordSchema = z
  .object({
    command: z.string().trim().min(1).max(MAX_COMMAND_CHARS),
    output: z.string().max(MAX_OUTPUT_CHARS).optional(),
    outputSource: z.enum(['auto', 'manual', 'rsp_command']),
    exitStatus: z.enum(['success', 'failure', 'unknown']),
    note: z.string().trim().max(MAX_NOTE_CHARS).optional(),
    // RSP のコマンドキューで実行した場合の出所（Phase 2）。
    rspCommandLogId: z.string().trim().min(1).max(MAX_CORRELATION_ID_CHARS).optional(),
    // RSP の remote_session との相互参照（任意）。
    rspSessionId: z.string().trim().min(1).max(MAX_CORRELATION_ID_CHARS).optional(),
  })
  .superRefine((value, ctx) => {
    // rsp_command は「どの実行結果か」を追えなければ意味がないため必須にする。
    if (value.outputSource === 'rsp_command' && !value.rspCommandLogId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rspCommandLogId'],
        message: 'outputSource が rsp_command のときは rspCommandLogId が必要です。',
      });
    }
  });

export const CloseSchema = z.object({
  reason: z.enum(['resolved', 'stopped', 'escalated']),
  note: z.string().trim().max(MAX_NOTE_CHARS).optional(),
});

export const KnowledgeDraftSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  cause: z.string().trim().max(4_000).optional(),
});

export interface MaskedText {
  text: string;
  truncated: boolean;
  findings: Array<{ type: string; count: number }>;
}

/**
 * コマンド・出力を保存用に整形する。
 *
 * 出力にはパスワード・トークン・個人情報が混ざり得るため、保存・ハッシュ・報告書の
 * すべてを「マスク後の値」で揃える。長すぎる出力は切り詰め、切り詰めたことを
 * `truncated` で明示する（黙って捨てない）。
 */
export function maskText(raw: string | undefined | null, limit: number): MaskedText {
  const source = String(raw ?? '');
  const masked = redactPII(source);
  const truncated = masked.text.length > limit;
  return {
    text: truncated ? masked.text.slice(0, limit) : masked.text,
    truncated,
    findings: masked.findings,
  };
}

export interface StepHashInput {
  sessionId: string;
  stepId: string;
  seq: number;
  command: string;
  output: string;
  outputSource: OutputSource;
  exitStatus: 'success' | 'failure' | 'unknown';
}

/** 実行記録のハッシュ。保存値（マスク後）と検証方法を一致させる。 */
export function computeStepHash(input: StepHashInput): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

export interface TerminalSessionRow {
  id: string;
  case_id: string;
  handover_id: string | null;
  device: string;
  operator_email: string;
  requester_email: string | null;
  status: 'active' | 'closed';
  close_reason: string | null;
  close_note: string | null;
  consent_screen_share: boolean;
  consent_remote_control: boolean;
  ai_model: string | null;
  knowledge_id: string | null;
  report_id: string | null;
  report_sha256: string | null;
  /** RSP の remote_session ID（Phase 2 で追加・相互参照用）。 */
  rsp_session_id: string | null;
  started_at: Date;
  expires_at: Date;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TerminalStepRow {
  id: string;
  session_id: string;
  seq: number;
  operator_email: string;
  intent: string | null;
  ai_command: string | null;
  ai_purpose: string | null;
  ai_risk: 'low' | 'medium' | 'high' | null;
  ai_verify: string | null;
  ai_rollback: string | null;
  ai_warnings: unknown;
  ai_model: string | null;
  executed_command: string | null;
  output: string | null;
  output_source: OutputSource | null;
  exit_status: 'success' | 'failure' | 'unknown' | null;
  note: string | null;
  sha256: string | null;
  /** RSP の command log_id（Phase 2 で追加・rsp_command の出所）。 */
  rsp_command_log_id: string | null;
  proposed_at: Date;
  recorded_at: Date | null;
}

export interface TerminalSessionDto {
  id: string;
  caseId: string;
  handoverId: string | null;
  device: string;
  status: 'active' | 'closed';
  closeReason: string | null;
  closeNote: string | null;
  operatorEmail: string;
  requesterEmail: string | null;
  startedAt: string;
  expiresAt: string;
  closedAt: string | null;
  aiModel: string | null;
  consent: { screenShare: boolean; remoteControl: boolean };
  knowledgeId: string | null;
  knowledge: { id: string; kbNo: string; status: string; title: string } | null;
  report: { id: string | null; sha256: string | null };
  /** RSP の remote_session ID（未相関なら null）。 */
  rspSessionId: string | null;
  stepCount: number;
  limits: { maxSteps: number; maxOutputChars: number };
  capture: { supported: boolean; reason: string | null };
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function warningsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).slice(0, 10) : [];
}

export function sessionDto(
  row: TerminalSessionRow,
  input: {
    stepCount: number;
    capture: { supported: boolean; reason: string | null };
    knowledge?: { id: string; kbNo: string; status: string; title: string } | null;
  },
): TerminalSessionDto {
  return {
    id: row.id,
    caseId: row.case_id,
    handoverId: row.handover_id,
    device: row.device,
    status: row.status,
    closeReason: row.close_reason,
    closeNote: row.close_note,
    operatorEmail: row.operator_email,
    requesterEmail: row.requester_email,
    startedAt: iso(row.started_at) as string,
    expiresAt: iso(row.expires_at) as string,
    closedAt: iso(row.closed_at),
    aiModel: row.ai_model,
    consent: {
      screenShare: row.consent_screen_share,
      remoteControl: row.consent_remote_control,
    },
    knowledgeId: row.knowledge_id,
    knowledge: input.knowledge ?? null,
    report: { id: row.report_id, sha256: row.report_sha256 },
    rspSessionId: row.rsp_session_id,
    stepCount: input.stepCount,
    limits: { maxSteps: MAX_STEPS, maxOutputChars: MAX_OUTPUT_CHARS },
    capture: input.capture,
  };
}

export function stepDto(row: TerminalStepRow) {
  const executed = row.recorded_at
    ? {
        command: row.executed_command ?? '',
        output: row.output ?? '',
        outputSource: row.output_source ?? 'manual',
        exitStatus: row.exit_status ?? 'unknown',
        note: row.note,
        sha256: row.sha256,
        // 未相関（Phase 2 以前・手動記録）は null を返す（キー自体は常に返す）。
        rspCommandLogId: row.rsp_command_log_id,
        recordedAt: iso(row.recorded_at),
      }
    : null;
  return {
    id: row.id,
    seq: row.seq,
    intent: row.intent ?? '',
    proposedAt: iso(row.proposed_at),
    operatorEmail: row.operator_email,
    proposal: {
      command: row.ai_command ?? '',
      purpose: row.ai_purpose ?? '',
      risk: row.ai_risk ?? 'medium',
      verify: row.ai_verify ?? '',
      rollback: row.ai_rollback ?? '',
      warnings: warningsOf(row.ai_warnings),
      model: row.ai_model ?? '',
    },
    executed,
  };
}

export type TerminalStepDto = ReturnType<typeof stepDto>;
