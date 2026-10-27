import { describe, expect, it } from 'vitest';
import {
  buildCaseContext,
  buildPcContext,
  type CaseSnapshot,
  extractCaseSnapshot,
  mergeCaseSnapshot,
  normalizeState,
} from './case-handover.js';

function coworkState() {
  return {
    v: 31,
    ui: { user: 'u1', screen: 'home' },
    counters: { case: 1, ticket: 1, prop: 1 },
    cases: [
      {
        id: 'CASE-0001',
        userId: 'u1',
        chatId: 'chat-1',
        subject: '共有フォルダが開けません',
        body: '異動後に開けなくなりました。',
        step: 4,
      },
    ],
    chats: [
      {
        id: 'chat-1',
        userId: 'u1',
        title: '共有フォルダ',
        messages: [{ id: 'm1', kind: 'user', text: '開けません' }],
      },
    ],
    tickets: [
      {
        id: 'TKT-2026-0001',
        chatId: 'chat-1',
        incId: 'INC-1001',
        userId: 'u1',
        status: '受付',
      },
    ],
    proposals: {
      'OP-0001': { id: 'OP-0001', chatId: 'chat-1', opId: 'SPOOLER_RESTART' },
      'OP-9999': { id: 'OP-9999', chatId: 'chat-other', opId: 'SPOOLER_RESTART' },
    },
  };
}

function helpdeskState() {
  return {
    actor: '佐藤 奨太',
    seq: { inc: 1001, draft: 1, kb: 1 },
    tickets: [
      {
        id: 'INC-1001',
        coworkTicket: 'TKT-2026-0001',
        status: 'escalated',
        draftId: 'DR-001',
        kbId: 'KB-001',
      },
    ],
    drafts: [{ id: 'DR-001', ticketId: 'INC-1001', status: 'draft' }],
    kb: [{ id: 'KB-001', title: '共有フォルダ' }],
    audit: [],
  };
}

describe('extractCaseSnapshot', () => {
  it('案件・チャット・TKT/INC・下書き・KB・提案を ID で抽出する', () => {
    const snapshot = extractCaseSnapshot(coworkState(), helpdeskState(), 'CASE-0001');
    expect(snapshot).not.toBeNull();
    expect(snapshot?.case.subject).toBe('共有フォルダが開けません');
    expect(snapshot?.chat?.id).toBe('chat-1');
    expect(snapshot?.ticket?.id).toBe('TKT-2026-0001');
    expect(snapshot?.inc?.id).toBe('INC-1001');
    expect(snapshot?.draft?.id).toBe('DR-001');
    expect(snapshot?.kb?.id).toBe('KB-001');
    expect(snapshot?.proposals.map((proposal) => proposal.id)).toEqual(['OP-0001']);
  });

  it('存在しない案件は null（推測で作らない）', () => {
    expect(extractCaseSnapshot(coworkState(), helpdeskState(), 'CASE-9999')).toBeNull();
  });

  it('文字列の状態も JSON.parse して扱う', () => {
    const parsed = normalizeState(JSON.stringify(coworkState()));
    expect(parsed?.v).toBe(31);
    expect(normalizeState('not-json')).toBeNull();
  });
});

