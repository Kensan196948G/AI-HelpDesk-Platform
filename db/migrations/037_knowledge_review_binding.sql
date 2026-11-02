-- KB の承認を、承認者が確認した本文へ束縛した記録と、元の引継ぎへの参照（additive・後方互換）。
-- 既存行は NULL のまま。過去の承認を確認済みと書き換えない（docs/64 §10）。
ALTER TABLE knowledge_reviews
  ADD COLUMN IF NOT EXISTS content_hash text,
  ADD COLUMN IF NOT EXISTS reviewed_version integer,
  ADD COLUMN IF NOT EXISTS published_version integer;

COMMENT ON COLUMN knowledge_reviews.content_hash IS
  '判定した時点の knowledgeContentHash（ID・版・本文・keywords）。NULL は束縛の導入前の判定。';
COMMENT ON COLUMN knowledge_reviews.reviewed_version IS '判定した時点の knowledge.version。';
COMMENT ON COLUMN knowledge_reviews.published_version IS '承認で公開された knowledge.version。差戻しは NULL。';

ALTER TABLE knowledge
  ADD COLUMN IF NOT EXISTS source_handover_id uuid REFERENCES case_handovers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_case_ref text;

COMMENT ON COLUMN knowledge.source_handover_id IS
  '下書きの元の引継ぎ。担当者が引き受けた行だけ。相談者へ返さない。';
COMMENT ON COLUMN knowledge.source_case_ref IS
  '下書きの元の案件。case_handovers.case_id をサーバで写す（クライアントの値は使わない）。';

CREATE INDEX IF NOT EXISTS knowledge_source_handover_idx
  ON knowledge (source_handover_id) WHERE source_handover_id IS NOT NULL;
