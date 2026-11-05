import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, parseArgs, runCli, runReadiness } from './ops-readiness.mjs';

const COMMIT = 'a1'.repeat(20);
const NOW = Date.parse('2026-11-05T12:00:00Z');
const BASE = { baseUrl: 'http://127.0.0.1:18950/', expectedCommit: COMMIT };
const PUBLIC = {
  publicUrl: 'https://app.example.test/',
  expectedAccessHost: 'example-team.cloudflareaccess.com',
};
const SENTINEL = 'DO_NOT_OUTPUT_response_credential_marker';
const HEALTH = { ok: true, db: 'ok', env: 'production', commit: COMMIT };
const fixtureRoots = new Set();

function healthResponse(body = HEALTH, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function validFetch(overrides = {}) {
  return vi.fn(async (url, init) => {
    if (url === new URL('/api/health', BASE.baseUrl).href) {
      return overrides.health ? overrides.health(url, init) : healthResponse();
    }
    if (url === new URL('/api/me', BASE.baseUrl).href) {
      return overrides.me ? overrides.me(url, init) : new Response(null, { status: 401 });
    }
    if (url === PUBLIC.publicUrl && overrides.public) return overrides.public(url, init);
    throw new Error(SENTINEL);
  });
}

async function fixture(contents = 'fixture-only-custom-dump', mode = 0o600) {
  const root = await mkdtemp(path.join(tmpdir(), 'aihd-ops-readiness-'));
  fixtureRoots.add(root);
  const file = path.join(root, 'fixture.dump');
  await writeFile(file, contents, { mode });
  await chmod(file, mode);
  await utimes(file, NOW / 1000, NOW / 1000);
  return { root, file };
}

async function withBackup(file, extra = {}) {
  return runReadiness(
    { ...BASE, backupFile: file, ...extra },
    { fetchImpl: validFetch(), now: () => NOW },
  );
}

function expectNoSensitiveOutput(value) {
  const output = JSON.stringify(value);
  expect(output).not.toContain(SENTINEL);
  expect(output).not.toContain('postgresql://');
  expect(output).not.toContain('https://');
  expect(output).not.toContain('http://');
  expect(output).not.toContain('password');
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of fixtureRoots) {
    // テスト自身がmkdtempした直下のfixtureだけ削除する。
    const resolved = path.resolve(root);
    const parent = path.resolve(tmpdir());
    if (
      path.dirname(resolved) !== parent ||
      !path.basename(resolved).startsWith('aihd-ops-readiness-')
    ) {
      throw new Error('FIXTURE_CLEANUP_SCOPE_INVALID');
    }
    await rm(resolved, { recursive: true, force: true });
  }
  fixtureRoots.clear();
});

