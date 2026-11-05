#!/usr/bin/env node
/**
 * 明示した対象だけの読み取り専用診断。環境ファイル・DB・設定の探索や変更は行わない。
 *
 * node scripts/ops-readiness.mjs --base-url http://127.0.0.1:18950/ \
 *   --expected-commit <40桁SHA> [--expected-env production|development|test] \
 *   [--public-url https://app.example.test/ --expected-access-host team.cloudflareaccess.com] \
 *   [--backup-file /absolute/path/backup.dump]
 *
 * 終了値: 0=要求した検査のみ合格、1=検査不合格、2=入力不正。
 * health は自己申告の照合、公開URLは未認証保護だけ。認証後の受入ではない。
 * dump の鮮度・権限・ハッシュは復元成功も由来も証明しない。
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { isMainModule } from './lib/is-main.mjs';

export const LIMITS = Object.freeze({
  timeoutMs: 5_000,
  maxBodyBytes: 16 * 1024,
  maxBackupAgeMs: 26 * 60 * 60 * 1000,
});

const SHA_RE = /^[a-f\d]{40}$/i;
const ACCESS_HOST_RE = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.cloudflareaccess\.com$/;
const DNS_HOST_RE = /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/;
const ENVIRONMENTS = new Set(['production', 'development', 'test']);
const ARGUMENTS = new Map([
  ['--base-url', 'baseUrl'],
  ['--expected-commit', 'expectedCommit'],
  ['--expected-env', 'expectedEnv'],
  ['--public-url', 'publicUrl'],
  ['--expected-access-host', 'expectedAccessHost'],
  ['--backup-file', 'backupFile'],
]);
const OPTION_NAMES = new Set(ARGUMENTS.values());

// 例外本文やスタックを外へ渡さない。コードはこのモジュール内の定数だけ。
class SafeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new SafeFailure(code);
}

function check(ok, code, extra = {}) {
  return { ok, code, ...extra };
}

function initialChecks() {
  return {
    localHealth: check(null, 'NOT_RUN'),
    localUnauthenticated: check(null, 'NOT_RUN'),
    publicAccess: check(null, 'NOT_REQUESTED', { authenticatedAcceptance: 'NOT_VERIFIED' }),
    backup: check(null, 'NOT_REQUESTED', {
      restoreProof: 'NOT_VERIFIED',
      provenance: 'NOT_VERIFIED',
    }),
  };
}

function report(checks, exitCode, code) {
  return {
    schemaVersion: 1,
    ok: exitCode === 0,
    code,
    exitCode,
    checks,
    limitations: [
      'HEALTH_SELF_REPORT_ONLY',
      'AUTHENTICATED_ACCESS_NOT_VERIFIED',
      'BACKUP_RESTORE_NOT_VERIFIED',
      'BACKUP_PROVENANCE_NOT_VERIFIED',
    ],
  };
}

function rootUrl(value, local) {
  const code = local ? 'BASE_URL_INVALID' : 'PUBLIC_URL_INVALID';
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2048 ||
    /[\s\\@?#%]/.test(value)
  ) {
    fail(code);
  }
  // WHATWG URL の短縮IPv4・dot segment等の正規化で拒否条件を消さない。
  const pattern = local
    ? /^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?\/?$/
    : /^https:\/\/[^/]+\/?$/;
  if (!pattern.test(value)) fail(code);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(code);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') fail(code);
  if (!local && (url.port || !DNS_HOST_RE.test(url.hostname))) fail(code);
  return url;
}

function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('ARGUMENTS_INVALID');
  if (Object.keys(options).some((name) => !OPTION_NAMES.has(name))) fail('ARGUMENTS_INVALID');
  const baseUrl = rootUrl(options.baseUrl, true);
  if (typeof options.expectedCommit !== 'string' || !SHA_RE.test(options.expectedCommit)) {
    fail('EXPECTED_COMMIT_INVALID');
  }
  const expectedEnv = options.expectedEnv === undefined ? 'production' : options.expectedEnv;
  if (!ENVIRONMENTS.has(expectedEnv)) fail('EXPECTED_ENV_INVALID');

  const hasPublic = options.publicUrl !== undefined;
  const hasAccessHost = options.expectedAccessHost !== undefined;
  if (hasPublic !== hasAccessHost) fail('PUBLIC_OPTIONS_INCOMPLETE');
  let publicUrl;
  if (hasPublic) {
    publicUrl = rootUrl(options.publicUrl, false);
    if (
      typeof options.expectedAccessHost !== 'string' ||
      !ACCESS_HOST_RE.test(options.expectedAccessHost)
    ) {
      fail('ACCESS_HOST_INVALID');
    }
  }

  const backupFile = options.backupFile;
  if (
    backupFile !== undefined &&
    (typeof backupFile !== 'string' ||
      !path.isAbsolute(backupFile) ||
      path.normalize(backupFile) !== backupFile ||
      [...backupFile].some((character) => {
        const code = character.codePointAt(0);
        return code < 32 || code === 127;
      }) ||
      !backupFile.endsWith('.dump'))
  ) {
    fail('BACKUP_PATH_INVALID');
  }
  return {
    baseUrl,
    expectedCommit: options.expectedCommit.toLowerCase(),
    expectedEnv,
    publicUrl,
    expectedAccessHost: options.expectedAccessHost,
    backupFile,
  };
}

export function parseArgs(args) {
  if (!Array.isArray(args)) fail('ARGUMENTS_INVALID');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = ARGUMENTS.get(args[index]);
    const value = args[index + 1];
    if (
      !name ||
      Object.hasOwn(options, name) ||
      typeof value !== 'string' ||
      value.length === 0 ||
      value.startsWith('--')
    ) {
      fail('ARGUMENTS_INVALID');
    }
    options[name] = value;
  }
  return options;
}

function discardBody(response, reader) {
  // cancelが完了しない応答でも診断の期限を延ばさない。
  try {
    const cancelled = reader ? reader.cancel() : response?.body?.cancel();
    cancelled?.catch(() => {});
  } catch {
    // 出力には例外を混ぜない。
  }
}

async function jsonBody(response, setReader) {
  const type = response.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(type)) fail('CONTENT_TYPE_INVALID');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > LIMITS.maxBodyBytes)) {
    fail('BODY_TOO_LARGE');
  }
  if (!response.body || typeof response.body.getReader !== 'function') fail('BODY_INVALID');
  const reader = response.body.getReader();
  setReader(reader);
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) fail('BODY_INVALID');
    bytes += value.byteLength;
    if (bytes > LIMITS.maxBodyBytes) fail('BODY_TOO_LARGE');
    chunks.push(value);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
    return JSON.parse(text);
  } catch {
    fail('JSON_INVALID');
  }
}

async function requestCheck(url, redirect, prefix, consume, fetchImpl) {
  const controller = new AbortController();
  let response;
  let reader;
  let timer;
  let timedOut = false;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      discardBody(response, reader);
      reject(new SafeFailure('TIMEOUT'));
    }, LIMITS.timeoutMs);
  });
  try {
    const operation = (async () => {
      response = await fetchImpl(url.href, {
        method: 'GET',
        redirect,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { Accept: prefix === 'PUBLIC' ? 'text/html' : 'application/json' },
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        discardBody(response);
        fail('TIMEOUT');
      }
      if (!response || !Number.isInteger(response.status)) fail('RESPONSE_INVALID');
      if (response.redirected) fail('REDIRECT_REJECTED');
      if (response.url && response.url !== url.href) fail('RESPONSE_URL_MISMATCH');
      return await consume(response, (value) => {
        reader = value;
      });
    })();
    return await Promise.race([operation, deadline]);
  } catch (error) {
    const code = timedOut
      ? 'TIMEOUT'
      : error instanceof SafeFailure
        ? error.code
        : 'REQUEST_FAILED';
    return check(false, `${prefix}_${code}`);
  } finally {
    clearTimeout(timer);
    discardBody(response, reader);
    controller.abort();
  }
}

function healthCheck(config, fetchImpl) {
  return requestCheck(
    new URL('/api/health', config.baseUrl),
    'error',
    'HEALTH',
    async (response, setReader) => {
      if (response.status !== 200) fail('STATUS_UNEXPECTED');
      const body = await jsonBody(response, setReader);
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('CONTRACT_INVALID');
      if (body.ok !== true) fail('OK_MISMATCH');
      if (body.db !== 'ok') fail('DB_MISMATCH');
      if (body.env !== config.expectedEnv) fail('ENV_MISMATCH');
      if (
        typeof body.commit !== 'string' ||
        !SHA_RE.test(body.commit) ||
        body.commit.toLowerCase() !== config.expectedCommit
      ) {
        fail('COMMIT_MISMATCH');
      }
      return check(true, 'HEALTH_OK');
    },
    fetchImpl,
  );
}

function unauthenticatedCheck(config, fetchImpl) {
  return requestCheck(
    new URL('/api/me', config.baseUrl),
    'error',
    'UNAUTHENTICATED',
    (response) => {
      if (response.status !== 401) fail('STATUS_UNEXPECTED');
      return check(true, 'UNAUTHENTICATED_401');
    },
    fetchImpl,
  );
}

function accessLocationValid(value, config) {
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    !value.startsWith('https://') ||
    /[\s\\#]/.test(value)
  ) {
    return false;
  }
  try {
    const location = new URL(value);
    const rawPath = value.slice(value.indexOf('/', 'https://'.length)).split('?')[0];
    const login = '/cdn-cgi/access/login';
    const loginPaths = [login, `${login}/`, `${login}/${config.publicUrl.hostname}`];
    return (
      !location.username &&
      !location.password &&
      !value.slice('https://'.length).split('/')[0].includes('@') &&
      location.origin === `https://${config.expectedAccessHost}` &&
      loginPaths.includes(rawPath) &&
      rawPath === location.pathname
    );
  } catch {
    return false;
  }
}

async function publicCheck(config, fetchImpl) {
  const result = await requestCheck(
    config.publicUrl,
    'manual',
    'PUBLIC',
    (response) => {
      if (response.status !== 302 && response.status !== 303) fail('STATUS_UNEXPECTED');
      if (!accessLocationValid(response.headers.get('location'), config)) {
        fail('ACCESS_LOCATION_INVALID');
      }
      return check(true, 'PUBLIC_ACCESS_LOGIN_REDIRECT');
    },
    fetchImpl,
  );
  return { ...result, authenticatedAcceptance: 'NOT_VERIFIED' };
}

async function inspectBackup(file, now) {
  let handle;
  try {
    if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') {
      fail('BACKUP_PLATFORM_UNSUPPORTED');
    }
    // 親を含むsymlinkを拒否。隠れた探索はせず、明示パスの各構成要素だけを調べる。
    let cursor = path.parse(file).root;
    let original;
    const parts = file.slice(cursor.length).split(path.sep);
    for (const [index, part] of parts.entries()) {
      cursor = path.join(cursor, part);
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) fail('BACKUP_SYMLINK');
      if (index < parts.length - 1 && !entry.isDirectory()) fail('BACKUP_NOT_REGULAR');
      original = entry;
    }
    if (!original?.isFile()) fail('BACKUP_NOT_REGULAR');
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== original.dev || before.ino !== original.ino) {
      fail('BACKUP_CHANGED');
    }
    if ((before.mode & 0o7777) !== 0o600) fail('BACKUP_MODE_INVALID');
    if (before.nlink !== 1) fail('BACKUP_HARDLINK');
    if (!Number.isSafeInteger(before.size) || before.size <= 0) fail('BACKUP_EMPTY');
    const nowMs = now();
    if (!Number.isFinite(nowMs) || !Number.isFinite(before.mtimeMs)) fail('BACKUP_CLOCK_INVALID');
    const ageMs = nowMs - before.mtimeMs;
    if (ageMs < 0) fail('BACKUP_FUTURE');
    if (ageMs > LIMITS.maxBackupAgeMs) fail('BACKUP_STALE');

    const hash = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, before.size - position),
        position,
      );
      if (bytesRead === 0) fail('BACKUP_CHANGED');
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(file);
    if (
      current.isSymbolicLink() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      ['size', 'mtimeMs', 'ctimeMs', 'mode', 'nlink'].some((key) => before[key] !== after[key])
    ) {
      fail('BACKUP_CHANGED');
    }
    return check(true, 'BACKUP_METADATA_OK', {
      metadata: {
        bytes: before.size,
        ageSeconds: Math.floor(ageMs / 1000),
        sha256: hash.digest('hex'),
      },
    });
  } catch (error) {
    return check(false, error instanceof SafeFailure ? error.code : 'BACKUP_UNREADABLE');
  } finally {
    if (handle) await handle.close();
  }
}

/** fetch/時計の注入点。importだけでは通信もファイルの読み取りも実行しない。 */
export async function runReadiness(
  options = {},
  { fetchImpl = globalThis.fetch, now = Date.now } = {},
) {
  const checks = initialChecks();
  let config;
  try {
    config = validateOptions(options);
  } catch (error) {
    return report(checks, 2, error instanceof SafeFailure ? error.code : 'ARGUMENTS_INVALID');
  }
  try {
    if (typeof fetchImpl !== 'function' || typeof now !== 'function') fail('DEPENDENCY_INVALID');
    checks.localHealth = await healthCheck(config, fetchImpl);
    checks.localUnauthenticated = await unauthenticatedCheck(config, fetchImpl);
    if (config.publicUrl) checks.publicAccess = await publicCheck(config, fetchImpl);
    if (config.backupFile) {
      checks.backup = {
        ...(await inspectBackup(config.backupFile, now)),
        restoreProof: 'NOT_VERIFIED',
        provenance: 'NOT_VERIFIED',
      };
    }
    const passed = Object.values(checks).every((entry) => entry.ok !== false);
    return report(checks, passed ? 0 : 1, passed ? 'REQUESTED_CHECKS_PASSED' : 'READINESS_FAILED');
  } catch {
    return report(checks, 1, 'INTERNAL_ERROR');
  }
}

/** stdoutは1行JSONだけ。入力・応答・例外・パスの原文を連結しない。 */
export async function runCli(args = process.argv.slice(2), dependencies = {}) {
  let result;
  try {
    result = await runReadiness(parseArgs(args), dependencies);
  } catch (error) {
    result = report(
      initialChecks(),
      2,
      error instanceof SafeFailure ? error.code : 'ARGUMENTS_INVALID',
    );
  }
  const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text));
  stdout(`${JSON.stringify(result)}\n`);
  return result.exitCode;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = await runCli();
}
