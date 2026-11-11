import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmployeeRow } from '../lib/mirai-info.js';

/**
 * ダッシュボードのログインユーザー表示（2026-11-11）。
 *
 * Cloudflare Access のメール → Mirai-Info 名簿 → 表示名、を決める。
 * `kensan1969@gmail.com` は管理者、PC ヘルプデスク可否は helpdesk-scope の
 * DX 名簿所属 / デモ許可で決まる（role だけでは決めない）。
 */
const { findEmployeeByEmail } = vi.hoisted(() => ({
  findEmployeeByEmail: vi.fn<(email: string) => Promise<EmployeeRow | null>>(),
}));

vi.mock('../lib/mirai-info.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/mirai-info.js')>();
  return { ...actual, findEmployeeByEmail };
});

import { config } from '../config.js';
import { buildStaff, resolveActor } from './ops.js';

const original = {
  PERSONA_SWITCH_ALLOWLIST: config.PERSONA_SWITCH_ALLOWLIST,
  AUTH_MODE: config.AUTH_MODE,
  EMAIL_ALIASES: config.EMAIL_ALIASES,
};

beforeEach(() => {
  findEmployeeByEmail.mockReset();
  config.PERSONA_SWITCH_ALLOWLIST = '';
  config.AUTH_MODE = 'cloudflare-access';
});

afterAll(() => {
  Object.assign(config, original);
});

describe('resolveActor', () => {
  it('管理者 Gmail は「管理者」/ PCヘルプデスクとして解決する', async () => {
    findEmployeeByEmail.mockResolvedValue(null);
    config.PERSONA_SWITCH_ALLOWLIST = 'kensan1969@gmail.com';

    const actor = await resolveActor('kensan1969@gmail.com', ['approver', 'helpdesk']);
    expect(actor).toMatchObject({
      name: '管理者',
      role: 'PCヘルプデスク',
      approver: true,
      helpdesk: true,
      email: 'kensan1969@gmail.com',
    });
  });

  it('Mirai-Info の DX 社員は名簿の氏名と PCヘルプデスクになる', async () => {
    findEmployeeByEmail.mockResolvedValue({
      employeeNo: 'E2E-1',
      name: '山田 太郎',
      section: 'DX推進部',
      division: 'DX推進部',
    });

    const actor = await resolveActor('taro@mirai-const.co.jp', ['helpdesk']);
    expect(actor.name).toBe('山田 太郎');
    expect(actor.role).toBe('PCヘルプデスク');
    expect(actor.helpdesk).toBe(true);
  });

  it('DX 以外の社員は名簿の氏名を使うが、helpdesk は false（fail-closed）', async () => {
    findEmployeeByEmail.mockResolvedValue({
      employeeNo: 'E2E-2',
      name: '佐々木 花子',
      section: '工事部',
      division: '工事部',
    });

    const actor = await resolveActor('hanako@mirai-const.co.jp', ['helpdesk']);
    expect(actor.name).toBe('佐々木 花子');
    expect(actor.helpdesk).toBe(false);
    expect(actor.role).toBe('ヘルプデスク担当');
  });

  it('名簿に居ない一般ユーザーはメールのローカル部で表示する', async () => {
    findEmployeeByEmail.mockResolvedValue(null);

    const actor = await resolveActor('guest@example.com', []);
    expect(actor.name).toBe('guest');
    expect(actor.helpdesk).toBe(false);
    expect(actor.role).toBe('一般社員');
  });
});

describe('buildStaff', () => {
  it('名簿に居ないログイン本人を先頭に残し、重複させない', () => {
    const actor = {
      name: '管理者',
      role: 'PCヘルプデスク',
      approver: true,
      email: 'kensan1969@gmail.com',
      helpdesk: true,
    };
    const staff = buildStaff(actor, [
      { employeeNo: 'E2E-1', name: '山田 太郎', section: 'DX推進部' },
      { employeeNo: 'E2E-3', name: '管理者', section: 'DX推進部' },
    ]);
    expect(staff[0]).toMatchObject({
      name: '管理者',
      role: 'PCヘルプデスク',
      approver: true,
    });
    expect(staff.filter((entry) => entry.name === '管理者')).toHaveLength(1);
    expect(staff.some((entry) => entry.name === '山田 太郎')).toBe(true);
  });
});
