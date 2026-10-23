import { config } from '../config.js';

/**
 * 同一人物のメール別名（`alias=primary` のカンマ区切り）。
 * 例: `taro@gmail.com=taro@mirai-const.co.jp`（Gmail ログインを会社アカウントに正規化）
 *
 * 目的:
 * - Cloudflare Access で同じ人が複数のメールでログインしても、状態・権限・表示を揃える。
 * - 名簿（/api/me）の照合は「正規化後のメール」と「別名」の両方を試す。
 */
export function parseAliases(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of String(raw || '').split(',')) {
    const [alias, primary] = pair.split('=').map((value) => value?.trim().toLowerCase());
    if (alias && primary && alias !== primary) map.set(alias, primary);
  }
  return map;
}

/** 別名を primary へ正規化する（連鎖は最大 3 段）。 */
export function canonicalEmail(
  email: string | null | undefined,
  rawAliases: string = config.EMAIL_ALIASES,
): string {
  let value = String(email || '')
    .trim()
    .toLowerCase();
  if (!value) return '';
  const map = parseAliases(rawAliases);
  for (let step = 0; step < 3; step += 1) {
    const next = map.get(value);
    if (!next || next === value) break;
    value = next;
  }
  return value;
}

/** 名簿照合用の候補（正規化後 + その別名）。 */
export function emailVariants(
  email: string | null | undefined,
  rawAliases: string = config.EMAIL_ALIASES,
): string[] {
  const canonical = canonicalEmail(email, rawAliases);
  if (!canonical) return [];
  const out = [canonical];
  for (const [alias, primary] of parseAliases(rawAliases)) {
    if (primary === canonical && !out.includes(alias)) out.push(alias);
  }
  return out;
}
