#!/usr/bin/env node
// apps/api/dist の canonical manifest を書き出す／検証する CLI。
// 書き出しは 0600・O_NOFOLLOW、commit は 40 hex の明示指定か git HEAD に限る。
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
  return 'usage: dist-manifest.mjs (--write|--verify) --manifest <absolute path> [--commit <40hex>]';
}

function parseArgs(argv) {
  let mode;
  let manifestPath;
  let commit;
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
    } else {
      throw new Error('ARGUMENTS_INVALID');
    }
  }
  if (!mode || !manifestPath) throw new Error('ARGUMENTS_INVALID');
  return { mode, manifestPath, commit };
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
  const { mode, manifestPath, commit } = parseArgs(argv);
  if (mode === 'write') {
    const manifest = await buildManifest({ repoRoot: root, commit: resolveCommit(commit) });
    await writeManifestFile(manifestPath, serializeManifest(manifest));
    console.log(`DIST_MANIFEST_WRITTEN ${manifest.sha256}`);
    return;
  }
  const manifest = await readManifestFile(manifestPath, { expectedCommit: resolveCommit(commit) });
  await verifyManifestAgainstDist(manifest, { repoRoot: root });
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
