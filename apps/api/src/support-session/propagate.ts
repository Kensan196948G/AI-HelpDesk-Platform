import { config } from '../config.js';
import { hashSid } from '../folder-access/sign.js';
import { appendAudit } from '../lib/audit-log.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import {
  isOpenSession,
  OPEN_SESSION_STATUSES,
  type SessionEndReason,
  sessionReasonForFolderEnd,
  terminalStatusForSession,
} from './state.js';

/**
 * 失効の伝搬（docs/63 §10）。folder-access/service.ts の endRequestTx から呼ばれるので、
 * 循環を避けるためここからは folder-access のサービスを読み込まない。
 * 呼び出し側は sql.begin の中から呼ぶ。ロック順は「依頼 → セッション → 提案 → 実行」。
 */

// postgres.js のトランザクション型は循環を避けて緩く受ける（audit-log.ts と同じ）。
type AnyTx = any;

export type AssistMode = 'off' | 'drain' | 'on';

/**
 * 動作モード（docs/63 §12）。ASSIST_SESSION_MODE を優先し、未設定なら ASSIST_SESSION_ENABLED に従う。
 * フォルダ機能が無効なら経路がないので off。設定を起動後に変えられるテストのため呼び出しごとに読む。
 */
export function assistMode(): AssistMode {
  if (!config.FOLDER_ACCESS_ENABLED) return 'off';
  return config.ASSIST_SESSION_MODE ?? (config.ASSIST_SESSION_ENABLED ? 'on' : 'off');
}

/**
 * 既存のセッションを処理するか（on と drain）。off なら定期処理の識別子の消去を除いて
 * 新テーブルに触らない（030 未適用の DB でも既存の経路を壊さない）。
 */
export function assistEnabled(): boolean {
  return assistMode() !== 'off';
}

/** 新しい受付（開始・同意・提案・Y）を受けるか。drain では既存の終了処理だけを動かす。 */
export function assistAcceptingNew(): boolean {
  return assistMode() === 'on';
}

interface SessionKeyRow {
  id: string;
  case_id: string;
  status: string;
  sid: string | null;
  windows_session_id: number | null;
  assignee_email: string;
  operation_consent_id: string | null;
}

/** 実行の取消。未配送は cancelled、配送済みは /start が拒否、実行中は停止要求。 */
export async function stopExecutionsTx(tx: AnyTx, sessionId: string): Promise<void> {
  await tx`
    UPDATE assist_executions
    SET status = 'cancelled', stop_requested_at = COALESCE(stop_requested_at, now()),
        cancel_acked_at = COALESCE(cancel_acked_at, now()),
        stop_outcome = 'not_running', stopped_at = now()
    WHERE support_session_id = ${sessionId} AND status = 'queued'
  `;
  await tx`
    UPDATE assist_executions
    SET stop_requested_at = COALESCE(stop_requested_at, now())
    WHERE support_session_id = ${sessionId} AND status IN ('delivered', 'executing')
  `;
  // 変更系は、結果と確認が揃うまで「変更が生じた可能性」を隠さない。
  // 実行中・タイムアウト済みの本体と、確認操作の途中で止まった完了済みの本体が対象。
  await tx`
    UPDATE assist_executions e
    SET partial_effect = COALESCE(e.partial_effect, '[]'::jsonb) || ${jsonbValue(['POSSIBLE_CHANGE'])}
    FROM assist_proposals p
    WHERE e.proposal_id = p.id
      AND e.support_session_id = ${sessionId}
      AND (
        e.status IN ('executing', 'timed_out')
        OR (e.status = 'completed' AND p.status = 'verifying')
      )
      AND e.role = 'main'
      AND p.effect = 'modify'
      AND NOT COALESCE(e.partial_effect, '[]'::jsonb) ? 'POSSIBLE_CHANGE'
  `;
}

/** セッションを終端にする。終端済みなら何もしない（false）。 */
export async function terminateSessionTx(
  tx: AnyTx,
  session: SessionKeyRow,
  reason: SessionEndReason,
  actorEmail: string,
): Promise<boolean> {
  const status = terminalStatusForSession(reason);
  const updated = await tx`
    UPDATE support_sessions
    SET status = ${status}, end_reason = ${reason}, ended_at = now(), updated_at = now()
    WHERE id = ${session.id} AND status = ANY(${[...OPEN_SESSION_STATUSES]}::text[])
    RETURNING id
  `;
  if (!updated[0]) return false;
  await stopExecutionsTx(tx, session.id);
  await tx`
    UPDATE assist_proposals
    SET status = 'invalidated'
    WHERE support_session_id = ${session.id} AND status IN ('proposed', 'approved')
  `;
  await tx`
    UPDATE assist_proposals
    SET status = 'failed'
    WHERE support_session_id = ${session.id} AND status IN ('executing', 'verifying')
  `;
  await tx`
    UPDATE operation_consents
    SET revoked_at = now(), revoke_reason = ${reason}
    WHERE support_session_id = ${session.id} AND revoked_at IS NULL
  `;
  await tx`
    UPDATE ai_input_consents
    SET revoked_at = now(), revoke_reason = ${reason}
    WHERE support_session_id = ${session.id} AND revoked_at IS NULL
  `;
  await appendAudit(tx, {
    actorId: null,
    action: 'support_session.end',
    targetType: 'support_session',
    targetId: session.id,
    detail: {
      actorEmail,
      caseId: session.case_id,
      assigneeEmail: session.assignee_email,
      sidHash: session.sid ? hashSid(session.sid) : null,
      windowsSessionId: session.windows_session_id,
      operationConsentId: session.operation_consent_id,
      status,
      endReason: reason,
    },
  });
  return true;
}

/** フォルダ同意の終了を、紐づく進行中のセッションへ伝える。 */
export async function terminateSessionsForFolderRequestTx(
  tx: AnyTx,
  folderRequestId: string,
  folderReason: string,
  actorEmail: string,
): Promise<void> {
  if (!assistEnabled()) return;
  const rows: SessionKeyRow[] = await tx`
    SELECT id, case_id, status, sid, windows_session_id, assignee_email, operation_consent_id
    FROM support_sessions
    WHERE folder_request_id = ${folderRequestId}
    FOR UPDATE
  `;
  const reason = sessionReasonForFolderEnd(folderReason);
  for (const row of rows) {
    if (isOpenSession(row.status)) await terminateSessionTx(tx, row, reason, actorEmail);
  }
}
