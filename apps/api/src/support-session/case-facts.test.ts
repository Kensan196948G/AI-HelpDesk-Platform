import { describe, expect, it } from 'vitest';
import {
  acceptAiExplanation,
  buildCaseFacts,
  CASE_CATEGORIES,
  CASE_PURPOSES,
  confirmedFacts,
  knowledgeRefs,
  SYMPTOM_TAGS,
} from './case-facts.js';

const snapshot = (subject: string, messages: unknown[] = [], extra = {}) => ({
  case: { subject },
  chat: { messages },
  ...extra,
});

describe('案件の固定の語彙への写像', () => {
  it.each([
    ['ディスクの容量が足りません', 'storage', ['storage_full']],
    ['保存できません', 'storage', ['save_failed']],
    ['共有のフォルダが見つかりません', 'storage', ['folder_missing']],
    ['ファイルが消えました', 'storage', ['file_missing']],
    ['プリンタで印刷できない', 'printing', ['print_failed']],
    ['VPN につながらない', 'network', ['vpn_failed', 'network_down']],
    ['パスワードを忘れてログインできない', 'account', ['password_reset', 'login_failed']],
    ['アプリが起動しない', 'software', ['app_crash']],
    ['PC が重い', 'performance', ['slow']],
    ['こんにちは', 'other', []],
  ])('%s', (subject, category, tags) => {
    const facts = buildCaseFacts(snapshot(subject));
    expect(facts.caseCategory).toBe(category);
    expect(facts.symptomTags).toEqual(tags);
  });

  it('出力は固定の語彙だけで、入力の文字列が混ざらない', () => {
    const canary = 'CANARY-山田太郎 C:\\Users\\yamada\\給与.xlsx 192.0.2.1 容量';
    const facts = buildCaseFacts(snapshot(canary, [{ role: 'user', text: canary }]));
    expect(JSON.stringify(facts)).not.toMatch(/CANARY|山田|Users|192\.0/);
    expect(CASE_CATEGORIES).toContain(facts.caseCategory);
    expect(CASE_PURPOSES).toContain(facts.purpose);
    for (const tag of facts.symptomTags) expect(SYMPTOM_TAGS).toContain(tag);
  });

  it('AI や担当者の発言、下書き、ナレッジ、提案を症状として数えない', () => {
    const facts = buildCaseFacts(
      snapshot(
        'こんにちは',
        [
          { role: 'ai', text: 'プリンタの確認をします' },
          { role: 'sys', text: '容量' },
          { role: 'staff', text: 'VPN' },
        ],
        {
          draft: { subject: '印刷' },
          kb: { title: '容量' },
          proposals: [{ text: 'VPN' }],
          ticket: { summary: '印刷' },
          inc: { subject: '容量' },
        },
      ),
    );
    expect(facts.symptomTags).toEqual([]);
    expect(facts.caseCategory).toBe('other');
  });

  it('本人の発言は数える。壊れたスナップショットでも失敗しない', () => {
    expect(
      buildCaseFacts(snapshot('x', [{ role: 'user', text: '容量' }, null, 3])).symptomTags,
    ).toEqual(['storage_full']);
    expect(buildCaseFacts(null).caseCategory).toBe('other');
    expect(buildCaseFacts('garbage').symptomTags).toEqual([]);
  });

  it('確認済み事項は固定条件を満たした実行だけから作る', () => {
    expect(
      confirmedFacts([
        { skillId: 'folder.summary', verified: true, output: { fileCount: 2 } },
        { skillId: 'disk.space', verified: false, output: {} },
        { skillId: 'user.marker.set', verified: null, output: {} },
      ]),
    ).toEqual(['FOLDER_ACCESSIBLE', 'FOLDER_HAS_ENTRIES']);
  });

  it('ナレッジは案件の症状に合う ID と固定タグだけ', () => {
    expect(
      knowledgeRefs(
        [
          { id: 'a', keywords: ['容量', '秘密の語'] },
          { id: 'b', keywords: ['印刷'] },
          { id: 'c', keywords: null },
        ],
        ['storage_full'],
      ),
    ).toEqual([{ id: 'a', tags: ['storage_full'] }]);
  });
});

describe('AI の説明の採用', () => {
  it('確かめていないのに解決を示す説明は使わない', () => {
    expect(acceptAiExplanation('解決しました', 'unknown', false)).toEqual({
      text: null,
      rejected: true,
    });
    expect(acceptAiExplanation('確認します', 'resolved', false)).toEqual({
      text: null,
      rejected: true,
    });
  });

  it('確かめた後の説明と、解決を示さない説明は推測として残す', () => {
    expect(acceptAiExplanation('解決した可能性', 'resolved', true).text).toBe('解決した可能性');
    expect(acceptAiExplanation('確認します', 'unknown', false).text).toBe('確認します');
    expect(acceptAiExplanation('', 'unknown', false).text).toBeNull();
  });
});
