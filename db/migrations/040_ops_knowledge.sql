-- 040: 運用統合 UI のナレッジ下書き・承認（docs/100 P3b）
--
-- 既存の knowledge テーブルをそのまま使い、Access の本人をメールで識別する。
-- 旧 UI（セッション認証）は author_id を使い続けるため、両方を許容する。

ALTER TABLE knowledge ALTER COLUMN author_id DROP NOT NULL;

ALTER TABLE knowledge
  ADD COLUMN IF NOT EXISTS author_email text,
  ADD COLUMN IF NOT EXISTS approver_email text,
  ADD COLUMN IF NOT EXISTS category text;

CREATE INDEX IF NOT EXISTS knowledge_author_email_idx
  ON knowledge (author_email, status, updated_at DESC);
