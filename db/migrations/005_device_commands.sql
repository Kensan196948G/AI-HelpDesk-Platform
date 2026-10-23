-- 実端末でのコマンド実行キュー（許可リストの操作のみ）。
-- 端末エージェントが x-device-token で取りに来て、結果を報告する。
CREATE TABLE IF NOT EXISTS device_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email text NOT NULL,
  device_id text,
  op_id text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT device_commands_status_check CHECK (status IN ('queued', 'delivered', 'done', 'failed', 'expired'))
);

CREATE INDEX IF NOT EXISTS device_commands_email_status_idx
  ON device_commands (user_email, status, created_at);
