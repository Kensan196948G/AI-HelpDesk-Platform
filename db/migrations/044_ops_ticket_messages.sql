-- 044: 運用統合 UI の会話ログ（docs/100 P8a）
--
-- チケットごとのやり取り（受付・AI回答・引継ぎ・解決）を 1 行ずつ残す。
-- これまで ai_answer に最新 1 件しか持たず、再読み込みで会話が消えていた。

CREATE TABLE IF NOT EXISTS ops_ticket_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES ops_tickets(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('sys', 'user', 'ai')),
  text text NOT NULL,
  provider text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ops_ticket_messages_ticket_idx
  ON ops_ticket_messages (ticket_id, created_at);
