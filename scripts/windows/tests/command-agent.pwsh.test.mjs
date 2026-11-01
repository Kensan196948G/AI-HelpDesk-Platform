import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * command-agent.ps1 の pwsh の試験を npm test から実行する（CI の Test の手順に入る）。
 * .github/workflows を変えずに済むように、ここから起動する。pwsh が無い環境は CI では失敗にする。
 */
const here = import.meta.dirname;
const root = path.resolve(here, '..', '..', '..');
const agent = readFileSync(path.join(here, '..', 'command-agent.ps1'), 'utf8');
const mjs = readFileSync(path.join(root, 'scripts', 'endpoint-command-agent.mjs'), 'utf8');
const manifest = JSON.parse(
  readFileSync(path.join(root, 'scripts', 'skills', 'approved.json'), 'utf8'),
);

const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;

/** ps1 の許可リスト。 */
function agentAllowlist() {
  return new Map(
    [...agent.matchAll(/\$script:SkillScripts\.Add\('([^']+)', '([^']+)'\)/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
}

describe('command-agent.ps1 と endpoint-command-agent.mjs の一致', () => {
  const elevated = [
    ...mjs.match(/ELEVATED_SKILL_IDS = Object\.freeze\(\[([\s\S]*?)\]\)/)[1].matchAll(/'([^']+)'/g),
  ].map((m) => m[1]);

  it('許可リストは mjs の Skill から昇格必須を除いたものと一致する', () => {
    const fromMjs = new Map(
      [...mjs.matchAll(/\[\s*'([a-z.]+)',\s*\{\s*file: '([^']+)'/g)].map((m) => [m[1], m[2]]),
    );
    expect(fromMjs.size).toBeGreaterThanOrEqual(16);
    const expected = [...fromMjs].filter(([id]) => !elevated.includes(id)).sort();
    expect([...agentAllowlist()].sort()).toEqual(expected);
  });

  it('許可リストの Skill はすべて approved.json に承認がある', () => {
    const approved = new Set(manifest.skills.map((entry) => entry.id));
    for (const id of agentAllowlist().keys()) expect(approved.has(id), id).toBe(true);
  });

  it('上限は mjs と同じ', () => {
    expect(mjs).toContain('SKILL_TIMEOUT_MS = 60_000');
    expect(agent).toContain('$script:SkillTimeoutSeconds = 60');
    expect(mjs).toContain('OUTPUT_LIMIT_BYTES = 64 * 1024');
    expect(agent).toContain('$script:OutputLimitBytes = 64 * 1024');
    expect(mjs).toContain('SUMMARY_LIMIT_CHARS = 2_000');
    expect(agent).toContain('$script:SummaryLimitChars = 2000');
  });

  it('リポジトリの Skill はバイト列で承認と一致し、改行の変換対象にならない', () => {
    const attributes = readFileSync(path.join(root, '.gitattributes'), 'utf8');
    expect(attributes).toContain('scripts/skills/windows/*.ps1 -text');
  });
});

describe('command-agent.ps1（pwsh）', () => {
  it.runIf(hasPwsh || process.env.CI)(
    'スタブの HTTP サーバと Skill で fail-closed を確かめる（タイムアウトは実時間 60 秒）',
    () => {
      const result = spawnSync(
        'pwsh',
        ['-NoProfile', '-NonInteractive', '-File', path.join(here, 'command-agent.tests.ps1')],
        { encoding: 'utf8', timeout: 400_000 },
      );
      expect(result.error, 'pwsh を起動できません').toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toMatch(/passed=\d+ failed=0/);
    },
    420_000,
  );
});
