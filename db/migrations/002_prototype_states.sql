-- 002_prototype_states.sql
-- 既存プロトタイプ HTML（100% 同じ UI）の状態を、ユーザー単位で PostgreSQL に保存する。
-- UI のデータ構造はプロトタイプの JSON をそのまま保持する（MVP / デモ用）。
CREATE TABLE IF NOT EXISTS prototype_states (
  user_email text NOT NULL,
  name text NOT NULL CHECK (name IN ('cowork', 'helpdesk')),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_email, name)
);

CREATE INDEX IF NOT EXISTS prototype_states_email_idx ON prototype_states (user_email);
