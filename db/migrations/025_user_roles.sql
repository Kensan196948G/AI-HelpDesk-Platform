-- docs/43 §7-3 の決定（docs/49）: ロールは**複数**を持てる。
--
-- 背景:
--   DX 推進部のメンバーは「ヘルプデスク担当・ナレッジ承認者・監査担当者・IT端末管理者」を
--   兼務しうる。users.role の単一値では表現できないため、user_roles を正本集合として足す。
--   後方互換のため users.role（主ロール）は残し、user_roles が空のユーザーは
--   従来どおり users.role で判定する。
--
-- 制約:
--   - auditor は他ロールと併存させない（読み取り専用の境界を崩さない。docs/43 §3-4）。
--     この排他はアプリ側（auth/roles.ts と sync-roles.ts）で検証する。
--   - 既存 users.role は source='seed' として移行する（データ変換なし・重複無視）。
CREATE TABLE IF NOT EXISTS user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('requester', 'helpdesk', 'approver', 'auditor', 'itops')),
  source text NOT NULL DEFAULT 'sync' CHECK (source IN ('seed', 'sync', 'manual')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by text,
  PRIMARY KEY (user_id, role)
);

CREATE INDEX IF NOT EXISTS user_roles_role_idx ON user_roles (role);

INSERT INTO user_roles (user_id, role, source)
SELECT id, role, 'seed' FROM users
ON CONFLICT (user_id, role) DO NOTHING;
