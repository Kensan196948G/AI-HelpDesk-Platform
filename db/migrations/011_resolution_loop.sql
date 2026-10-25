-- 011_resolution_loop.sql
-- 解決ループ（Phase B: 読み取り専用ループ PoC）の Skill カタログ・セッション・ステップ。
-- 設計: docs/25-skill-resolution-loop.md §9。
-- 追加のみ（既存テーブル・既存データは壊さない）。

-- Skill カタログ（コード .ps1 のハッシュ承認とセットで運用する）。
CREATE TABLE IF NOT EXISTS skills (
  id text NOT NULL,
  version text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  symptoms jsonb NOT NULL DEFAULT '[]'::jsonb,
  os text[] NOT NULL DEFAULT '{}',
  risk_level integer NOT NULL DEFAULT 1,
  requires jsonb NOT NULL DEFAULT '{}'::jsonb,
  params_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  script_path text NOT NULL,
  args jsonb NOT NULL DEFAULT '[]'::jsonb,
  verify jsonb,
  rollback jsonb,
  timeout_sec integer NOT NULL DEFAULT 60,
  result_schema jsonb,
  output_policy jsonb,
  status text NOT NULL DEFAULT 'draft',
  content_hash text,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version),
  CONSTRAINT skills_status_check CHECK (status IN ('draft', 'review', 'approved', 'disabled')),
  CONSTRAINT skills_risk_level_check CHECK (risk_level BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS skills_status_idx ON skills (status, id);

-- 解決セッション（1 相談 = 1 セッション。上限・期限をサーバで強制する）。
CREATE TABLE IF NOT EXISTS resolution_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email text NOT NULL,
  case_id text NOT NULL,
  device_id text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  step_count integer NOT NULL DEFAULT 0,
  max_steps integer NOT NULL DEFAULT 6,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resolution_sessions_status_check CHECK (
    status IN (
      'active', 'waiting_execute', 'executing', 'waiting_continue',
      'resolved', 'escalated', 'stopped', 'expired'
    )
  ),
  CONSTRAINT resolution_sessions_step_count_check CHECK (step_count >= 0),
  CONSTRAINT resolution_sessions_max_steps_check CHECK (max_steps > 0)
);

CREATE INDEX IF NOT EXISTS resolution_sessions_email_idx
  ON resolution_sessions (user_email, created_at DESC);
CREATE INDEX IF NOT EXISTS resolution_sessions_case_idx ON resolution_sessions (case_id);

-- 解決ステップ（提案 → 承認 → 実行 → 結果）。
-- approval_expires_at は承認ハッシュの payload を step の各列から再構築するために保存する
-- （設計 §5-2 の expiresAt。step.created_at とは独立に 5 分で失効させる）。
CREATE TABLE IF NOT EXISTS resolution_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES resolution_sessions(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  skill_id text NOT NULL,
  skill_version text NOT NULL,
  skill_content_hash text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  rationale text NOT NULL DEFAULT '',
  risk_level integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'proposed',
  nonce text NOT NULL,
  approval_hash text,
  admin_approval_hash text,
  approved_by text,
  approved_at timestamptz,
  command_id uuid,
  result_summary jsonb,
  result_full jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz,
  approval_expires_at timestamptz NOT NULL,
  UNIQUE (session_id, seq),
  CONSTRAINT resolution_steps_status_check CHECK (
    status IN (
      'proposed', 'approved', 'executing', 'done', 'failed',
      'rejected', 'cancelled', 'skipped'
    )
  ),
  CONSTRAINT resolution_steps_risk_level_check CHECK (risk_level BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS resolution_steps_session_idx ON resolution_steps (session_id, seq);
CREATE INDEX IF NOT EXISTS resolution_steps_command_idx ON resolution_steps (command_id);

-- 既存の実端末コマンドキューに、解決ループの出所を紐づける列を追加する。
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS skill_id text;
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS skill_version text;
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS step_id uuid;

CREATE INDEX IF NOT EXISTS device_commands_session_idx ON device_commands (session_id);

-- 端末エージェントのトークンと端末 ID（WEB-XXXXXXXX）を紐づける（Phase B は保存のみ）。
ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS device_id text;
