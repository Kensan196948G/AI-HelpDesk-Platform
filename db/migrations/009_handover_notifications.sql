-- 引継ぎ通知（メール）の送信キュー。
-- 引継ぎの作成と同一トランザクションで積み、送信はバックグラウンドで行う。
-- 送信に失敗しても引継ぎ自体は成功させる（メールは best-effort）。
CREATE TABLE IF NOT EXISTS case_handover_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handover_id uuid NOT NULL REFERENCES case_handovers(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'email',
  recipient_email text NOT NULL,
  recipient_name text,
  subject text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT case_handover_notifications_channel_check CHECK (channel IN ('email')),
  CONSTRAINT case_handover_notifications_status_check
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS case_handover_notifications_pending_idx
  ON case_handover_notifications (status, created_at);

-- 同じ引継ぎ・同じ宛先に二重に送らない。
CREATE UNIQUE INDEX IF NOT EXISTS case_handover_notifications_handover_recipient_idx
  ON case_handover_notifications (handover_id, recipient_email);