describe('F-04: 保存するスナップショットの PII 伏せ字', () => {
  function piiCoworkState() {
    return {
      v: 31,
      ui: { user: 'u1', screen: 'home' },
      cases: [
        {
          id: 'CASE-0002',
          userId: 'u1',
          chatId: 'chat-2',
          subject: '連絡先 taro.yamada@example.com の件',
          body: '電話は 090-1234-5678、IP は 192.168.10.25、カードは 4111 1111 1111 1111 です。',
          step: 4,
          device: { serial: 'SN-9999', assetNo: 'PC-22222' },
          pc: {
            state: 'done',
            snap: {
              items: [
                { grp: 'ネットワーク', k: 'IPアドレス', v: '192.168.10.26' },
                { grp: '端末', k: 'シリアル', v: 'SN-0001' },
                { grp: '資産', k: '資産番号', v: 'PC-12345' },
                { grp: 'OS', k: 'エディション', v: 'Windows 11 Pro' },
                { grp: '通知', k: '連絡先', v: 'taro.yamada@example.com' },
              ],
            },
          },
        },
      ],
      chats: [
        {
          id: 'chat-2',
          userId: 'u1',
          title: '件名',
          messages: [{ id: 'm1', kind: 'user', text: 'IP は 10.0.0.5、電話は 090-1234-5678 です' }],
        },
      ],
      tickets: [{ id: 'TKT-2026-0002', chatId: 'chat-2', incId: 'INC-1002', userId: 'u1' }],
      proposals: {
        'OP-0002': {
          id: 'OP-0002',
          chatId: 'chat-2',
          note: { contacts: ['support@example.com'], card: '4111 1111 1111 1111' },
        },
      },
    };
  }

  it('ネスト・配列を含む snapshot に平文のメール/電話/IP/カード/資産番号/シリアルを残さない', () => {
    const snapshot = extractCaseSnapshot(piiCoworkState(), null, 'CASE-0002');
    expect(snapshot).not.toBeNull();
    const json = JSON.stringify(snapshot);
    for (const raw of [
      'taro.yamada@example.com',
      'support@example.com',
      '090-1234-5678',
      '192.168.10.25',
      '192.168.10.26',
      '10.0.0.5',
      '4111 1111 1111 1111',
      'SN-0001',
      'SN-9999',
      'PC-12345',
      'PC-22222',
    ]) {
      expect(json).not.toContain(raw);
    }
    expect(json).toContain('[メールアドレス]');
    expect(json).toContain('[電話番号]');
    expect(json).toContain('[IPアドレス]');
    expect(json).toContain('[カード番号]');
    expect(json).toContain('[資産番号]');
    expect(json).toContain('[シリアル番号]');
    // 伏せ字対象でない値は残す。
    expect(json).toContain('Windows 11 Pro');
  });

  it('抽出元の状態オブジェクトを書き換えない', () => {
    const cowork = piiCoworkState();
    extractCaseSnapshot(cowork, null, 'CASE-0002');
    expect(cowork.cases[0].subject).toBe('連絡先 taro.yamada@example.com の件');
    expect(cowork.cases[0].body).toContain('090-1234-5678');
    expect(cowork.chats[0].messages[0].text).toContain('10.0.0.5');
  });

  it('ID など伏せ字対象でない文字列はそのまま残す', () => {
    const snapshot = extractCaseSnapshot(piiCoworkState(), null, 'CASE-0002');
    expect(snapshot?.caseId).toBe('CASE-0002');
    expect(snapshot?.ticket?.id).toBe('TKT-2026-0002');
  });

  it('端末識別子（device / deviceId / agentId / hostname）は伏せ字にしない', () => {
    const cowork = {
      v: 31,
      ui: {},
      cases: [
        {
          id: 'CASE-0005',
          userId: 'u1',
          chatId: 'chat-5',
          subject: '端末がつながらない',
          body: '連絡先は taro.yamada@example.com、電話は 090-1234-5678 です。',
          step: 4,
          device: 'MRK-NB-1000',
          remote: { agentId: 'AGENT-MRK-2000', hostname: 'MRK-NB-1000' },
          pc: {
            state: 'done',
            snap: {
              device: 'MRK-NB-1000',
              items: [
                { grp: '端末', k: 'コンピュータ名', v: 'MRK-NB-1000', lv: 'ok' },
                { grp: '端末', k: 'シリアル番号', v: 'SN123456', lv: 'ok' },
                { grp: 'ネットワーク', k: 'IPアドレス', v: '10.1.2.3', lv: 'ok' },
              ],
            },
          },
        },
      ],
      chats: [{ id: 'chat-5', userId: 'u1', title: '端末', messages: [] }],
      tickets: [],
      proposals: { 'OP-0005': { id: 'OP-0005', chatId: 'chat-5', deviceId: 'MRK-NB-1000' } },
    };
    const snapshot = extractCaseSnapshot(cowork, null, 'CASE-0005');
    expect(snapshot).not.toBeNull();
    const json = JSON.stringify(snapshot);
    // 照合・相関に使う識別子は保持する（'MRK-NB-1000' の NB-1000 を資産番号と誤判定しない）。
    expect(snapshot?.case.device).toBe('MRK-NB-1000');
    expect((snapshot?.case.pc as { snap?: { device?: string } })?.snap?.device).toBe('MRK-NB-1000');
    expect((snapshot?.case.remote as { agentId?: string })?.agentId).toBe('AGENT-MRK-2000');
    expect((snapshot?.case.remote as { hostname?: string })?.hostname).toBe('MRK-NB-1000');
    expect(snapshot?.proposals[0]?.deviceId).toBe('MRK-NB-1000');
    // 端末情報内の表示用の識別子項目（コンピュータ名）も保持する。
    expect(json).toContain('コンピュータ名');
    expect(json.match(/MRK-NB-1000/g)?.length).toBeGreaterThanOrEqual(4);
    // 表示用のシリアル・IP は従来どおり伏せる。
    expect(json).not.toContain('SN123456');
    expect(json).not.toContain('10.1.2.3');
    expect(json).toContain('[シリアル番号]');
    expect(json).toContain('[IPアドレス]');
    // 自由記述のメール・電話は従来どおり伏せる。
    expect(json).not.toContain('taro.yamada@example.com');
    expect(json).not.toContain('090-1234-5678');
    expect(json).toContain('[メールアドレス]');
    expect(json).toContain('[電話番号]');
  });
});

