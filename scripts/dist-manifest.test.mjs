import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildManifest, serializeManifest } from './lib/dist-manifest.mjs';

const CLI = fileURLToPath(new URL('./dist-manifest.mjs', import.meta.url));
const COMMIT = 'a1'.repeat(20);
const INDEX = 'console.log("index")\n';
const LIB = 'export const a = 1;\n';
const fixtureRoots = new Set();

// repo 側 apps/api/dist とはファイル集合が異なる 2 ファイルだけの fixture を作る。
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'aihd-dist-manifest-cli-'));
  fixtureRoots.add(root);
  await mkdir(path.join(root, 'apps/api/dist/lib'), { recursive: true });
  await writeFile(path.join(root, 'apps/api/dist/index.js'), INDEX);
  await writeFile(path.join(root, 'apps/api/dist/lib/a.js'), LIB);
  return root;
}

async function writeFixtureManifest(root) {
  const manifest = await buildManifest({ repoRoot: root, commit: COMMIT });
  const file = path.join(root, 'dist-manifest.json');
  await writeFile(file, serializeManifest(manifest), { mode: 0o600 });
  await chmod(file, 0o600);
  return { file, manifest };
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 20_000 });
}

afterEach(async () => {
  for (const root of fixtureRoots) {
    const resolved = path.resolve(root);
    if (
      path.dirname(resolved) !== path.resolve(tmpdir()) ||
      !path.basename(resolved).startsWith('aihd-dist-manifest-cli-')
    ) {
      throw new Error('FIXTURE_CLEANUP_SCOPE_INVALID');
    }
    await rm(resolved, { recursive: true, force: true });
  }
  fixtureRoots.clear();
});

