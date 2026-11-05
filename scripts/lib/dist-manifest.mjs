// apps/api/dist を commit に束縛する canonical manifest の生成・検証。
// fs と crypto だけを使い、DB・環境ファイル・dotenv には触れない。
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';

export const DIST_MANIFEST_VERSION = 1;
export const DIST_ROOT_RELATIVE = 'apps/api/dist';
export const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
// manifest は小さな JSON。読み込み時に上限を固定して、差し替えられた巨大ファイルを読まない。
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_FILES = 10_000;
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_PATH_BYTES = 4096;
const DIST_FILE_PATH_PATTERN = new RegExp(
  `^${DIST_ROOT_RELATIVE.replaceAll('/', '\\/')}(?:\\/[A-Za-z0-9._-]+)+$`,
);

export class DistManifestError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DistManifestError';
    this.code = code;
  }
}

function fail(code) {
  throw new DistManifestError(code);
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalFile(file) {
  return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
}

/** manifest の sha256 は「sha256 フィールドを除いた canonical body」の digest。 */
export function computeManifestSha256({ version, commit, files }) {
  return sha256Hex(JSON.stringify({ version, commit, files: files.map(canonicalFile) }));
}

/** 省略可能な項目を固定順で並べた 1 行 JSON（末尾改行あり）。 */
export function serializeManifest(manifest) {
  return `${JSON.stringify({
    version: manifest.version,
    commit: manifest.commit,
    files: manifest.files.map(canonicalFile),
    sha256: manifest.sha256,
  })}\n`;
}

function assertFileEntry(entry) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
    fail('DIST_MANIFEST_INVALID');
  const keys = Object.keys(entry);
  if (
    keys.length !== 3 ||
    !keys.includes('path') ||
    !keys.includes('bytes') ||
    !keys.includes('sha256')
  ) {
    fail('DIST_MANIFEST_INVALID');
  }
  if (typeof entry.path !== 'string' || !DIST_FILE_PATH_PATTERN.test(entry.path)) {
    fail('DIST_MANIFEST_INVALID');
  }
  // `.` / `..` / 空 segment を混ぜた repo 外参照を作らせない。
  if (
    entry.path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    fail('DIST_MANIFEST_INVALID');
  }
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES) {
    fail('DIST_MANIFEST_INVALID');
  }
  if (typeof entry.sha256 !== 'string' || !SHA256_PATTERN.test(entry.sha256)) {
    fail('DIST_MANIFEST_INVALID');
  }
}

/** canonical 形式の manifest 文字列だけを受理し、digest を再計算して照合する。 */
export function parseManifest(text) {
  if (
    typeof text !== 'string' ||
    text.length === 0 ||
    Buffer.byteLength(text) > MAX_MANIFEST_BYTES
  ) {
    fail('DIST_MANIFEST_INVALID');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('DIST_MANIFEST_INVALID');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('DIST_MANIFEST_INVALID');
  }
  const keys = Object.keys(parsed);
  if (
    keys.length !== 4 ||
    !keys.includes('version') ||
    !keys.includes('commit') ||
    !keys.includes('files') ||
    !keys.includes('sha256')
  ) {
    fail('DIST_MANIFEST_INVALID');
  }
  if (parsed.version !== DIST_MANIFEST_VERSION) fail('DIST_MANIFEST_INVALID');
  if (typeof parsed.commit !== 'string' || !COMMIT_PATTERN.test(parsed.commit)) {
    fail('DIST_MANIFEST_INVALID');
  }
  if (
    !Array.isArray(parsed.files) ||
    parsed.files.length === 0 ||
    parsed.files.length > MAX_FILES
  ) {
    fail('DIST_MANIFEST_INVALID');
  }
  for (const entry of parsed.files) assertFileEntry(entry);
  for (let index = 1; index < parsed.files.length; index += 1) {
    if (!(parsed.files[index - 1].path < parsed.files[index].path)) fail('DIST_MANIFEST_INVALID');
  }
  if (typeof parsed.sha256 !== 'string' || !SHA256_PATTERN.test(parsed.sha256)) {
    fail('DIST_MANIFEST_INVALID');
  }
  const manifest = {
    version: parsed.version,
    commit: parsed.commit,
    files: parsed.files.map(canonicalFile),
    sha256: parsed.sha256,
  };
  // 表記ゆれ（空白・キー順）を許さず、書き出し形式と完全一致させる。
  if (text !== serializeManifest(manifest)) fail('DIST_MANIFEST_INVALID');
  if (computeManifestSha256(manifest) !== manifest.sha256) fail('DIST_MANIFEST_INVALID');
  return manifest;
}

