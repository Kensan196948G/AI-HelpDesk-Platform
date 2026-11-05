import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const TOKEN = 'a'.repeat(64);
const INVALID_TOKEN = 'a'.repeat(63);

// 子プロセスには PATH だけを渡す。token / manifest path / DB URL を継承させない。
function run(env) {
  return spawnSync(process.execPath, ['scripts/staging-smoke.mjs'], {
    cwd: root,
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
    timeout: 8_000,
    maxBuffer: 64 * 1024,
  });
}

function expectFixedFailure(env, code) {
  const result = run(env);
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stderr.trim()).toBe(code);
  // 固定 code だけを出し、token・DSN を echo しない。
  expect(result.stderr).not.toContain(TOKEN);
  expect(result.stderr).not.toContain(INVALID_TOKEN);
  expect(result.stderr).not.toContain('postgresql://');
  expect(result.stdout).not.toContain(TOKEN);
  expect(result.stdout).not.toContain(INVALID_TOKEN);
}

describe('staging-smoke 入口: DB 接続前に固定 code で停止する', () => {
  it.each([
    ['token 未設定', {}],
    ['token が短い', { AIHD_SMOKE_OWNER_TOKEN: INVALID_TOKEN }],
    ['token が大文字', { AIHD_SMOKE_OWNER_TOKEN: TOKEN.toUpperCase() }],
    ['token が非 hex', { AIHD_SMOKE_OWNER_TOKEN: 'g'.repeat(64) }],
  ])('%sなら SMOKE_OWNER_TOKEN_INVALID', (_label, env) => {
    expectFixedFailure(env, 'SMOKE_OWNER_TOKEN_INVALID');
  });

  it.each([
    ['AIHD_DIST_MANIFEST 未設定', {}],
    ['相対 path', { AIHD_DIST_MANIFEST: 'dist-manifest.json' }],
  ])('token が正しく %s なら SMOKE_DIST_MANIFEST_MISSING', (_label, env) => {
    expectFixedFailure({ AIHD_SMOKE_OWNER_TOKEN: TOKEN, ...env }, 'SMOKE_DIST_MANIFEST_MISSING');
  });

  it.each([
    ['存在しない path', '/tmp/aihd-staging-smoke-missing.json'],
    ['directory', root],
  ])('manifest が %s なら SMOKE_DIST_MANIFEST_INVALID', (_label, manifestPath) => {
    expectFixedFailure(
      { AIHD_SMOKE_OWNER_TOKEN: TOKEN, AIHD_DIST_MANIFEST: manifestPath },
      'SMOKE_DIST_MANIFEST_INVALID',
    );
  });
});
