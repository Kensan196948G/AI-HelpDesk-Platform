-- 最終報告書（Standalone HTML / PDF）の保存。
-- 画面が組み立てた構造化データ（伏せ字化後）と、生成した HTML / SHA-256 を保存する。
-- GET は作成した利用者（user_email）だけに限定する。
CREATE TABLE IF NOT EXISTS final_reports (
  id uuid PRIMARY KEY,
  user_email text NOT NULL,
  case_id text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  html text NOT NULL,
  html_filename text NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT final_reports_kind_check CHECK (kind IN ('ai_resolved', 'helpdesk_resolved'))
);

CREATE INDEX IF NOT EXISTS final_reports_user_created_idx
  ON final_reports (user_email, created_at DESC);
