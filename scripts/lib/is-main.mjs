/**
 * ESM スクリプトの「このファイルがエントリポイントか」判定。
 *
 * 素朴な判定 `import.meta.url === pathToFileURL(process.argv[1]).href` は、
 * スクリプトが **シンボリックリンク経由** で起動された場合に偽になる。
 * Node は既定（`--preserve-symlinks` 無効）でモジュールを実パスで解決するため
 * `import.meta.url` は実パスを指すが、`process.argv[1]` は起動時に渡された
 * 文字列（symlink を含むパス）のままになるためである。
 *
 * その結果 `main()` が実行されず、**終了コード 0 のまま何もしない**。
 * 呼び出し側は「成功した」と誤認する。release の `current` シンボリックリンク経由で
 * 起動する運用（本リポジトリの Staging/本番配備）では常にこれが起きる。
 *
 * 本モジュールは双方を実パスに解決してから比較する。実パス解決に失敗した場合は
 * 生の文字列比較へフォールバックする（存在を前提にしない）。
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function resolve(realpath, target) {
  try {
    const resolved = realpath(target);
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} importMetaUrl - 呼び出し側の `import.meta.url`
 * @param {string | undefined} argv1 - `process.argv[1]`
 * @param {(p: string) => string} [realpath] - テスト用の差し替え（省略時は fs.realpathSync）
 * @returns {boolean} エントリポイントとして起動された場合のみ true
 */
export function isMainModule(importMetaUrl, argv1, realpath = realpathSync) {
  if (typeof importMetaUrl !== 'string' || !importMetaUrl.startsWith('file:')) return false;
  if (typeof argv1 !== 'string' || argv1.length === 0) return false;

  let selfPath;
  try {
    selfPath = fileURLToPath(importMetaUrl);
  } catch {
    return false;
  }

  const self = resolve(realpath, selfPath) ?? selfPath;
  const entry = resolve(realpath, argv1) ?? argv1;
  return self === entry;
}
