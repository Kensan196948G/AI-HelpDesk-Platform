import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 契約: Linux / Node 22 の読み取り専用 inventory。import 時には I/O しない。
// 対象は固定35ファイルと dist/**/*.js のみ。コピー・ビルド・配備は行わない。
// createRuntimeInventory(root) / verifyRuntimeInventory(root, manifest) は同形の JSON を返す。
// verify は任意のパスを manifest から読み込まず、固定対象を再計算して照合する。
// SHA-256 は内容一致の参考情報であり、由来・署名・原子的 snapshot の証明ではない。
// CLI の manifest は専用 basename に限定し、禁止構成要素を I/O より先に拒否する。
// エラーは固定 code のみ。絶対パス・例外原文・ファイル内容を出力しない。
export const ROOT_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'apps/api/package.json',
  'Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html',
]);
export const BRIDGE_FILES = Object.freeze(
  [
    'staff-access-bridge.js',
    'bridge.js',
    'device-bridge.js',
    'honest-labels-bridge.js',
    'employee-bridge.js',
    'assist-bridge.js',
    'resolve-bridge.js',
    'remote-support-bridge.js',
    'handover-workspace-bridge.js',
    'folder-access-bridge.js',
    'support-session-bridge.js',
  ].map((name) => `apps/api/src/prototype/${name}`),
);
export const SKILL_FILES = Object.freeze(
  [
    'os-info.ps1',
    'disk-space.ps1',
    'spooler-status.ps1',
    'service-status.ps1',
    'network-adapters.ps1',
    'spooler-restart.ps1',
    'spooler-queue-purge.ps1',
    'service-start.ps1',
    'service-restart.ps1',
    'network-adapter-restart.ps1',
    'defender-update.ps1',
    'recyclebin-clear.ps1',
    'temp-cleanup.ps1',
    'dns-flush.ps1',
    'bitlocker-status.ps1',
    'defender-quickscan.ps1',
    'folder-summary.ps1',
    'user-marker-set.ps1',
    'user-marker-clear.ps1',
    'user-marker-status.ps1',
  ].map((name) => `scripts/skills/windows/${name}`),
);
export const LIMITATIONS = Object.freeze([
  'APPROVAL_MANIFEST:EXTERNAL_NOT_INCLUDED',
  'ALLOWLIST:EXTERNAL_NOT_INCLUDED',
  'DEPENDENCIES:NOT_VERIFIED',
  'SOURCE_BUILD_PROVENANCE:NOT_VERIFIED',
  'RELEASE_SIGNATURE:NOT_VERIFIED',
  'RUNTIME_BEHAVIOR:NOT_VERIFIED',
  'SNAPSHOT_ATOMICITY:NOT_GUARANTEED',
  'MIGRATION_STATE:NOT_VERIFIED',
  'PLATFORM_COMPATIBILITY:NOT_VERIFIED',
]);
const FIXED_FILES = [...ROOT_FILES, ...BRIDGE_FILES, ...SKILL_FILES];
const FIXED_SET = new Set(FIXED_FILES);
const DIST = 'apps/api/dist';
export const REQUIRED_DIST_FILES = Object.freeze(
  ['index.js', 'config.js', 'db.js', 'server.js'].map((name) => `${DIST}/${name}`),
);
const MAX_FILES = 512;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_DIRECTORIES = 128;
const MAX_DIST_DEPTH = 8;
const MAX_DIRECTORY_ENTRIES = 2048;
const STAT_FIELDS = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const ERROR_CODES = new Set(
  [
    'ARGUMENT_INVALID',
    'ROOT_INVALID',
    'PATH_INVALID',
    'FILE_UNSAFE',
    'LIMIT_EXCEEDED',
    'CHANGED',
    'INCOMPLETE',
    'MANIFEST_INVALID',
    'MISMATCH',
    'READ_FAILED',
  ].map((name) => `INVENTORY_${name}`),
);

function fail(suffix) {
  const code = `INVENTORY_${suffix}`;
  throw Object.assign(new Error(code), { code });
}

