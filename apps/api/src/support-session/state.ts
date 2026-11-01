import { stableStringify } from '../domain/audit.js';

/**
 * 共通支援セッションの純関数（docs/63）。DB / ネットワークに触れない。
 * 上限はここで一元管理する（§8）。resolve の 6 ステップ、terminal の 20、旧 UI の 15 とは別物。
 */

export const ASSIST_LIMITS = {
  /** 1 セッションの提案数。確認操作は数えない（§8）。 */
  maxProposals: 6,
  sessionMinutes: 30,
  /** Y/N を受け付ける時間（§5）。 */
  approvalMinutes: 5,
  /** 配信から /start までの期限。ヘルパーのポーリングは 120 秒以内なので余裕を見る。 */
  opSeconds: 180,
  /** Skill の timeoutSec に足す、結果報告までの猶予。 */
  runGraceSeconds: 30,
  maxOutputBytes: 8192,
  maxConsentTtlMinutes: 30,
  /** 進行中のヘルパーへ勧めるポーリング間隔。 */
  activePollSeconds: 5,
  /** 失効したトークンで結果を報告できる時間。helper の revoked_at が基準で、再送で延長しない。 */
  revokedReportHours: 24,
  /** proposing の期限の下限。AI の応答待ちにも余裕を足す（proposingSeconds）。 */
  minProposingSeconds: 120,
  proposingGraceSeconds: 60,
} as const;

export const OPERATION_CONSENT_VERSION = 'operation-consent/1';
export const AI_INPUT_CONSENT_VERSION = 'ai-input-consent/1';
/** フォルダ同意（docs/62）には版の列が無いので、同意文の版を固定値として束縛する。 */
export const FOLDER_CONSENT_VERSION = 'folder-consent/1';

export const OPERATION_SCOPES = ['read_only', 'user_reversible'] as const;
export type OperationScope = (typeof OPERATION_SCOPES)[number];

export const OPEN_SESSION_STATUSES = [
  'binding_pending',
  'consent_pending',
  'ready',
  'proposing',
  'awaiting_approval',
  'approved',
  'executing',
  'verifying',
  'awaiting_next',
  'resolve_confirm',
] as const;
export type OpenSessionStatus = (typeof OPEN_SESSION_STATUSES)[number];
export type TerminalSessionStatus = 'resolved' | 'stopped' | 'escalated' | 'expired' | 'revoked';

export function isOpenSession(status: string): boolean {
  return (OPEN_SESSION_STATUSES as readonly string[]).includes(status);
}

export const SESSION_END_REASONS = [
  // 本人
  'resolved',
  'requester_revoked',
  'requester_declined',
  // 担当者
  'operator_stop',
  // 期限
  'expired',
  'approval_expired',
  'execution_expired',
  'execution_timeout',
  'proposing_timeout',
  // 束縛（docs/62 の終了理由と同名）
  'assignee_changed',
  'session_changed',
  'user_logged_off',
  'helper_revoked',
  'lease_conflict',
  'device_mismatch',
  'sid_mismatch',
  'binding_changed',
  'session_not_active',
  // 反復の停止条件（§8）
  'proposal_limit',
  'duplicate_proposal',
  'no_progress',
  'no_candidate',
  'ai_consent_changed',
  'execution_failed',
  'verify_failed',
  'unverifiable',
  'result_mismatch',
  'ai_stop',
  'escalated',
] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/** proposing の期限（秒）。AI の応答を待つ時間より必ず長くする。 */
export function proposingSeconds(aiTimeoutMs: number): number {
  return Math.max(
    ASSIST_LIMITS.minProposingSeconds,
    Math.ceil(aiTimeoutMs / 1000) + ASSIST_LIMITS.proposingGraceSeconds,
  );
}

export function terminalStatusForSession(reason: SessionEndReason): TerminalSessionStatus {
  switch (reason) {
    case 'resolved':
      return 'resolved';
    case 'escalated':
      return 'escalated';
    case 'expired':
    case 'approval_expired':
      return 'expired';
    case 'requester_revoked':
    case 'assignee_changed':
    case 'session_changed':
    case 'user_logged_off':
    case 'helper_revoked':
    case 'lease_conflict':
    case 'device_mismatch':
    case 'sid_mismatch':
      return 'revoked';
    default:
      return 'stopped';
  }
}

/** フォルダ同意の終了理由（docs/62 §3）をセッションの終了理由へ写す。 */
export function sessionReasonForFolderEnd(reason: string): SessionEndReason {
  switch (reason) {
    case 'requester_revoked':
    case 'expired':
    case 'assignee_changed':
    case 'session_changed':
    case 'user_logged_off':
    case 'helper_revoked':
    case 'lease_conflict':
    case 'device_mismatch':
    case 'sid_mismatch':
      return reason;
    default:
      return 'operator_stop';
  }
}

/** セッションの終了で、フォルダ同意（とヘルパーのトークン）をどの理由で終えるか（§10）。 */
export function folderReasonForSessionEnd(
  reason: SessionEndReason,
): 'requester_revoked' | 'expired' | 'operator_end' {
  if (reason === 'requester_revoked' || reason === 'requester_declined') {
    return 'requester_revoked';
  }
  if (reason === 'expired') return 'expired';
  return 'operator_end';
}

/** 実行の結果の指紋（Skill + params + 正規化した出力）。キーの順序に左右されない。 */
export function progressFingerprint(skillId: string, params: unknown, output: unknown): string {
  return stableStringify({ skillId, params, output });
}

/**
 * 進捗なし（§8）。同じ操作が同じ結果を返したとき。直前に限らないので、
 * 別の Skill を交互に実行して何も変わらない場合も検出する。異なる操作の成功は進捗として扱う。
 */
export function isNoProgress(previous: readonly string[], current: string): boolean {
  return previous.includes(current);
}
