#!/usr/bin/env node
/** 合成 DB のみ。production/Access enforce で起動し、未認証の閉鎖境界を確認する。 */
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, realpathSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
// この入口の main DB は NODE_ENV=test の guard と同じく厳格検証する。
const { assertTestDatabase } = await import('../apps/api/dist/lib/test-database.js');
// NODE_ENV=test を明示した隔離 runner からだけ使う（production DB での利用を拒否）。
const target = assertTestDatabase(process.env);
if (!target) throw new Error('TEST_ENV_REQUIRED');
for (const file of ['.env', '.env.local', '.env.test.local']) {
  try {
    lstatSync(path.join(root, file));
    throw new Error('ENV_FILE_PRESENT');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('ENV_FILE_PRESENT');
  }
}
const home = process.env.HOME;
if (
  typeof home !== 'string' ||
  !/^\/tmp\/aihd-verify\.[A-Za-z0-9]{8}\/home$/.test(home) ||
  realpathSync(home) !== home ||
  !lstatSync(home).isDirectory() ||
  (lstatSync(home).mode & 0o777) !== 0o700
)
  throw new Error('PRIVATE_SCRATCH_REQUIRED');
const allowlistFile = path.join(home, 'synthetic-allowlist');
writeFileSync(allowlistFile, 'synthetic@example.invalid\n', { mode: 0o600, flag: 'wx' });
const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
  timeout: 5000,
});
const expected = commit.status === 0 ? commit.stdout.trim() : '';
if (!/^[a-f0-9]{40}$/.test(expected)) throw new Error('COMMIT_INVALID');
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close((error) => (error ? reject(error) : resolve(address.port)));
  });
});
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['apps/api/dist/index.js'], {
  cwd: root,
  stdio: 'ignore',
  env: {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    DATABASE_URL: process.env.DATABASE_URL,
    SESSION_SECRET: 'synthetic-session-secret-0123456789abcdef',
    LOG_LEVEL: 'silent',
    PORT: String(port),
    HOST: '127.0.0.1',
    COMMIT_SHA: expected,
    AUTH_MODE: 'cloudflare-access',
    ACCESS_JWT_MODE: 'enforce',
    ACCESS_TEAM_DOMAIN: 'synthetic-team.cloudflareaccess.com',
    ACCESS_AUD: 'synthetic-audience',
    ACCESS_ALLOWLIST_FILE: allowlistFile,
    REQUIRE_PROXY_SECRET: 'false',
    MAIL_TRANSPORT: 'disabled',
    AUDIT_KNOWN_BREAKS: '',
    MIRAI_INFO_DATABASE_URL: process.env.DATABASE_URL,
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
    RSP_BASE_URL: 'http://127.0.0.1:1',
    // RESOLVE_PATH_MODE / ASSIST_SESSION_MODE / FOLDER_ACCESS_ENABLED は未指定（既定 off）。
  },
});
let running = true;
let spawnError = false;
const closed = new Promise((resolve) => {
  child.once('error', () => {
    spawnError = true;
  });
  child.once('close', () => {
    running = false;
    resolve();
  });
});
async function stop() {
  if (!running) return;
  child.kill('SIGTERM');
  await Promise.race([closed, delay(7000)]);
  if (running) {
    child.kill('SIGKILL');
    await closed;
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void stop().then(() => process.exit(1));
  });
}
async function request(route, options = {}, timeoutMs = 3000) {
  return fetch(`${base}${route}`, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
}
try {
  let ready = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!running || spawnError) throw new Error('SMOKE_START_FAILED');
    try {
      const response = await request(
        '/api/health',
        {},
        Math.max(1, Math.min(3000, deadline - Date.now())),
      );
      const body = await response.json();
      ready =
        response.status === 200 &&
        body.ok === true &&
        body.db === 'ok' &&
        body.env === 'production' &&
        body.commit === expected;
      if (ready) break;
    } catch {
      /* 自分の起動だけを最大 30 秒待つ。 */
    }
    await delay(Math.max(1, Math.min(500, deadline - Date.now())));
  }
  if (!ready) throw new Error('SMOKE_HEALTH_FAILED');
  const me = await request('/api/me');
  if (me.status !== 401) throw new Error('SMOKE_AUTH_BOUNDARY_FAILED');
  const forged = await request('/api/me', {
    headers: { 'Cf-Access-Authenticated-User-Email': 'synthetic@example.invalid' },
  });
  if (forged.status !== 401) throw new Error('SMOKE_UNSIGNED_HEADER_ACCEPTED');
  const register = await request('/api/device/agent/folder-helper/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (register.status !== 404) throw new Error('SMOKE_DISABLED_HELPER_OPEN');
  const registerBody = await register.json();
  if (registerBody.error?.message !== 'パスは存在しません。')
    throw new Error('SMOKE_DISABLED_HELPER_WRONG_REASON');
  // readonly 診断本体も、合格/誤SHAの負対照の両方を実プロセスへ実行する。
  for (const [sha, expectedStatus] of [
    [expected, 0],
    ['0'.repeat(40), 1],
  ]) {
    const result = spawnSync(
      process.execPath,
      ['scripts/ops-readiness.mjs', '--base-url', base, '--expected-commit', sha],
      {
        cwd: root,
        env: { PATH: process.env.PATH ?? '' },
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 128 * 1024,
      },
    );
    if (result.error || result.status !== expectedStatus)
      throw new Error('SMOKE_READINESS_CONTRAST_FAILED');
  }
  console.log(
    'PASS: production-mode synthetic smoke (health/auth/unsigned-header/off/readiness/wrong-SHA)',
  );
  console.log(
    'NOT VERIFIED: real Access login, authenticated UI, actual employee/device, restore, production deployment',
  );
} catch (error) {
  console.error(
    error instanceof Error && /^SMOKE_[A-Z_]+$/.test(error.message)
      ? error.message
      : 'SMOKE_FAILED',
  );
  process.exitCode = 1;
} finally {
  await stop();
  const portClosed = await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(true));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
  if (portClosed) console.log('cleanup: owned smoke child stopped; port closed');
  else {
    console.error('SMOKE_PORT_REMAINS_OPEN');
    process.exitCode = 1;
  }
}
