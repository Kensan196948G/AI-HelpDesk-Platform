import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { approvalCatalog } from '../support-session/skill-approval.js';
import {
  APPROVAL_MANIFEST_PATH,
  computeScriptHash,
  computeSkillDefinitionHash,
  readApprovalManifest,
  SKILL_CATALOG,
  type SkillDefinition,
  validateParams,
} from './skills.js';

/** Phase B の読み取り専用 5 件（定義・挙動・リスクを変えない）。 */
const PHASE_B_READ_ONLY = [
  'disk.space',
  'network.adapters',
  'os.info',
  'service.status',
  'spooler.status',
] as const;

/** Phase 2 で追加した修復系 7 件。 */
const REPAIR_SKILLS = [
  'bitlocker.status',
  'defender.quickscan',
  'dns.flush',
  'service.start',
  'spooler.queue.purge',
  'spooler.restart',
  'temp.cleanup',
] as const;

const REPAIR_SKILL_SET = new Set<string>(REPAIR_SKILLS);

/** Phase 7 で追加する修復系（到達率向上 / 既存 12 件の定義は変えない）。 */
const PHASE_7_SKILLS = [
  'service.restart',
  'network.adapter.restart',
  'defender.update',
  'recyclebin.clear',
] as const;

const PHASE_7_SKILL_SET = new Set<string>(PHASE_7_SKILLS);

/** Phase 2 で指定されたリスクレベル（これ以外へ上げ下げしない）。 */
const REPAIR_RISK_LEVEL: Record<string, number> = {
  'spooler.restart': 2,
  'spooler.queue.purge': 3,
  'service.start': 2,
  'temp.cleanup': 2,
  'dns.flush': 1,
  'bitlocker.status': 1,
  'defender.quickscan': 1,
};

/** Phase 7 で指定されたリスクレベル（4 以上に上げない）。 */
const PHASE_7_RISK_LEVEL: Record<string, number> = {
  'service.restart': 2,
  'network.adapter.restart': 3,
  'defender.update': 1,
  'recyclebin.clear': 2,
};

const REPO_ROOT = process.cwd();

const AGENT_SOURCE = readFileSync(
  path.join(REPO_ROOT, 'scripts', 'endpoint-command-agent.mjs'),
  'utf8',
);

function skillById(id: string): SkillDefinition {
  const skill = SKILL_CATALOG.find((item) => item.id === id);
  if (!skill) throw new Error(`Skill がありません: ${id}`);
  return skill;
}

function readSkillScript(skill: SkillDefinition): string {
  return readFileSync(path.join(REPO_ROOT, skill.scriptPath), 'utf8');
}

function propertiesOf(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {};
  return properties as Record<string, Record<string, unknown>>;
}

/**
 * 変更系（修復）Skill の不変条件: verify / rollback の存在と形。
 *
 * Phase 2 の 7 件と Phase 7 の追加分で同じ契約を強制するため関数に切り出す
 * （assert を緩めないため、Phase 2 のテストもこの関数を通す）。
 */
function assertRepairSkillShape(id: string): void {
  const skill = skillById(id);
  expect(skill.verify, `${id}.verify`).not.toBeNull();
  expect(skill.rollback, `${id}.rollback`).not.toBeNull();

  const verify = skill.verify as Record<string, unknown>;
  expect(typeof verify.description, `${id}.verify.description`).toBe('string');
  expect((verify.description as string).length, id).toBeGreaterThan(0);
  // 確認条件は「既存スクリプトによる独立確認」か「自 Skill の結果フィールド」のどちらか。
  expect(
    typeof verify.script === 'string' || typeof verify.resultField === 'string',
    `${id}.verify`,
  ).toBe(true);
  if (typeof verify.script === 'string') {
    expect(existsSync(path.join(REPO_ROOT, verify.script)), verify.script).toBe(true);
  }

  const rollback = skill.rollback as Record<string, unknown>;
  expect(typeof rollback.reversible, `${id}.rollback.reversible`).toBe('boolean');
  expect(typeof rollback.description, `${id}.rollback.description`).toBe('string');
  expect((rollback.description as string).length, id).toBeGreaterThan(0);
  // 実行基盤の無い rollback スクリプトを参照しない（実体の無い約束を作らない）。
  expect(rollback.script, `${id}.rollback.script`).toBeNull();
}

/**
 * 端末エージェントの許可リスト（skill_id → スクリプトファイル名）をソースから取り出す。
 * endpoint-command-agent.mjs は起動時に main() を実行するため import せず、静的に読む。
 */
