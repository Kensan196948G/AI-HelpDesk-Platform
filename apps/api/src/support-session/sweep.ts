import { config } from '../config.js';
import { sql } from '../db.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { assistEnabled } from './propagate.js';
import { applyLiveness, lockSession, sessionAudit } from './service.js';
import { ASSIST_LIMITS, OPEN_SESSION_STATUSES } from './state.js';

export interface SweepLog {
  error: (obj: unknown, msg: string) => void;
}

const consoleLog: SweepLog = {
  error: (obj, msg) => console.error(msg, obj),
};

/** 1 件の失敗で残りの処理を止めない。メッセージだけを記録する（端末の値を出さない）。 */
async function guarded(
  log: SweepLog,
  step: string,
  ref: Record<string, unknown>,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    log.error(
      { step, ...ref, message: error instanceof Error ? error.message : String(error) },
      '共通支援セッションの期限処理の一部に失敗しました。',
    );
  }
}

/** 期限の定期処理（docs/63 §10）。DB だけを触る。機能フラグが無効の間は何もしない。 */
export async function sweepSupportSessions(log: SweepLog = consoleLog): Promise<number> {
  // 無効なら新テーブルに触らない（030 未適用の DB で失敗し続けない）。有効に戻せば追いつく。
  if (!assistEnabled()) return 0;
  const due = await sql<{ id: string }[]>`
    SELECT DISTINCT s.id
    FROM support_sessions s
    LEFT JOIN assist_proposals p ON p.support_session_id = s.id AND p.status = 'proposed'
    LEFT JOIN assist_executions e ON e.support_session_id = s.id
    WHERE s.status = ANY(${[...OPEN_SESSION_STATUSES]}::text[])
      AND (
        s.expires_at <= now()
        OR (s.status = 'proposing' AND s.proposing_expires_at <= now())
        OR s.operation_consent_expires_at <= now()
        OR p.approval_expires_at <= now()
        OR (e.status IN ('queued', 'delivered') AND e.expires_at <= now())
        OR (e.status = 'executing' AND e.deadline_at <= now())
      )
  `;
  let ended = 0;
  for (const { id } of due) {
    await guarded(log, 'liveness', { sessionId: id }, () =>
      sql.begin(async (tx) => {
        const locked = await lockSession(tx, id);
        if (!locked) return;
        const before = locked.session.status;
        await applyLiveness(tx, locked.ctx, locked.session, 'system:sweep');
        if (locked.session.status !== before) ended += 1;
      }),
    );
  }

  // 終端後に開始されなかった配送を閉じる。
  await guarded(
    log,
    'close_delivered',
    {},
    () => sql`
    UPDATE assist_executions e
    SET status = 'expired', stop_outcome = COALESCE(stop_outcome, 'not_running'),
        stopped_at = COALESCE(stopped_at, now())
    FROM support_sessions s
    WHERE e.support_session_id = s.id
      AND s.ended_at IS NOT NULL
      AND e.status = 'delivered'
      AND e.expires_at <= now()
  `,
  );
  // 停止要求の後に報告が届かないものは、止まったと書かない（§10）。
  await guarded(
    log,
    'stop_unconfirmed',
    {},
    () => sql`
    UPDATE assist_executions e
    SET stop_outcome = 'stop_unconfirmed',
        status = CASE WHEN e.status = 'executing' THEN 'timed_out' ELSE e.status END,
        partial_effect = CASE WHEN e.role = 'main' AND p.effect = 'modify'
          THEN COALESCE(e.partial_effect, '[]'::jsonb) || ${jsonbValue(['STOP_UNCONFIRMED'])}
          ELSE e.partial_effect END
    FROM assist_proposals p
    WHERE p.id = e.proposal_id
      AND e.stop_requested_at IS NOT NULL
      AND e.started_at IS NOT NULL
      AND e.result_received_at IS NULL
      AND e.stop_outcome IS NULL
      AND e.stop_requested_at
        <= now() - ((e.max_seconds + ${ASSIST_LIMITS.runGraceSeconds}::int) * interval '1 second')
  `,
  );
  await guarded(log, 'expired_reports', {}, () => closeExpiredReports(log));
  await guarded(log, 'retention', {}, () => scrubExpiredIdentifiers());
  return ended;
}

