-- 共通支援セッション（docs/63 §12）: 承認済みナレッジの固定の症状タグ。
--
-- 画面からの同期は keywords を常に空で送るので、keywords だけでは
-- 画面で作って承認したナレッジが AI の参照（knowledgeRefs）に入らない。
-- 承認のときに title / symptom からサーバで固定の語彙へ写して保存する。
-- AI へ渡すのはこの語彙だけで、title / symptom の自由文は渡さない。
--
-- NULL は「まだ求めていない」（この列より前に承認された行や、機能が無効の間に承認された行）。
-- 読むときに本文から同じ辞書で求める。既存の行は書き換えない。
ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS symptom_tags text[];

COMMENT ON COLUMN knowledge.symptom_tags IS
  '承認時に title/symptom から求めた固定の症状タグ（SYMPTOM_TAGS のみ）。NULL は未算出。';
