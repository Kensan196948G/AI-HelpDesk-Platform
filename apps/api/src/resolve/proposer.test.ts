import { describe, expect, it } from 'vitest';
import {
  fallbackPropose,
  isDuplicateProposal,
  type ProposalContext,
  type ProposalHistoryEntry,
} from './proposer.js';
import { SKILL_CATALOG, type SkillRecord } from './skills.js';

function skillRecords(ids: string[] = SKILL_CATALOG.map((skill) => skill.id)): SkillRecord[] {
  return SKILL_CATALOG.filter((skill) => ids.includes(skill.id)).map((skill) => ({
    id: skill.id,
    version: skill.version,
    title: skill.title,
    summary: skill.summary,
    symptoms: skill.symptoms,
    os: skill.os,
    riskLevel: skill.riskLevel,
    requires: skill.requires,
    paramsSchema: skill.paramsSchema,
    scriptPath: skill.scriptPath,
    args: skill.args,
    verify: skill.verify,
    rollback: skill.rollback,
    timeoutSec: skill.timeoutSec,
    resultSchema: skill.resultSchema,
    outputPolicy: skill.outputPolicy,
    status: 'approved',
    contentHash: `sha256:${'b'.repeat(64)}`,
    approvedBy: 'test',
    approvedAt: null,
    createdAt: '',
  }));
}

function context(partial: Partial<ProposalContext>): ProposalContext {
  return {
    text: '',
    lastSummary: null,
    history: [],
    skills: skillRecords(),
    ...partial,
  };
}

describe('fallback proposer', () => {
  it('印刷の相談では spooler.status を選ぶ', () => {
    const proposal = fallbackPropose(
      context({ text: 'プリンタで印刷できません。印刷キューに残ります。' }),
    );
    expect(proposal?.skillId).toBe('spooler.status');
    expect(proposal?.params).toEqual({});
  });

  it('容量の相談では disk.space を選ぶ', () => {
    const proposal = fallbackPropose(
      context({ text: 'Cドライブの空き容量が少なく、保存できません。' }),
    );
    expect(proposal?.skillId).toBe('disk.space');
  });

  it('ネットワーク / VPN の相談では network.adapters を選ぶ', () => {
    const proposal = fallbackPropose(
      context({ text: 'VPN に接続できず、ネットワークがつながりません。' }),
    );
    expect(proposal?.skillId).toBe('network.adapters');
  });

  it('許可済みサービス名があるときだけ service.status をパラメータ付きで選ぶ', () => {
    const proposal = fallbackPropose(context({ text: 'W32Time サービスが起動しません。' }));
    expect(proposal?.skillId).toBe('service.status');
    expect(proposal?.params).toEqual({ service: 'W32Time' });

    const noServiceName = fallbackPropose(context({ text: 'サービスが起動しません。' }));
    expect(noServiceName?.skillId).not.toBe('service.status');
  });

  it('該当キーワードが無いときは os.info にフォールバックする', () => {
    const proposal = fallbackPropose(context({ text: '困っています。至急お願いします。' }));
    expect(proposal?.skillId).toBe('os.info');
  });

  it('承認済み Skill に無いものは提案しない', () => {
    const proposal = fallbackPropose(
      context({ text: '印刷できません。', skills: skillRecords(['os.info']) }),
    );
    expect(proposal?.skillId).toBe('os.info');
    const empty = fallbackPropose(context({ text: '印刷できません。', skills: [] }));
    expect(empty).toBeNull();
  });

  it('同一 Skill + 同一 params は再提案しない', () => {
    const history: ProposalHistoryEntry[] = [{ skillId: 'os.info', params: {} }];
    expect(fallbackPropose(context({ text: '困っています。', history }))).toBeNull();
  });

  it('同一 Skill でも params が違えば再提案できる', () => {
    const history: ProposalHistoryEntry[] = [
      { skillId: 'service.status', params: { service: 'Spooler' } },
    ];
    const proposal = fallbackPropose(
      context({ text: 'W32Time サービスが起動しません。', history }),
    );
    expect(proposal?.skillId).toBe('service.status');
    expect(proposal?.params).toEqual({ service: 'W32Time' });
  });

  it('直近結果のキーワードも次提案の材料にする', () => {
    const proposal = fallbackPropose(
      context({ text: '困っています。', lastSummary: 'ディスクの空き容量: 2% (C:)' }),
    );
    expect(proposal?.skillId).toBe('disk.space');
  });

  it('提案にコマンド文字列・スクリプト・引数を含めない', () => {
    const proposal = fallbackPropose(context({ text: '印刷できません。' }));
    expect(proposal).not.toBeNull();
    expect(Object.keys(proposal ?? {}).sort()).toEqual([
      'params',
      'rationale',
      'skillId',
      'source',
    ]);
    expect(JSON.stringify(proposal)).not.toMatch(/powershell|\.ps1|-Command/i);
  });

  it('isDuplicateProposal は params のキー順に依存しない', () => {
    expect(
      isDuplicateProposal({ skillId: 'service.status', params: { service: 'Spooler' } }, [
        { skillId: 'service.status', params: { service: 'Spooler' } },
      ]),
    ).toBe(true);
    expect(
      isDuplicateProposal({ skillId: 'service.status', params: { service: 'Winmgmt' } }, [
        { skillId: 'service.status', params: { service: 'Spooler' } },
      ]),
    ).toBe(false);
  });
});
