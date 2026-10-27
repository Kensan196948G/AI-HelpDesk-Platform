import { sql } from '../db.js';
import { isRole, ROLE_VALUES, validateRoleSet } from './role-values.js';
import type { Role } from './types.js';

// ロール値の定義・検証は DB 非依存の role-values.ts に置く（CLI からも使う）。
export { isRole, ROLE_VALUES, validateRoleSet };

/**
 * ユーザーのロール集合を返す。
 * `user_roles` を正本とし、行が無い場合だけ `users.role`（主ロール）へフォールバックする
 * （migration 025 以前のユーザー・シード直後のユーザーを壊さない）。
 */
export async function loadUserRoles(userId: string, primaryRole: Role): Promise<Role[]> {
  const rows = await sql<{ role: Role }[]>`
    SELECT role FROM user_roles WHERE user_id = ${userId} ORDER BY role
  `;
  if (rows.length === 0) return [primaryRole];
  return rows.map((row) => row.role);
}

/** 許可ロールのいずれかを持っているか。 */
export function rolesInclude(roles: readonly Role[], allowed: readonly Role[]): boolean {
  return roles.some((role) => allowed.includes(role));
}

/**
 * メールアドレスからロール集合を引く（UI 経路用）。
 * `users` に居ない（＝シード外・デモ用）場合は null を返す（呼び出し側は従来動作を維持する）。
 */
export async function loadRolesByEmail(email: string): Promise<Role[] | null> {
  const rows = await sql<{ id: string; role: Role }[]>`
    SELECT id, role FROM users
    WHERE lower(email) = lower(${email}) AND is_active = true
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return loadUserRoles(row.id, row.role);
}
