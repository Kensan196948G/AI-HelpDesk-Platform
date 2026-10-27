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
