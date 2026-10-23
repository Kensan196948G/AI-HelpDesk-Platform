import { config } from '../config.js';

/**
 * 「操作する人」の切替モード。
 * - local（開発・テスト）: any（デモのため自由に切替）
 * - cloudflare-access（本番）: self（本人以外へ切り替え不可）
 *   `PERSONA_SWITCH_ALLOWLIST` に列挙したメールだけ any（デモ用アカウント）
 */
export function personaSwitchMode(
  email: string | null | undefined,
  authMode: string = config.AUTH_MODE,
): 'any' | 'self' {
  if (authMode === 'local') return 'any';
  return personaSwitchAllowed(email) ? 'any' : 'self';
}

export function personaSwitchAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  const target = email.trim().toLowerCase();
  return config.PERSONA_SWITCH_ALLOWLIST.split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(target);
}
