-- 020: RSP 相関ID（Phase 2: W23 コマンドキューの実出力取込と、セッションの相互参照）
--
-- 由来: RSP docs/36-rsp-integration.md §7 Phase 2
--   - RSP の非同期コマンドキュー（POST /api/v1/devices/{id}/commands →
--     GET /api/v1/devices/{id}/commands/{log_id} が output を返す）で実行した結果を、
--     HelpDesk の実行記録（terminal_steps）へ取り込む。
--     どの実行結果かを追えるよう、RSP の command log_id を保存する。
--   - HelpDesk の terminal_session と RSP の remote_session を相互参照できるよう、
--     両側に相手の ID を保存する（本マイグレーションは HelpDesk 側）。
--
-- 方針:
--   - 追加のみ・冪等（既存テーブル・既存データに影響しない。列追加と CHECK の張り替えだけ）。
--   - 既存の 'auto'（ターミナルログの自動取込・Phase 4）と 'manual' はそのまま。
--     'rsp_command' は RSP のコマンドキューが実行主体で、実出力を取得済みの記録を表す。
--   - 相関IDは NULL 可（Phase 2 以前の行・相関が取れない記録もある）。

ALTER TABLE terminal_steps
  ADD COLUMN IF NOT EXISTS rsp_command_log_id text;

ALTER TABLE terminal_sessions
  ADD COLUMN IF NOT EXISTS rsp_session_id text;

-- 出力ソースに 'rsp_command' を追加するため CHECK を張り替える（既存行は auto/manual/NULL のみ）。
ALTER TABLE terminal_steps
  DROP CONSTRAINT IF EXISTS terminal_steps_output_source_check;
ALTER TABLE terminal_steps
  ADD CONSTRAINT terminal_steps_output_source_check
  CHECK (output_source IS NULL OR output_source IN ('auto', 'manual', 'rsp_command'));

-- 相関IDから記録を引けるようにする（任意・冪等）。
CREATE INDEX IF NOT EXISTS terminal_steps_rsp_command_log_idx
  ON terminal_steps (rsp_command_log_id);
CREATE INDEX IF NOT EXISTS terminal_sessions_rsp_session_idx
  ON terminal_sessions (rsp_session_id);

COMMENT ON COLUMN terminal_steps.rsp_command_log_id IS
  'RSP W23 コマンドキューの command log_id（outputSource=''rsp_command'' のときの出所）';
COMMENT ON COLUMN terminal_sessions.rsp_session_id IS
  'RSP の remote_session ID（terminal_session との相互参照用・NULL 可）';
