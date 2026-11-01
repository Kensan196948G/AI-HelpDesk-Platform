import { describe, expect, it } from 'vitest';
import {
  acceptAiExplanation,
  buildCaseFacts,
  CASE_CATEGORIES,
  CASE_PURPOSES,
  confirmedFacts,
  knowledgeRefs,
  knowledgeTagsFromText,
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
    const facts = buildCaseFacts(snapshot(canary, [{ kind: 'user', text: canary }]));
    expect(JSON.stringify(facts)).not.toMatch(/CANARY|山田|Users|192\.0/);
    expect(CASE_CATEGORIES).toContain(facts.caseCategory);
    expect(CASE_PURPOSES).toContain(facts.purpose);
    for (const tag of facts.symptomTags) expect(SYMPTOM_TAGS).toContain(tag);
  });

  it('本人の発言（kind が user）だけを数える。AI・担当者・案内・下書きなどは数えない', () => {
    const facts = buildCaseFacts(
      snapshot(
        'こんにちは',
        [
          { kind: 'ai', text: 'プリンタで印刷できません' },
          { kind: 'kb', text: '容量が不足' },
          { kind: 'steps', text: 'VPN につながらない' },
          { kind: 'ticket', text: '保存できない' },
          { text: 'kind のない行は数えない 容量が不足' },
          { role: 'user', text: 'role だけの行も数えない 容量が不足' },
        ],
        {
          draft: { subject: 'プリンタで印刷できません' },
          kb: { title: '容量が不足' },
          proposals: [{ text: 'VPN につながらない' }],
          ticket: { summary: 'プリンタで印刷できません' },
          inc: { subject: '容量が不足' },
        },
      ),
    );
    expect(facts.symptomTags).toEqual([]);
    expect(facts.caseCategory).toBe('other');
  });

  it('本人の発言は数える。壊れたスナップショットでも失敗しない', () => {
    expect(
      buildCaseFacts(snapshot('x', [{ kind: 'user', text: '容量が不足' }, null, 3])).symptomTags,
    ).toEqual(['storage_full']);
    expect(buildCaseFacts(null).caseCategory).toBe('other');
    expect(buildCaseFacts('garbage').symptomTags).toEqual([]);
  });

  it.each([
    'フォルダが見つかりました',
    'ファイルが見つかりました',
    'フォルダは問題ないです',
    '容量は十分あります',
    '空きはあります',
    '保存できました',
    '印刷できました',
    'プリンタは正常です',
    'VPN につながりました',
    'ネットワークは問題ありません',
    'ログインできました',
    'パスワードを変更しました',
    'アプリは正常に起動しました',
    'PC は重くないです',
  ])('肯定文を症状にしない: %s', (text) => {
    expect(buildCaseFacts(snapshot(text)).symptomTags).toEqual([]);
  });

  it.each([
    ['フォルダが見つからない', 'folder_missing'],
    ['フォルダが見つかりません', 'folder_missing'],
    ['フォルダが見当たりません', 'folder_missing'],
    ['ファイルが消えました', 'file_missing'],
    ['容量が足りません', 'storage_full'],
    ['空きがありません', 'storage_full'],
    ['ディスクがいっぱいです', 'storage_full'],
    ['保存できません', 'save_failed'],
    ['保存に失敗します', 'save_failed'],
    ['印刷できません', 'print_failed'],
    ['プリンタが応答しません', 'print_failed'],
    ['ネットワークにつながりません', 'network_down'],
    ['VPN に接続できません', 'vpn_failed'],
    ['ログインできません', 'login_failed'],
    ['パスワードを忘れました', 'password_reset'],
    ['アプリが起動しません', 'app_crash'],
    ['PC が遅いです', 'slow'],
  ])('否定形を症状にする: %s', (text, tag) => {
    expect(buildCaseFacts(snapshot(text)).symptomTags).toContain(tag);
  });

  describe('否定・解消済み・過去形・複数症状（docs/63 §12）', () => {
    const tags = (subject: string, messages: string[] = []) =>
      buildCaseFacts(
        snapshot(
          subject,
          messages.map((text) => ({ kind: 'user', text })),
        ),
      ).symptomTags;

    it.each([
      '印刷できる',
      '印刷エラーはありません',
      '印刷に失敗していません',
      '印刷できないわけではない',
      'フォルダは消えていません',
      'ファイルは消えていない',
      'VPN は切れていません',
      '容量不足ではありません',
      'ネットワークのエラーは出ていません',
      'PC が重いわけではありません',
    ])('否定を症状にしない: %s', (text) => {
      expect(tags(text)).toEqual([]);
    });

    it('節をまたいで症状を作らない', () => {
      expect(tags('印刷はできるが、保存できない')).toEqual(['save_failed']);
      expect(tags('プリンタは正常ですが VPN につながらない')).toEqual([
        'vpn_failed',
        'network_down',
      ]);
    });

    it.each([
      '印刷できませんでしたが、直りました',
      '印刷できない件は解決しました',
      'VPN につながらなかったが今はつながる',
      'ファイルが消えましたが、見つかりました',
      '保存できませんでしたが、再起動したら保存できました',
      'プリンタで印刷できません。プリンタは直りました',
    ])('解消済みを症状にしない: %s', (text) => {
      expect(tags(text)).toEqual([]);
    });

    it('本人の後の発言で解消した症状を残さない', () => {
      expect(tags('プリンタで印刷できない', ['直りました'])).toEqual([]);
      expect(tags('VPN につながらない', ['もう大丈夫です'])).toEqual([]);
    });

    it('解消の後にまた起きたら症状にする', () => {
      expect(tags('印刷できません', ['直りました', 'また印刷できません'])).toEqual([
        'print_failed',
      ]);
    });

    it('どれが直ったか語からも節からも分からないときは推測で消さない', () => {
      expect(tags('印刷できません。VPN につながりません。直りました')).toEqual([
        'print_failed',
        'vpn_failed',
        'network_down',
      ]);
    });

    it('まだ直っていない表現を解消にしない', () => {
      expect(tags('印刷できません。まだ解決していません')).toEqual(['print_failed']);
      expect(tags('印刷できません。直りましたか')).toEqual(['print_failed']);
    });

    it.each([
      '昨日はファイルが開けなかったが今は開ける',
      '昨日は印刷できませんでした',
      '先週は VPN につながらなかった',
      '以前は保存できませんでした',
    ])('過去の時点の話を今の症状にしない: %s', (text) => {
      expect(tags(text)).toEqual([]);
    });

    it.each([
      ['昨日から印刷できません', 'print_failed'],
      ['昨日は印刷できませんでしたが今も印刷できません', 'print_failed'],
      ['さっき試したら印刷できませんでした', 'print_failed'],
      ['ファイルが開けなかった', 'file_missing'],
      ['プリンタが動かない', 'print_failed'],
      ['パスワードがわからない', 'password_reset'],
      ['アプリが固まる', 'app_crash'],
    ])('続いている症状は残す: %s', (text, tag) => {
      expect(tags(text)).toContain(tag);
    });

    it('複数の症状を全部残し、直ったものだけ除く', () => {
      expect(tags('印刷できません。ログインもできません。PC が重い')).toEqual([
        'print_failed',
        'login_failed',
        'slow',
      ]);
      expect(tags('印刷は直りましたが、VPN につながらない')).toEqual([
        'vpn_failed',
        'network_down',
      ]);
      expect(tags('VPN につながりません。印刷できません。印刷は直りました')).toEqual([
        'vpn_failed',
        'network_down',
      ]);
    });

    it('同じ節で起きた症状は一緒に解消する', () => {
      expect(tags('VPN につながりません。VPN は直りました')).toEqual([]);
    });

    it('分類は残った症状から決める', () => {
      expect(buildCaseFacts(snapshot('印刷は直りましたが、VPN につながらない')).caseCategory).toBe(
        'network',
      );
      expect(buildCaseFacts(snapshot('印刷できませんでしたが、直りました')).caseCategory).toBe(
        'other',
      );
    });

    it.each([
      ['問題ないです', 'unknown'],
      ['印刷できませんでしたが、直りました', 'unknown'],
      ['印刷できません', 'repair'],
      ['容量の確認方法は', 'information'],
      ['直してほしい', 'repair'],
    ])('目的は残った内容から決める: %s', (text, purpose) => {
      expect(buildCaseFacts(snapshot(text)).purpose).toBe(purpose);
    });
  });

  it('確認済み事項は固定条件を満たした実行だけから作る', () => {
    expect(
      confirmedFacts([
        { skillId: 'folder.summary', verified: true, output: { fileCount: 2 } },
        { skillId: 'disk.space', verified: false, output: {} },
        { skillId: 'user.marker.set', verified: null, output: {} },
      ]),
    ).toEqual(['FOLDER_ACCESSIBLE', 'FOLDER_HAS_ENTRIES']);
    for (const output of [{ directoryCount: 1 }, { linkCount: 1 }, { fileCount: 1 }]) {
      expect(confirmedFacts([{ skillId: 'folder.summary', verified: true, output }])).toContain(
        'FOLDER_HAS_ENTRIES',
      );
    }
    expect(
      confirmedFacts([
        {
          skillId: 'folder.summary',
          verified: true,
          output: { fileCount: 0, directoryCount: 0, linkCount: 0 },
        },
      ]),
    ).toEqual(['FOLDER_ACCESSIBLE']);
  });

  it('保存したタグを使い、固定の語彙の外は捨てる', () => {
    expect(
      knowledgeRefs(
        [
          { id: 'a', keywords: [], symptomTags: ['print_failed', 'CANARY'] },
          { id: 'b', keywords: [], symptomTags: ['vpn_failed'] },
          { id: 'c', keywords: [], symptomTags: [] },
        ],
        ['print_failed'],
      ),
    ).toEqual([{ id: 'a', tags: ['print_failed'] }]);
  });

  it('ナレッジの本文からは、解決の記述があっても症状のタグを求める。打ち消しは除く', () => {
    expect(
      knowledgeTagsFromText('印刷できないときの対処', '印刷できません。再起動で直りました'),
    ).toEqual(['print_failed']);
    expect(knowledgeTagsFromText('印刷エラーはありません')).toEqual([]);
    expect(knowledgeTagsFromText('CANARY-山田太郎')).toEqual([]);
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

  it.each([
    '解決しました',
    '問題は解決済みです',
    '直りました',
    '修復しました',
    '復旧しました',
    '解消しました',
    'これで解決します',
    '成功しました',
    'The issue is resolved',
  ])('読み取りや目印の成功の後でも、断定的な解決の表現は使わない: %s', (text) => {
    expect(acceptAiExplanation(text, 'unknown', true)).toEqual({ text: null, rejected: true });
  });

  it('確かめた後の説明と、解決を示さない説明は推測として残す', () => {
    expect(acceptAiExplanation('解決した可能性', 'resolved', true).text).toBe('解決した可能性');
    expect(acceptAiExplanation('確認します', 'unknown', false).text).toBe('確認します');
    expect(acceptAiExplanation('', 'unknown', false).text).toBeNull();
  });
});
