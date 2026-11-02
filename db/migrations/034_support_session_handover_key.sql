-- 034: 進行中のセッションを引継ぎごとに 1 件にする（案件番号は相談者ごとの採番で一意でない）。
--      停止の結果に「停止の前に完了」を加える。030 は本番未適用で、インデックスの置き換えだけ。冪等。
DROP INDEX IF EXISTS support_sessions_open_case_idx;
CREATE UNIQUE INDEX IF NOT EXISTS support_sessions_open_handover_idx
  ON support_sessions (handover_id)
  WHERE status IN (
    'binding_pending', 'consent_pending', 'ready', 'proposing', 'awaiting_approval',
    'approved', 'executing', 'verifying', 'awaiting_next', 'resolve_confirm'
  );

ALTER TABLE assist_executions DROP CONSTRAINT IF EXISTS assist_executions_stop_check;
ALTER TABLE assist_executions ADD CONSTRAINT assist_executions_stop_check CHECK (
  stop_outcome IS NULL OR stop_outcome IN (
    'stopped', 'stop_failed', 'not_running', 'stop_unconfirmed', 'completed_before_stop'
  )
);
