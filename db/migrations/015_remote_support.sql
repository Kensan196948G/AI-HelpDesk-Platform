-- 015: Phase 1 遠隔対応（端末マッピングと MeshAgent 導入要求）
--
-- AI HelpDesk のケース（解決ループの escalated セッション）と RSP の端末を結び、
-- MeshAgent の導入要求と結果をサーバ側に残す。実行は RSP が担う。

CREATE TABLE IF NOT EXISTS device_mesh_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email text NOT NULL,
  device_id text NOT NULL,            -- AI HelpDesk の WEB-XXXXXXXX
  hostname text NOT NULL,
  rsp_device_id uuid NOT NULL,
  mesh_node_id text,
  mapping_status text NOT NULL DEFAULT 'verified',
  verified_by text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_mesh_links_status_check CHECK (mapping_status IN ('verified', 'ambiguous')),
  UNIQUE (device_id)
);
CREATE INDEX IF NOT EXISTS device_mesh_links_user_idx ON device_mesh_links (user_email, created_at DESC);

CREATE TABLE IF NOT EXISTS mesh_install_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id text NOT NULL,
  resolve_session_id uuid REFERENCES resolution_sessions(id) ON DELETE SET NULL,
  user_email text NOT NULL,
  device_id text NOT NULL,
  rsp_device_id uuid NOT NULL,
  hostname text NOT NULL,
  status text NOT NULL,               -- requested | triggered | installed | skipped | failed
  triggered_deploy boolean NOT NULL DEFAULT false,
  agent_installed boolean NOT NULL DEFAULT false,
  agent_online boolean NOT NULL DEFAULT false,
  last_error text,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mesh_install_requests_status_check CHECK (
    status IN ('requested', 'triggered', 'installed', 'skipped', 'failed')
  ),
  UNIQUE (case_id, rsp_device_id)
);
CREATE INDEX IF NOT EXISTS mesh_install_requests_case_idx ON mesh_install_requests (case_id, requested_at DESC);

COMMENT ON TABLE device_mesh_links IS 'AI HelpDesk 端末と RSP 端末の対応（推測で結ばない）';
COMMENT ON TABLE mesh_install_requests IS 'MeshAgent 導入要求と結果（実行は RSP）';
