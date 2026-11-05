import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildManifest,
  collectDistFiles,
  computeManifestSha256,
  MAX_MANIFEST_BYTES,
  parseManifest,
  readManifestFile,
  serializeManifest,
  verifyManifestAgainstDist,
} from './dist-manifest.mjs';

const COMMIT = 'a1'.repeat(20);
const OTHER_COMMIT = 'b2'.repeat(20);
const INDEX = 'console.log("index")\n';
const LIB = 'export const a = 1;\n';
const fixtureRoots = new Set();

async function fixture({ withFiles = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'aihd-dist-manifest-'));
  fixtureRoots.add(root);
  if (withFiles) {
    await mkdir(path.join(root, 'apps/api/dist/lib'), { recursive: true });
    await writeFile(path.join(root, 'apps/api/dist/index.js'), INDEX);
    await writeFile(path.join(root, 'apps/api/dist/lib/a.js'), LIB);
  }
  return root;
}

async function writeManifestFile(root, manifest, { mode = 0o600 } = {}) {
  const file = path.join(root, 'dist-manifest.json');
  await writeFile(file, serializeManifest(manifest), { mode });
  await chmod(file, mode);
  return file;
}

async function expectFailure(promise, code) {
  await expect(promise).rejects.toMatchObject({ code });
}

afterEach(async () => {
  for (const root of fixtureRoots) {
    const resolved = path.resolve(root);
    if (
      path.dirname(resolved) !== path.resolve(tmpdir()) ||
      !path.basename(resolved).startsWith('aihd-dist-manifest-')
    ) {
      throw new Error('FIXTURE_CLEANUP_SCOPE_INVALID');
    }
    await rm(resolved, { recursive: true, force: true });
  }
  fixtureRoots.clear();
});

describe('dist-manifest: dist を repo 相対 path・bytes・sha256 で列挙する', () => {
  it('regular file だけを path 順に列挙する', async () => {
    const root = await fixture();
    const files = await collectDistFiles(root);
    expect(files.map((file) => file.path)).toEqual([
      'apps/api/dist/index.js',
      'apps/api/dist/lib/a.js',
    ]);
    expect(files[0]).toEqual({
      path: 'apps/api/dist/index.js',
      bytes: Buffer.byteLength(INDEX),
      sha256: createHash('sha256').update(INDEX).digest('hex'),
    });
    expect(files[1].sha256).toBe(createHash('sha256').update(LIB).digest('hex'));
  });

  it('dist が無い・directory でない・空のときは生成しない', async () => {
    const empty = await fixture({ withFiles: false });
    await expectFailure(collectDistFiles(empty), 'DIST_MANIFEST_DIST_MISSING');
    const notDirectory = await fixture();
    const missingRoot = path.join(notDirectory, 'apps/api/dist');
    await rm(missingRoot, { recursive: true, force: true });
    await writeFile(missingRoot, 'not a directory');
    await expectFailure(collectDistFiles(notDirectory), 'DIST_MANIFEST_DIST_NOT_DIRECTORY');
    const emptyDist = await fixture();
    await rm(path.join(emptyDist, 'apps/api/dist/index.js'));
    await rm(path.join(emptyDist, 'apps/api/dist/lib'), { recursive: true });
    await expectFailure(
      buildManifest({ repoRoot: emptyDist, commit: COMMIT }),
      'DIST_MANIFEST_EMPTY',
    );
  });

  it('dist 内の symlink を拒否する', async () => {
    const root = await fixture();
    const outside = path.join(root, 'outside.js');
    await writeFile(outside, 'outside');
    await symlink(outside, path.join(root, 'apps/api/dist/link.js'));
    await expectFailure(collectDistFiles(root), 'DIST_MANIFEST_SYMLINK');
  });
});

describe('dist-manifest: canonical manifest の生成と検証', () => {
  it('生成した manifest は parse でき、commit と digest が一致する', async () => {
    const root = await fixture();
    const manifest = await buildManifest({ repoRoot: root, commit: COMMIT });
    expect(manifest.version).toBe(1);
    expect(manifest.commit).toBe(COMMIT);
    expect(manifest.files).toHaveLength(2);
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.sha256).toBe(computeManifestSha256(manifest));
    expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
    await expect(verifyManifestAgainstDist(manifest, { repoRoot: root })).resolves.toEqual({
      files: 2,
    });
  });

  it.each([
    ['40 hex でない commit', 'abc1234'],
    ['大文字 commit', COMMIT.toUpperCase()],
    ['短縮 commit', COMMIT.slice(0, 12)],
  ])('build は %s を拒否する', async (_label, commit) => {
    const root = await fixture();
    await expectFailure(buildManifest({ repoRoot: root, commit }), 'DIST_MANIFEST_COMMIT_INVALID');
  });

  it('書き出した manifest を commit 照合つきで読める', async () => {
    const root = await fixture();
    const manifest = await buildManifest({ repoRoot: root, commit: COMMIT });
    const file = await writeManifestFile(root, manifest);
    await expect(readManifestFile(file, { expectedCommit: COMMIT })).resolves.toEqual(manifest);
    await expect(readManifestFile(file)).resolves.toEqual(manifest);
  });

  it.each([
    ['改竄', async (root) => writeFile(path.join(root, 'apps/api/dist/index.js'), 'tampered')],
    ['余剰', async (root) => writeFile(path.join(root, 'apps/api/dist/extra.js'), 'extra')],
    ['欠落', async (root) => rm(path.join(root, 'apps/api/dist/lib/a.js'))],
  ])('dist の%sを files mismatch として拒否する', async (_label, mutate) => {
    const root = await fixture();
    const manifest = await buildManifest({ repoRoot: root, commit: COMMIT });
    await mutate(root);
    await expectFailure(
      verifyManifestAgainstDist(manifest, { repoRoot: root }),
      'DIST_MANIFEST_FILES_MISMATCH',
    );
  });

  it('commit が HEAD と一致しない manifest を拒否する', async () => {
    const root = await fixture();
    const manifest = await buildManifest({ repoRoot: root, commit: COMMIT });
    const file = await writeManifestFile(root, manifest);
    await expectFailure(
      readManifestFile(file, { expectedCommit: OTHER_COMMIT }),
      'DIST_MANIFEST_COMMIT_MISMATCH',
    );
    await expectFailure(
      readManifestFile(file, { expectedCommit: 'not-a-commit' }),
      'DIST_MANIFEST_COMMIT_INVALID',
    );
  });
});

