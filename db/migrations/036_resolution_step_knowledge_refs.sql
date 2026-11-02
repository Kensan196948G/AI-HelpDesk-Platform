-- 解決ループの提案に照合した承認済み KB の参照（additive・後方互換）。
-- {"matched":[{kbNo,version,title,stepsSummary}],"used":[kbNo]}。used は AI が使ったと答えたものだけ。
ALTER TABLE resolution_steps
  ADD COLUMN IF NOT EXISTS knowledge_refs jsonb NOT NULL DEFAULT '{"matched":[],"used":[]}'::jsonb;
