-- docs/43 Phase B: 4 職務（担当 / 承認 / 監査 / IT 端末管理）へロールを拡張する。
--
-- ねらい:
--   監査（auditor）は読み取り専用、IT 端末管理（itops）は端末系の担当として扱う。
--   既存の 3 ロール（requester / helpdesk / approver）の権限は変更しないため、
--   Access グループが未設定の移行期も現行動作のまま動く。
--
-- 変更は CHECK 制約の許可値のみ。既存行は書き換えない（データ変換なし）。
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('requester', 'helpdesk', 'approver', 'auditor', 'itops'));
