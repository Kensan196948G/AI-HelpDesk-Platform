-- 029: 失効済みトークンの報告期限を過ぎた実行の記録（docs/63 §10）。追加のみ・冪等。
-- 期限そのものは保存しない（folder_access_helpers.revoked_at + 固定時間で毎回計算し、再送で延長しない）。
ALTER TABLE assist_executions ADD COLUMN IF NOT EXISTS report_expired_at timestamptz;
