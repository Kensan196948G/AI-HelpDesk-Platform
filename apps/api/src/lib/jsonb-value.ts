import { sql } from '../db.js';

/**
 * JSONB 列へ渡す値を postgres.js の JSON 値としてマークする。
 *
 * `JSON.stringify()` した文字列を `::jsonb` でキャストすると、postgres.js が
 * さらに JSON エンコードして「JSON 文字列」として保存される（二重エンコード）。
 * オブジェクトをそのまま渡す必要があるが、postgres.js の `JSONValue` 型は
 * index signature を要求するため、アプリ側の interface をそのまま渡せない。
 * 型の変換はこの 1 箇所に閉じ込める。
 */
export function jsonbValue(value: unknown) {
  return sql.json(value as never);
}
