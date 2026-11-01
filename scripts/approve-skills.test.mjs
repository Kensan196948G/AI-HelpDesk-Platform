import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** 実際の CLI を動かす。承認の記録先は一時ファイルで、approved.json を書き換えない。 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const realManifest = path.join(repoRoot, 'scripts/skills/approved.json');
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function run(...args) {
  return spawnSync('npx', ['tsx', 'scripts/approve-skills.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    // DB なしで動くこと（環境の設定に依存しないこと）を確かめる。
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !['DATABASE_URL', 'SESSION_SECRET', 'NODE_ENV'].includes(key),
      ),
    ),
  });
}

describe('scripts/approve-skills.ts', () => {
  let dir;
  let manifest;
  let realBefore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'aihd-approve-'));
    manifest = path.join(dir, 'approved.json');
    copyFileSync(realManifest, manifest);
    realBefore = sha(realManifest);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    expect(sha(realManifest)).toBe(realBefore);
  });

  const read = () => JSON.parse(readFileSync(manifest, 'utf8'));

  it('--help は DB や環境の設定なしで動く', () => {
    const result = run('--help');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('--dry-run');
    expect(result.stdout).toContain('--only');
    expect(result.stderr).not.toContain('環境変数');
  }, 60_000);

  it.each([['--only'], ['--only', '--dry-run'], ['--only', ' , '], ['--manifest'], ['--note']])(
    '値のない %s は失敗にする（全カタログを承認しない）',
    (...args) => {
      const before = sha(manifest);
      const flagArgs = args.filter((item) => typeof item === 'string');
      // --manifest の値なしは、記録先を指定しない形で確かめる（書き込まれれば後片付けの確認で分かる）。
      const target = flagArgs[0] === '--manifest' ? [] : ['--manifest', manifest];
      const result = run('--by', 'reviewer@example.com', ...target, ...flagArgs);
      expect(result.status).toBe(1);
      expect(sha(manifest)).toBe(before);
    },
    60_000,
  );

  it('--by の値がなければ失敗にする', () => {
    const result = run('--manifest', manifest, '--by');
    expect(result.status).toBe(1);
  }, 60_000);

  it('--by がなければ承認しない（既定の承認者を持たない）', () => {
    const before = sha(manifest);
    const result = run('--manifest', manifest);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--by');
    expect(sha(manifest)).toBe(before);
  }, 60_000);

  // 実物の manifest は承認が進むので、未承認の状態を一時ファイルに作る。
  const withoutFolderSummary = () => {
    const current = read();
    writeFileSync(
      manifest,
      JSON.stringify({
        ...current,
        skills: current.skills.filter((entry) => entry.id !== 'folder.summary'),
      }),
    );
  };

  it('--dry-run は差分だけ表示し、書き込まない', () => {
    withoutFolderSummary();
    const before = sha(manifest);
    const result = run('--dry-run', '--manifest', manifest);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('added');
    expect(result.stdout).toContain('folder.summary@1.0.0');
    expect(result.stdout).toContain('dry-run');
    expect(sha(manifest)).toBe(before);
  }, 60_000);

  it('新カタログを追加し、以前の承認者と時刻を残す', () => {
    withoutFolderSummary();
    const before = read();
    const result = run('--by', 'reviewer@example.com', '--manifest', manifest);
    expect(result.status, result.stderr).toBe(0);
    const after = read();
    const summary = after.skills.find((entry) => entry.id === 'folder.summary');
    expect(summary).toMatchObject({ version: '1.0.0', approvedBy: 'reviewer@example.com' });
    expect(summary.scriptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(summary.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const entry of before.skills) {
      expect(after.skills.find((item) => item.id === entry.id)).toEqual(entry);
    }
  }, 60_000);

  it('カタログに無い行（以前の版や廃止した Skill）も消さない', () => {
    const before = read();
    const old = { ...before.skills[0], id: 'legacy.skill', version: '0.9.0' };
    writeFileSync(manifest, JSON.stringify({ ...before, skills: [...before.skills, old] }));
    expect(run('--by', 'reviewer@example.com', '--manifest', manifest).status).toBe(0);
    expect(read().skills.find((entry) => entry.id === 'legacy.skill')).toEqual(old);
  }, 60_000);

  it('定義やスクリプトのハッシュが違う行は更新として記録する', () => {
    const before = read();
    before.skills[0].contentHash = `sha256:${'0'.repeat(64)}`;
    writeFileSync(manifest, JSON.stringify(before));
    const result = run('--by', 'reviewer@example.com', '--manifest', manifest);
    expect(result.stdout).toContain(`updated        ${before.skills[0].id}`);
    expect(read().skills[0].approvedBy).toBe('reviewer@example.com');
  }, 60_000);

  it('検証用の Skill は明示しないと載らず、diag.sleep は指定しても載らない', () => {
    expect(run('--by', 'reviewer@example.com', '--manifest', manifest).status).toBe(0);
    let ids = read().skills.map((entry) => entry.id);
    for (const id of ['user.marker.set', 'user.marker.clear', 'user.marker.status', 'diag.sleep']) {
      expect(ids).not.toContain(id);
    }
    for (const args of [
      ['--only', 'diag.sleep'],
      ['--only', 'diag.sleep', '--include-verification'],
      ['--only', 'user.marker.set'],
    ]) {
      const refused = run('--by', 'reviewer@example.com', '--manifest', manifest, ...args);
      expect(refused.status, args.join(' ')).toBe(1);
    }
    expect(
      run('--by', 'r@example.com', '--manifest', manifest, '--include-verification').status,
    ).toBe(0);
    ids = read().skills.map((entry) => entry.id);
    expect(ids).toContain('user.marker.status');
    expect(ids).not.toContain('diag.sleep');
  }, 120_000);

  it('--only で指定したものだけを承認する', () => {
    const result = run('--by', 'r@example.com', '--manifest', manifest, '--only', 'folder.summary');
    expect(result.status, result.stderr).toBe(0);
    const ids = read().skills.map((entry) => entry.id);
    expect(ids).toContain('folder.summary');
    expect(ids).not.toContain('user.marker.set');
  }, 60_000);

  it('壊れた manifest を空として上書きしない', () => {
    writeFileSync(manifest, '{broken');
    const before = sha(manifest);
    const result = run('--by', 'reviewer@example.com', '--manifest', manifest);
    expect(result.status).toBe(1);
    expect(sha(manifest)).toBe(before);
  }, 60_000);
});
