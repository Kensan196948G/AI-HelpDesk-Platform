import { describe, expect, it } from 'vitest';
import type { EmployeeRow } from '../lib/mirai-info.js';
import {
  type HelpdeskDirectory,
  isHelpdeskEmployee,
  recipientDecision,
  resolveHelpdeskActor,
} from './helpdesk-scope.js';

function employee(overrides: Partial<EmployeeRow> = {}): EmployeeRow {
  return {
    employeeNo: 'MK0001',
    name: 'テスト 太郎',
    section: 'DX推進部',
    division: 'DX推進部',
    ...overrides,
  };
}

/** メール→社員の固定名簿（外部 DB に依存しない）。 */
function directoryOf(map: Record<string, EmployeeRow | null>): HelpdeskDirectory {
  return {
    findByEmail: async (email: string) => map[email.toLowerCase()] ?? null,
  };
}

const baseOptions = {
  authMode: 'cloudflare-access' as const,
  devEmail: 'dev@example.com',
  demoAllowlist: '',
  aliases: '',
};

describe('helpdesk-scope', () => {
  it('DX 推進部の社員はヘルプデスク相当として許可する', async () => {
    const actor = await resolveHelpdeskActor('dx1@example.com', {
      ...baseOptions,
      directory: directoryOf({ 'dx1@example.com': employee() }),
    });
    expect(actor).toMatchObject({
      email: 'dx1@example.com',
      employeeNo: 'MK0001',
      name: 'テスト 太郎',
      section: 'DX推進部',
      via: 'dx',
    });
  });

  it('section が空でも division が DX 推進部なら許可する', async () => {
    const actor = await resolveHelpdeskActor('dx2@example.com', {
      ...baseOptions,
      directory: directoryOf({
        'dx2@example.com': employee({ employeeNo: 'MK0002', section: undefined }),
      }),
    });
    expect(actor.via).toBe('dx');
    expect(actor.employeeNo).toBe('MK0002');
  });

  it('一般社員（DX 推進部以外）は 403 で拒否する', async () => {
    await expect(
      resolveHelpdeskActor('general@example.com', {
        ...baseOptions,
        directory: directoryOf({
          'general@example.com': employee({
            employeeNo: 'MK0122',
            section: '総務部',
            division: '管理本部',
          }),
        }),
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('名簿で解決できない場合は fail-closed（本番）', async () => {
    await expect(
      resolveHelpdeskActor('unknown@example.com', {
        ...baseOptions,
        directory: directoryOf({}),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('ローカル開発/テストは設定済みの DEV_AUTH_EMAIL だけ例外にする', async () => {
    const actor = await resolveHelpdeskActor('dev@example.com', {
      ...baseOptions,
      authMode: 'local',
      directory: directoryOf({}),
    });
    expect(actor).toMatchObject({ via: 'dev', employeeNo: null });

    await expect(
      resolveHelpdeskActor('other@example.com', {
        ...baseOptions,
        authMode: 'local',
        directory: directoryOf({}),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('デモ用アカウント（明示設定）は名簿に無くても許可する', async () => {
    const actor = await resolveHelpdeskActor('demo@example.com', {
      ...baseOptions,
      demoAllowlist: 'demo@example.com, other@example.com',
      directory: directoryOf({}),
    });
    expect(actor.via).toBe('demo');
  });

  it('別名は正規化して名簿を引く', async () => {
    const actor = await resolveHelpdeskActor('alias@example.com', {
      ...baseOptions,
      aliases: 'alias@example.com=dx1@example.com',
      directory: directoryOf({ 'dx1@example.com': employee() }),
    });
    expect(actor.email).toBe('dx1@example.com');
    expect(actor.via).toBe('dx');
  });

  it('所属の表記ゆれ（空白）を吸収する', () => {
    expect(isHelpdeskEmployee({ section: ' DX 推進部 ', division: undefined })).toBe(true);
    expect(isHelpdeskEmployee({ section: '総務部', division: '管理本部' })).toBe(false);
  });

  describe('recipientDecision', () => {
    it('指名なしはグループとして開く', () => {
      expect(recipientDecision(null, { employeeNo: 'MK0001' })).toBe('open');
      expect(recipientDecision('', { employeeNo: null })).toBe('open');
    });

    it('指名された本人だけ match になる', () => {
      expect(recipientDecision('MK0001', { employeeNo: 'MK0001' })).toBe('match');
      expect(recipientDecision('MK0002', { employeeNo: 'MK0001' })).toBe('mismatch');
    });

    it('本人確認できない場合は unknown（fail-closed）', () => {
      expect(recipientDecision('MK0001', { employeeNo: null })).toBe('unknown');
    });
  });
});
