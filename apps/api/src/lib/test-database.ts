/** DB・環境ファイルを一切読まない、接続前の test 専用ガード。 */
export interface TestDatabaseEnvironment {
  [key: string]: string | undefined;
  NODE_ENV?: string;
  DATABASE_URL?: string;
  AIHD_TEST_DATABASE_NAME?: string;
}

export interface TestDatabaseTarget {
  databaseName: string;
}

// 既存 CI の固定 fixture のみ後方互換にする。接続 URL から期待値を推測しない。
export const DEFAULT_TEST_DATABASE_NAME = 'ai_helpdesk_test';
const TEST_DATABASE_NAME = /^(?:ai_helpdesk_test|aihd_test_[a-z0-9_]+)$/;
const LOOPBACK_AUTHORITY = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::([1-9][0-9]{0,4}))?$/;

function reject(reason: string): never {
  // URL・実際の DB 名・資格情報・入力例外の cause は絶対に含めない。
  throw new Error(`[test-database] ${reason}`);
}

function isTestDatabaseName(name: string): boolean {
  return name.length <= 63 && TEST_DATABASE_NAME.test(name);
}

/** 非 test の開発・本番設定は変更しない。test は明示 URL を接続前に検証する。 */
export function assertTestDatabase(env: TestDatabaseEnvironment): TestDatabaseTarget | undefined {
  if (env.NODE_ENV !== 'test') return undefined;

  const raw = env.DATABASE_URL;
  if (typeof raw !== 'string' || !raw) {
    reject('NODE_ENV=test には DATABASE_URL の明示指定が必要です。');
  }
  // URL の正規化による別表記、ソケット、複数ホスト、query の設定上書きを許可しない。
  // 空の ? / # も拒否する。ドライバと URL パーサーの解釈差を作らない。
  const parts = /^(postgresql|postgres):\/\/([^/?#]+)\/([^/?#]+)$/.exec(raw);
  if (!parts || /[\s\\]/.test(raw)) {
    reject('PostgreSQL の単一ホスト URL が必要です（query・fragment は禁止）。');
  }
  const authority = parts[2] ?? '';
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  const hostMatch = LOOPBACK_AUTHORITY.exec(host);
  if (!hostMatch || authority.indexOf('@') !== authority.lastIndexOf('@')) {
    reject('接続ホストは完全一致の loopback のみ許可します。');
  }
  if (hostMatch[1] && Number(hostMatch[1]) > 65535) {
    reject('接続ポートが不正です。');
  }
  try {
    // URL constructor のエラーに入力の DSN が含まれる場合があるため、そのまま再送出しない。
    new URL(raw);
  } catch {
    reject('接続 URL の形式が不正です。');
  }

  const databaseName = parts[3] ?? '';
  if (!isTestDatabaseName(databaseName)) {
    reject('接続 DB 名は test 専用の許可名でなければなりません。');
  }
  const expected = env.AIHD_TEST_DATABASE_NAME ?? DEFAULT_TEST_DATABASE_NAME;
  if (typeof expected !== 'string' || !isTestDatabaseName(expected) || expected !== databaseName) {
    reject('AIHD_TEST_DATABASE_NAME と接続 DB 名の完全一致が必要です。');
  }
  return { databaseName };
}

/** migrate / seed の最初の SELECT 結果を、書込開始前に照合する。 */
export function assertCurrentTestDatabase(
  actualDatabaseName: unknown,
  target: TestDatabaseTarget,
): void {
  if (actualDatabaseName !== target.databaseName) {
    reject('current_database() が検証済みの期待 DB 名と一致しません。');
  }
}
