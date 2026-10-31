import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');

function loadConfig(env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', "await import('./apps/api/src/config.ts')"],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        DATABASE_URL: 'postgresql://user:pass@127.0.0.1:1/none',
        SESSION_SECRET: 'x'.repeat(40),
        ...env,
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
}

describe('config（起動時の安全確認）', () => {
  it('NODE_ENV=production で AUTH_MODE=local は起動を拒否する', () => {
    const result = loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'local' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AUTH_MODE=local');
  });

  it('NODE_ENV=production で AUTH_MODE 未指定（既定 local）も拒否する', () => {
    const result = loadConfig({ NODE_ENV: 'production' });
    expect(result.status).toBe(1);
  });

  it('ACCESS_JWT_MODE を有効にするのに AUD が無ければ拒否する', () => {
    const result = loadConfig({
      NODE_ENV: 'production',
      AUTH_MODE: 'cloudflare-access',
      ACCESS_JWT_MODE: 'enforce',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ACCESS_AUD');
  });

  it('NODE_ENV=production で FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE=true は起動を拒否する', () => {
    const result = loadConfig({
      NODE_ENV: 'production',
      AUTH_MODE: 'cloudflare-access',
      FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE: 'true',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE');
  });

  it('本番以外では FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE=true で起動できる（検証用）', () => {
    const result = loadConfig({
      NODE_ENV: 'development',
      FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE: 'true',
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('FOLDER_ACCESS_ENABLED は true/false 以外を拒否する', () => {
    const result = loadConfig({ NODE_ENV: 'development', FOLDER_ACCESS_ENABLED: 'yes' });
    expect(result.status).toBe(1);
  });

  it('production + cloudflare-access は起動できる', () => {
    const result = loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'cloudflare-access' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('空の ACCESS_TEAM_DOMAIN / ACCESS_AUD（.env.example の既定）は未設定として扱う', () => {
    const result = loadConfig({
      NODE_ENV: 'production',
      AUTH_MODE: 'cloudflare-access',
      ACCESS_JWT_MODE: 'off',
      ACCESS_TEAM_DOMAIN: '',
      ACCESS_AUD: '',
    });
    expect(result.status, result.stderr).toBe(0);
  });
});