describe('ops-readiness: 入力は全検証してから通信する', () => {
  it.each([
    ['base欠落', { expectedCommit: COMMIT }, 'BASE_URL_INVALID'],
    ['SHA欠落', { baseUrl: BASE.baseUrl }, 'EXPECTED_COMMIT_INVALID'],
    ['短縮SHA', { ...BASE, expectedCommit: 'abc1234' }, 'EXPECTED_COMMIT_INVALID'],
    ['非hexSHA', { ...BASE, expectedCommit: 'z'.repeat(40) }, 'EXPECTED_COMMIT_INVALID'],
    ['SHA改行', { ...BASE, expectedCommit: `${COMMIT}\n` }, 'EXPECTED_COMMIT_INVALID'],
    ['環境未許可', { ...BASE, expectedEnv: SENTINEL }, 'EXPECTED_ENV_INVALID'],
    ['未知option', { ...BASE, execute: true }, 'ARGUMENTS_INVALID'],
    ['配列option', [], 'ARGUMENTS_INVALID'],
    ['null option', null, 'ARGUMENTS_INVALID'],
    ['public片側', { ...BASE, publicUrl: PUBLIC.publicUrl }, 'PUBLIC_OPTIONS_INCOMPLETE'],
    [
      'Access片側',
      { ...BASE, expectedAccessHost: PUBLIC.expectedAccessHost },
      'PUBLIC_OPTIONS_INCOMPLETE',
    ],
    ['backup相対', { ...BASE, backupFile: 'fixture.dump' }, 'BACKUP_PATH_INVALID'],
    ['backup非dump', { ...BASE, backupFile: '/tmp/fixture.conf' }, 'BACKUP_PATH_INVALID'],
    [
      'backup非正規path',
      { ...BASE, backupFile: '/tmp/../tmp/fixture.dump' },
      'BACKUP_PATH_INVALID',
    ],
    ['backup制御文字', { ...BASE, backupFile: '/tmp/fixture\n.dump' }, 'BACKUP_PATH_INVALID'],
  ])('%sを拒否する', async (_label, options, code) => {
    const fetchImpl = vi.fn(() => {
      throw new Error(SENTINEL);
    });
    const result = await runReadiness(options, { fetchImpl });
    expect(result).toMatchObject({ ok: false, exitCode: 2, code });
    expect(fetchImpl).not.toHaveBeenCalled();
    expectNoSensitiveOutput(result);
  });

  it.each([
    'http://localhost:18950/',
    'http://127.0.0.2:18950/',
    'http://127.1:18950/',
    'http://2130706433:18950/',
    'http://0x7f000001:18950/',
    'http://[::ffff:127.0.0.1]:18950/',
    'http://192.0.2.1:18950/',
    'https://remote.example.test/',
    'ftp://127.0.0.1/',
    `http://name:${SENTINEL}@127.0.0.1:18950/`,
    'http://@127.0.0.1:18950/',
    'http://127.0.0.1:18950/?',
    `http://127.0.0.1:18950/?password=${SENTINEL}`,
    'http://127.0.0.1:18950/#',
    'http://127.0.0.1:18950/prefix',
    'http://127.0.0.1:18950/prefix/../',
    'http://127.0.0.1:18950/%2e/',
    'http://127.0.0.1:18950\\evil',
    ' http://127.0.0.1:18950/',
    'http://127.0.0.1:65536/',
    'http://127.0.0.1:0/',
  ])('危険または曖昧なbase URLを通信前拒否する: %s', async (baseUrl) => {
    const fetchImpl = vi.fn();
    const result = await runReadiness({ ...BASE, baseUrl }, { fetchImpl });
    expect(result).toMatchObject({ code: 'BASE_URL_INVALID', exitCode: 2 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expectNoSensitiveOutput(result);
  });

  it.each([
    { publicUrl: 'http://app.example.test/' },
    { publicUrl: 'https://app.example.test/prefix' },
    { publicUrl: 'https://app.example.test/?' },
    { publicUrl: 'https://app.example.test/#' },
    { publicUrl: `https://name:${SENTINEL}@app.example.test/` },
    { publicUrl: 'https://app.example.test:8443/' },
    { publicUrl: 'https://127.0.0.1/' },
    { expectedAccessHost: '*.cloudflareaccess.com' },
    { expectedAccessHost: 'cloudflareaccess.com' },
    { expectedAccessHost: 'example-team.cloudflareaccess.com.evil.test' },
    { expectedAccessHost: 'child.example-team.cloudflareaccess.com' },
    { expectedAccessHost: 'https://example-team.cloudflareaccess.com/' },
    { expectedAccessHost: 'example-team.cloudflareaccess.com:443' },
    { expectedAccessHost: 'example-team.cloudflareaccess.com.' },
  ])('public入力不正でもlocal通信前に失敗する: %j', async (invalid) => {
    const fetchImpl = vi.fn();
    const result = await runReadiness({ ...BASE, ...PUBLIC, ...invalid }, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expectNoSensitiveOutput(result);
  });

  it.each(['http://127.0.0.1:18950', 'http://[::1]:18950/', 'https://127.0.0.1/'])(
    '数値loopbackだけの明示URLを許可する: %s',
    async (baseUrl) => {
      const fetchImpl = vi.fn(async (url) =>
        url.endsWith('/api/health') ? healthResponse() : new Response(null, { status: 401 }),
      );
      const result = await runReadiness({ ...BASE, baseUrl }, { fetchImpl });
      expect(result).toMatchObject({ ok: true, exitCode: 0 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );
});

describe('ops-readiness: local healthと未認証をfail closedで照合する', () => {
  it('health契約一致と未認証401だけで要求したlocal検査に合格する', async () => {
    const fetchImpl = validFetch();
    const result = await runReadiness(BASE, { fetchImpl });
    expect(result).toMatchObject({
      ok: true,
      code: 'REQUESTED_CHECKS_PASSED',
      exitCode: 0,
      checks: {
        localHealth: { ok: true, code: 'HEALTH_OK' },
        localUnauthenticated: { ok: true, code: 'UNAUTHENTICATED_401' },
        publicAccess: { ok: null, code: 'NOT_REQUESTED', authenticatedAcceptance: 'NOT_VERIFIED' },
        backup: {
          ok: null,
          code: 'NOT_REQUESTED',
          restoreProof: 'NOT_VERIFIED',
          provenance: 'NOT_VERIFIED',
        },
      },
    });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:18950/api/health',
      'http://127.0.0.1:18950/api/me',
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
      expect(init.headers).toEqual({ Accept: 'application/json' });
      expect(init).not.toHaveProperty('body');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(result.limitations).toContain('HEALTH_SELF_REPORT_ONLY');
    expectNoSensitiveOutput(result);
  });

  it('明示した環境と大文字SHAを照合できる', async () => {
    const fetchImpl = validFetch({
      health: () => healthResponse({ ...HEALTH, env: 'test', commit: COMMIT.toUpperCase() }),
    });
    const result = await runReadiness({ ...BASE, expectedEnv: 'test' }, { fetchImpl });
    expect(result.ok).toBe(true);
  });

  it.each([
    [{ ...HEALTH, ok: false }, 'HEALTH_OK_MISMATCH'],
    [{ ...HEALTH, ok: 'true' }, 'HEALTH_OK_MISMATCH'],
    [{ ...HEALTH, db: 'error' }, 'HEALTH_DB_MISMATCH'],
    [{ ...HEALTH, db: true }, 'HEALTH_DB_MISMATCH'],
    [{ ...HEALTH, env: 'development' }, 'HEALTH_ENV_MISMATCH'],
    [{ ...HEALTH, commit: 'b2'.repeat(20) }, 'HEALTH_COMMIT_MISMATCH'],
    [{ ...HEALTH, commit: null }, 'HEALTH_COMMIT_MISMATCH'],
    [{ ...HEALTH, commit: COMMIT.slice(0, 7) }, 'HEALTH_COMMIT_MISMATCH'],
    [{}, 'HEALTH_OK_MISMATCH'],
    [null, 'HEALTH_CONTRACT_INVALID'],
    [[], 'HEALTH_CONTRACT_INVALID'],
    ['ok', 'HEALTH_CONTRACT_INVALID'],
  ])('200でも不一致は合格させない: %j', async (body, code) => {
    const fetchImpl = validFetch({ health: () => healthResponse(body) });
    const result = await runReadiness(BASE, { fetchImpl });
    expect(result).toMatchObject({
      ok: false,
      exitCode: 1,
      checks: { localHealth: { code, ok: false } },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expectNoSensitiveOutput(result);
  });

  it.each([200, 204, 302, 403, 500])('/api/meの%sは401の代わりにならない', async (status) => {
    const fetchImpl = validFetch({ me: () => new Response(null, { status }) });
    const result = await runReadiness(BASE, { fetchImpl });
    expect(result).toMatchObject({
      ok: false,
      exitCode: 1,
      checks: { localUnauthenticated: { code: 'UNAUTHENTICATED_STATUS_UNEXPECTED' } },
    });
  });

  it.each([302, 401, 503])('healthの%sを失敗にする', async (status) => {
    const result = await runReadiness(BASE, {
      fetchImpl: validFetch({ health: () => healthResponse({ detail: SENTINEL }, { status }) }),
    });
    expect(result.checks.localHealth.code).toBe('HEALTH_STATUS_UNEXPECTED');
    expectNoSensitiveOutput(result);
  });

  it('fetch例外のURL/DSN/stackを出さない', async () => {
    const result = await runReadiness(BASE, {
      fetchImpl: vi.fn(async () => {
        throw new Error(`postgresql://user:password@db.invalid/secret ${SENTINEL}`);
      }),
    });
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.checks.localHealth.code).toBe('HEALTH_REQUEST_FAILED');
    expect(result.checks.localUnauthenticated.code).toBe('UNAUTHENTICATED_REQUEST_FAILED');
    expectNoSensitiveOutput(result);
  });

  it('契約以外の応答フィールドや未認証bodyを一切出さない', async () => {
    const fetchImpl = validFetch({
      health: () =>
        healthResponse({
          ...HEALTH,
          detail: SENTINEL,
          dsn: 'postgresql://password@db.invalid/private',
        }),
      me: () => new Response(SENTINEL, { status: 401 }),
    });
    const result = await runReadiness(BASE, { fetchImpl });
    expect(result.ok).toBe(true);
    expectNoSensitiveOutput(result);
  });

  it('取得済みの別URLや追従済みResponseも失敗にする', async () => {
    const response = healthResponse();
    Object.defineProperty(response, 'redirected', { value: true });
    const result = await runReadiness(BASE, { fetchImpl: validFetch({ health: () => response }) });
    expect(result.checks.localHealth.code).toBe('HEALTH_REDIRECT_REJECTED');
    const wrongUrl = healthResponse();
    Object.defineProperty(wrongUrl, 'url', { value: `https://${SENTINEL}.invalid/` });
    const mismatch = await runReadiness(BASE, {
      fetchImpl: validFetch({ health: () => wrongUrl }),
    });
    expect(mismatch.checks.localHealth.code).toBe('HEALTH_RESPONSE_URL_MISMATCH');
    expectNoSensitiveOutput(mismatch);
  });
});

describe('ops-readiness: 応答容量と期限を制限する', () => {
  it.each([
    [
      () => new Response(SENTINEL, { headers: { 'content-type': 'text/html' } }),
      'HEALTH_CONTENT_TYPE_INVALID',
    ],
    [
      () => new Response(`{${SENTINEL}`, { headers: { 'content-type': 'application/json' } }),
      'HEALTH_JSON_INVALID',
    ],
    [
      () =>
        healthResponse(HEALTH, {
          headers: { 'content-type': 'application/json', 'content-length': '16385' },
        }),
      'HEALTH_BODY_TOO_LARGE',
    ],
    [
      () =>
        healthResponse(HEALTH, {
          headers: { 'content-type': 'application/json', 'content-length': '-1' },
        }),
      'HEALTH_BODY_TOO_LARGE',
    ],
    [
      () =>
        new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
      'HEALTH_JSON_INVALID',
    ],
  ])('不正bodyを安全codeへ変換する', async (response, code) => {
    const result = await runReadiness(BASE, { fetchImpl: validFetch({ health: response }) });
    expect(result).toMatchObject({ ok: false, exitCode: 1, checks: { localHealth: { code } } });
    expectNoSensitiveOutput(result);
  });

  it('Content-Lengthが偽でも読取りbyte上限で打ち切る', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(' '.repeat(LIMITS.maxBodyBytes)));
        controller.enqueue(new TextEncoder().encode(SENTINEL));
      },
      cancel,
    });
    const response = new Response(body, {
      headers: { 'content-type': 'application/json', 'content-length': '1' },
    });
    const result = await runReadiness(BASE, { fetchImpl: validFetch({ health: () => response }) });
    expect(result.checks.localHealth.code).toBe('HEALTH_BODY_TOO_LARGE');
    expect(cancel).toHaveBeenCalledTimes(1);
    expectNoSensitiveOutput(result);
  });

  it('上限ぴったりのJSONは受け入れる', async () => {
    const text = JSON.stringify(HEALTH);
    const padded = text + ' '.repeat(LIMITS.maxBodyBytes - Buffer.byteLength(text));
    const result = await runReadiness(BASE, {
      fetchImpl: validFetch({
        health: () => new Response(padded, { headers: { 'content-type': 'application/json' } }),
      }),
    });
    expect(result.ok).toBe(true);
  });

  it('fetchがAbortSignalを無視してもdeadlineで返る', async () => {
    vi.useFakeTimers();
    const fetchImpl = validFetch({ health: () => new Promise(() => {}) });
    const pending = runReadiness(BASE, { fetchImpl });
    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs);
    const result = await pending;
    expect(result.checks.localHealth.code).toBe('HEALTH_TIMEOUT');
    expect(result.exitCode).toBe(1);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('headers後にbodyが停止しても同じdeadlineでcancelする', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'application/json' },
    });
    const pending = runReadiness(BASE, { fetchImpl: validFetch({ health: () => response }) });
    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs);
    const result = await pending;
    expect(result.checks.localHealth.code).toBe('HEALTH_TIMEOUT');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ops-readiness: publicは正確なAccessログインredirectだけを認める', () => {
  it.each([
    [302, '/cdn-cgi/access/login'],
    [303, '/cdn-cgi/access/login/'],
    [302, '/cdn-cgi/access/login/app.example.test'],
  ])('%sの正確なlogin path %sを追従せず判定する', async (status, pathname) => {
    const fetchImpl = validFetch({
      public: () =>
        new Response(SENTINEL, {
          status,
          headers: {
            location: `https://${PUBLIC.expectedAccessHost}${pathname}?kid=${SENTINEL}&redirect_url=%2F`,
          },
        }),
    });
    const result = await runReadiness({ ...BASE, ...PUBLIC }, { fetchImpl });
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      checks: {
        publicAccess: {
          ok: true,
          code: 'PUBLIC_ACCESS_LOGIN_REDIRECT',
          authenticatedAcceptance: 'NOT_VERIFIED',
        },
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2]).toEqual([
      PUBLIC.publicUrl,
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: { Accept: 'text/html' },
      }),
    ]);
    expect(result.limitations).toContain('AUTHENTICATED_ACCESS_NOT_VERIFIED');
    expectNoSensitiveOutput(result);
  });

  it.each([
    null,
    '/cdn-cgi/access/login',
    `http://${PUBLIC.expectedAccessHost}/cdn-cgi/access/login`,
    `https://${PUBLIC.expectedAccessHost}.evil.test/cdn-cgi/access/login`,
    'https://other-team.cloudflareaccess.com/cdn-cgi/access/login',
    `https://${PUBLIC.expectedAccessHost}:8443/cdn-cgi/access/login`,
    `https://name:${SENTINEL}@${PUBLIC.expectedAccessHost}/cdn-cgi/access/login`,
    `https://@${PUBLIC.expectedAccessHost}/cdn-cgi/access/login`,
    `https://${PUBLIC.expectedAccessHost}/cdn-cgi/access/login#fragment`,
    `https://${PUBLIC.expectedAccessHost}/cdn-cgi/access/login-evil`,
    `https://${PUBLIC.expectedAccessHost}/cdn-cgi/access/login.evil`,
    `https://${PUBLIC.expectedAccessHost}/cdn-cgi/access/login/other.example.test`,
    `https://${PUBLIC.expectedAccessHost}/evil/../cdn-cgi/access/login`,
    `https://${PUBLIC.expectedAccessHost}/cdn-cgi/access/%6cogin`,
    `https://${PUBLIC.expectedAccessHost}/cdn-cgi/access/login/app.example.test/extra`,
    `https://${PUBLIC.expectedAccessHost}/`,
  ])('見せかけのAccess locationを拒否する: %s', async (location) => {
    const fetchImpl = validFetch({
      public: () =>
        new Response(null, { status: 302, headers: location === null ? {} : { location } }),
    });
    const result = await runReadiness({ ...BASE, ...PUBLIC }, { fetchImpl });
    expect(result.checks.publicAccess).toMatchObject({
      ok: false,
      code: 'PUBLIC_ACCESS_LOCATION_INVALID',
    });
    expect(result.exitCode).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expectNoSensitiveOutput(result);
  });

  it.each([200, 301, 307, 308, 401, 403, 500])('%sは未認証保護成功と誤認しない', async (status) => {
    const fetchImpl = validFetch({
      public: () =>
        new Response(null, {
          status,
          headers: { location: `https://${PUBLIC.expectedAccessHost}/cdn-cgi/access/login` },
        }),
    });
    const result = await runReadiness({ ...BASE, ...PUBLIC }, { fetchImpl });
    expect(result.checks.publicAccess).toMatchObject({
      ok: false,
      code: 'PUBLIC_STATUS_UNEXPECTED',
    });
    expect(result.exitCode).toBe(1);
  });
});

