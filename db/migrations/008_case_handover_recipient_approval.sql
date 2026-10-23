-- 引継ぎの「宛先（DX 推進部グループから選択）」と「ナレッジ承認（DX 推進部の誰か）」。
-- 007 の引継ぎテーブルに列を追加する（既存行は NULL のままでよい）。
ALTER TABLE case_handovers
  ADD COLUMN IF NOT EXISTS recipient_no text,
  ADD COLUMN IF NOT EXISTS recipient_name text,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS self_approved boolean NOT NULL DEFAULT false;
