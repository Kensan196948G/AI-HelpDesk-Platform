import { hashSid } from '../folder-access/sign.js';
import { appendAudit } from '../lib/audit-log.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import {
  isOpenSession,
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
  // 実行中の変更系は、結果が届くまで「変更が生じた可能性」を隠さない。
  await tx`
    UPDATE assist_executions e
    SET partial_effect = COALESCE(e.partial_effect, '[]'::jsonb) || ${jsonbValue(['POSSIBLE_CHANGE'])}
    FROM assist_proposals p
    WHERE e.proposal_id = p.id
      AND e.support_session_id = ${sessionId}
      AND e.status = 'executing'
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
    WHERE id = ${session.id} AND status IN (
      'binding_pending', 'consent_pending', 'ready', 'proposing', 'awaiting_approval',
      'approved', 'executing', 'verifying', 'awaiting_next', 'resolve_confirm'
    )
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