function safeError(error) {
  if (ERROR_CODES.has(error?.code))
    return Object.assign(new Error(error.code), { code: error.code });
  const suffix =
    error?.code === 'ENOENT'
      ? 'INCOMPLETE'
      : ['ELOOP', 'ENOTDIR'].includes(error?.code)
        ? 'FILE_UNSAFE'
        : 'READ_FAILED';
  const code = `INVENTORY_${suffix}`;
  return Object.assign(new Error(code), { code });
}

function forbiddenComponent(value) {
  const lower = value.toLowerCase();
  return (
    lower.startsWith('.env') ||
    ['node_modules', '.git', 'approved.json', 'mailaddress.txt'].includes(lower)
  );
}

function absolutePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 1 &&
    value.length <= 4096 &&
    isAbsolute(value) &&
    resolve(value) === value &&
    !/[\\?#%:]/.test(value) &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    !value.includes('..') &&
    value.split('/').length <= 64 &&
    !value.split('/').some(forbiddenComponent)
  );
}

function relativePath(value) {
  return (
    typeof value === 'string' &&
    value.length <= 512 &&
    !value.includes('..') &&
    value.split('/').every((part) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part)) &&
    !value.split('/').some(forbiddenComponent)
  );
}

function allowedEntry(value) {
  return (
    relativePath(value) &&
    (FIXED_SET.has(value) || (value.startsWith(`${DIST}/`) && value.endsWith('.js')))
  );
}

function sameStat(before, after) {
  return STAT_FIELDS.every((field) => before[field] === after[field]);
}

