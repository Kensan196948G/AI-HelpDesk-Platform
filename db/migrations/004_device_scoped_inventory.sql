-- 004_device_scoped_inventory.sql
-- 同一ユーザーでも「ログイン中のブラウザ端末」と「エージェントを実行した端末」を
-- 混ぜないため、device_id を含む主キーへ変更する。
-- 既存行は device_id を持っている（browser は UUID、agent はホスト名）。
UPDATE device_inventories SET device_id = 'unknown' WHERE device_id IS NULL;
ALTER TABLE device_inventories DROP CONSTRAINT IF EXISTS device_inventories_pkey;
ALTER TABLE device_inventories ALTER COLUMN device_id SET NOT NULL;
ALTER TABLE device_inventories ADD PRIMARY KEY (user_email, source, device_id);
