import { config } from '../config.js';

/**
 * 「別アカウントだが同じ人物」の対応表（`SHARED_IDENTITY_GROUPS`）。
 *
 * `EMAIL_ALIASES` は同一人物の複数メールを **1 つの主体に正規化**する（状態・権限が共有される）。
 * こちらは正規化せず、**監査・応答に「同一人物である」事実を残すためだけ**に使う。
 * 例: `kensan1969@gmail.com|k-aritoh@mirai-const.co.jp`（`;` 区切りで複数グループ）
 *
 * 背景: 別名を解除してアカウントを分けると `self_approved=false` になるが、それは
 * 「別アカウント」の意味であって「別人物」ではない。読み手が誤解しないよう記録する。
 */
export function parseSharedIdentityGroups(raw: string): string[][] {
  return String(raw || '')
    .split(';')
    .map((group) =>
      group
        .split('|')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    )
    .filter((group) => group.length >= 2);
}

/** a と b が「別アカウントだが同一人物」か。同じ文字列なら false（別アカウントではない）。 */
export function sameHuman(
  a: string | null | undefined,
  b: string | null | undefined,
  raw: string = config.SHARED_IDENTITY_GROUPS,
): boolean {
  const x = String(a ?? '')
    .trim()
    .toLowerCase();
  const y = String(b ?? '')
    .trim()
    .toLowerCase();
  if (!x || !y || x === y) return false;
  return parseSharedIdentityGroups(raw).some((group) => group.includes(x) && group.includes(y));
}