describe('F-05: 引継ぎ通知に使う案件件名', () => {
  it('案件の件名があればそのまま使う', () => {
    const snapshot = extractCaseSnapshot(coworkState(), helpdeskState(), 'CASE-0001');
    expect(snapshot?.case.subject).toBe('共有フォルダが開けません');
  });

  it('件名が空でもチケット概要から補う（STEP4 直後の共有向け）', () => {
    const cowork = {
      v: 31,
      ui: {},
      cases: [{ id: 'CASE-0003', userId: 'u1', chatId: 'chat-3', subject: '', body: '', step: 4 }],
      chats: [{ id: 'chat-3', userId: 'u1', title: '新しい相談', messages: [] }],
      tickets: [
        {
          id: 'TKT-2026-0003',
          chatId: 'chat-3',
          incId: 'INC-1003',
          userId: 'u1',
          summary: '共有フォルダの権限申請で連絡先が通じない',
        },
      ],
      proposals: {},
    };
    const snapshot = extractCaseSnapshot(cowork, null, 'CASE-0003');
    expect(snapshot?.case.subject).toBe('共有フォルダの権限申請で連絡先が通じない');
  });

  it('クライアントが送った件名を最優先する（シグネチャ拡張）', () => {
    const snapshot = extractCaseSnapshot(coworkState(), helpdeskState(), 'CASE-0001', {
      subject: '  【検証20261027】共有フォルダの権限申請で連絡先が通じない  ',
    });
    expect(snapshot?.case.subject).toBe('【検証20261027】共有フォルダの権限申請で連絡先が通じない');
  });

  it('クライアントが送った件名も伏せ字にする', () => {
    const snapshot = extractCaseSnapshot(coworkState(), helpdeskState(), 'CASE-0001', {
      subject: '連絡先 a@example.com の件',
    });
    expect(snapshot?.case.subject).toBe('連絡先 [メールアドレス] の件');
  });

  it('件名がどこにも無いときだけ空のまま返す（通知側で「(件名なし)」）', () => {
    const cowork = {
      v: 31,
      ui: {},
      cases: [
        {
          id: 'CASE-0004',
          userId: 'u1',
          chatId: 'chat-4',
          subject: '',
          // 本文があっても件名の代用にはしない（件名は件名フィールドだけ）。
          body: '共有フォルダの権限申請で連絡先が通じない',
          step: 4,
        },
      ],
      chats: [{ id: 'chat-4', userId: 'u1', title: '新しい相談', messages: [] }],
      tickets: [],
      proposals: {},
    };
    const snapshot = extractCaseSnapshot(cowork, null, 'CASE-0004');
    expect(snapshot?.case.subject).toBe('');
  });
});

