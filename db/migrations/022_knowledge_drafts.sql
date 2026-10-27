-- F-06 サーバ側: ナレッジ下書き・承認を UI（Cloudflare Access）から使えるようにする。
-- additive 変更のみ（既存の knowledge / knowledge_reviews ルートはそのまま動く）。
--
-- 既存 knowledge は cases(id) への UUID FK を持つが、UI の案件 ID は
-- CASE-xxxx のような外部 ID なので、外部 ID を別列で保持する。

ALTER TABLE knowledge
  ADD COLUMN IF NOT EXISTS external_case_id text,
  ADD COLUMN IF NOT EXISTS handover_id uuid,
  ADD COLUMN IF NOT EXISTS author_email text,
  ADD COLUMN IF NOT EXISTS approver_email text,
  ADD COLUMN IF NOT EXISTS checklist jsonb,
  ADD COLUMN IF NOT EXISTS self_approved boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS knowledge_external_case_idx
  ON knowledge (external_case_id);

-- 下書き→承認待ちを 'review' として扱う（既存の 'pending' は後方互換で許可）。
ALTER TABLE knowledge DROP CONSTRAINT IF EXISTS knowledge_status_check;
ALTER TABLE knowledge ADD CONSTRAINT knowledge_status_check
  CHECK (status IN ('draft', 'review', 'pending', 'approved', 'rejected'));

-- kb_no 採番。001_init で kb_no_seq は作成済みだが、既存 seed 行
-- (KB-2026-0001..0009) より後ろから採番できるよう最大値まで進める。
CREATE SEQUENCE IF NOT EXISTS kb_no_seq START 1;
SELECT setval(
  'kb_no_seq',
  GREATEST(
    (SELECT last_value FROM kb_no_seq),
    COALESCE(
      (SELECT max(NULLIF(split_part(kb_no, '-', 3), '')::int) FROM knowledge),
      0
    ) + 1
  ),
  true
);
