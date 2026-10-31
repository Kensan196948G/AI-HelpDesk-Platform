-- 028: 共通支援セッションと AI 操作ループ（docs/63-assist-session.md）
--
-- フラグ ASSIST_SESSION_ENABLED（既定 false）の裏で使う専用テーブル。追加のみ・冪等。
--   - 既存テーブルを変更しない。device_commands / resolution_steps を参照しない（§6）。
--   - SID・MachineGuid は束縛に使うため保存し、保持期間を過ぎたら定期処理が消す（NULL 許容）。
--   - 監査ログへは SID のハッシュだけを書く。実パス・名前・端末の自由文は保存しない。

CREATE TABLE IF NOT EXISTS support_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handover_id uuid NOT NULL REFERENCES case_handovers(id) ON DELETE CASCADE,
  case_id text NOT NULL,
  requester_email text NOT NULL,
  assignee_email text NOT NULL,
  folder_request_id uuid NOT NULL REFERENCES folder_access_requests(id) ON DELETE CASCADE,
  folder_consent_id uuid,
  folder_consent_version text,
  folder_consent_expires_at timestamptz,
  -- 貸与の照合結果（§3。社員番号・氏名は持たない）
  lease_status text NOT NULL,
  lease_source text,
  lease_fetched_at timestamptz,
  -- 確定した端末と Windows セッション
  rsp_device_id uuid,
  mesh_node_id text,
  machine_guid text,
  sid text,
  windows_session_id integer,
  helper_id uuid REFERENCES folder_access_helpers(id) ON DELETE SET NULL,
  -- 同意の写し（正本は operation_consents / ai_input_consents）
  operation_consent_id uuid,
  operation_consent_version text,
  operation_consent_scope text,
  operation_consent_expires_at timestamptz,
  ai_input_consent_id uuid,
  ai_input_consent_version text,
  ai_input_consent_expires_at timestamptz,
  proposal_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'binding_pending',
  end_reason text,
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_sessions_status_check CHECK (status IN (
    'binding_pending', 'consent_pending', 'ready', 'proposing', 'awaiting_approval',
    'approved', 'executing', 'verifying', 'awaiting_next', 'resolve_confirm',
    'resolved', 'stopped', 'escalated', 'expired', 'revoked'
  )),
  CONSTRAINT support_sessions_scope_check CHECK (
    operation_consent_scope IS NULL OR operation_consent_scope IN ('read_only', 'user_reversible')
  ),
  CONSTRAINT support_sessions_count_check CHECK (proposal_count >= 0)
);

-- 1 案件に進行中のセッションは 1 件だけ（§3）。
CREATE UNIQUE INDEX IF NOT EXISTS support_sessions_open_case_idx
  ON support_sessions (case_id)
  WHERE status IN (
    'binding_pending', 'consent_pending', 'ready', 'proposing', 'awaiting_approval',
    'approved', 'executing', 'verifying', 'awaiting_next', 'resolve_confirm'
  );
CREATE INDEX IF NOT EXISTS support_sessions_folder_idx
  ON support_sessions (folder_request_id);
CREATE INDEX IF NOT EXISTS support_sessions_requester_idx
  ON support_sessions (requester_email, created_at DESC);
CREATE INDEX IF NOT EXISTS support_sessions_handover_idx
  ON support_sessions (handover_id, created_at DESC);

CREATE TABLE IF NOT EXISTS operation_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  support_session_id uuid NOT NULL REFERENCES support_sessions(id) ON DELETE CASCADE,
  requester_email text NOT NULL,
  scope text NOT NULL,
  version text NOT NULL,
  consented_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  CONSTRAINT operation_consents_scope_check CHECK (scope IN ('read_only', 'user_reversible'))
);
CREATE INDEX IF NOT EXISTS operation_consents_session_idx
  ON operation_consents (support_session_id, consented_at DESC);

CREATE TABLE IF NOT EXISTS ai_input_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  support_session_id uuid NOT NULL REFERENCES support_sessions(id) ON DELETE CASCADE,
  requester_email text NOT NULL,
  version text NOT NULL,
  consented_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text
);
CREATE INDEX IF NOT EXISTS ai_input_consents_session_idx
  ON ai_input_consents (support_session_id, consented_at DESC);

