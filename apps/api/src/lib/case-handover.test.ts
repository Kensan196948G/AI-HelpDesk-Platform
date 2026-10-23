import { describe, expect, it } from 'vitest';
import {
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