describe('mergeCaseSnapshot', () => {
  const snapshot = (): CaseSnapshot => {
    const extracted = extractCaseSnapshot(coworkState(), helpdeskState(), 'CASE-0001');
    if (!extracted) throw new Error('snapshot missing');
    return extracted;
  };

  it('B さんの状態へマージし、ui.user / actor は B さんのままにする', () => {
    const bCowork = {
      v: 31,
      ui: { user: 'u2', screen: 'home' },
      counters: { case: 1, ticket: 1, prop: 1 },
      cases: [],
      chats: [],
      tickets: [],
      proposals: {},
    };
    const bHelpdesk = {
      actor: '鈴木 学',
      seq: { inc: 1, draft: 1, kb: 1 },
      tickets: [],
      drafts: [],
      kb: [],
      audit: [],
    };
    const merged = mergeCaseSnapshot(bCowork, bHelpdesk, snapshot(), {
      id: '11111111-1111-1111-1111-111111111111',
      claimedBy: 'b@example.com',
    });
    const cowork = merged.cowork as Record<string, any>;
    const helpdesk = merged.helpdesk as Record<string, any>;

    expect(cowork.ui.user).toBe('u2');
    expect(cowork.ui.case).toBe('CASE-0001');
    expect(cowork.ui.screen).toBe('wizard');
    expect(cowork.cases).toHaveLength(1);
    expect(cowork.cases[0].shared).toBe(true);
    expect(cowork.cases[0].handoverId).toBe('11111111-1111-1111-1111-111111111111');
    expect(cowork.cases[0].step).toBe(3);
    expect(cowork.chats[0].messages.at(-1).who).toBe('システム');
    expect(cowork.proposals['OP-0001']).toBeDefined();
    expect(cowork.proposals['OP-9999']).toBeUndefined();
    expect(cowork.counters.case).toBeGreaterThanOrEqual(2);
    expect(cowork.counters.ticket).toBeGreaterThanOrEqual(2);

    expect(helpdesk.actor).toBe('鈴木 学');
    expect(helpdesk.tickets[0].id).toBe('INC-1001');
    expect(helpdesk.drafts[0].id).toBe('DR-001');
    expect(helpdesk.kb[0].id).toBe('KB-001');
    expect(helpdesk.seq.inc).toBeGreaterThanOrEqual(1002);
    expect(helpdesk.audit.at(-1).action).toBe('引継ぎを引き受け');
  });

  it('同じスナップショットを 2 回マージしても重複しない', () => {
    const mergedOnce = mergeCaseSnapshot(
      { v: 31, ui: {}, cases: [], chats: [], tickets: [], proposals: {} },
      { seq: {}, tickets: [], drafts: [], kb: [], audit: [] },
      snapshot(),
      { id: 'id-1', claimedBy: 'b@example.com' },
    );
    const mergedTwice = mergeCaseSnapshot(mergedOnce.cowork, mergedOnce.helpdesk, snapshot(), {
      id: 'id-1',
      claimedBy: 'b@example.com',
    });
    const cowork = mergedTwice.cowork as Record<string, any>;
    const helpdesk = mergedTwice.helpdesk as Record<string, any>;
    expect(cowork.cases).toHaveLength(1);
    expect(cowork.chats).toHaveLength(1);
    expect(cowork.tickets).toHaveLength(1);
    expect(helpdesk.tickets).toHaveLength(1);
    expect(helpdesk.drafts).toHaveLength(1);
  });
});

describe('AI 追加質問へ渡す文脈', () => {
  function snapshot(): CaseSnapshot {
    const cowork = coworkState() as Record<string, any>;
    return {
      caseId: 'CASE-0001',
      case: {
        ...cowork.cases[0],
        pc: {
          state: 'done',
          snap: {
            items: [
              { grp: 'ネットワーク', k: 'IPアドレス', v: '192.168.10.34', lv: 'ok' },
              { grp: '端末', k: 'シリアル', v: 'SN-0001', lv: 'ok' },
              { grp: '資産', k: '資産番号', v: 'PC-12345', lv: 'ok' },
              { grp: 'OS', k: 'エディション', v: 'Windows 11 Pro', lv: 'ok' },
            ],
          },
        },
      },
      chat: {
        id: 'chat-1',
        messages: [{ id: 'm1', kind: 'user', text: '連絡先は a@example.com です' }],
      },
      ticket: null,
      inc: null,
      draft: null,
      kb: null,
      proposals: [],
      extractedAt: new Date().toISOString(),
    };
  }

  it('PC 情報は IP・シリアル・資産番号を伏せたうえで AI に渡す', () => {
    const context = buildPcContext(snapshot());
    expect(context).toContain('Windows 11 Pro');
    expect(context).not.toContain('192.168.10.34');
    expect(context).not.toContain('SN-0001');
    expect(context).not.toContain('PC-12345');
    expect(context).toContain('[IPアドレス]');
    expect(context).toContain('[シリアル番号]');
    expect(context).toContain('[資産番号]');
  });

  it('案件の文脈はメール等の PII を伏せ、直近の発言を含める', () => {
    const context = buildCaseContext(snapshot());
    expect(context).toContain('共有フォルダが開けません');
    expect(context).not.toContain('a@example.com');
    expect(context).toContain('[メールアドレス]');
  });
});
