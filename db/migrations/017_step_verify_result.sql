-- 017: 解決ループ Phase 5（verify 評価結果の保存）
--
-- resolution_steps.verify_result は、サーバが実行結果に対して Skill の verify を
-- 評価した結果（ok / evaluated / reason 等）を保存する。AI には判定させない。
--
-- - ok: true  = 確認条件を満たした（変更系ステップなら解決候補として停止する）
-- - ok: false = 満たさない
-- - ok: null  = 評価不能（verify 未定義 / script 形態 / 型不一致 等）。
--   null も「評価不能」という情報なので必ず保存する（成功と見なさない）。
--
-- 追加のみ・冪等（既存データに影響しない）。

ALTER TABLE resolution_steps ADD COLUMN IF NOT EXISTS verify_result jsonb;

COMMENT ON COLUMN resolution_steps.verify_result IS
  'サーバが評価した verify の結果（ok/evaluated/reason）。ok=null は評価不能（成功と見なさない）';
