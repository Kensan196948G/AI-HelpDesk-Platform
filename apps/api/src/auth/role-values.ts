import type { Role } from './types.js';

/**
 * ロールの値と検証（DB に依存しない純粋な部分）。
 * 設定を読む `roles.ts` とは分離し、CLI（scripts/sync-roles.ts）からも安全に使えるようにする。
 */

/** 有効なロール（docs/43 Phase B）。 */
export const ROLE_VALUES: readonly Role[] = [
  'requester',
  'helpdesk',
  'approver',
  'auditor',
  'itops',
] as const;

export function isRole(value: string): value is Role {
  return (ROLE_VALUES as readonly string[]).includes(value);
}

/**
 * ロール集合の検証（docs/49 §3）。
 * - 監査は読み取り専用の境界を保つため、他ロールと併存させない。
 * - 空集合は許可しない（主ロールへフォールバックさせるため）。
 * 問題があれば日本語のメッセージ、問題なければ null を返す。
 */
export function validateRoleSet(roles: readonly string[]): string | null {
  if (roles.length === 0) return 'ロールを1つ以上指定してください。';
  const unknown = roles.filter((role) => !isRole(role));
  if (unknown.length > 0) return `不明なロールです: ${unknown.join(', ')}`;
  if (roles.includes('auditor') && roles.length > 1) {
    return 'auditor は他のロールと併存できません（読み取り専用の境界を保つため）。';
  }
  return null;
}