describe('dist-manifest: manifest ファイルの境界を fail-closed にする', () => {
  it('symlink・非 0600・相対 path・非正規化 path を拒否する', async () => {
    const root = await fixture();
    const manifest = await buildManifest({ repoRoot: root, commit: COMMIT });
    const file = await writeManifestFile(root, manifest, { mode: 0o644 });
    await expectFailure(readManifestFile(file), 'DIST_MANIFEST_MODE_INVALID');

    const alias = path.join(root, 'manifest-link.json');
    await symlink(file, alias);
    await expectFailure(readManifestFile(alias), 'DIST_MANIFEST_SYMLINK');

    await expectFailure(readManifestFile('dist-manifest.json'), 'DIST_MANIFEST_PATH_INVALID');
    await expectFailure(
      readManifestFile(`${root}/../${path.basename(root)}/dist-manifest.json`),
      'DIST_MANIFEST_PATH_INVALID',
    );
  });

  it('存在しない・directory・空の manifest を拒否する', async () => {
    const root = await fixture();
    await expectFailure(
      readManifestFile(path.join(root, 'missing.json')),
      'DIST_MANIFEST_UNREADABLE',
    );
    await expectFailure(readManifestFile(root), 'DIST_MANIFEST_NOT_REGULAR');
    const empty = path.join(root, 'empty.json');
    await writeFile(empty, '', { mode: 0o600 });
    await chmod(empty, 0o600);
    await expectFailure(readManifestFile(empty), 'DIST_MANIFEST_INVALID');
  });

  it('上限を超える manifest を読まない', async () => {
    const root = await fixture();
    const oversized = path.join(root, 'oversized.json');
    await writeFile(oversized, 'x'.repeat(MAX_MANIFEST_BYTES + 1), { mode: 0o600 });
    await chmod(oversized, 0o600);
    await expectFailure(readManifestFile(oversized), 'DIST_MANIFEST_TOO_LARGE');
  });

  it.each([
    ['空白入り', (text) => text.replace('{', '{ ')],
    ['末尾改行なし', (text) => text.trimEnd()],
    [
      'sha256 改竄',
      (text) => text.replace(/"sha256":"[a-f0-9]{64}"/, `"sha256":"${'0'.repeat(64)}"`),
    ],
    ['version 違い', (text) => text.replace('"version":1', '"version":2')],
    ['未知キー', (text) => text.replace('"sha256":', '"extra":1,"sha256":')],
  ])('canonical でない・改竄された manifest を拒否する: %s', async (_label, mutate) => {
    const root = await fixture();
    const manifest = await buildManifest({ repoRoot: root, commit: COMMIT });
    const text = mutate(serializeManifest(manifest));
    expect(() => parseManifest(text)).toThrow('DIST_MANIFEST_INVALID');
  });

  it('files の順序・重複・不正 path を拒否する', async () => {
    const root = await fixture();
    const manifest = await buildManifest({ repoRoot: root, commit: COMMIT });
    const reversed = { ...manifest, files: [...manifest.files].reverse() };
    reversed.sha256 = computeManifestSha256(reversed);
    expect(() => parseManifest(serializeManifest(reversed))).toThrow('DIST_MANIFEST_INVALID');

    const duplicated = { ...manifest, files: [manifest.files[0], manifest.files[0]] };
    duplicated.sha256 = computeManifestSha256(duplicated);
    expect(() => parseManifest(serializeManifest(duplicated))).toThrow('DIST_MANIFEST_INVALID');

    const escaped = {
      ...manifest,
      files: [{ ...manifest.files[0], path: 'apps/api/dist/../../etc/passwd' }],
    };
    escaped.sha256 = computeManifestSha256(escaped);
    expect(() => parseManifest(serializeManifest(escaped))).toThrow('DIST_MANIFEST_INVALID');
  });
});
