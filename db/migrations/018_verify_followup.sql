-- 018: 解決ループ Phase 6a（script 形態 verify の追撃実行）
--
-- script 形態の verify（`{script, args, expect}`）は、確認用スクリプトを追加実行
-- しないと評価できない。そこでサーバは、変更系親ステップの完了時に
-- verify.script と同一 script_path を持つ読み取り Skill（risk_level=1 / approved）を
-- 自動承認（approved_by='system:verify'）で追撃ステップとして積む。
--
-- verify_for_step_id は「この追撃ステップが、どの親ステップの verify のための
-- 実行か」を表す。追撃ステップの完了時、親の verify.expect をサブセット一致で
-- 評価し、親の verify_result を更新する（追撃の追撃は作らない）。
--
-- 追加のみ・冪等（既存データに影響しない）。
-- 同一親に追撃は 1 回だけ（部分 UNIQUE インデックスで二重 enqueue を防ぐ）。

ALTER TABLE resolution_steps
  ADD COLUMN IF NOT EXISTS verify_for_step_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS resolution_steps_verify_for_step_uidx
  ON resolution_steps (verify_for_step_id)
  WHERE verify_for_step_id IS NOT NULL;

COMMENT ON COLUMN resolution_steps.verify_for_step_id IS
  '親ステップ ID（script 形態 verify の追撃実行）。NULL は通常ステップ。同一親に 1 回だけ';