describe('ops-readiness: backupは明示fixtureのmetadataのみ検査する', () => {
  it('0600・26h以内・非空dumpのsha256だけを出す', async () => {
    const contents = `fixture ${SENTINEL}`;
    const { file } = await fixture(contents);
    const result = await withBackup(file);
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(result.checks.backup).toEqual({
      ok: true,
      code: 'BACKUP_METADATA_OK',
      metadata: {
        bytes: Buffer.byteLength(contents),
        ageSeconds: 0,
        sha256: createHash('sha256').update(contents).digest('hex'),
      },
      restoreProof: 'NOT_VERIFIED',
      provenance: 'NOT_VERIFIED',
    });
    expect(JSON.stringify(result)).not.toContain(file);
    expect(JSON.stringify(result)).not.toContain(path.basename(file));
    expectNoSensitiveOutput(result);
  });

  it('26hちょうどを受け入れ、超過を拒否する', async () => {
    const { file } = await fixture();
    const boundary = (NOW - LIMITS.maxBackupAgeMs) / 1000;
    await utimes(file, boundary, boundary);
    expect((await withBackup(file)).checks.backup.code).toBe('BACKUP_METADATA_OK');
    await utimes(file, boundary - 1, boundary - 1);
    const stale = await withBackup(file);
    expect(stale.checks.backup.code).toBe('BACKUP_STALE');
    expect(stale.exitCode).toBe(1);
  });

  it.each([0o644, 0o640, 0o400, 0o700, 0o4600])('0600以外%sを拒否しchmodしない', async (mode) => {
    const { file } = await fixture('fixture', mode);
    const result = await withBackup(file);
    expect(result.checks.backup.code).toBe('BACKUP_MODE_INVALID');
    expect(result.exitCode).toBe(1);
    expectNoSensitiveOutput(result);
  });

  it('空dumpと未来mtimeを拒否する', async () => {
    const empty = await fixture('');
    expect((await withBackup(empty.file)).checks.backup.code).toBe('BACKUP_EMPTY');
    const future = await fixture();
    await utimes(future.file, (NOW + 1000) / 1000, (NOW + 1000) / 1000);
    expect((await withBackup(future.file)).checks.backup.code).toBe('BACKUP_FUTURE');
  });

  it('最終symlinkも親symlinkも拒否する', async () => {
    const { root, file } = await fixture();
    const alias = path.join(root, 'alias.dump');
    await symlink(file, alias);
    expect((await withBackup(alias)).checks.backup.code).toBe('BACKUP_SYMLINK');
    const realDirectory = path.join(root, 'real');
    await mkdir(realDirectory);
    const nested = path.join(realDirectory, 'nested.dump');
    await writeFile(nested, 'fixture', { mode: 0o600 });
    const parentAlias = path.join(root, 'alias');
    await symlink(realDirectory, parentAlias);
    expect((await withBackup(path.join(parentAlias, 'nested.dump'))).checks.backup.code).toBe(
      'BACKUP_SYMLINK',
    );
  });

  it('hardlink・directory・存在しないdumpを拒否する', async () => {
    const { root, file } = await fixture();
    await link(file, path.join(root, 'hardlink.dump'));
    expect((await withBackup(file)).checks.backup.code).toBe('BACKUP_HARDLINK');
    const directory = path.join(root, 'directory.dump');
    await mkdir(directory);
    expect((await withBackup(directory)).checks.backup.code).toBe('BACKUP_NOT_REGULAR');
    const missing = await withBackup(path.join(root, `${SENTINEL}.dump`));
    expect(missing.checks.backup.code).toBe('BACKUP_UNREADABLE');
    expectNoSensitiveOutput(missing);
  });

  it('大きいfixtureもchunkでhashし復元検証とは呼ばない', async () => {
    const contents = Buffer.alloc(150_000, 'x');
    const { file } = await fixture(contents);
    const result = await withBackup(file);
    expect(result.checks.backup.metadata.sha256).toBe(
      createHash('sha256').update(contents).digest('hex'),
    );
    expect(result.checks.backup.restoreProof).toBe('NOT_VERIFIED');
    expect(result.checks.backup.provenance).toBe('NOT_VERIFIED');
  });
});

