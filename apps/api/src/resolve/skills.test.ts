import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_MANIFEST_PATH,
  computeScriptHash,
  computeSkillDefinitionHash,
  readApprovalManifest,
  SKILL_CATALOG,
  validateParams,
} from './skills.js';

describe('Skill カタログ定義', () => {
  it('Phase B の 5 Skill がすべて読み取り専用・Windows・リスク 1 で定義されている', () => {
    expect(SKILL_CATALOG.map((skill) => skill.id).sort()).toEqual(
      ['disk.space', 'network.adapters', 'os.info', 'service.status', 'spooler.status'].sort(),
    );
    for (const skill of SKILL_CATALOG) {
      expect(skill.riskLevel).toBe(1);
      expect(skill.os).toEqual(['windows']);
      expect(skill.scriptPath.startsWith('scripts/skills/windows/')).toBe(true);
      expect(skill.scriptPath.endsWith('.ps1')).toBe(true);
      expect(Array.isArray(skill.args)).toBe(true);
      expect(skill.requires).toMatchObject({
        userConfirm: true,
        adminApproval: false,
        elevation: false,
      });
    }
  });

  it('service.status だけが許可済み enum のパラメータを持つ', () => {
    const service = SKILL_CATALOG.find((skill) => skill.id === 'service.status');
    expect(service?.paramsSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['service'],
      properties: { service: { type: 'string', enum: ['Spooler', 'W32Time', 'Winmgmt'] } },
    });
    for (const skill of SKILL_CATALOG.filter((item) => item.id !== 'service.status')) {
      expect(skill.args).toEqual([]);
    }
  });

  it('スクリプト内容の SHA-256 を sha256: 形式で返す', () => {
    expect(computeScriptHash('hello')).toBe(
      'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

describe('validateParams', () => {
  const noParams = SKILL_CATALOG.find((skill) => skill.id === 'os.info')?.paramsSchema;
  const serviceParams = SKILL_CATALOG.find((skill) => skill.id === 'service.status')?.paramsSchema;

  it('パラメータ無し Skill は空オブジェクトだけ許可する', () => {
    expect(validateParams(noParams, {})).toEqual({ ok: true });
    expect(validateParams(noParams, { extra: 'x' }).ok).toBe(false);
    expect(validateParams(noParams, null).ok).toBe(false);
  });

  it('service.status は enum 内の値だけ許可する', () => {
    expect(validateParams(serviceParams, { service: 'Spooler' })).toEqual({ ok: true });
    expect(validateParams(serviceParams, { service: 'W32Time' })).toEqual({ ok: true });
    expect(validateParams(serviceParams, { service: 'Notepad' }).ok).toBe(false);
    expect(validateParams(serviceParams, {}).ok).toBe(false);
    expect(validateParams(serviceParams, { service: 1 }).ok).toBe(false);
    expect(validateParams(serviceParams, { service: 'Spooler', command: 'rm -rf' }).ok).toBe(false);
    expect(validateParams(serviceParams, ['Spooler']).ok).toBe(false);
  });

  it('Skill 定義のハッシュは引数・リスク・スキーマの変更で変わる', () => {
    const base = SKILL_CATALOG[0];
    const hash = 'sha256:' + 'a'.repeat(64);
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
  });

  it('承認 manifest が全 Skill のスクリプトと定義に一致する', () => {
    const manifest = readApprovalManifest(process.cwd());
    expect(manifest.skills.length).toBe(SKILL_CATALOG.length);
    for (const skill of SKILL_CATALOG) {
      const entry = manifest.skills.find(
        (item) => item.id === skill.id && item.version === skill.version,
      );
      expect(entry, `${skill.id}@${skill.version}`).toBeTruthy();
      const script = readFileSync(path.join(process.cwd(), skill.scriptPath));
      const scriptHash = computeScriptHash(script);
      expect(entry?.scriptHash).toBe(scriptHash);
      expect(entry?.contentHash).toBe(computeSkillDefinitionHash(skill, scriptHash));
    }
    expect(APPROVAL_MANIFEST_PATH).toBe('scripts/skills/approved.json');
  });
});
