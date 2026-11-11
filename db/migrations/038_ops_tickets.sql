-- 038: 運用統合 UI（/ops）の受付チケット（docs/100 P2）
--
-- 旧 UI の案件（cases）とは別の受付モデル。受付→AI一次対応→引継ぎのうち、
-- まず「受付」と「AI一次対応の記録」を実 DB に残す。
-- 引継ぎ（case_handovers）との接続は P3 で行う。

CREATE SEQUENCE IF NOT EXISTS ops_ticket_seq START WITH 1001;

CREATE TABLE IF NOT EXISTS ops_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tkt_no text NOT NULL UNIQUE,
  requester_email text NOT NULL,
  requester_name text,
  requester_label text,
  channel text,
  category text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  urgency text NOT NULL DEFAULT 'normal',
  impact text,
  priority text,
  signal text,
  status text NOT NULL DEFAULT 'ai'
    CHECK (status IN ('ai', 'escalated', 'in_progress', 'resolved', 'closed')),
  ai_answer text,
  ai_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_provider text,
  ai_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS ops_tickets_requester_created_idx
  ON ops_tickets (requester_email, created_at DESC);
CREATE INDEX IF NOT EXISTS ops_tickets_status_idx
  ON ops_tickets (status, created_at DESC);
