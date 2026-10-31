-- 028: RSP への問い合わせ回数の上限（docs/62 §4）。追加のみ・冪等。
ALTER TABLE folder_access_requests
  ADD COLUMN IF NOT EXISTS rsp_probe_reads integer NOT NULL DEFAULT 0;
