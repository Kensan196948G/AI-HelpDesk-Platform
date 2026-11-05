// staging-smoke の DB 所有証明で使う純粋関数。DB・ファイル・環境変数には触れない。
// token は 32 byte の hex（64 文字）だけを許可する。
export const SMOKE_OWNER_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

/** 形式が正しい所有証明 token かを返す。非文字列・大文字・長さ違いはすべて拒否する。 */
export function isSmokeOwnerToken(value) {
  return typeof value === 'string' && SMOKE_OWNER_TOKEN_PATTERN.test(value);
}

/** 刻印する comment の期待値。token が不正なら undefined（誤った刻印を作らない）。 */
export function expectedSmokeOwnerComment(token) {
  return isSmokeOwnerToken(token) ? `smoke-owner:${token}` : undefined;
}

/** DB から読んだ comment が、指定 token の刻印と完全一致するかを返す。 */
export function isSmokeOwnerComment(actual, token) {
  if (!isSmokeOwnerToken(token) || typeof actual !== 'string') return false;
  return actual === `smoke-owner:${token}`;
}