/**
 * 報告の期限（失効 + 固定時間）までに結果が来なかった実行を記録する（§10）。
 * 既存の stop_outcome / partial_effect を消さない。未確認を成功や停止完了にしない
 * （stopped_at・verify_ok・evidence を書かない）。
 */
async function closeExpiredReports(log: SweepLog): Promise<void> {
  const due = await sql<
    { id: string; support_session_id: string; skill_id: string; role: string }[]
  >`
    SELECT e.id, e.support_session_id, e.skill_id, e.role
    FROM assist_executions e
    JOIN folder_access_helpers h ON h.id = e.helper_id
    WHERE e.started_at IS NOT NULL
      AND e.result_received_at IS NULL
      AND e.report_expired_at IS NULL
      AND h.revoked_at <= now() - (${ASSIST_LIMITS.revokedReportHours}::int * interval '1 hour')
  `;
  for (const row of due) {
    await guarded(log, 'expired_report', { sessionId: row.support_session_id, opId: row.id }, () =>
      sql.begin(async (tx) => {
        const locked = await lockSession(tx, row.support_session_id);
        if (!locked) return;
        const updated = await tx<{ id: string }[]>`
        UPDATE assist_executions e
        SET report_expired_at = now(),
            status = CASE WHEN e.status = 'executing' THEN 'timed_out' ELSE e.status END,
            partial_effect = CASE WHEN e.stop_outcome IS NULL AND e.role = 'main' AND p.effect = 'modify'
              THEN COALESCE(e.partial_effect, '[]'::jsonb) || ${jsonbValue(['STOP_UNCONFIRMED'])}
              ELSE e.partial_effect END,
            stop_outcome = COALESCE(e.stop_outcome, 'stop_unconfirmed')
        FROM assist_proposals p
        WHERE p.id = e.proposal_id
          AND e.id = ${row.id} AND e.result_received_at IS NULL AND e.report_expired_at IS NULL
        RETURNING e.id
      `;
        if (!updated[0]) return;
        await sessionAudit(tx, 'support_session.report_expired', locked.session, 'system:sweep', {
          opId: row.id,
          skillId: row.skill_id,
          role: row.role,
          source: 'sweep',
        });
      }),
    );
  }
}

/** 終了から保持期間を過ぎた識別子を消す。状態・理由・時刻は残す（docs/62 §7-1 と同じ方針）。 */
async function scrubExpiredIdentifiers(): Promise<void> {
  const days = config.FOLDER_ACCESS_RETENTION_DAYS;
  await sql`
    UPDATE assist_executions e
    SET sid = NULL, actor_sid = NULL, windows_session_id = NULL, normalized_output = NULL,
        params = '{}'::jsonb, helper_id = NULL
    FROM support_sessions s
    WHERE e.support_session_id = s.id
      AND s.ended_at <= now() - (${days}::int * interval '1 day')
      AND (e.sid IS NOT NULL OR e.actor_sid IS NOT NULL OR e.normalized_output IS NOT NULL)
  `;
  await sql`
    UPDATE support_sessions
    SET sid = NULL, machine_guid = NULL, windows_session_id = NULL, rsp_device_id = NULL,
        mesh_node_id = NULL, helper_id = NULL
    WHERE ended_at <= now() - (${days}::int * interval '1 day')
      AND (sid IS NOT NULL OR machine_guid IS NOT NULL OR rsp_device_id IS NOT NULL
           OR mesh_node_id IS NOT NULL OR helper_id IS NOT NULL)
  `;
}

export function startSupportSessionSweeper(log: {
  error: (obj: unknown, msg: string) => void;
}): () => void {
  const timer = setInterval(() => {
    sweepSupportSessions(log).catch((error: unknown) => {
      log.error({ err: error }, '共通支援セッションの期限処理に失敗しました。');
    });
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