describe('ops-readiness: CLIは安全な1行JSONとexitを返す', () => {
  it('引数を明示的に解析する', () => {
    expect(parseArgs(['--base-url', BASE.baseUrl, '--expected-commit', COMMIT])).toEqual(BASE);
  });

  it.each([
    [],
    ['--unknown', SENTINEL],
    ['--base-url'],
    ['--base-url', BASE.baseUrl, '--base-url', BASE.baseUrl],
    ['--base-url', '--expected-commit', COMMIT],
    ['--base-url', BASE.baseUrl, '--expected-commit', 'short'],
  ])('入力不正は通信せずexit2のJSONだけを出す: %j', async (args) => {
    const stdout = vi.fn();
    const fetchImpl = vi.fn();
    const exitCode = await runCli(args, { fetchImpl, stdout });
    expect(exitCode).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledTimes(1);
    const output = stdout.mock.calls[0][0];
    expect(output.endsWith('\n')).toBe(true);
    expect(output.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(output)).toMatchObject({ ok: false, exitCode: 2 });
    expectNoSensitiveOutput(output);
  });

  it.each([true, false])('検査結果に合わせてexit0/1を返す: %s', async (success) => {
    const stdout = vi.fn();
    const fetchImpl = validFetch({
      health: () => healthResponse({ ...HEALTH, ok: success, detail: SENTINEL }),
    });
    const exitCode = await runCli(['--base-url', BASE.baseUrl, '--expected-commit', COMMIT], {
      fetchImpl,
      stdout,
    });
    expect(exitCode).toBe(success ? 0 : 1);
    const output = stdout.mock.calls[0][0];
    expect(JSON.parse(output)).toMatchObject({ ok: success, exitCode });
    expectNoSensitiveOutput(output);
  });
});
