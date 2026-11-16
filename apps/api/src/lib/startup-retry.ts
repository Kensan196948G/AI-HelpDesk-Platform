/**
 * 起動直後の一過性 DB 失敗だけを、短い待機で再試行する。
 *
 * 2026-11-16 12:37 のホスト再起動で、本番 API が PostgreSQL（Docker 側）より先に
 * 起動し、`ensureSkillCatalog()` が ECONNREFUSED で 1 回失敗した（journal 実測）。
 * 失敗してもサーバは起動するが、次回再起動まで Skill カタログが同期されない。
 *
 * 対象は「DB がまだ受け付けていない」系のエラーだけにする。認証・SQL 構文・
 * 権限などの恒久的な失敗を再試行で隠さない。
 */

export interface StartupRetryOptions {
  /** 総試行回数（初回を含む）。 */
  attempts?: number;
  /** 再試行前の待機。足りない場合は最後の値を使う。 */
  delaysMs?: number[];
  /** 再試行してよいエラーか。既定は DB 起動待ちの既知コードのみ。 */
  shouldRetry?: (error: unknown) => boolean;
  /** テストで待機を差し替えるためのフック。 */
  sleep?: (ms: number) => Promise<void>;
}

/** PostgreSQL / ネットワークが「まだ起動していない」ときに返す既知コード。 */
export function isDatabaseStarting(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return false;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    // PostgreSQL: the database system is starting up
    code === '57P03'
  );
}

/**
 * `fn` を最大 `attempts` 回まで実行する。再試行対象のエラーでのみ待機してやり直し、
 * 対象外のエラーまたは最後の試行ではそのまま throw する。
 */
export async function retryWhileStarting<T>(
  fn: () => Promise<T>,
  options: StartupRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 5);
  const delays = options.delaysMs ?? [250, 500, 1000, 2000];
  const shouldRetry = options.shouldRetry ?? isDatabaseStarting;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isLast = attempt === attempts - 1;
      if (isLast || !shouldRetry(error)) throw error;
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0;
      await sleep(delay);
    }
  }
  throw lastError;
}