function agentAllowlist(): Map<string, string> {
  const entries = new Map<string, string>();
  const pattern = /\[\s*'([a-z][a-z0-9.]*)',\s*\{\s*file:\s*'([^']+)'/g;
  for (const match of AGENT_SOURCE.matchAll(pattern)) {
    const id = match[1];
    const file = match[2];
    if (id && file) entries.set(id, file);
  }
  return entries;
}

describe('Skill カタログ定義', () => {
  it('Phase B の読み取り 5 件と Phase 2 / Phase 7 の修復 Skill で構成される', () => {
    expect(SKILL_CATALOG.map((skill) => skill.id).sort()).toEqual(
      [...PHASE_B_READ_ONLY, ...REPAIR_SKILLS, ...PHASE_7_SKILLS].sort(),
    );
  });

  it('スクリプト内容の SHA-256 を sha256: 形式で返す', () => {
    expect(computeScriptHash('hello')).toBe(
      'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('Phase B の 5 件は読み取り専用・リスク 1 のまま変更されていない', () => {
    for (const id of PHASE_B_READ_ONLY) {
      const skill = skillById(id);
      expect(skill.riskLevel).toBe(1);
      expect(skill.requires).toEqual({
        userConfirm: true,
        adminApproval: false,
        elevation: false,
      });
      if (id === 'service.status') {
        expect(skill.args).toEqual(['-Service', '{{service}}']);
      } else {
        expect(skill.args).toEqual([]);
      }
      expect(skill.verify).toBeNull();
      expect(skill.rollback).toBeNull();
      expect(skill.timeoutSec).toBe(60);
      expect(skill.outputPolicy).toMatchObject({ maskPii: true });
    }
    // service.status の許可 enum も従来どおり。
    expect(skillById('service.status').paramsSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['service'],
      properties: { service: { type: 'string', enum: ['Spooler', 'W32Time', 'Winmgmt'] } },
    });
  });

  it('修復 7 件の riskLevel は指定どおり（4 以上に上げない）', () => {
    for (const id of REPAIR_SKILLS) {
      expect(skillById(id).riskLevel, id).toBe(REPAIR_RISK_LEVEL[id]);
    }
  });

  it('Phase 7 の修復 Skill の riskLevel も指定どおり（4 以上に上げない）', () => {
    for (const id of PHASE_7_SKILLS) {
      const risk = skillById(id).riskLevel;
      expect(risk, id).toBe(PHASE_7_RISK_LEVEL[id]);
      expect(risk, id).toBeLessThan(4);
    }
  });

  it('全 Skill の不変条件（リスク 1..5 / Windows / スクリプト実体 / 引数配列 / タイムアウト）', () => {
    for (const skill of SKILL_CATALOG) {
      expect(Number.isInteger(skill.riskLevel), skill.id).toBe(true);
      expect(skill.riskLevel).toBeGreaterThanOrEqual(1);
      expect(skill.riskLevel).toBeLessThanOrEqual(5);
      expect(skill.os).toEqual(['windows']);
      expect(skill.scriptPath.startsWith('scripts/skills/windows/')).toBe(true);
      expect(skill.scriptPath.endsWith('.ps1')).toBe(true);
      expect(existsSync(path.join(REPO_ROOT, skill.scriptPath)), skill.scriptPath).toBe(true);
      expect(Array.isArray(skill.args)).toBe(true);
      for (const arg of skill.args) expect(typeof arg).toBe('string');
      expect(skill.requires).toMatchObject({ userConfirm: true, adminApproval: false });
      expect(typeof (skill.requires as Record<string, unknown>).elevation).toBe('boolean');
      // 端末エージェントの実行タイムアウトは 60 秒固定。これを超えると結果が返らない。
      expect(Number.isInteger(skill.timeoutSec), skill.id).toBe(true);
      expect(skill.timeoutSec).toBeGreaterThanOrEqual(1);
      expect(skill.timeoutSec).toBeLessThanOrEqual(60);
      expect(skill.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(skill.symptoms.length).toBeGreaterThan(0);
      expect(skill.outputPolicy).toMatchObject({ maskPii: true });
      expect(Array.isArray((skill.outputPolicy as Record<string, unknown>).fieldsToAi)).toBe(true);
    }
  });

  it('args のテンプレートは宣言済みパラメータだけを参照し、制御文字を含まない', () => {
    for (const skill of SKILL_CATALOG) {
      const declared = Object.keys(propertiesOf(skill.paramsSchema));
      for (const arg of skill.args) {
        expect(arg, skill.id).not.toMatch(/[;|&$`>]/);
        for (const match of arg.matchAll(/\{\{(\w+)\}\}/g)) {
          expect(declared, `${skill.id}: ${match[1]}`).toContain(match[1]);
        }
      }
    }
  });

  it('outputPolicy.fieldsToAi は resultSchema に宣言済みのキーだけを参照する', () => {
    // 実出力キーと宣言のずれ（Phase C で直した不整合）を再発させない。
    for (const skill of SKILL_CATALOG) {
      const declared = Object.keys(skill.resultSchema ?? {});
      const fields = (skill.outputPolicy as Record<string, unknown>).fieldsToAi as unknown[];
      for (const field of fields) {
        expect(declared, `${skill.id}: ${String(field)}`).toContain(String(field));
      }
    }
  });

  it('paramsSchema は JSON Schema として妥当（object / additionalProperties:false / 型・enum・範囲）', () => {
    for (const skill of SKILL_CATALOG) {
      const schema = skill.paramsSchema;
      expect(schema.type, skill.id).toBe('object');
      expect(schema.additionalProperties, skill.id).toBe(false);
      const properties = propertiesOf(schema);
      const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
      for (const key of required) {
        expect(Object.keys(properties), `${skill.id}.${String(key)}`).toContain(String(key));
      }
      for (const [key, property] of Object.entries(properties)) {
        const label = `${skill.id}.${key}`;
        expect(['string', 'integer', 'number', 'boolean'], label).toContain(property.type);
        if (property.enum !== undefined) {
          expect(Array.isArray(property.enum), label).toBe(true);
          const values = property.enum as unknown[];
          expect(values.length, label).toBeGreaterThan(0);
          for (const value of values) expect(typeof value, label).toBe('string');
        }
        if (property.type === 'string') {
          expect(property.minimum, label).toBeUndefined();
          expect(property.maximum, label).toBeUndefined();
        }
        if (property.type === 'integer' || property.type === 'number') {
          if (property.minimum !== undefined) expect(typeof property.minimum, label).toBe('number');
          if (property.maximum !== undefined) expect(typeof property.maximum, label).toBe('number');
          if (typeof property.minimum === 'number' && typeof property.maximum === 'number') {
            expect(property.minimum, label).toBeLessThanOrEqual(property.maximum);
          }
          if (property.type === 'integer') {
            if (typeof property.minimum === 'number') {
              expect(Number.isInteger(property.minimum), label).toBe(true);
            }
            if (typeof property.maximum === 'number') {
              expect(Number.isInteger(property.maximum), label).toBe(true);
            }
          }
        }
      }
    }
  });

  it('修復 7 件は verify と rollback を必ず持つ（description / reversible 付き）', () => {
    for (const id of REPAIR_SKILLS) assertRepairSkillShape(id);
  });

  it('Phase 7 の修復 Skill も verify と rollback を必ず持つ', () => {
    for (const id of PHASE_7_SKILLS) assertRepairSkillShape(id);
  });

  it('spooler.queue.purge は取消不可・影響範囲を rollback に明記する（risk 3）', () => {
    const skill = skillById('spooler.queue.purge');
    expect(skill.riskLevel).toBe(3);
    const rollback = skill.rollback as Record<string, unknown>;
    expect(rollback.reversible).toBe(false);
    expect(rollback.description as string).toContain('取消不可');
    expect(rollback.description as string).toContain('影響範囲');
    expect((skill.verify as Record<string, unknown>).resultField).toBe('remainingErrorCount');
  });

  it('temp.cleanup は復元不可・対象範囲を rollback に明記する（risk 2）', () => {
    const skill = skillById('temp.cleanup');
    expect(skill.riskLevel).toBe(2);
    const rollback = skill.rollback as Record<string, unknown>;
    expect(rollback.reversible).toBe(false);
    expect(rollback.description as string).toContain('復元できない');
    expect(rollback.description as string).toContain('影響範囲');
  });

  it('可逆な修復 Skill は reversible:true を宣言する', () => {
    for (const id of ['spooler.restart', 'service.start', 'dns.flush', 'bitlocker.status']) {
      const rollback = skillById(id).rollback as Record<string, unknown>;
      expect(rollback.reversible, id).toBe(true);
    }
    // スキャン開始のみ（設定変更なし）も取消可能として扱う。
    const scan = skillById('defender.quickscan').rollback as Record<string, unknown>;
    expect(scan.reversible).toBe(true);
  });

  it('service.start は name を Spooler / W32Time に限定する', () => {
    const skill = skillById('service.start');
    expect(skill.paramsSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: { type: 'string', enum: ['Spooler', 'W32Time'] } },
    });
    expect(skill.args).toEqual(['-Service', '{{name}}']);
  });

  it('temp.cleanup は olderThanDays を 1..30 の整数に限定する', () => {
    const skill = skillById('temp.cleanup');
    expect(skill.paramsSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['olderThanDays'],
      properties: { olderThanDays: { type: 'integer', minimum: 1, maximum: 30 } },
    });
    expect(skill.args).toEqual(['-OlderThanDays', '{{olderThanDays}}']);
  });

  it('service.restart は name を Spooler / W32Time に限定し、status で verify する', () => {
    const skill = skillById('service.restart');
    expect(skill.riskLevel).toBe(2);
    expect(skill.paramsSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: { type: 'string', enum: ['Spooler', 'W32Time'] } },
    });
    expect(skill.args).toEqual(['-Service', '{{name}}']);
    // 追撃に頼らず、再起動スクリプト自身が返す status で決定的に判定する。
    expect(skill.verify).toMatchObject({ resultField: 'status', equals: 'Running' });
    // 再起動のみでスタートアップは変えない（可逆）。
    expect((skill.rollback as Record<string, unknown>).reversible).toBe(true);
    // サービス操作は昇格が必要（admin エージェント経路で実行する）。
    expect((skill.requires as Record<string, unknown>).elevation).toBe(true);
  });

  it('network.adapter.restart は interfaceAlias を型付きで受け取り、status=Up で verify する', () => {
    const skill = skillById('network.adapter.restart');
    expect(skill.riskLevel).toBe(3);
    // アダプタ名は端末ごとに異なるため enum にしない。長さと形式だけをスキーマで絞る。
    expect(skill.paramsSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['interfaceAlias'],
      properties: {
        interfaceAlias: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[^-]' },
      },
    });
    expect(skill.args).toEqual(['-InterfaceAlias', '{{interfaceAlias}}']);
    expect(skill.verify).toMatchObject({ resultField: 'status', equals: 'Up' });
    // 無効化→有効化のみで IP 構成は変わらない（可逆）。
    expect((skill.rollback as Record<string, unknown>).reversible).toBe(true);
    expect((skill.requires as Record<string, unknown>).elevation).toBe(true);
  });

  it('defender.update は定義更新で updated=true を verify し、リスク 1 のままにする', () => {
    const skill = skillById('defender.update');
    expect(skill.riskLevel).toBe(1);
    expect(skill.paramsSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {},
    });
    expect(skill.verify).toMatchObject({ resultField: 'updated', equals: true });
    expect((skill.rollback as Record<string, unknown>).reversible).toBe(true);
    expect((skill.requires as Record<string, unknown>).elevation).toBe(true);
    // 固定コマンド（引数でコマンド文字列を受け取らない）。
    const text = readSkillScript(skill);
    expect(text).toContain('Update-MpSignature');
  });

  it('recyclebin.clear は復元不可を rollback に明記し、標準権限で実行する（risk 2）', () => {
    const skill = skillById('recyclebin.clear');
    expect(skill.riskLevel).toBe(2);
    expect(skill.verify).toMatchObject({ resultField: 'cleared', equals: true });
    const rollback = skill.rollback as Record<string, unknown>;
    expect(rollback.reversible).toBe(false);
    expect(rollback.description as string).toContain('復元不可');
    expect(rollback.description as string).toContain('影響範囲');
    // 自分のごみ箱だけを消すため昇格は不要（standard エージェントで実行する）。
    expect((skill.requires as Record<string, unknown>).elevation).toBe(false);
  });

  it('修復 Skill はプロンプト由来のコマンド文字列を受け取るパラメータを持たない', () => {
    for (const skill of SKILL_CATALOG) {
      for (const [key, property] of Object.entries(propertiesOf(skill.paramsSchema))) {
        expect(['command', 'script', 'args', 'path', 'url'], `${skill.id}.${key}`).not.toContain(
          key.toLowerCase(),
        );
        expect(property.type, `${skill.id}.${key}`).not.toBe('object');
      }
    }
  });
});

describe('端末エージェントとの契約（静的検証）', () => {
  it('許可リストはカタログと完全一致し、スクリプトファイル名も一致する', () => {
    const allowlist = agentAllowlist();
    expect(allowlist.size).toBe(SKILL_CATALOG.length);
    expect([...allowlist.keys()].sort()).toEqual(SKILL_CATALOG.map((skill) => skill.id).sort());
    for (const skill of SKILL_CATALOG) {
      expect(allowlist.get(skill.id), skill.id).toBe(path.basename(skill.scriptPath));
    }
  });

  it('未知の Skill ID は実行しない（fail-closed）', () => {
    // 許可リストに無い id は runPowerShellSkill / runMockSkill の両方で例外になる。
    expect(AGENT_SOURCE).toContain('未対応の Skill です');
    // manifest 未承認（= 人間の承認前）も実行しない。
    expect(AGENT_SOURCE).toContain('承認されていない Skill です');
    expect(AGENT_SOURCE).toContain('Skill スクリプトのハッシュが一致しません');
    // 端末の実行タイムアウトは 60 秒固定（カタログの timeoutSec 上限と一致させる）。
    expect(AGENT_SOURCE).toContain('const SKILL_TIMEOUT_MS = 60_000;');
  });

  it('修復 Skill は mock fixture か専用 mock 分岐を持つ（Linux での PoC 用）', () => {
    // パラメータで対象が決まる Skill は fixture ではなく専用分岐で組み立てる。
    const branchSkills = new Set(['service.start', 'service.restart', 'network.adapter.restart']);
    for (const id of [...REPAIR_SKILLS, ...PHASE_7_SKILLS]) {
      const escaped = id.replace(/\./g, '\\.');
      const hasFixture = new RegExp(`'${escaped}': Object\\.freeze\\(`).test(AGENT_SOURCE);
      if (branchSkills.has(id)) {
        expect(hasFixture, `${id} は専用分岐`).toBe(false);
        expect(AGENT_SOURCE).toContain(`skillId === '${id}'`);
      } else {
        expect(hasFixture, `${id} の fixture`).toBe(true);
      }
    }
  });

  it('端末はパラメータを再検証する（許可リスト・整数範囲・確認トークン）', () => {
    expect(AGENT_SOURCE).toContain(
      "const SERVICE_START_NAMES = Object.freeze(['Spooler', 'W32Time'])",
    );
    expect(AGENT_SOURCE).toContain('function requireAllowedStartService');
    expect(AGENT_SOURCE).toContain('function requireOlderThanDays');
    expect(AGENT_SOURCE).toContain('function requirePurgeConfirm');
    expect(AGENT_SOURCE).toContain("const PURGE_CONFIRM_TOKEN = 'PURGE'");
    // service.restart も端末側で許可リストを再検証する。
    expect(AGENT_SOURCE).toContain(
      "const SERVICE_RESTART_NAMES = Object.freeze(['Spooler', 'W32Time'])",
    );
    expect(AGENT_SOURCE).toContain('function requireRestartService');
    // network.adapter.restart は端末側でも形（長さ・先頭文字・制御文字）を再検証する。
    expect(AGENT_SOURCE).toContain('function requireInterfaceAlias');
    expect(AGENT_SOURCE).toContain('const INTERFACE_ALIAS_MAX_LENGTH = 64;');
    expect(AGENT_SOURCE).toContain('interfaceAlias を "-" で開始できません');
  });
});

describe('端末スクリプトの静的契約（Windows 実機なし・実行検証は未実施）', () => {
  const repairSkills = SKILL_CATALOG.filter(
    (skill) => REPAIR_SKILL_SET.has(skill.id) || PHASE_7_SKILL_SET.has(skill.id),
  );

  it('動的実行・シェル文字列連結・$args の直接利用をしない', () => {
    for (const skill of repairSkills) {
      const text = readSkillScript(skill);
      expect(text, skill.id).not.toMatch(/Invoke-Expression|\biex\b/i);
      expect(text, skill.id).not.toMatch(/\bcmd(\.exe)?\s+\/c/i);
      expect(text, skill.id).not.toMatch(/Invoke-Command|Start-Job/);
      expect(text, skill.id).not.toMatch(/\$args\b/);
      // 引数は param() で明示バインドする。
      expect(text, skill.id).toContain('param(');
    }
  });

  it('パラメータを受け取るスクリプトは許可リスト・範囲・確認トークンを再検証する', () => {
    const serviceStart = readSkillScript(skillById('service.start'));
    expect(serviceStart).toContain("$allowed = @('Spooler', 'W32Time')");
    expect(serviceStart).toMatch(/exit 2/);

    const tempCleanup = readSkillScript(skillById('temp.cleanup'));
    expect(tempCleanup).toContain('$OlderThanDays');
    expect(tempCleanup).toMatch(/\$OlderThanDays -lt 1 -or \$OlderThanDays -gt 30/);
    expect(tempCleanup).toMatch(/exit 2/);

    const purge = readSkillScript(skillById('spooler.queue.purge'));
    expect(purge).toContain('[switch]$ConfirmPurge');
    expect(purge).toMatch(/-not \$ConfirmPurge/);
    expect(purge).toMatch(/exit 2/);

    // service.restart: 引数をそのまま -Name に渡さず、許可リストの正規名へ解決する。
    const serviceRestart = readSkillScript(skillById('service.restart'));
    expect(serviceRestart).toContain('[string]$Service');
    expect(serviceRestart).toContain("$allowed = @('Spooler', 'W32Time')");
    expect(serviceRestart).toMatch(/exit 2/);
    expect(serviceRestart).toContain('Restart-Service -Name $canonical');

    // network.adapter.restart: 形の検証 → 実機一覧との完全一致 → Disable→Enable。
    const adapterRestart = readSkillScript(skillById('network.adapter.restart'));
    expect(adapterRestart).toContain('[string]$InterfaceAlias');
    expect(adapterRestart).toContain('$InterfaceAlias.Length -gt 64');
    expect(adapterRestart).toContain('$InterfaceAlias.StartsWith');
    expect(adapterRestart).toMatch(/exit 2/);
    expect(adapterRestart).toContain('Disable-NetAdapter -Name $adapterName');
    expect(adapterRestart).toContain('Enable-NetAdapter -Name $adapterName');
  });

  it('出力は JSON 1 行で、失敗時は stderr + 非 0 終了コードを返す', () => {
    for (const skill of repairSkills) {
      const text = readSkillScript(skill);
      expect(text, skill.id).toContain('ConvertTo-Json -Compress');
      expect(text, skill.id).toContain('[Console]::Error.WriteLine');
      expect(text, skill.id).toMatch(/exit 1/);
    }
  });

  // 2026-10-26 実機（Windows 11 / PowerShell 5.1）で、BOM なし UTF-8 の日本語コメントが
  // ANSI として解釈されて構文エラーになった（spooler.restart が実行不能）。
  // 端末エージェントは powershell.exe（5.1）を呼ぶため、全スクリプトで BOM を必須にする。
  it('スクリプトは UTF-8 BOM 付きで保存されている（PowerShell 5.1 の文字化け防止）', () => {
    for (const skill of SKILL_CATALOG) {
      const buf = readFileSync(path.join(REPO_ROOT, skill.scriptPath));
      expect([...buf.subarray(0, 3)], `${skill.id} は BOM なし`).toEqual([0xef, 0xbb, 0xbf]);
    }
  });

  it('BitLocker は回復キーを取得・出力しない', () => {
    const text = readSkillScript(skillById('bitlocker.status'));
    expect(text).not.toMatch(/Get-BitLockerKeyProtector|protectors\s+-get/i);
    expect(text).not.toMatch(/RecoveryPassword/i);
  });

  it('昇格が必要な Skill は管理者権限を明示的に確認する', () => {
    for (const id of [
      'spooler.restart',
      'spooler.queue.purge',
      'service.start',
      'service.restart',
      'network.adapter.restart',
      'defender.update',
      'bitlocker.status',
      'defender.quickscan',
    ]) {
      const text = readSkillScript(skillById(id));
      expect(text, id).toContain('Test-IsElevated');
      expect(text, id).toMatch(/exit 3/);
    }
  });

  it('recyclebin.clear は自分のごみ箱だけを対象にし、実行前後で件数を測る', () => {
    const text = readSkillScript(skillById('recyclebin.clear'));
    // 他ユーザーのごみ箱や任意ドライブを引数で指定させない（固定コマンド）。
    expect(text).toContain('Clear-RecycleBin -Force');
    expect(text).not.toMatch(/-DriveLetter/);
    expect(text).toContain('itemsBefore');
    expect(text).toContain('itemsAfter');
    expect(text).not.toContain('Test-IsElevated');
  });
});

describe('validateParams', () => {
  const noParams = skillById('os.info').paramsSchema;
  const serviceStatusParams = skillById('service.status').paramsSchema;
  const serviceStartParams = skillById('service.start').paramsSchema;
  const tempCleanupParams = skillById('temp.cleanup').paramsSchema;
  const purgeParams = skillById('spooler.queue.purge').paramsSchema;

  it('パラメータ無し Skill は空オブジェクトだけ許可する', () => {
    expect(validateParams(noParams, {})).toEqual({ ok: true });
    expect(validateParams(noParams, { extra: 'x' }).ok).toBe(false);
    expect(validateParams(noParams, null).ok).toBe(false);
  });

  it('service.status は enum 内の値だけ許可する', () => {
    expect(validateParams(serviceStatusParams, { service: 'Spooler' })).toEqual({ ok: true });
    expect(validateParams(serviceStatusParams, { service: 'W32Time' })).toEqual({ ok: true });
    expect(validateParams(serviceStatusParams, { service: 'Notepad' }).ok).toBe(false);
    expect(validateParams(serviceStatusParams, {}).ok).toBe(false);
    expect(validateParams(serviceStatusParams, { service: 1 }).ok).toBe(false);
    expect(validateParams(serviceStatusParams, { service: 'Spooler', command: 'rm -rf' }).ok).toBe(
      false,
    );
    expect(validateParams(serviceStatusParams, ['Spooler']).ok).toBe(false);
  });

  it('service.start は name を Spooler / W32Time に限定する', () => {
    expect(validateParams(serviceStartParams, { name: 'Spooler' })).toEqual({ ok: true });
    expect(validateParams(serviceStartParams, { name: 'W32Time' })).toEqual({ ok: true });
    expect(validateParams(serviceStartParams, { name: 'Winmgmt' }).ok).toBe(false);
    expect(validateParams(serviceStartParams, { name: 'spooler' }).ok).toBe(false);
    expect(validateParams(serviceStartParams, { service: 'Spooler' }).ok).toBe(false);
    expect(validateParams(serviceStartParams, {}).ok).toBe(false);
  });

  it('service.restart も name を Spooler / W32Time に限定する', () => {
    const restartParams = skillById('service.restart').paramsSchema;
    expect(validateParams(restartParams, { name: 'Spooler' })).toEqual({ ok: true });
    expect(validateParams(restartParams, { name: 'W32Time' })).toEqual({ ok: true });
    expect(validateParams(restartParams, { name: 'Winmgmt' }).ok).toBe(false);
    expect(validateParams(restartParams, { name: 'Spooler; Restart-Computer' }).ok).toBe(false);
    expect(validateParams(restartParams, { service: 'Spooler' }).ok).toBe(false);
    expect(validateParams(restartParams, {}).ok).toBe(false);
  });

  it('temp.cleanup は olderThanDays の型と範囲（1..30）を強制する', () => {
    expect(validateParams(tempCleanupParams, { olderThanDays: 1 })).toEqual({ ok: true });
    expect(validateParams(tempCleanupParams, { olderThanDays: 30 })).toEqual({ ok: true });
    expect(validateParams(tempCleanupParams, { olderThanDays: 0 }).ok).toBe(false);
    expect(validateParams(tempCleanupParams, { olderThanDays: 31 }).ok).toBe(false);
    expect(validateParams(tempCleanupParams, { olderThanDays: -1 }).ok).toBe(false);
    expect(validateParams(tempCleanupParams, { olderThanDays: 7.5 }).ok).toBe(false);
    expect(validateParams(tempCleanupParams, { olderThanDays: '7' }).ok).toBe(false);
    expect(validateParams(tempCleanupParams, {}).ok).toBe(false);
    expect(validateParams(tempCleanupParams, { olderThanDays: 7, force: true }).ok).toBe(false);
  });

  it('spooler.queue.purge は confirm:"PURGE" を必須にする（二重確認）', () => {
    expect(validateParams(purgeParams, { confirm: 'PURGE' })).toEqual({ ok: true });
    expect(validateParams(purgeParams, {}).ok).toBe(false);
    expect(validateParams(purgeParams, { confirm: 'purge' }).ok).toBe(false);
    expect(validateParams(purgeParams, { confirm: 'YES' }).ok).toBe(false);
    expect(validateParams(purgeParams, { confirm: 'PURGE', force: true }).ok).toBe(false);
  });

  it('minimum / maximum を数値・整数の両方で強制する', () => {
    const numberSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { ratio: { type: 'number', minimum: 0.5, maximum: 1.5 } },
    };
    expect(validateParams(numberSchema, { ratio: 0.5 })).toEqual({ ok: true });
    expect(validateParams(numberSchema, { ratio: 1.5 })).toEqual({ ok: true });
    expect(validateParams(numberSchema, { ratio: 0.4 }).ok).toBe(false);
    expect(validateParams(numberSchema, { ratio: 1.6 }).ok).toBe(false);
  });

  it('network.adapter.restart の interfaceAlias は長さと形式（先頭 "-" 不可）で検証する', () => {
    const aliasParams = skillById('network.adapter.restart').paramsSchema;
    // 日本語のアダプタ名（イーサネット / Wi-Fi）を許可する。
    expect(validateParams(aliasParams, { interfaceAlias: 'Ethernet' })).toEqual({ ok: true });
    expect(validateParams(aliasParams, { interfaceAlias: 'イーサネット' })).toEqual({ ok: true });
    expect(validateParams(aliasParams, { interfaceAlias: 'Wi-Fi' })).toEqual({ ok: true });
    expect(validateParams(aliasParams, { interfaceAlias: 'Ethernet 2' })).toEqual({ ok: true });
    // 空・長すぎる・先頭 "-"・型違い・未知キーは拒否する。
    expect(validateParams(aliasParams, { interfaceAlias: '' }).ok).toBe(false);
    expect(validateParams(aliasParams, { interfaceAlias: 'A'.repeat(65) }).ok).toBe(false);
    expect(validateParams(aliasParams, { interfaceAlias: '-Ethernet' }).ok).toBe(false);
    expect(validateParams(aliasParams, { interfaceAlias: 1 }).ok).toBe(false);
    expect(validateParams(aliasParams, {}).ok).toBe(false);
    expect(validateParams(aliasParams, { interfaceAlias: 'Ethernet', command: 'x' }).ok).toBe(
      false,
    );
  });

  it('minLength / maxLength / pattern を文字列にも強制する（不正な pattern は拒否）', () => {
    const lengthSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string', minLength: 2, maxLength: 4 } },
    };
    expect(validateParams(lengthSchema, { name: 'abc' })).toEqual({ ok: true });
    expect(validateParams(lengthSchema, { name: 'a' }).ok).toBe(false);
    expect(validateParams(lengthSchema, { name: 'abcde' }).ok).toBe(false);

    // コンパイルできない pattern は「検証不能」として拒否する（fail-closed）。
    const brokenPatternSchema = {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string', pattern: '[' } },
    };
    expect(validateParams(brokenPatternSchema, { name: 'abc' }).ok).toBe(false);
  });

  it('全 Skill が未知パラメータ（コマンド文字列など）を拒否する', () => {
    for (const skill of SKILL_CATALOG) {
      expect(validateParams(skill.paramsSchema, { command: 'powershell -c calc' }).ok).toBe(false);
    }
  });

  it('Skill 定義のハッシュは引数・リスク・スキーマの変更で変わる', () => {
    const base = SKILL_CATALOG[0];
    const hash = `sha256:${'a'.repeat(64)}`;
    const initial = computeSkillDefinitionHash(base, hash);
    expect(computeSkillDefinitionHash({ ...base }, hash)).toBe(initial);
    expect(computeSkillDefinitionHash({ ...base, args: ['-Changed'] }, hash)).not.toBe(initial);
    expect(computeSkillDefinitionHash({ ...base, riskLevel: 3 }, hash)).not.toBe(initial);
    expect(
      computeSkillDefinitionHash(
        { ...base, paramsSchema: { type: 'object', properties: { x: { type: 'string' } } } },
        hash,
      ),
    ).not.toBe(initial);
    expect(
      computeSkillDefinitionHash(
        { ...base, rollback: { reversible: true, description: 'x', script: null, args: [] } },
        hash,
      ),
    ).not.toBe(initial);
  });
});

describe('承認 manifest', () => {
  it('manifest の全エントリがカタログ定義とハッシュ一致する（改ざん・陳腐化を検出）', () => {
    const manifest = readApprovalManifest(REPO_ROOT);
    expect(APPROVAL_MANIFEST_PATH).toBe('scripts/skills/approved.json');
    // 支援セッションの Skill も同じ manifest で承認する。検証専用は本番の manifest に入れない。
    const byKey = new Map(
      [...SKILL_CATALOG, ...approvalCatalog({ includeVerification: false })].map((skill) => [
        `${skill.id}@${skill.version}`,
        skill,
      ]),
    );
    for (const entry of manifest.skills) {
      const skill = byKey.get(`${entry.id}@${entry.version}`);
      expect(skill, `カタログに無い承認: ${entry.id}@${entry.version}`).toBeTruthy();
      if (!skill) continue;
      const scriptHash = computeScriptHash(readFileSync(path.join(REPO_ROOT, skill.scriptPath)));
      expect(entry.scriptHash, entry.id).toBe(scriptHash);
      expect(entry.contentHash, entry.id).toBe(computeSkillDefinitionHash(skill, scriptHash));
    }
  });

  it('Phase B の 5 件は人間承認済みのまま（承認を失っていない）', () => {
    const manifest = readApprovalManifest(REPO_ROOT);
    for (const id of PHASE_B_READ_ONLY) {
      expect(
        manifest.skills.some((entry) => entry.id === id),
        id,
      ).toBe(true);
    }
  });
});