function regularFile(stat, limit) {
  if (!stat.isFile() || stat.nlink !== 1n) fail('FILE_UNSAFE');
  if (stat.size < 0n || stat.size > BigInt(limit)) fail('LIMIT_EXCEEDED');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Node 22 に openat はないため、Linux の自プロセス fd を親アンカーとして使用する。
// 各親を O_NOFOLLOW で固定し、ユーザー指定の symlink を途中でたどらない。
function directoryContext(scopeRoot) {
  if (
    process.platform !== 'linux' ||
    !['O_NOFOLLOW', 'O_DIRECTORY', 'O_NONBLOCK'].every((key) => Number.isInteger(constants[key]))
  ) {
    fail('READ_FAILED');
  }
  const directories = new Map();
  const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const dirFlags = fileFlags | constants.O_DIRECTORY;

  async function pin(absolute) {
    if (directories.has(absolute)) return directories.get(absolute);
    if (directories.size >= MAX_DIRECTORIES) fail('LIMIT_EXCEEDED');
    const parent = absolute === '/' ? null : await pin(dirname(absolute));
    const anchored = parent ? `/proc/self/fd/${parent.handle.fd}/${basename(absolute)}` : '/';
    const before = await fs.lstat(anchored, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) fail('FILE_UNSAFE');
    const handle = await fs.open(anchored, dirFlags);
    try {
      const after = await handle.stat({ bigint: true });
      if (!after.isDirectory() || !sameStat(before, after)) fail('CHANGED');
      const record = { absolute, handle, stat: after };
      directories.set(absolute, record);
      return record;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async function restat() {
    for (const record of directories.values()) {
      const opened = await record.handle.stat({ bigint: true });
      const named = await fs.lstat(record.absolute, { bigint: true });
      // root 外の祖先は同一性だけ確認し、他プロセスの /tmp 等の追加削除で誤失敗しない。
      const fields =
        record.absolute === scopeRoot || record.absolute.startsWith(`${scopeRoot}/`)
          ? STAT_FIELDS
          : ['dev', 'ino', 'mode'];
      if (
        !fields.every(
          (field) => record.stat[field] === opened[field] && record.stat[field] === named[field],
        )
      ) {
        fail('CHANGED');
      }
    }
  }

  async function close() {
    const results = await Promise.allSettled(
      [...directories.values()].reverse().map((record) => record.handle.close()),
    );
    if (results.some((result) => result.status === 'rejected')) fail('READ_FAILED');
  }

  return { pin, restat, close, fileFlags };
}

async function collect(root, context) {
  const files = [];
  let totalBytes = 0;
  let visitedEntries = 0;

  async function add(path, parent, stat) {
    if (!allowedEntry(path)) fail('PATH_INVALID');
    regularFile(stat, MAX_FILE_BYTES);
    if (path.startsWith(`${DIST}/`) && stat.size === 0n) fail('INCOMPLETE');
    totalBytes += Number(stat.size);
    if (files.length >= MAX_FILES || totalBytes > MAX_TOTAL_BYTES) fail('LIMIT_EXCEEDED');
    files.push({ path, parent, stat });
  }

  for (const path of FIXED_FILES) {
    const parent = await context.pin(dirname(join(root, path)));
    const stat = await fs.lstat(`/proc/self/fd/${parent.handle.fd}/${basename(path)}`, {
      bigint: true,
    });
    await add(path, parent, stat);
  }

  async function walk(path, depth) {
    if (depth > MAX_DIST_DEPTH) fail('LIMIT_EXCEEDED');
    const parent = await context.pin(join(root, path));
    const directory = await fs.opendir(`/proc/self/fd/${parent.handle.fd}`, { bufferSize: 16 });
    for await (const entry of directory) {
      visitedEntries += 1;
      if (visitedEntries > MAX_DIRECTORY_ENTRIES) fail('LIMIT_EXCEEDED');
      const child = `${path}/${entry.name}`;
      // .map を含め、除外判断より先に末尾の型とリンクを確認する。内容は読まない。
      const stat = await fs.lstat(`/proc/self/fd/${parent.handle.fd}/${entry.name}`, {
        bigint: true,
      });
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail('FILE_UNSAFE');
      if (stat.isFile() && stat.nlink !== 1n) fail('FILE_UNSAFE');
      if (!relativePath(child)) fail('PATH_INVALID');
      if (stat.isDirectory()) await walk(child, depth + 1);
      else if (child.endsWith('.js')) await add(child, parent, stat);
    }
  }

  await walk(DIST, 0);
  if (!REQUIRED_DIST_FILES.every((path) => files.some((file) => file.path === path))) {
    fail('INCOMPLETE');
  }
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

async function readStableFile(context, parent, name, expected, limit) {
  regularFile(expected, limit);
  const anchored = `/proc/self/fd/${parent.handle.fd}/${name}`;
  const handle = await fs.open(anchored, context.fileFlags);
  try {
    const before = await handle.stat({ bigint: true });
    regularFile(before, limit);
    if (!sameStat(expected, before)) fail('CHANGED');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, {
        offset: count,
        length: buffer.length - count,
        position: count,
      });
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await fs.lstat(anchored, { bigint: true });
    if (count !== Number(before.size) || !sameStat(before, after) || !sameStat(before, named)) {
      fail('CHANGED');
    }
    return buffer.subarray(0, count);
  } finally {
    await handle.close();
  }
}

async function createInventory(root) {
  if (!absolutePath(root)) fail('ROOT_INVALID');
  const context = directoryContext(root);
  try {
    try {
      await context.pin(root);
      if ((await fs.realpath(root)) !== root) fail('ROOT_INVALID');
    } catch {
      fail('ROOT_INVALID');
    }
    const files = await collect(root, context);
    const rootRelativeEntries = [];
    for (const file of files) {
      const bytes = await readStableFile(
        context,
        file.parent,
        basename(file.path),
        file.stat,
        MAX_FILE_BYTES,
      );
      rootRelativeEntries.push({ path: file.path, bytes: bytes.length, sha256: sha256(bytes) });
    }
    // 個別 fd 確認だけでなく、読み終わってから全ファイルと全親を再確認する。
    for (const file of files) {
      const current = await fs.lstat(join(root, file.path), { bigint: true });
      if (!sameStat(file.stat, current)) fail('CHANGED');
    }
    await context.restat();
    return {
      schemaVersion: 1,
      kind: 'aihd-runtime-inventory',
      deploymentReady: false,
      rootRelativeEntries,
      snapshotSha256: sha256(JSON.stringify(rootRelativeEntries)),
      limitations: [...LIMITATIONS],
    };
  } finally {
    await context.close();
  }
}

export async function createRuntimeInventory(root) {
  try {
    return await createInventory(root);
  } catch (error) {
    throw safeError(error);
  }
}

function exactObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  return (
    ownKeys.length === keys.length &&
    keys.every((key) => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value'))
  );
}

function exactArray(value, maximum) {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({ length: value.length }, (_, index) => index).every((index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
    })
  );
}

function validateManifest(manifest) {
  if (
    !exactObject(manifest, [
      'schemaVersion',
      'kind',
      'deploymentReady',
      'rootRelativeEntries',
      'snapshotSha256',
      'limitations',
    ]) ||
    manifest.schemaVersion !== 1 ||
    manifest.kind !== 'aihd-runtime-inventory' ||
    manifest.deploymentReady !== false ||
    !exactArray(manifest.rootRelativeEntries, MAX_FILES) ||
    manifest.rootRelativeEntries.length === 0 ||
    !exactArray(manifest.limitations, LIMITATIONS.length) ||
    manifest.limitations.length !== LIMITATIONS.length ||
    !LIMITATIONS.every((value, index) => manifest.limitations[index] === value) ||
    typeof manifest.snapshotSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.snapshotSha256)
  ) {
    fail('MANIFEST_INVALID');
  }
  let previous = '';
  let total = 0;
  const entries = [];
  for (const entry of manifest.rootRelativeEntries) {
    if (
      !exactObject(entry, ['path', 'bytes', 'sha256']) ||
      !allowedEntry(entry.path) ||
      entry.path <= previous ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      (entry.path.startsWith(`${DIST}/`) && entry.bytes === 0) ||
      entry.bytes > MAX_FILE_BYTES ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      fail('MANIFEST_INVALID');
    }
    previous = entry.path;
    total += entry.bytes;
    if (total > MAX_TOTAL_BYTES) fail('MANIFEST_INVALID');
    entries.push({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 });
  }
  if (
    ![...FIXED_FILES, ...REQUIRED_DIST_FILES].every((path) =>
      entries.some((entry) => entry.path === path),
    ) ||
    sha256(JSON.stringify(entries)) !== manifest.snapshotSha256
  ) {
    fail('MANIFEST_INVALID');
  }
  return entries;
}

export async function verifyRuntimeInventory(root, manifest) {
  try {
    const entries = validateManifest(manifest);
    const current = await createInventory(root);
    if (
      current.snapshotSha256 !== manifest.snapshotSha256 ||
      JSON.stringify(current.rootRelativeEntries) !== JSON.stringify(entries)
    ) {
      fail('MISMATCH');
    }
    return current;
  } catch (error) {
    throw safeError(error);
  }
}

async function readManifest(path) {
  const context = directoryContext(dirname(path));
  try {
    const parent = await context.pin(dirname(path));
    if ((await fs.realpath(dirname(path))) !== dirname(path)) fail('FILE_UNSAFE');
    const expected = await fs.lstat(`/proc/self/fd/${parent.handle.fd}/${basename(path)}`, {
      bigint: true,
    });
    const bytes = await readStableFile(
      context,
      parent,
      basename(path),
      expected,
      MAX_MANIFEST_BYTES,
    );
    const named = await fs.lstat(path, { bigint: true });
    if (!sameStat(expected, named)) fail('CHANGED');
    await context.restat();
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      fail('MANIFEST_INVALID');
    }
  } finally {
    await context.close();
  }
}

