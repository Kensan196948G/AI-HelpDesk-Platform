-- 026: 本人同意付きフォルダ一覧（docs/62-consented-folder-access.md）
--
-- 既存の「PC 基本情報の共有」同意とは分離した専用テーブル。追加のみ・冪等。
--   - トークンは SHA-256、ペアリングコードは HMAC のハッシュだけを保存する（平文を持たない）。
--   - SID は同意の束縛に使うため保存してよい。監査ログへはハッシュだけを書く。
--   - 結果（ファイル名）は folder_access_results にだけ保存し、同意の終了時に削除する。
--     同じ理由で、終了時に consent_segments / windows_user も消す（アプリ側）。

CREATE TABLE IF NOT EXISTS folder_access_helpers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  machine_guid text NOT NULL,
  sid text NOT NULL,
  user_name text,
  session_id integer NOT NULL,
  session_state text NOT NULL,
  hostname text,
  helper_version text,
  pairing_code_hash text,
  pairing_expires_at timestamptz NOT NULL,
  pairing_used_at timestamptz,
  request_id uuid,
  paired_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 未使用のコードだけ一意にする（コード衝突を登録時に検出する）。
CREATE UNIQUE INDEX IF NOT EXISTS folder_access_helpers_code_idx
  ON folder_access_helpers (pairing_code_hash)
  WHERE pairing_used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS folder_access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handover_id uuid NOT NULL REFERENCES case_handovers(id) ON DELETE CASCADE,
  case_id text NOT NULL,
  requester_email text NOT NULL,
  assignee_email text NOT NULL,
  status text NOT NULL DEFAULT 'device_pending',
  end_reason text,
  reason_code text,
  -- 貸与情報（Mirai-Info PII API。社員番号・氏名は保存しない）
  lease_status text NOT NULL DEFAULT 'pending',
  lease_source text,
  lease_asset_tag text,
  lease_fetched_at timestamptz,
  lease_generated_at timestamptz,
  -- RSP 端末と固定テンプレートの結果（出力そのものは保存しない）
  rsp_device_id uuid,
  mesh_node_id text,
  rsp_hostname text,
  rsp_probe_log_id text,
  rsp_probe_status text NOT NULL DEFAULT 'none',
  rsp_probe_attempts integer NOT NULL DEFAULT 0,
  rsp_probe_checked_at timestamptz,
  rsp_machine_guid text,
  -- ペアリングで確定する Windows 側の束縛
  helper_id uuid REFERENCES folder_access_helpers(id) ON DELETE SET NULL,
  machine_guid text,
  sid text,
  session_id integer,
  windows_user text,
  helper_hostname text,
  pair_attempts integer NOT NULL DEFAULT 0,
  -- 同意
  consent_id uuid,
  consent_root text,
  consent_segments jsonb NOT NULL DEFAULT '[]'::jsonb,
  consent_operation text,
  consented_at timestamptz,
  consent_expires_at timestamptz,
  request_expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT folder_access_requests_status_check CHECK (status IN (
    'device_pending', 'helper_pending', 'consent_pending', 'active',
    'ended', 'revoked', 'expired', 'denied'
  )),
  CONSTRAINT folder_access_requests_end_reason_check CHECK (end_reason IS NULL OR end_reason IN (
    'operator_end', 'requester_revoked', 'expired', 'assignee_changed', 'session_changed',
    'user_logged_off', 'helper_revoked', 'lease_conflict', 'device_mismatch', 'sid_mismatch'
  )),
  CONSTRAINT folder_access_requests_lease_check CHECK (
    lease_status IN ('pending', 'verified', 'unverified')
  ),
  CONSTRAINT folder_access_requests_probe_check CHECK (
    rsp_probe_status IN ('none', 'pending', 'completed', 'failed')
  ),
  CONSTRAINT folder_access_requests_root_check CHECK (consent_root IS NULL OR consent_root IN (
    'Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos'
  )),
  CONSTRAINT folder_access_requests_operation_check CHECK (
    consent_operation IS NULL OR consent_operation = 'list_metadata'
  )
);

-- 1 つの引継ぎに進行中の依頼は 1 件だけ。
CREATE UNIQUE INDEX IF NOT EXISTS folder_access_requests_open_idx
  ON folder_access_requests (handover_id)
  WHERE status IN ('device_pending', 'helper_pending', 'consent_pending', 'active');
CREATE INDEX IF NOT EXISTS folder_access_requests_requester_idx
  ON folder_access_requests (requester_email, created_at DESC);
CREATE INDEX IF NOT EXISTS folder_access_requests_handover_idx
  ON folder_access_requests (handover_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'folder_access_helpers_request_fk'
  ) THEN
    ALTER TABLE folder_access_helpers
      ADD CONSTRAINT folder_access_helpers_request_fk
      FOREIGN KEY (request_id) REFERENCES folder_access_requests(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS folder_access_ops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES folder_access_requests(id) ON DELETE CASCADE,
  helper_id uuid NOT NULL REFERENCES folder_access_helpers(id) ON DELETE CASCADE,
  consent_id uuid NOT NULL,
  sid text NOT NULL,
  session_id integer NOT NULL,
  root text NOT NULL,
  segments jsonb NOT NULL DEFAULT '[]'::jsonb,
  operation text NOT NULL DEFAULT 'list_metadata',
  status text NOT NULL DEFAULT 'queued',
  expires_at timestamptz NOT NULL,
  max_entries integer NOT NULL,
  max_bytes integer NOT NULL,
  max_seconds integer NOT NULL,
  requested_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  completed_at timestamptz,
  cancel_acked_at timestamptz,
  CONSTRAINT folder_access_ops_operation_check CHECK (operation = 'list_metadata'),
  CONSTRAINT folder_access_ops_status_check CHECK (
    status IN ('queued', 'delivered', 'done', 'failed', 'cancelled', 'expired')
  )
);

CREATE INDEX IF NOT EXISTS folder_access_ops_helper_idx
  ON folder_access_ops (helper_id, status, created_at);
CREATE INDEX IF NOT EXISTS folder_access_ops_request_idx
  ON folder_access_ops (request_id, created_at DESC);

CREATE TABLE IF NOT EXISTS folder_access_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES folder_access_requests(id) ON DELETE CASCADE,
  op_id uuid NOT NULL UNIQUE REFERENCES folder_access_ops(id) ON DELETE CASCADE,
  consent_id uuid NOT NULL,
  status text NOT NULL,
  reason text,
  truncated boolean NOT NULL DEFAULT false,
  entry_count integer NOT NULL DEFAULT 0,
  elapsed_ms integer,
  entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT folder_access_results_status_check CHECK (status IN ('ok', 'partial', 'error'))
);

CREATE INDEX IF NOT EXISTS folder_access_results_request_idx
  ON folder_access_results (request_id, received_at DESC);
