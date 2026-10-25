/**
 * 端末エージェント（scripts/endpoint-command-agent.mjs）の権限分離の契約テスト。
 *
 * 分離の本体はサーバ側（apps/api/src/routes/device.ts の統合テストで証明する）。
 * ここでは二重防御としてのエージェント側の契約を固定する:
 *   - admin の許可リストが「昇格必須 5 件」と一致する（カタログの elevation:true と突き合わせ）
 *   - 昇格必須の .ps1 が非昇格時に exit 3 で拒否する（最後の砦）
 *   - 既定は standard。admin で adminDeviceToken が無い/同一なら起動しない
 *
 * 実体は起動時に main() を実行するため import せず、ソースとプロセス起動で検証する。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SKILL_CATALOG } from '../apps/api/src/resolve/skills.js';

const REPO_ROOT = process.cwd();
const AGENT_PATH = path.join(REPO_ROOT, 'scripts', 'endpoint-command-agent.mjs');
const AGENT_SOURCE = readFileSync(AGENT_PATH, 'utf8');
const ELEVATED_SKILLS = SKILL_CATALOG.filter((skill) => skill.requires.elevation === true).map(
  (skill) => skill.id,
);

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'aihd-agent-priv-'));
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** エージェントの ELEVATED_SKILL_IDS（admin の許可リスト）をソースから取り出す。 */
function agentElevatedSkillIds() {
  const block = AGENT_SOURCE.match(/const ELEVATED_SKILL_IDS = Object\.freeze\(\[([\s\S]*?)\]\);/);
  if (!block?.[1]) return [];
  return [...block[1].matchAll(/'([a-z][a-z0-9.]*)'/g)].map((match) => match[1]);
}

/** 一時 config を書いて 1 回起動する（起動時検証のみを対象にし、通信はさせない）。 */
function runAgent(config, env = {}, args = ['--once', '--mock']) {
  const configPath = path.join(tmpDir, `agent-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(configPath, JSON.stringify(config), 'utf8');
  return spawnSync(process.execPath, [AGENT_PATH, '--config', configPath, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, ...env },
  });
}

describe('端末エージェントの権限区分（二重防御）', () => {
  it('admin の許可リストはカタログの昇格必須 Skill 5 件と一致する', () => {
    expect(agentElevatedSkillIds().sort()).toEqual([...ELEVATED_SKILLS].sort());
    expect(ELEVATED_SKILLS).toHaveLength(5);
    expect(ELEVATED_SKILLS.sort()).toEqual([
      'bitlocker.status',
      'defender.quickscan',
      'service.start',
      'spooler.queue.purge',
      'spooler.restart',
    ]);
  });

  it('昇格必須の .ps1 は非昇格時に exit 3 で拒否する（最後の砦）', () => {
    for (const id of ELEVATED_SKILLS) {
      const skill = SKILL_CATALOG.find((item) => item.id === id);
      const script = readFileSync(path.join(REPO_ROOT, skill.scriptPath), 'utf8');
      expect(script, id).toMatch(
        /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/,
      );
      expect(script, id).toMatch(/exit 3/);
    }
  });

  it('既定は standard（AIHD_AGENT_PRIVILEGE 未設定）で、deviceToken が無ければ起動しない', () => {
    const result = runAgent({ url: 'http://127.0.0.1:9' }, { AIHD_AGENT_PRIVILEGE: '' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('deviceToken が設定されていません');
  });

  it('AIHD_AGENT_PRIVILEGE=admin で adminDeviceToken が無ければ起動しない', () => {
    const result = runAgent(
      { url: 'http://127.0.0.1:9', deviceToken: 'standard-token-0123456789' },
      { AIHD_AGENT_PRIVILEGE: 'admin' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('adminDeviceToken');
  });

  it('adminDeviceToken が standard の deviceToken と同一なら起動しない', () => {
    const same = 'standard-token-0123456789';
    const result = runAgent(
      { url: 'http://127.0.0.1:9', deviceToken: same, adminDeviceToken: same },
      { AIHD_AGENT_PRIVILEGE: 'admin' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('別トークン');
  });

  it('AIHD_AGENT_PRIVILEGE が不正な値なら起動しない（既定へ倒さない）', () => {
    const result = runAgent(
      { url: 'http://127.0.0.1:9', deviceToken: 'standard-token-0123456789' },
      { AIHD_AGENT_PRIVILEGE: 'root' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AIHD_AGENT_PRIVILEGE');
  });

  it('実行経路は権限チェックを通る（admin は昇格必須以外を実行しない）', () => {
    expect(AGENT_SOURCE).toMatch(
      /function execute\(command\) \{\s*assertSkillAllowedForPrivilege\(command\)/,
    );
    expect(AGENT_SOURCE).toMatch(/管理者エージェントは昇格必須 Skill 以外を実行しません/);
  });
});
