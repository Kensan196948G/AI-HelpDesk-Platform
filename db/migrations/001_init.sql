-- 001_init.sql — みらいAI窓口 × ヘルプデスク MVP
-- 追加のみ（CREATE IF NOT EXISTS）。破壊的変更は含めない。
-- 実行: pnpm db:migrate / node scripts/migrate.mjs

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 利用者（3 ロール）
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('requester', 'helpdesk', 'approver')),
  password_hash text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq ON users (lower(email));

-- セッション（トークンはハッシュのみ保存）
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- 案件番号の採番
CREATE SEQUENCE IF NOT EXISTS case_no_seq START 1;
CREATE SEQUENCE IF NOT EXISTS inc_no_seq START 1;
CREATE SEQUENCE IF NOT EXISTS kb_no_seq START 1;

-- 相談案件（STEP 1〜7）
CREATE TABLE IF NOT EXISTS cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no text NOT NULL UNIQUE,
  requester_id uuid NOT NULL REFERENCES users(id),
  category text NOT NULL CHECK (category IN (
    'pc_network', 'account', 'file_share', 'procedure', 'security', 'other'
  )),
  subject text NOT NULL,
  body text NOT NULL,
  urgency text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('normal', 'urgent')),
  signal text NOT NULL DEFAULT 'blue' CHECK (signal IN ('blue', 'amber', 'red')),
  current_step integer NOT NULL DEFAULT 2 CHECK (current_step BETWEEN 1 AND 7),
  status text NOT NULL DEFAULT 'awaiting_decision' CHECK (status IN (
    'draft', 'awaiting_decision', 'ai_resolved', 'handoff_pending',
    'in_progress', 'knowledge_pending', 'completed', 'cancelled'
  )),
  ai_resolved boolean NOT NULL DEFAULT false,
  ai_summary text,
  shared_pc_info boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cases_requester_idx ON cases (requester_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cases_status_idx ON cases (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS cases_signal_idx ON cases (signal);
CREATE INDEX IF NOT EXISTS cases_created_idx ON cases (created_at DESC);

-- 相談・AI・引継ぎ・解決のメッセージ
CREATE TABLE IF NOT EXISTS case_messages (
  id bigserial PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  kind text NOT NULL CHECK (kind IN (
    'consultation', 'ai_assessment', 'decision', 'handoff',
    'resolution', 'knowledge', 'note'
  )),
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS case_messages_case_idx ON case_messages (case_id, created_at);

-- PC 基本情報（デモ / 読み取りのみ）
CREATE TABLE IF NOT EXISTS pc_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL UNIQUE REFERENCES cases(id) ON DELETE CASCADE,
  collected_at timestamptz NOT NULL DEFAULT now(),
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  concerns jsonb NOT NULL DEFAULT '[]'::jsonb,
  shared boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'demo' CHECK (source IN ('demo', 'agent')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ヘルプデスクのチケット（TKT / INC）
CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL UNIQUE REFERENCES cases(id) ON DELETE CASCADE,
  tkt_no text NOT NULL UNIQUE,
  inc_no text NOT NULL UNIQUE,
  assignee_id uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'assigned', 'in_progress', 'resolved', 'closed'
  )),
  handoff_memo text NOT NULL DEFAULT '',
  shared_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tickets_assignee_idx ON tickets (assignee_id, status);
CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets (status, created_at);

-- 解決記録
CREATE TABLE IF NOT EXISTS resolutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  cause text NOT NULL,
  steps text NOT NULL,
  duration_min integer NOT NULL DEFAULT 0 CHECK (duration_min >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resolutions_case_idx ON resolutions (case_id);

-- ナレッジ（下書き → 承認待ち → 公開 / 差戻し）
CREATE TABLE IF NOT EXISTS knowledge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_no text NOT NULL UNIQUE,
  case_id uuid REFERENCES cases(id) ON DELETE SET NULL,
  resolution_id uuid UNIQUE REFERENCES resolutions(id) ON DELETE SET NULL,
  title text NOT NULL,
  symptom text NOT NULL,
  cause text NOT NULL,
  steps text NOT NULL,
  keywords text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'pending', 'approved', 'rejected'
  )),
  author_id uuid NOT NULL REFERENCES users(id),
  approver_id uuid REFERENCES users(id),
  version integer NOT NULL DEFAULT 1,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_status_idx ON knowledge (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_keywords_gin ON knowledge USING gin (keywords);
CREATE INDEX IF NOT EXISTS knowledge_case_idx ON knowledge (case_id);

-- 承認・差戻しの履歴
CREATE TABLE IF NOT EXISTS knowledge_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_id uuid NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES users(id),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  comment text NOT NULL DEFAULT '',
  checklist jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_reviews_kb_idx ON knowledge_reviews (knowledge_id, created_at);

-- 監査ログ（ハッシュチェーン）
CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_target_idx ON audit_log (target_type, target_id);

-- updated_at トリガー
DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS cases_updated_at ON cases;
CREATE TRIGGER cases_updated_at BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS tickets_updated_at ON tickets;
CREATE TRIGGER tickets_updated_at BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS knowledge_updated_at ON knowledge;
CREATE TRIGGER knowledge_updated_at BEFORE UPDATE ON knowledge
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
