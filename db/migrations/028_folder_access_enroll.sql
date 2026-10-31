-- 028: ヘルパー登録の導入コード（docs/62）。追加のみ・冪等。
--   コードは HMAC だけを保存する。一回限りで、再発行すると上書きされる。
--   enrolled_request_id はペアの前の候補。ペアで確定する request_id とは別に持つ。
ALTER TABLE folder_access_requests ADD COLUMN IF NOT EXISTS enroll_code_hash text;
ALTER TABLE folder_access_requests ADD COLUMN IF NOT EXISTS enroll_code_expires_at timestamptz;
ALTER TABLE folder_access_requests
  ADD COLUMN IF NOT EXISTS enroll_code_issues integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS folder_access_requests_enroll_code_idx
  ON folder_access_requests (enroll_code_hash)
  WHERE enroll_code_hash IS NOT NULL;

ALTER TABLE folder_access_helpers ADD COLUMN IF NOT EXISTS enrolled_request_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'folder_access_helpers_enrolled_request_fk'
  ) THEN
    ALTER TABLE folder_access_helpers
      ADD CONSTRAINT folder_access_helpers_enrolled_request_fk
      FOREIGN KEY (enrolled_request_id) REFERENCES folder_access_requests(id) ON DELETE SET NULL;
  END IF;
END $$;
