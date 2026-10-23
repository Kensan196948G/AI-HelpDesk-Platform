-- 003_device_inventory.sql
-- 実端末のハードウェア・ソフトウェア情報（読み取りのみ）と、端末エージェントのトークン。
-- 取得対象は端末の基本情報のみ。ファイル内容・閲覧履歴・画面・キー入力・メール本文は保存しない。

CREATE TABLE IF NOT EXISTS device_inventories (
  user_email text NOT NULL,
  source text NOT NULL CHECK (source IN ('browser', 'agent')),
  device_id text,
  hostname text,
  os text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  collected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_email, source)
);

CREATE INDEX IF NOT EXISTS device_inventories_email_idx
  ON device_inventories (user_email, collected_at DESC);

CREATE TABLE IF NOT EXISTS device_tokens (
  token_hash text PRIMARY KEY,
  user_email text NOT NULL,
  label text NOT NULL DEFAULT 'endpoint-agent',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS device_tokens_email_idx ON device_tokens (user_email);

-- PC スナップショットの取得元に browser（ブラウザ取得）を追加する。
ALTER TABLE pc_snapshots DROP CONSTRAINT IF EXISTS pc_snapshots_source_check;
ALTER TABLE pc_snapshots
  ADD CONSTRAINT pc_snapshots_source_check
  CHECK (source IN ('demo', 'browser', 'agent'));
