#!/usr/bin/env node
// apps/api/dist の canonical manifest を書き出す／検証する CLI。
// 書き出しは 0600・O_NOFOLLOW、commit は 40 hex の明示指定か git HEAD に限る。
// --verify に限り --root で repo 外（release）の dist を検証できる（release のコードは実行しない）。
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import {
  buildManifest,
  COMMIT_PATTERN,
  DistManifestError,
  readManifestFile,
  serializeManifest,
  verifyManifestAgainstDist,
} from './lib/dist-manifest.mjs';

const root = path.resolve(import.meta.dirname, '..');

function usage() {
  return [
    'usage: dist-manifest.mjs (--write|--verify) --manifest <absolute path> [--commit <40hex>]',
    '       dist-manifest.mjs --verify --manifest <absolute path> --root <absolute path> --commit <40hex>',
  ].join('\n');
}

// --root は検証対象の dist を辿る trust anchor。呼び出し側の解決規則を暗黙に変えないため、
// 絶対・正規化済み・制御文字なしの path だけを受理する（相対・`..` 混じりは再現性を壊す）。
// --root 自体は symlink（…/current）でもよい。dist 内部の symlink は collectDistFiles が拒否する。
function assertVerifyRoot(value) {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error('ARGUMENTS_INVALID');
  }
  if ([...value].some((character) => character.codePointAt(0) <= 0x1f)) {
    throw new Error('ARGUMENTS_INVALID');
  }
}

function parseArgs(argv) {
  let mode;
  let manifestPath;
  let commit;
  let verifyRoot;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--write' || argument === '--verify') {
      if (mode) throw new Error('ARGUMENTS_INVALID');
      mode = argument.slice(2);
    } else if (argument === '--manifest') {
      const value = argv[index + 1];
      index += 1;
      if (!value || manifestPath) throw new Error('ARGUMENTS_INVALID');
      manifestPath = value;
    } else if (argument === '--commit') {
      const value = argv[index + 1];
      index += 1;
      if (!value || commit) throw new Error('ARGUMENTS_INVALID');
      commit = value;
    } else if (argument === '--root') {
      const value = argv[index + 1];
      index += 1;
      if (!value || verifyRoot !== undefined) throw new Error('ARGUMENTS_INVALID');
      verifyRoot = value;
    } else {
      throw new Error('ARGUMENTS_INVALID');
    }
  }
  if (!mode || !manifestPath) throw new Error('ARGUMENTS_INVALID');
  if (verifyRoot !== undefined) {
    // 書き出しは常に repo 側（この CLI の apps/api/dist）に固定する。検証だけを repo 外へ向ける。
    if (mode !== 'verify') throw new Error('ARGUMENTS_INVALID');
    assertVerifyRoot(verifyRoot);
    // 期待 commit を repo の HEAD で暗黙に埋めると release と repo を取り違えるため、
    // --root 指定時は --commit を必須にする（release 側の commit を明示させる）。
    if (commit === undefined) throw new Error('ARGUMENTS_INVALID');
  }
  return { mode, manifestPath, commit, verifyRoot };
}

function resolveCommit(explicitCommit) {
  if (explicitCommit !== undefined) {
    if (!COMMIT_PATTERN.test(explicitCommit)) throw new Error('DIST_MANIFEST_COMMIT_INVALID');
    return explicitCommit;
  }
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
  });
  const head = result.status === 0 ? result.stdout.trim() : '';
  if (!COMMIT_PATTERN.test(head)) throw new Error('DIST_MANIFEST_COMMIT_INVALID');
  return head;
}

async function writeManifestFile(manifestPath, text) {
  if (!path.isAbsolute(manifestPath) || path.normalize(manifestPath) !== manifestPath) {
    throw new Error('DIST_MANIFEST_PATH_INVALID');
  }
  let handle;
  try {
    handle = await open(
      manifestPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error('DIST_MANIFEST_SYMLINK');
    throw new Error('DIST_MANIFEST_WRITE_FAILED');
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main(argv) {
  const { mode, manifestPath, commit, verifyRoot } = parseArgs(argv);
  if (mode === 'write') {
    const manifest = await buildManifest({ repoRoot: root, commit: resolveCommit(commit) });
    await writeManifestFile(manifestPath, serializeManifest(manifest));
    console.log(`DIST_MANIFEST_WRITTEN ${manifest.sha256}`);
    return;
  }
  const manifest = await readManifestFile(manifestPath, { expectedCommit: resolveCommit(commit) });
  // verifyRoot 未指定時は従来どおり repo 側の dist と照合する。
  await verifyManifestAgainstDist(manifest, { repoRoot: verifyRoot ?? root });
  console.log(`DIST_MANIFEST_OK ${manifest.sha256}`);
}

main(process.argv.slice(2)).catch((error) => {
  const code =
    error instanceof DistManifestError ||
    (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message))
      ? error.message
      : 'DIST_MANIFEST_FAILED';
  console.error(code);
  if (code === 'ARGUMENTS_INVALID') console.error(usage());
  process.exitCode = code === 'ARGUMENTS_INVALID' ? 2 : 1;
});