async function hashFile(absolutePath) {
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(absolutePath)) {
      bytes += chunk.length;
      if (bytes > MAX_FILE_BYTES) fail('DIST_MANIFEST_TOO_LARGE');
      hash.update(chunk);
    }
  } catch (error) {
    if (error instanceof DistManifestError) throw error;
    fail('DIST_MANIFEST_UNREADABLE');
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function walkDist(absoluteDir, relativeDir, output) {
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    fail('DIST_MANIFEST_UNREADABLE');
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const absolutePath = path.join(absoluteDir, entry.name);
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isSymbolicLink()) fail('DIST_MANIFEST_SYMLINK');
    if (entry.isDirectory()) {
      await walkDist(absolutePath, relativePath, output);
      continue;
    }
    // Dirent と実体の間に差し替えられても symlink・特殊ファイルは受理しない。
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch {
      fail('DIST_MANIFEST_UNREADABLE');
    }
    if (metadata.isSymbolicLink()) fail('DIST_MANIFEST_SYMLINK');
    if (!metadata.isFile()) fail('DIST_MANIFEST_NON_REGULAR');
    if (metadata.size > MAX_FILE_BYTES) fail('DIST_MANIFEST_TOO_LARGE');
    const hashed = await hashFile(absolutePath);
    output.push({ path: relativePath, bytes: hashed.bytes, sha256: hashed.sha256 });
    if (output.length > MAX_FILES) fail('DIST_MANIFEST_TOO_LARGE');
  }
}

/** apps/api/dist 配下の regular file を repo 相対 path で列挙し、sha256 を付ける。 */
export async function collectDistFiles(repoRoot) {
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) {
    fail('DIST_MANIFEST_PATH_INVALID');
  }
  const absoluteRoot = path.join(repoRoot, DIST_ROOT_RELATIVE);
  let metadata;
  try {
    metadata = await lstat(absoluteRoot);
  } catch {
    fail('DIST_MANIFEST_DIST_MISSING');
  }
  if (metadata.isSymbolicLink()) fail('DIST_MANIFEST_SYMLINK');
  if (!metadata.isDirectory()) fail('DIST_MANIFEST_DIST_NOT_DIRECTORY');
  const files = [];
  await walkDist(absoluteRoot, DIST_ROOT_RELATIVE, files);
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return files;
}

/** 実際の dist から canonical manifest を組み立てる。commit は 40 hex のみ。 */
export async function buildManifest({ repoRoot, commit }) {
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
    fail('DIST_MANIFEST_COMMIT_INVALID');
  }
  const files = await collectDistFiles(repoRoot);
  if (files.length === 0) fail('DIST_MANIFEST_EMPTY');
  const manifest = { version: DIST_MANIFEST_VERSION, commit, files, sha256: '' };
  manifest.sha256 = computeManifestSha256(manifest);
  return manifest;
}

/** manifest が現在の dist と全ファイル一致することを確認する。 */
export async function verifyManifestAgainstDist(manifest, { repoRoot }) {
  const actual = await collectDistFiles(repoRoot);
  if (actual.length !== manifest.files.length) fail('DIST_MANIFEST_FILES_MISMATCH');
  for (let index = 0; index < actual.length; index += 1) {
    const expected = manifest.files[index];
    const observed = actual[index];
    if (
      observed.path !== expected.path ||
      observed.bytes !== expected.bytes ||
      observed.sha256 !== expected.sha256
    ) {
      fail('DIST_MANIFEST_FILES_MISMATCH');
    }
  }
  return { files: actual.length };
}

/**
 * manifest ファイルの位置・種別・owner・mode・サイズを検証してから内容を読む。
 * open に O_NOFOLLOW を付け、検証と読み込みの間の symlink 差し替えを避ける。
 */
export async function readManifestFile(manifestPath, { expectedCommit } = {}) {
  if (
    typeof manifestPath !== 'string' ||
    !path.isAbsolute(manifestPath) ||
    path.normalize(manifestPath) !== manifestPath ||
    [...manifestPath].some((character) => character.codePointAt(0) <= 0x1f) ||
    Buffer.byteLength(manifestPath) > MAX_MANIFEST_PATH_BYTES
  ) {
    fail('DIST_MANIFEST_PATH_INVALID');
  }
  let handle;
  try {
    handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    fail(error?.code === 'ELOOP' ? 'DIST_MANIFEST_SYMLINK' : 'DIST_MANIFEST_UNREADABLE');
  }
  let manifest;
  try {
    const metadata = await handle.stat();
    if (metadata.isSymbolicLink()) fail('DIST_MANIFEST_SYMLINK');
    if (!metadata.isFile()) fail('DIST_MANIFEST_NOT_REGULAR');
    if ((metadata.mode & 0o777) !== 0o600) fail('DIST_MANIFEST_MODE_INVALID');
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      fail('DIST_MANIFEST_OWNER_INVALID');
    }
    if (metadata.size <= 0) fail('DIST_MANIFEST_INVALID');
    if (metadata.size > MAX_MANIFEST_BYTES) fail('DIST_MANIFEST_TOO_LARGE');
    let text;
    try {
      text = await handle.readFile('utf8');
    } catch {
      fail('DIST_MANIFEST_UNREADABLE');
    }
    if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) fail('DIST_MANIFEST_TOO_LARGE');
    manifest = parseManifest(text);
  } finally {
    await handle.close();
  }
  if (expectedCommit !== undefined) {
    if (typeof expectedCommit !== 'string' || !COMMIT_PATTERN.test(expectedCommit)) {
      fail('DIST_MANIFEST_COMMIT_INVALID');
    }
    if (manifest.commit !== expectedCommit) fail('DIST_MANIFEST_COMMIT_MISMATCH');
  }
  return manifest;
}
