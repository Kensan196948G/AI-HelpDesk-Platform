import { canonicalEmail } from '../auth/email-alias.js';
import { config } from '../config.js';

/**
 * IT 管理者（リスク 4 以上の Skill 承認者）の許可リスト。
 * 呼び出し時にパースする（テストが config を差し替えるため）。
 */
export function resolveAdminAllowlist(): Set<string> {
  return new Set(
    String(config.RESOLVE_ADMIN_ALLOWLIST ?? '')
      .split(',')
      .map((value) => canonicalEmail(value))
      .filter(Boolean),
  );
}

/** そのメールが IT 管理者か。空の許可リストは「誰も承認できない」（fail-closed）。 */
export function isResolveAdmin(email: string): boolean {
  return resolveAdminAllowlist().has(canonicalEmail(email));
}
