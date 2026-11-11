-- 039: 運用統合 UI の受付チケットに担当・解決記録を追加（docs/100 P3）
--
-- ③ 引継ぎ（担当開始）と ④ 解決記録を実 DB に残す。
-- ナレッジ下書き（⑤〜⑦）との接続は次の段で行う。

ALTER TABLE ops_tickets
  ADD COLUMN IF NOT EXISTS assignee_email text,
  ADD COLUMN IF NOT EXISTS assignee_name text,
  ADD COLUMN IF NOT EXISTS cause text,
  ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS resolution_minutes integer,
  ADD COLUMN IF NOT EXISTS resolution_note text,
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS started_at timestamptz;

CREATE INDEX IF NOT EXISTS ops_tickets_assignee_idx
  ON ops_tickets (assignee_email, status, created_at DESC);
