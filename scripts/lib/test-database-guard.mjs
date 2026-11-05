// 実行スクリプトは tsx、試験は Vitest で解決する。API build は src 内の正本を同梱する。
export {
  assertCurrentTestDatabase,
  assertTestDatabase,
  DEFAULT_TEST_DATABASE_NAME,
  isEnvFileTestSwitch,
} from '../../apps/api/src/lib/test-database.ts';
