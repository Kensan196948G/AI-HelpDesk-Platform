-- 019: RSP 実行セッション（AI 提案 → 担当者が RSP で実行 → 報告書・ナレッジ下書き）
--
-- 設計: docs/35-terminal-session.md
--
-- - サーバはコマンドを実行しない。実行するのは claim 済みの担当者。
-- - AI の提案と、実際に実行したコマンド・出力を別々に保存する（提案 ≠ 実行）。
-- - 出力は PII マスク後の値と、その値に対する SHA-256 を保存する。
-- - 追加のみ・冪等（既存テーブル・既存データに影響しない）。

CREATE TABLE IF NOT EXISTS terminal_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- プロトタイプの案件 ID（case_handovers.case_id と同じ text）。
  case_id text NOT NULL,
  handover_id uuid REFERENCES case_handovers(id) ON DELETE SET NULL,
  device text NOT NULL DEFAULT 'unknown',
  operator_email text NOT NULL,
  requester_email text,
  status text NOT NULL DEFAULT 'active',
  close_reason text,
  close_note text,
  consent_screen_share boolean NOT NULL DEFAULT false,
  consent_remote_control boolean NOT NULL DEFAULT false,
  ai_model text,
  knowledge_id uuid REFERENCES knowledge(id) ON DELETE SET NULL,
  report_id uuid,
  report_sha256 text,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT terminal_sessions_status_check CHECK (status IN ('active', 'closed')),
  CONSTRAINT terminal_sessions_close_reason_check CHECK (
    close_reason IS NULL OR close_reason IN ('resolved', 'stopped', 'escalated', 'expired')
  )
);

-- 1 引継ぎにつき同時に 1 セッションだけ（active のみを対象にした部分 UNIQUE）。
CREATE UNIQUE INDEX IF NOT EXISTS terminal_sessions_active_handover_uidx
  ON terminal_sessions (handover_id)
  WHERE status = 'active' AND handover_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS terminal_sessions_case_idx
  ON terminal_sessions (case_id, started_at DESC);

CREATE TABLE IF NOT EXISTS terminal_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq BETWEEN 1 AND 20),
  operator_email text NOT NULL,
  intent text,
  -- AI の提案（サーバは実行しない）。
  ai_command text,
  ai_purpose text,
  ai_risk text CHECK (ai_risk IS NULL OR ai_risk IN ('low', 'medium', 'high')),
  ai_verify text,
  ai_rollback text,
  ai_warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_model text,
  -- 担当者が実際に実行した内容（提案と異なってよい）。
  executed_command text,
  output text,
  output_source text CHECK (output_source IS NULL OR output_source IN ('auto', 'manual')),
  exit_status text CHECK (exit_status IS NULL OR exit_status IN ('success', 'failure', 'unknown')),
  note text,
  sha256 text,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz,
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS terminal_steps_session_idx
  ON terminal_steps (session_id, seq);

COMMENT ON TABLE terminal_sessions IS
  'RSP 実行セッション。担当者の同意・TTL・終了理由・作成済み報告書/ナレッジを持つ';
COMMENT ON TABLE terminal_steps IS
  'AI の提案と、担当者が実行したコマンド・出力（PII マスク済み）を 1 ステップ 1 行で保持する';
COMMENT ON COLUMN terminal_steps.sha256 IS
  '実行記録のハッシュ。対象は sessionId/stepId/seq/command/output/outputSource/exitStatus（マスク後）';