export async function runCli(argv) {
  try {
    if (!Array.isArray(argv) || !['inspect', 'verify'].includes(argv[0])) fail('ARGUMENT_INVALID');
    const [mode, ...args] = argv;
    const options = new Map();
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index];
      const value = args[index + 1];
      if (!['--root', '--manifest'].includes(flag) || options.has(flag) || !absolutePath(value)) {
        fail('ARGUMENT_INVALID');
      }
      options.set(flag, value);
    }
    if (
      !options.has('--root') ||
      (mode === 'inspect' && options.size !== 1) ||
      (mode === 'verify' &&
        (options.size !== 2 ||
          basename(options.get('--manifest') ?? '') !== 'runtime-inventory.json'))
    ) {
      fail('ARGUMENT_INVALID');
    }
    const output =
      mode === 'inspect'
        ? await createRuntimeInventory(options.get('--root'))
        : await verifyRuntimeInventory(
            options.get('--root'),
            await readManifest(options.get('--manifest')),
          );
    return { exitCode: 0, output };
  } catch (error) {
    const { code } = safeError(error);
    return {
      exitCode: code === 'INVENTORY_ARGUMENT_INVALID' ? 2 : 1,
      output: { ok: false, deploymentReady: false, code },
    };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { exitCode, output } = await runCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = exitCode;
}
