-- 013: 解決ループ Phase C（タイムアウト / 管理者承認 / AI 入力の厳密化）
--
-- - result_ai: Skill の outputPolicy.fieldsToAi を適用した「AI に渡してよい」結果。
--   生ログ・宣言外フィールドは含めない（設計 §6 / §8-3）。
-- - timeout_sec / deadline_at: 承認時に確定する実行期限。スイープが failed にする。
-- - admin_*: リスク 4 以上の Skill に対する IT 管理者承認（設計 §4-3）。
--   admin_approval_hash は 011 で追加済み。ここでは承認者と期限を足す。

ALTER TABLE resolution_steps ADD COLUMN IF NOT EXISTS result_ai jsonb;
ALTER TABLE resolution_steps ADD COLUMN IF NOT EXISTS timeout_sec integer;
ALTER TABLE resolution_steps ADD COLUMN IF NOT EXISTS deadline_at timestamptz;
ALTER TABLE resolution_steps ADD COLUMN IF NOT EXISTS admin_nonce text;
ALTER TABLE resolution_steps ADD COLUMN IF NOT EXISTS admin_expires_at timestamptz;
ALTER TABLE resolution_steps ADD COLUMN IF NOT EXISTS admin_approved_by text;
ALTER TABLE resolution_steps ADD COLUMN IF NOT EXISTS admin_approved_at timestamptz;

-- タイムアウトのスイープ用（実行中・承認済みだけを走査する）。
CREATE INDEX IF NOT EXISTS resolution_steps_deadline_idx
  ON resolution_steps (status, deadline_at)
  WHERE status IN ('approved', 'executing');

-- IT 管理者の承認待ち一覧用。
CREATE INDEX IF NOT EXISTS resolution_steps_admin_pending_idx
  ON resolution_steps (risk_level, created_at)
  WHERE status = 'proposed' AND risk_level >= 4;

COMMENT ON COLUMN resolution_steps.result_ai IS
  'outputPolicy.fieldsToAi 適用後の結果（AI 入力用）。生ログは含めない';
COMMENT ON COLUMN resolution_steps.deadline_at IS
  '承認時に設定する実行期限。過ぎたらスイープが failed にする';
COMMENT ON COLUMN resolution_steps.admin_approved_by IS
  'リスク 4 以上の Skill を承認した IT 管理者のメール（依頼者と同一不可）';
