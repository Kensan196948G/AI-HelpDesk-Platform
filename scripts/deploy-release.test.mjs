import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * deploy-release.sh の入力ガード。
 *
 * 2026-11-11 の Staging 配備では、`--env-file` に release メタ情報だけの
 * `current/release.env`（DATABASE_URL を含まない）を渡したため、build 後の
 * migrate で停止した。`--unit-template` を付けない呼び出しでも、build 前に
 * 同じ誤りを検出できることを確認する（実 build は行わない）。
 */
const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'scripts', 'deploy-release.sh');
const ref = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirs = [];

function prepare(envContent) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aihd-deploy-guard-'));
  dirs.push(dir);
  const envFile = path.join(dir, 'env');
  writeFileSync(envFile, envContent, { mode: 0o600 });
  chmodSync(envFile, 0o600);
  const releaseRoot = path.join(dir, 'releases-root');
  mkdirSync(releaseRoot);
  return { envFile, releaseRoot };
}

function run(flag, envFile, releaseRoot) {
  return spawnSync(
    'bash',
    [
      script,
      '--repo',
      root,
      '--ref',
      ref,
      '--root',
      releaseRoot,
      '--env-file',
      envFile,
      '--unit',
      'test-unit',
      '--health-port',
      '19999',
      flag,
    ],
    { cwd: root, encoding: 'utf8', timeout: 15_000 },
  );
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('deploy-release.sh: --migrate/--seed の DATABASE_URL 事前ガード', () => {
  it.each(['--migrate', '--seed'])(
    '%s は DATABASE_URL のない env file を build 前に拒否する',
    (flag) => {
      const { envFile, releaseRoot } = prepare('SESSION_SECRET=test-only\n');
      const result = run(flag, envFile, releaseRoot);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('lacks DATABASE_URL');
    },
  );
});
