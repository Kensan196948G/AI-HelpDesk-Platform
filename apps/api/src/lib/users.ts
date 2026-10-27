import { sql } from '../db.js';

/** メールアドレスから users 行の id を引く（大文字小文字は同一視する）。 */
export async function userIdForEmail(email: string): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE lower(email) = lower(${email}) LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * ナレッジ・実行記録の作成者（author_id）を解決する。
 *
 * Access 認証の担当者は `users` に居ないことがあるため、作成時に限り
 * パスワードではログインできない行（password_hash が scrypt 形式でない）を作る。
 * 作成者を別の人にすり替えない（監査のため）。
 */
export async function ensureAuthorUser(email: string, name: string): Promise<string> {
  const existing = await userIdForEmail(email);
  if (existing) return existing;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, role, password_hash)
    VALUES (${email}, ${name.slice(0, 120)}, 'helpdesk', 'access-only$no-login')
    ON CONFLICT (lower(email)) DO UPDATE SET updated_at = now()
    RETURNING id
  `;
  return rows[0]?.id ?? '';
}