CREATE TABLE IF NOT EXISTS assist_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  support_session_id uuid NOT NULL REFERENCES support_sessions(id) ON DELETE CASCADE,
  step_seq integer NOT NULL,
  skill_id text NOT NULL,
  skill_version text NOT NULL,
  content_hash text NOT NULL,
  script_hash text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  effect text NOT NULL,
  executor text NOT NULL DEFAULT 'user_session',
  required_privilege text NOT NULL,
  risk_level integer NOT NULL,
  target_ref text,
  title text NOT NULL,
  purpose text NOT NULL,
  impact text NOT NULL,
  success_criteria text NOT NULL,
  failure_action text NOT NULL,
  rollback_scope text NOT NULL,
  -- 表示用の説明。実行契約にしない（§5）。
  rationale text,
  proposal_source text NOT NULL,
  -- 成功条件と、承認時に提示した確認操作の定義（§8）。
  verify jsonb NOT NULL,
  approval_hash text NOT NULL,
  nonce text NOT NULL,
  nonce_consumed_at timestamptz,
  approval_expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'proposed',
  decision text,
  decided_by text,
  decided_at timestamptz,
  verify_ok boolean,
  verify_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assist_proposals_effect_check CHECK (effect IN ('read', 'modify')),
  CONSTRAINT assist_proposals_executor_check CHECK (executor = 'user_session'),
  CONSTRAINT assist_proposals_source_check CHECK (proposal_source IN ('deepseek', 'rule')),
  CONSTRAINT assist_proposals_decision_check CHECK (decision IS NULL OR decision IN ('Y', 'N')),
  CONSTRAINT assist_proposals_status_check CHECK (status IN (
    'proposed', 'approved', 'rejected', 'invalidated', 'executing', 'verifying',
    'succeeded', 'failed'
  ))
);
CREATE UNIQUE INDEX IF NOT EXISTS assist_proposals_seq_idx
  ON assist_proposals (support_session_id, step_seq);

CREATE TABLE IF NOT EXISTS assist_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES assist_proposals(id) ON DELETE CASCADE,
  support_session_id uuid NOT NULL REFERENCES support_sessions(id) ON DELETE CASCADE,
  step_seq integer NOT NULL,
  role text NOT NULL,
  verify_index integer NOT NULL DEFAULT 0,
  helper_id uuid REFERENCES folder_access_helpers(id) ON DELETE SET NULL,
  sid text,
  windows_session_id integer,
  skill_id text NOT NULL,
  skill_version text NOT NULL,
  content_hash text NOT NULL,
  script_hash text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  check_definition jsonb NOT NULL,
  max_seconds integer NOT NULL,
  max_output_bytes integer NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  expires_at timestamptz NOT NULL,
  delivered_at timestamptz,
  -- 開始の記録（§6）。start_nonce は 1 回だけ消費する。
  start_nonce text NOT NULL,
  start_nonce_consumed_at timestamptz,
  started_at timestamptz,
  deadline_at timestamptz,
  -- 結果と出所（§7）。result_source はサーバが書く。
  execution_mode text,
  result_source text,
  actor_sid text,
  result_status text,
  result_code text,
  exit_code integer,
  reported_started_at timestamptz,
  reported_finished_at timestamptz,
  elapsed_ms integer,
  normalized_output jsonb,
  evidence boolean NOT NULL DEFAULT false,
  verify_ok boolean,
  verify_reason text,
  result_received_at timestamptz,
  late_result boolean NOT NULL DEFAULT false,
  -- 失効の伝搬（§10）。stop_requested と stopped / stop_failed を別に記録する。
  stop_requested_at timestamptz,
  stopped_at timestamptz,
  stop_outcome text,
  cancel_acked_at timestamptz,
  partial_effect jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assist_executions_role_check CHECK (role IN ('main', 'verify')),
  CONSTRAINT assist_executions_mode_check CHECK (
    execution_mode IS NULL OR execution_mode IN ('real', 'mock', 'manual')
  ),
  CONSTRAINT assist_executions_status_check CHECK (status IN (
    'queued', 'delivered', 'executing', 'completed', 'failed', 'cancelled',
    'rejected_at_start', 'rejected_by_helper', 'expired', 'timed_out'
  )),
  CONSTRAINT assist_executions_stop_check CHECK (
    stop_outcome IS NULL OR stop_outcome IN ('stopped', 'stop_failed', 'not_running', 'stop_unconfirmed')
  ),
  -- 本番の real だけが証拠になる。mock / manual を証拠として保存できないようにする。
  CONSTRAINT assist_executions_evidence_check CHECK (
    evidence = false OR execution_mode = 'real'
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS assist_executions_step_idx
  ON assist_executions (proposal_id, role, verify_index);
CREATE INDEX IF NOT EXISTS assist_executions_helper_idx
  ON assist_executions (helper_id, status, created_at);
CREATE INDEX IF NOT EXISTS assist_executions_session_idx
  ON assist_executions (support_session_id, created_at DESC);
