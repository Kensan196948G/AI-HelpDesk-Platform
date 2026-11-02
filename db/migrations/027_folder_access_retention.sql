-- 027: 同意の終了から保持期間を過ぎた識別子を消せるようにする（docs/62 §7-1）。
-- NOT NULL を外すだけで、既存のデータと既存のコードに影響しない。追加のみ・冪等。
ALTER TABLE folder_access_helpers ALTER COLUMN sid DROP NOT NULL;
ALTER TABLE folder_access_helpers ALTER COLUMN machine_guid DROP NOT NULL;
ALTER TABLE folder_access_ops ALTER COLUMN sid DROP NOT NULL;
ALTER TABLE folder_access_ops ALTER COLUMN root DROP NOT NULL;
