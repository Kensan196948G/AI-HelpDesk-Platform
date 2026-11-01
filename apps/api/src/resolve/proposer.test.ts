import { describe, expect, it } from 'vitest';
import { acceptAiExplanation, symptomStatusOf } from '../support-session/case-facts.js';
import {
  buildSkillCatalogForAi,
  escalationReasonForDecision,
  fallbackPropose,
  isDuplicateProposal,
  type ProposalContext,
  type ProposalHistoryEntry,
  proposalFromAiBody,
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

describe('AI 提案の正規化と終了宣言（decision）', () => {
  const base = { skills: skillRecords(), history: [] as ProposalHistoryEntry[] };

  it('decision=escalate は skillId が空でも終了宣言として採用し、理由は ai_escalated', () => {
    const proposal = proposalFromAiBody(
      { skillId: '', params: {}, rationale: '人手が必要です', decision: 'escalate' },
      base,
    );
    expect(proposal).toMatchObject({
      skillId: '',
      params: {},
      source: 'ai',
      decision: 'escalate',
    });
    expect(escalationReasonForDecision(proposal?.decision)).toBe('ai_escalated');
  });

  it('decision=stop は skillId が有効でも終了宣言を優先し、理由は ai_stop', () => {
    const proposal = proposalFromAiBody({ skillId: 'spooler.status', decision: 'stop' }, base);
    expect(proposal?.decision).toBe('stop');
    expect(proposal?.skillId).toBe('');
    expect(escalationReasonForDecision(proposal?.decision)).toBe('ai_stop');
  });

  it('skillId が未知でも decision は採用する（終了宣言は Skill に依存しない）', () => {
    const proposal = proposalFromAiBody({ skillId: 'not-in-catalog', decision: 'escalate' }, base);
    expect(proposal?.decision).toBe('escalate');
  });

  it('未知の decision 値は無視し、従来どおり skillId を検証する', () => {
    const proposal = proposalFromAiBody(
      { skillId: 'spooler.status', params: {}, decision: 'resolve' },
      base,
    );
    expect(proposal?.skillId).toBe('spooler.status');
    expect(proposal).not.toHaveProperty('decision');
  });

  it('decision の無い提案に decision キーを生やさない（既存挙動の後方互換）', () => {
    const proposal = proposalFromAiBody({ skillId: 'os.info', params: {} }, base);
    expect(proposal).not.toBeNull();
    // undefined のプロパティを足すと既存テスト（キー集合の検証）が壊れるため作らない。
    expect(Object.keys(proposal ?? {}).sort()).toEqual([
      'params',
      'rationale',
      'skillId',
      'source',
    ]);
  });

  it('skillId がカタログに無い / params が不正 / 重複提案は null（従来どおり fallback へ）', () => {
    expect(proposalFromAiBody({ skillId: 'not-in-catalog' }, base)).toBeNull();
    expect(proposalFromAiBody({ skillId: 'spooler.queue.purge', params: {} }, base)).toBeNull();
    expect(
      proposalFromAiBody(
        { skillId: 'os.info', params: {} },
        { skills: base.skills, history: [{ skillId: 'os.info', params: {} }] },
      ),
    ).toBeNull();
  });

  it('壊れた応答（null / 文字列 / 配列）は null', () => {
    for (const raw of [null, undefined, 'text', 42, [], [{}]]) {
      expect(proposalFromAiBody(raw, base)).toBeNull();
    }
  });

  it('fallback の提案は decision を返さない（従来どおり提案を続ける）', () => {
    const proposal = fallbackPropose(context({ text: '印刷できません。' }));
    expect(proposal).not.toBeNull();
    expect(proposal).not.toHaveProperty('decision');
  });

  it('escalationReasonForDecision は未指定で null', () => {
    expect(escalationReasonForDecision(undefined)).toBeNull();
  });
});

describe('buildSkillCatalogForAi', () => {
  const base = {
    version: '1.0.0',
    summary: '',
    symptoms: [],
    os: ['windows'],
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    scriptPath: 'scripts/skills/windows/x.ps1',
    args: [],
    verify: null,
    timeoutSec: 60,
    resultSchema: {},
    outputPolicy: {},
  };
  it('risk>=2 かつ rollback ありは repair、読み取りは diagnose', () => {
    const catalog = buildSkillCatalogForAi([
      {
        ...base,
        id: 'service.restart',
        title: 'restart',
        riskLevel: 2,
        rollback: { description: '戻せる' },
        requires: { elevation: true },
      },
      {
        ...base,
        id: 'bitlocker.status',
        title: 'status',
        riskLevel: 1,
        rollback: { description: '取消不要' },
        requires: { elevation: true },
      },
      { ...base, id: 'os.info', title: 'info', riskLevel: 1, rollback: null, requires: {} },
    ] as never);
    expect(catalog.map((s) => [s.id, s.kind])).toEqual([
      ['service.restart', 'repair'],
      ['bitlocker.status', 'diagnose'],
      ['os.info', 'diagnose'],
    ]);
    expect(catalog[0].requiresElevation).toBe(true);
    expect(catalog[2].requiresElevation).toBe(false);
  });
});

describe('AI の説明の断定を採用しない（#120 の判定。docs/67）', () => {
  it('解決を断定する説明は固定の文へ置き換える', async () => {
    const accepted = acceptAiExplanation('スプーラを再起動して解決しました', null, false);
    expect(accepted.rejected).toBe(true);
    expect(acceptAiExplanation('スプーラの状態を確認します', null, false).rejected).toBe(false);
  });

  it('否定、解消、過去形は retracted、言い方が辞書に無いものは unknown', () => {
    expect(symptomStatusOf('印刷エラーはありません')).toBe('retracted');
    expect(symptomStatusOf('印刷できませんでしたが、もう直りました')).toBe('retracted');
    expect(symptomStatusOf('昨日は印刷できませんでした。今は問題ありません')).toBe('retracted');
    expect(symptomStatusOf('印刷できない')).toBe('active');
    expect(symptomStatusOf('印刷できず、VPNもつながりません')).toBe('active');
    expect(symptomStatusOf('紙が出ません')).toBe('unknown');
  });
});