describe('dist-manifest CLI: --root は --verify の検証対象だけを repo 外へ向ける', () => {
  it('fixture root の dist を manifest と照合して成功する', async () => {
    const root = await fixture();
    const { file, manifest } = await writeFixtureManifest(root);
    const result = runCli(['--verify', '--manifest', file, '--root', root, '--commit', COMMIT]);
    // --root を verifyManifestAgainstDist へ渡し忘れた実装では repo 側 dist を見て fail する。
    // これが「--root 無視」に対する負の対照になる。
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`DIST_MANIFEST_OK ${manifest.sha256}`);
    expect(result.stderr).toBe('');
  });

  it('--root を指定しなければ repo 側の dist を見る（fixture を勝手に使わない）', async () => {
    const root = await fixture();
    const { file } = await writeFixtureManifest(root);
    const result = runCli(['--verify', '--manifest', file, '--commit', COMMIT]);
    // build 済みなら files mismatch、未 build なら dist missing。どちらも fixture を見ていない証拠。
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^DIST_MANIFEST_(FILES_MISMATCH|DIST_MISSING)$/m);
    expect(result.stdout).toBe('');
  });

  it.each([
    ['相対 path', () => 'apps/api/dist'],
    ['`..` を含む非正規化 path', (root) => `${root}/../${path.basename(root)}`],
    ['区切り重複（非正規化 path）', (root) => `${root}//`],
    ['制御文字', (root) => `${root}\u001f`],
    ['空文字', () => ''],
  ])('--root の%s は exit 2 と usage で拒否する', async (_label, makeRoot) => {
    const root = await fixture();
    const { file } = await writeFixtureManifest(root);
    const result = runCli([
      '--verify',
      '--manifest',
      file,
      '--root',
      makeRoot(root),
      '--commit',
      COMMIT,
    ]);
    // 正規化してから検証する実装は `..` や区切り重複を受け入れ、exit 0/1 になる。
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^ARGUMENTS_INVALID$/m);
    expect(result.stderr).toContain('usage: dist-manifest.mjs');
    expect(result.stdout).toBe('');
  });

  it('末尾スラッシュ 1 つは path.normalize と一致するため受理する（契約の明示）', async () => {
    const root = await fixture();
    const { file, manifest } = await writeFixtureManifest(root);
    const result = runCli([
      '--verify',
      '--manifest',
      file,
      '--root',
      `${root}/`,
      '--commit',
      COMMIT,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`DIST_MANIFEST_OK ${manifest.sha256}`);
  });

  it('--write と --root の併用は exit 2（書き出し先を repo 外へ向けさせない）', async () => {
    const root = await fixture();
    const { file } = await writeFixtureManifest(root);
    const before = await readFile(file, 'utf8');
    const result = runCli(['--write', '--manifest', file, '--root', root, '--commit', COMMIT]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^ARGUMENTS_INVALID$/m);
    expect(result.stdout).toBe('');
    // 引数エラーで止まる場合も、既存 manifest の bytes を書き換えない。
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('--root 指定時は --commit を必須にする（repo HEAD を暗黙に使わない）', async () => {
    const root = await fixture();
    const { file } = await writeFixtureManifest(root);
    const result = runCli(['--verify', '--manifest', file, '--root', root]);
    // 省略時に repo の HEAD を期待 commit にすると release と repo の取り違えを招く。
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^ARGUMENTS_INVALID$/m);
    expect(result.stderr).toContain('usage: dist-manifest.mjs');
    expect(result.stdout).toBe('');
  });

  it('--root の symlink（current 相当）を受理する（dist 内部の symlink は別途拒否）', async () => {
    const root = await fixture();
    const { file, manifest } = await writeFixtureManifest(root);
    const alias = path.join(root, 'current');
    await symlink(root, alias);
    const result = runCli(['--verify', '--manifest', file, '--root', alias, '--commit', COMMIT]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`DIST_MANIFEST_OK ${manifest.sha256}`);
  });

  it('--root の重複指定・値の欠落は exit 2 と usage で拒否する', async () => {
    const root = await fixture();
    const { file } = await writeFixtureManifest(root);
    const duplicated = runCli([
      '--verify',
      '--manifest',
      file,
      '--root',
      root,
      '--root',
      root,
      '--commit',
      COMMIT,
    ]);
    expect(duplicated.status).toBe(2);
    expect(duplicated.stderr).toMatch(/^ARGUMENTS_INVALID$/m);
    expect(duplicated.stderr).toContain('usage: dist-manifest.mjs');

    const missingValue = runCli(['--verify', '--manifest', file, '--root']);
    expect(missingValue.status).toBe(2);
    expect(missingValue.stderr).toMatch(/^ARGUMENTS_INVALID$/m);
    expect(missingValue.stderr).toContain('usage: dist-manifest.mjs');
  });

  it('改竄された dist は --root 付きでも exit 1 と理由コードで拒否する', async () => {
    const root = await fixture();
    const { file } = await writeFixtureManifest(root);
    await writeFile(path.join(root, 'apps/api/dist/index.js'), 'tampered');
    const result = runCli(['--verify', '--manifest', file, '--root', root, '--commit', COMMIT]);
    // exit code だけでなく、どの検査で落ちたか（stderr のコード）まで固定する。
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('DIST_MANIFEST_FILES_MISMATCH\n');
    expect(result.stdout).toBe('');
  });

  it('--root 指定時に --commit が manifest と食い違えば exit 1 で commit 不一致を返す', async () => {
    const root = await fixture();
    const { file } = await writeFixtureManifest(root);
    const otherCommit = 'b2'.repeat(20);
    const result = runCli([
      '--verify',
      '--manifest',
      file,
      '--root',
      root,
      '--commit',
      otherCommit,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('DIST_MANIFEST_COMMIT_MISMATCH\n');
    expect(result.stdout).toBe('');
  });

  it('--root が path として正しくても dist が無ければ exit 1（引数エラーと区別する）', async () => {
    const root = await fixture();
    const { file } = await writeFixtureManifest(root);
    const missing = path.join(root, 'no-such-release');
    const result = runCli(['--verify', '--manifest', file, '--root', missing, '--commit', COMMIT]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('DIST_MANIFEST_DIST_MISSING\n');
    expect(result.stdout).toBe('');
  });
});
