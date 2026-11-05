#!/usr/bin/env node
/** 合成 DB のみ。production/Access enforce で起動し、未認証の閉鎖境界を確認する。 */
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, realpathSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DistManifestError,
  readManifestFile,
  verifyManifestAgainstDist,
} from './lib/dist-manifest.mjs';
import { isSmokeOwnerComment, isSmokeOwnerToken } from './lib/smoke-guards.mjs';

const root = path.resolve(import.meta.dirname, '..');
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

function manifestError(error) {
  const code = error instanceof DistManifestError ? error.code : '';
  if (code === 'DIST_MANIFEST_COMMIT_MISMATCH') return new Error('SMOKE_DIST_COMMIT_MISMATCH');
  if (code === 'DIST_MANIFEST_FILES_MISMATCH') return new Error('SMOKE_DIST_FILES_MISMATCH');
  return new Error('SMOKE_DIST_MANIFEST_INVALID');
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

// .env 系がある作業ツリーでは起動しない（dotenv の隠れた値を読ませない）。
function assertNoLocalEnvFiles() {
  for (const file of ['.env', '.env.local', '.env.test.local']) {
    try {
      lstatSync(path.join(root, file));
      throw new Error('ENV_FILE_PRESENT');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('ENV_FILE_PRESENT');
    }
  }
}

// verify-isolated が作る private scratch だけを HOME として許可する。
function privateHome() {
  const home = process.env.HOME;
  if (
    typeof home !== 'string' ||
    !/^\/tmp\/aihd-verify\.[A-Za-z0-9]{8}\/home$/.test(home) ||
    realpathSync(home) !== home ||
    !lstatSync(home).isDirectory() ||
    (lstatSync(home).mode & 0o777) !== 0o700
  )
    throw new Error('PRIVATE_SCRATCH_REQUIRED');
  return home;
}

// 起動前に、所有証明 token の形式 → manifest の path/内容（commit=HEAD・全 hash）→
// dist guard の import → test DB guard → .env 非在 → private HOME → DB comment の所有証明、
// の順で検証する。どれかが欠けたらアプリを起動しない。
// token・comment・manifest path はログへ出さない。
async function preflight() {
  const ownerToken = process.env.AIHD_SMOKE_OWNER_TOKEN;
  if (!isSmokeOwnerToken(ownerToken)) throw new Error('SMOKE_OWNER_TOKEN_INVALID');
  const manifestPath = process.env.AIHD_DIST_MANIFEST;
  if (typeof manifestPath !== 'string' || !path.isAbsolute(manifestPath)) {
    throw new Error('SMOKE_DIST_MANIFEST_MISSING');
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    // token / manifest path を git 子プロセスへ継承させない。
    env: { PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
    timeout: 5000,
  });
  const headSha = head.status === 0 ? head.stdout.trim() : '';
  if (!COMMIT_PATTERN.test(headSha)) throw new Error('COMMIT_INVALID');
  let manifest;
  try {
    manifest = await readManifestFile(manifestPath, { expectedCommit: headSha });
    await verifyManifestAgainstDist(manifest, { repoRoot: root });
  } catch (error) {
    throw manifestError(error);
  }
  // この入口の main DB は NODE_ENV=test の guard と同じく厳格検証する。
  const { assertTestDatabase } = await import('../apps/api/dist/lib/test-database.js');
  const target = assertTestDatabase(process.env);
  if (!target) throw new Error('TEST_ENV_REQUIRED');
  // DB へ接続する前に、dotenv が読み得る環境ファイルの不在と HOME を確定する。
  assertNoLocalEnvFiles();
  const home = privateHome();
  await assertSmokeDatabaseOwnership(process.env.DATABASE_URL, ownerToken);
  return { commit: manifest.commit, home };
}

// DB への書き込みはせず、新規 DB に刻印した comment を読むだけ。
async function assertSmokeDatabaseOwnership(databaseUrl, ownerToken) {
  const { default: postgres } = await import('postgres');
  let sql;
  try {
    sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const rows = await sql`
      SELECT shobj_description(oid, 'pg_database') AS owner_comment
      FROM pg_database
      WHERE datname = current_database()
    `;
    if (!isSmokeOwnerComment(rows[0]?.owner_comment, ownerToken)) {
      throw new Error('SMOKE_DB_OWNERSHIP_FAILED');
    }
  } catch (error) {
    // 接続失敗の DSN・認証情報を表示しない。
    if (error instanceof Error && error.message === 'SMOKE_DB_OWNERSHIP_FAILED') throw error;
    throw new Error('SMOKE_DB_OWNERSHIP_FAILED');
  } finally {
    if (sql) {
      try {
        await sql.end({ timeout: 5 });
      } catch {
        /* 固定 code だけを報告する。 */
      }
    }
  }
}

let child;
let running = false;
let port;
let closed = Promise.resolve();

async function stop() {
  if (!child || !running) return;
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
  return fetch(`http://127.0.0.1:${port}${route}`, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

try {
  const { commit: expected, home } = await preflight();

  const allowlistFile = path.join(home, 'synthetic-allowlist');
  writeFileSync(allowlistFile, 'synthetic@example.invalid\n', { mode: 0o600, flag: 'wx' });

  port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['apps/api/dist/index.js'], {
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
      // 自己申告の git HEAD ではなく、検証済み manifest の commit を使う。
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
      // 所有証明 token・manifest path は子プロセスへ渡さない（curated env のまま）。
    },
  });
  running = true;
  let spawnError = false;
  closed = new Promise((resolve) => {
    child.once('error', () => {
      spawnError = true;
    });
    child.once('close', () => {
      running = false;
      resolve();
    });
  });

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
  if (typeof port === 'number') {
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
}
