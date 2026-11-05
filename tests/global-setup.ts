import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { assertTestDatabase } from '../scripts/lib/test-database-guard.mjs';

export default function globalSetup(): void {
  // test.env は worker にしか適用されない。親が別環境なら子だけ test に変えず拒否する。
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('[test-database] globalSetup には親 NODE_ENV=test の明示指定が必要です。');
  }
  const root = path.resolve(import.meta.dirname, '..');
  const env = { ...process.env };
  // 子プロセス・dotenv・DB driver を起動する前に検証する。設定不足時の補完は禁止。
  assertTestDatabase(env);
  execFileSync('npx', ['tsx', 'scripts/migrate.ts'], { cwd: root, stdio: 'inherit', env });
  execFileSync('npx', ['tsx', 'scripts/seed.ts'], { cwd: root, stdio: 'inherit', env });
}
