import { describe, expect, it } from 'vitest';
import { computeScriptHash, SKILL_CATALOG, validateParams } from './skills.js';

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
});
