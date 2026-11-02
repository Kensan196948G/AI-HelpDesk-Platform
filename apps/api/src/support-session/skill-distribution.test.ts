import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { repoRoot } from '../config.js';
import { computeScriptHash, readApprovalManifest } from '../resolve/skills.js';
import { ASSIST_SKILLS, resolveApprovedSkill } from './skills.js';

/** 配布の経路（Mock なし。実際の git と実ファイル）。 */
describe('スクリプトの配布でハッシュが変わらない', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  /** core.autocrlf=true の clone（Windows の既定）で取り出したファイルのハッシュ。 */
  function cloneWithAutocrlf(attributes: string | null) {
    const source = mkdtempSync(path.join(tmpdir(), 'aihd-attr-src-'));
    const target = mkdtempSync(path.join(tmpdir(), 'aihd-attr-dst-'));
    dirs.push(source, target);
    git(source, 'init', '-q');
    git(source, 'config', 'user.email', 'test@example.com');
    git(source, 'config', 'user.name', 'test');
    if (attributes) writeFileSync(path.join(source, '.gitattributes'), attributes);
    writeFileSync(path.join(source, 'skill.ps1'), 'line1\nline2\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-qm', 'x');
    git(target, '-c', 'core.autocrlf=true', 'clone', '-q', source, 'out');
    return {
      original: computeScriptHash(readFileSync(path.join(source, 'skill.ps1'))),
      cloned: computeScriptHash(readFileSync(path.join(target, 'out', 'skill.ps1'))),
    };
  }

  it('リポジトリの .gitattributes で autocrlf の clone でも同じバイト列になる', () => {
    const attributes = readFileSync(path.join(repoRoot, '.gitattributes'), 'utf8');
    const { original, cloned } = cloneWithAutocrlf(attributes);
    expect(cloned).toBe(original);
  });

  it('対照: .gitattributes がなければ変わる（上の確認が意味を持つ）', () => {
    const { original, cloned } = cloneWithAutocrlf(null);
    expect(cloned).not.toBe(original);
  });

  it('本経路のスクリプトはすべて改行の変換対象外', () => {
    for (const skill of ASSIST_SKILLS) {
      const output = git(repoRoot, 'check-attr', 'text', '--', skill.definition.scriptPath);
      expect(output.trim().endsWith('text: unset'), skill.definition.scriptPath).toBe(true);
    }
  });
});

describe('本番の manifest（scripts/skills/approved.json）', () => {
  const entries = readApprovalManifest(repoRoot).skills;

  it('検証専用の diag.sleep を載せず、カタログにも登録しない', () => {
    expect(entries.map((entry) => entry.id)).not.toContain('diag.sleep');
    expect(ASSIST_SKILLS.map((skill) => skill.definition.id)).not.toContain('diag.sleep');
    expect(resolveApprovedSkill('diag.sleep')).toBeNull();
  });

  it('未登録の Skill は manifest に行があっても承認済みにならない', () => {
    const forged = {
      version: 1,
      skills: [
        {
          id: 'diag.sleep',
          version: '1.0.0',
          scriptHash: `sha256:${'a'.repeat(64)}`,
          contentHash: `sha256:${'b'.repeat(64)}`,
          approvedBy: 'x',
          approvedAt: 'x',
        },
      ],
    };
    expect(resolveApprovedSkill('diag.sleep', forged)).toBeNull();
  });
});
