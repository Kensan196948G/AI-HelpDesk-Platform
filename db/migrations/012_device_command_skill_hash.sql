-- 端末コマンドに Skill 定義のハッシュを保存し、端末側で承認済み Skill と照合できるようにする。
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS skill_content_hash text;
