-- 010_jsonb_objects.sql
-- アプリ経由の JSONB 書き込みが JSON 文字列（二重エンコード）として保存されていた分を、
-- JSON オブジェクト / 配列へ戻す。読み出し側は文字列・オブジェクトの両方に対応済み。
-- 文字列が JSON として妥当でない場合は変更しない（誤ったキャストで失敗させない）。

UPDATE prototype_states
SET data = (data #>> '{}')::jsonb
WHERE jsonb_typeof(data) = 'string' AND btrim(data #>> '{}') ~ '^[\[{]';

UPDATE device_inventories
SET data = (data #>> '{}')::jsonb
WHERE jsonb_typeof(data) = 'string' AND btrim(data #>> '{}') ~ '^[\[{]';

UPDATE device_commands
SET params = (params #>> '{}')::jsonb
WHERE jsonb_typeof(params) = 'string' AND btrim(params #>> '{}') ~ '^[\[{]';

UPDATE device_commands
SET result = (result #>> '{}')::jsonb
WHERE jsonb_typeof(result) = 'string' AND btrim(result #>> '{}') ~ '^[\[{]';

UPDATE case_handovers
SET snapshot = (snapshot #>> '{}')::jsonb
WHERE jsonb_typeof(snapshot) = 'string' AND btrim(snapshot #>> '{}') ~ '^[\[{]';

UPDATE case_messages
SET metadata = (metadata #>> '{}')::jsonb
WHERE jsonb_typeof(metadata) = 'string' AND btrim(metadata #>> '{}') ~ '^[\[{]';

UPDATE pc_snapshots
SET items = (items #>> '{}')::jsonb
WHERE jsonb_typeof(items) = 'string' AND btrim(items #>> '{}') ~ '^[\[{]';

UPDATE pc_snapshots
SET concerns = (concerns #>> '{}')::jsonb
WHERE jsonb_typeof(concerns) = 'string' AND btrim(concerns #>> '{}') ~ '^[\[{]';

UPDATE tickets
SET shared_fields = (shared_fields #>> '{}')::jsonb
WHERE jsonb_typeof(shared_fields) = 'string' AND btrim(shared_fields #>> '{}') ~ '^[\[{]';

UPDATE knowledge_reviews
SET checklist = (checklist #>> '{}')::jsonb
WHERE jsonb_typeof(checklist) = 'string' AND btrim(checklist #>> '{}') ~ '^[\[{]';

UPDATE final_reports
SET payload = (payload #>> '{}')::jsonb
WHERE jsonb_typeof(payload) = 'string' AND btrim(payload #>> '{}') ~ '^[\[{]';

-- 監査ログの detail は stableStringify で再計算するため、オブジェクト化してもチェーンは保たれる。
UPDATE audit_log
SET detail = (detail #>> '{}')::jsonb
WHERE jsonb_typeof(detail) = 'string' AND btrim(detail #>> '{}') ~ '^[\[{]';
