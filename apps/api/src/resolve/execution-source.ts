/**
 * 端末コマンドの結果の出所（docs/25 §20）。
 *
 * - `endpoint_agent`: 端末エージェントが PowerShell を実行した結果（エージェントの申告）。
 * - `mock`: エージェントの fixture（`--mock` / Windows 以外）。実端末の結果ではない。
 * - `unknown`: 申告が無い・値が不正（旧版エージェント等）。実端末の結果と見なさない。
 *
 * 申告はデバイストークンを持つエージェントの自己申告であり、端末の実在を証明しない。
 * 「模擬を実端末に見せない」「模擬を本番へ入れない」ための区別である。
 */
export type ExecutionSource = 'endpoint_agent' | 'mock' | 'unknown';

export function executionSourceOf(result: unknown): ExecutionSource {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'unknown';
  const value = (result as { executionSource?: unknown }).executionSource;
  return value === 'endpoint_agent' || value === 'mock' ? value : 'unknown';
}

/**
 * Skill の結果を受け取ってよいか。本番相当では `endpoint_agent` だけを受け付ける（fail-closed）。
 * 旧版エージェントの fixture は申告が無いので、`unknown` も拒否する。
 * Cloudflare Access の認証で動いている環境は NODE_ENV の設定漏れがあっても本番相当とみなす。
 */
export function resultSourceAccepted(
  source: ExecutionSource,
  env: { nodeEnv: string; authMode: string },
): boolean {
  if (env.nodeEnv !== 'production' && env.authMode !== 'cloudflare-access') return true;
  return source === 'endpoint_agent';
}

/**
 * Skill の resultSchema（{ キー: 型名 }）と結果の形を照合する（機械検証の下限）。
 * 宣言が無ければ null（評価しない）。true でも問題の解決を意味しない。
 */
export function resultShapeOk(schema: unknown, normalized: unknown): boolean | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const entries = Object.entries(schema as Record<string, unknown>);
  if (entries.length === 0) return null;
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return false;
  const record = normalized as Record<string, unknown>;
  return entries.every(([key, type]) => {
    if (!Object.hasOwn(record, key)) return false;
    if (type === 'string' || type === 'number' || type === 'boolean') {
      return typeof record[key] === type;
    }
    return true;
  });
}
