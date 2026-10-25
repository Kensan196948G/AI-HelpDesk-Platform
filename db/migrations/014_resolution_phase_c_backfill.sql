-- 014: Phase C の既存データ移行
--
-- 013 適用前に approved / executing だったステップは deadline_at が NULL のため、
-- タイムアウトのスイープ対象にならない。安全側に倒して「適用時刻から 60 秒」を期限にする。
-- 既存の done ステップは result_ai が NULL のままにする（AI へは渡さない fail-closed）。

UPDATE resolution_steps
SET timeout_sec = COALESCE(timeout_sec, 60),
    deadline_at = now() + interval '60 seconds'
WHERE status IN ('approved', 'executing')
  AND deadline_at IS NULL;

COMMENT ON COLUMN resolution_steps.deadline_at IS
  '承認時に設定する実行期限。過ぎたらスイープが failed にする（014 で既存分を補完）';
