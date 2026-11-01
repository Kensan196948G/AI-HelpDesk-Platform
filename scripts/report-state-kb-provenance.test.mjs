import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  dbRowBlocker,
  demoKbKeys,
  refusalReason,
  summarize,
} from './report-state-kb-provenance.mjs';

const at = '2026-11-01T00:00:00.000Z';
const later = '2026-11-02T00:00:00.000Z';
const row = (overrides = {}) => ({
  status: 'approved',
  client_ref: 'ui-DR-1',
  author_id: 'a',
  approver_id: 'b',
  approved_at: at,
  updated_at: at,
  keywords: ['x'],
  author_email: 'a@example.com',
  approver_email: 'b@example.com',
  ...overrides,
});

describe('report-state-kb-provenance', () => {
  it('_test で終わらない DB は --allow-db なしで拒否する', () => {
    expect(refusalReason(undefined)).toContain('AUDIT_DATABASE_URL');
    expect(refusalReason('postgres://u@h/ai_helpdesk_kb_test')).toBeNull();
    expect(refusalReason('postgres://u@h/ai_helpdesk_mvp')).toContain('--allow-db');
    expect(refusalReason('postgres://u@h/ai_helpdesk_mvp', 'other')).toContain('--allow-db');
    expect(refusalReason('postgres://u@h/ai_helpdesk_mvp', 'ai_helpdesk_mvp')).toBeNull();
  });

  it('原本 HTML の初期 KB を抽出できる', () => {
    const html = readFileSync(
      new URL('../Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html', import.meta.url),
      'utf8',
    );
    expect(demoKbKeys(html).size).toBe(10);
  });

  it('DB の行が使えない理由を判定する', () => {
    expect(dbRowBlocker(row())).toBeNull();
    expect(dbRowBlocker(row({ status: 'pending' }))).toBe('notApproved');
    expect(dbRowBlocker(row({ approver_id: null }))).toBe('missingApprovalRecord');
    expect(dbRowBlocker(row({ approver_id: 'a' }))).toBe('selfApproved');
    expect(dbRowBlocker(row({ updated_at: later }))).toBe('editedAfterApproval');
  });

  it('state の active KB を分類し、件数だけを返す', () => {
    const demo = new Set(['KB-101|デモ']);
    const data = {
      kb: [
        { id: 'KB-101', title: 'デモ', status: 'active' },
        { id: 'KB-101', title: '同じ番号で別の本文', status: 'active' },
        { id: 'KB-111', title: '使用可', status: 'active' },
        { id: 'KB-112', title: '自己承認', status: 'active' },
        { id: 'KB-113', title: 'DB になし', status: 'active' },
        { id: 'KB-114', title: '使用停止', status: 'archived' },
      ],
      drafts: [
        { id: 'DR-1', kbId: 'KB-111' },
        { id: 'DR-2', kbId: 'KB-112' },
        { id: 'DR-3', kbId: 'KB-113' },
      ],
    };
    const report = summarize(
      [{ data }, { data: JSON.stringify({ kb: [] }) }, { data: 'broken' }],
      [
        row(),
        row({ client_ref: 'ui-DR-2', approver_id: 'a', keywords: [] }),
        row({ client_ref: null, keywords: [] }),
        row({ client_ref: 'other', status: 'pending' }),
      ],
      demo,
      [['a@example.com', 'b@example.com']],
    );
    expect(report.state).toEqual({
      users: 1,
      activeKb: 5,
      demoInitial: 1,
      noDraftLink: 1,
      linkedUsable: 1,
      linkedNotUsable: 1,
      linkedNoDbRow: 1,
    });
    expect(report.db).toEqual({
      approved: 3,
      usable: 2,
      usableSharedIdentity: 2,
      selfApproved: 1,
      editedAfterApproval: 0,
      missingApprovalRecord: 0,
      usableWithoutKeywords: 1,
      draftsWithoutClientRef: 0,
    });
    expect(JSON.stringify(report)).not.toContain('example.com');
  });
});
