import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearUiRoleCache } from '../auth/ui.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { flushHandoverNotifications } from '../lib/handover-notify.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { resetRateLimits } from '../lib/rate-limit.js';
import { buildServer } from '../server.js';

// 名簿（Mirai-Info）は外部 DB。テストでは固定名簿に差し替えて、
// 「DX 推進部」「一般社員」を決定的に再現する（F-01 の回帰テスト用）。
const directory = vi.hoisted(() => ({
  byEmail: new Map<string, Record<string, unknown>>(),
  staff: [] as Record<string, unknown>[],
}));

// メール送信はテストでは無効（実メールを送らない）。F-05 の通知件名だけ、
// 送信キューに積めるよう一時的に sendmail 相当へ差し替える。
const mailState = vi.hoisted(() => ({
  transport: { name: 'disabled', send: async () => {} } as {
    name: string;
    send: (message: unknown) => Promise<void>;
  },
}));

vi.mock('../lib/mailer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/mailer.js')>();
  return {
    ...actual,
    getMailTransport: () => mailState.transport,
    resetMailTransport: () => {},
  };
});

vi.mock('../lib/mirai-info.js', () => ({
  findEmployeeByEmail: async (email: string) =>
    directory.byEmail.get(String(email || '').toLowerCase()) ?? null,
  findEmployeeEmailByNo: async (employeeNo: string) => {
    for (const [email, employee] of directory.byEmail) {
      if (employee.employeeNo === employeeNo) {
        return { email, name: String(employee.name ?? '') };
      }
    }
    return null;
  },
  listEmployees: async (scope: 'staff' | 'all') => {
    const employees = scope === 'staff' ? directory.staff : directory.staff;
    return {
      employees,
      total: employees.length,
      cachedAt: new Date().toISOString(),
    };
  },
  filterStaff: (rows: Record<string, unknown>[]) =>
    rows.filter((row) => row.section === 'DX推進部'),
}));

const DX1 = {
  employeeNo: 'MK1073',
  name: '佐藤 奨太',
  section: 'DX推進部',
  division: 'DX推進部',
};
const DX2 = {
  employeeNo: 'MK0370',
  name: '加藤 里美',
  section: 'DX推進部',
  division: 'DX推進部',
};
const GENERAL = {
  employeeNo: 'MK0122',
  name: '一般 社員',
  section: '総務部',
  division: '管理本部',
};
const DX1_EMAIL = 'dx1@example.com';
const DX2_EMAIL = 'dx2@example.com';
const GENERAL_EMAIL = 'general@example.com';
const AUTHZ_CASE_PREFIX = 'CASE-H-AUTHZ';
const originalDevEmail = config.DEV_AUTH_EMAIL;
const originalNotifyEmail = config.HANDOVER_NOTIFY_EMAIL;
const originalAllowSelfApproval = config.ALLOW_SELF_APPROVAL;
const originalAuthMode = config.AUTH_MODE;

/** 承認は approver ロールが必要（docs/61）。テストの DX 担当者に付与する。 */
async function grantApproverToDx(): Promise<void> {
  for (const email of [DX1_EMAIL, DX2_EMAIL, originalDevEmail]) {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO users (email, name, role, password_hash)
      VALUES (${email}, ${email}, 'helpdesk', 'access-only$no-login')
      ON CONFLICT (lower(email)) DO UPDATE SET updated_at = now()
      RETURNING id
    `;
    for (const role of ['helpdesk', 'approver']) {
      await sql`
        INSERT INTO user_roles (user_id, role, source, granted_by)
        VALUES (${rows[0]?.id ?? ''}, ${role}, 'manual', 'test')
        ON CONFLICT DO NOTHING
      `;
    }
  }
  clearUiRoleCache();
}

let app: FastifyInstance;

const CASE_ID = 'CASE-H1';

/** 監査一覧（/api/audit）確認用のレガシーログイン（approver）。 */
async function loginApprover(): Promise<string> {
  const password = process.env.SEED_PASSWORD ?? '';
  expect(password).not.toBe('');
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'watanabe@example.com', password },
  });
  expect(response.statusCode, response.body).toBe(200);
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') throw new Error('set-cookie missing');
  return value.split(';')[0] ?? '';
}

function coworkState() {
  return {
    v: 31,
    ui: { user: 'u1', screen: 'home' },
    counters: { case: 1, ticket: 1, prop: 1 },
    cases: [
      {
        id: CASE_ID,
        userId: 'u1',
        chatId: 'chat-h1',
        subject: '共有フォルダが開けません',
        body: '異動後に開けなくなりました。',
        step: 4,
        pc: {
          state: 'done',
          snap: {
            items: [{ grp: 'ネットワーク', k: '共有フォルダ', v: 'アクセス不可', lv: 'ng' }],
          },
        },
      },
    ],
    chats: [
      {
        id: 'chat-h1',
        userId: 'u1',
        title: '共有フォルダ',
        messages: [{ id: 'm1', kind: 'user', text: '共有フォルダが開けません' }],
      },
    ],
    tickets: [
      {
        id: 'TKT-2026-9001',
        chatId: 'chat-h1',
        incId: 'INC-9001',
        userId: 'u1',
        status: '受付',
        assigneeLabel: 'DX推進部 / 佐藤 奨太',
      },
    ],
    proposals: {},
    audit: [],
  };
}

function helpdeskState() {
  return {
    actor: '佐藤 奨太',
    seq: { inc: 9001, draft: 1, kb: 1 },
    tickets: [
      {
        id: 'INC-9001',
        coworkTicket: 'TKT-2026-9001',
        status: 'escalated',
      },
    ],
    drafts: [],
    kb: [],
    audit: [],
  };
}

/** 指定したアカウントで画面状態を保存する（引継ぎ作成・claim の前提）。 */
async function putStatesFor(email: string): Promise<void> {
  config.DEV_AUTH_EMAIL = email;
  const cowork = await app.inject({
    method: 'PUT',
    url: '/api/state/cowork',
    payload: { data: coworkState() },
  });
  expect(cowork.statusCode, cowork.body).toBe(200);
  const helpdesk = await app.inject({
    method: 'PUT',
    url: '/api/state/helpdesk',
    payload: { data: helpdeskState() },
  });
  expect(helpdesk.statusCode, helpdesk.body).toBe(200);
}

beforeAll(async () => {
  resetRateLimits();
  directory.byEmail.clear();
  directory.staff.length = 0;
  for (const employee of [DX1, DX2]) directory.staff.push(employee);
  directory.byEmail.set(DX1_EMAIL, DX1);
  directory.byEmail.set(DX2_EMAIL, DX2);
  directory.byEmail.set(GENERAL_EMAIL, GENERAL);
  app = await buildServer({ logger: false });
  await app.ready();
});

beforeEach(async () => {
  await grantApproverToDx();
  resetRateLimits();
  config.DEV_AUTH_EMAIL = originalDevEmail;
  config.HANDOVER_NOTIFY_EMAIL = originalNotifyEmail;
  config.ALLOW_SELF_APPROVAL = originalAllowSelfApproval;
  config.AUTH_MODE = originalAuthMode;
  mailState.transport = { name: 'disabled', send: async () => {} };
});

afterAll(async () => {
  config.DEV_AUTH_EMAIL = originalDevEmail;
  config.HANDOVER_NOTIFY_EMAIL = originalNotifyEmail;
  config.ALLOW_SELF_APPROVAL = originalAllowSelfApproval;
  config.AUTH_MODE = originalAuthMode;
  await sql`DELETE FROM case_handovers WHERE case_id = ${CASE_ID}`;
  await sql`DELETE FROM case_handovers WHERE case_id LIKE ${`${AUTHZ_CASE_PREFIX}%`}`;
  await sql`DELETE FROM prototype_states WHERE user_email = ${config.DEV_AUTH_EMAIL}`;
  await sql`DELETE FROM prototype_states WHERE user_email IN (${DX1_EMAIL}, ${DX2_EMAIL}, ${GENERAL_EMAIL})`;
  await app.close();
});

describe('案件引継ぎ API', () => {
  it('A の案件を DX グループへ共有し、B の状態へマージして AI 追加質問できる', async () => {
    resetRateLimits();
    const email = config.DEV_AUTH_EMAIL;

    const putCowork = await app.inject({
      method: 'PUT',
      url: '/api/state/cowork',
      payload: { data: coworkState() },
    });
    expect(putCowork.statusCode, putCowork.body).toBe(200);
    const putHelpdesk = await app.inject({
      method: 'PUT',
      url: '/api/state/helpdesk',
      payload: { data: helpdeskState() },
    });
    expect(putHelpdesk.statusCode, putHelpdesk.body).toBe(200);

    const shared = await app.inject({
      method: 'POST',
      url: '/api/case-handovers',
      payload: { caseId: CASE_ID, assigneeHint: 'DX推進部 / 佐藤 奨太' },
    });
    expect(shared.statusCode, shared.body).toBe(200);
    const handoverId = shared.json().handover.id as string;
    expect(handoverId).toMatch(/^[0-9a-f-]{36}$/);
    // テスト環境ではメール送信を無効にしている（実メールを送らない）。
    expect(shared.json().notify).toEqual({ queued: 0, transport: 'disabled' });

    const inbox = await app.inject({ method: 'GET', url: '/api/case-handovers/inbox' });
    expect(inbox.statusCode, inbox.body).toBe(200);
    const item = inbox.json().items.find((entry: { caseId: string }) => entry.caseId === CASE_ID);
    expect(item).toBeDefined();
    expect(item.subject).toContain('共有フォルダ');

    const claimed = await app.inject({
      method: 'POST',
      url: `/api/case-handovers/${handoverId}/claim`,
      payload: {},
    });
    expect(claimed.statusCode, claimed.body).toBe(200);

    const state = await app.inject({ method: 'GET', url: '/api/state' });
    expect(state.statusCode, state.body).toBe(200);
    const body = state.json();
    expect(body.cowork.ui.case).toBe(CASE_ID);
    expect(body.cowork.cases[0].id).toBe(CASE_ID);
    expect(body.cowork.cases[0].shared).toBe(true);
    expect(body.cowork.cases[0].handoverId).toBe(handoverId);
    expect(body.cowork.chats[0].id).toBe('chat-h1');
    expect(body.cowork.tickets[0].id).toBe('TKT-2026-9001');
    expect(body.helpdesk.tickets[0].id).toBe('INC-9001');
    expect(body.helpdesk.seq.inc).toBeGreaterThanOrEqual(9002);

    const answer = await app.inject({
      method: 'POST',
      url: '/api/ai/answer-case',
      payload: { caseId: CASE_ID, text: '次に確認すべきことは？' },
    });
    expect(answer.statusCode, answer.body).toBe(200);
    const answerBody = answer.json();
    expect(answerBody.answer.length).toBeGreaterThan(0);
    expect(['fallback', 'deepseek']).toContain(answerBody.provider);

    // 同じ案件をもう一度共有すると、進行中の行は置き換わる（重複しない）。
    const reShared = await app.inject({
      method: 'POST',
      url: '/api/case-handovers',
      payload: { caseId: CASE_ID },
    });
    expect(reShared.statusCode, reShared.body).toBe(200);
    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM case_handovers
      WHERE case_id = ${CASE_ID} AND owner_email = ${email}
        AND status IN ('pending', 'claimed')
    `;
    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  });

  it('宛先は DX 推進部の名簿から選択し、名簿にない宛先は受け付けない', async () => {
    resetRateLimits();
    const recipients = await app.inject({ method: 'GET', url: '/api/case-handovers/recipients' });
    expect(recipients.statusCode, recipients.body).toBe(200);
    const body = recipients.json();
    expect(body.group).toBe('DX推進部');
    expect(Array.isArray(body.members)).toBe(true);
    for (const member of body.members) {
      expect(member.section).toBe('DX推進部');
      expect(member.email).toBeUndefined();
    }

    // 名簿に無い宛先（自由入力の氏名など）は指名として受け付けない。
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/case-handovers',
      payload: { caseId: CASE_ID, recipientNo: 'NOT-IN-DIRECTORY' },
    });
    expect(rejected.statusCode, rejected.body).not.toBe(200);
    expect(['INVALID_RECIPIENT', 'DIRECTORY_UNAVAILABLE']).toContain(rejected.json().error.code);
  });

  it('ナレッジ承認は DX 推進部の担当者が行い、引き受け前は承認できない', async () => {
    resetRateLimits();
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM case_handovers
      WHERE case_id = ${CASE_ID} AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const pendingId = rows[0]?.id;
    expect(pendingId, '前のテストが作った pending の引継ぎ').toBeDefined();

    // 引き受けていない案件は承認できない。
    const beforeClaim = await app.inject({
      method: 'POST',
      url: `/api/case-handovers/${pendingId}/approve`,
      payload: {},
    });
    expect(beforeClaim.statusCode, beforeClaim.body).toBe(409);
    expect(beforeClaim.json().error.code).toBe('NOT_CLAIMED');

    const claimed = await app.inject({
      method: 'POST',
      url: `/api/case-handovers/${pendingId}/claim`,
      payload: {},
    });
    expect(claimed.statusCode, claimed.body).toBe(200);

    const approved = await app.inject({
      method: 'POST',
      url: `/api/case-handovers/${pendingId}/approve`,
      payload: { note: 'チェックリスト確認済み' },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const handover = approved.json().handover;
    expect(handover.status).toBe('completed');
    expect(handover.approvedBy).toBe(config.DEV_AUTH_EMAIL);
    expect(typeof handover.approvedByName).toBe('string');
    // 同一ログインのデモなので対応者と承認者が同じ。黙って通さず自己承認として記録する。
    expect(handover.selfApproved).toBe(true);

    const stored = await sql<{ status: string; self_approved: boolean }[]>`
      SELECT status, self_approved FROM case_handovers WHERE id = ${pendingId}
    `;
    expect(stored[0]?.status).toBe('completed');
    expect(stored[0]?.self_approved).toBe(true);
  });

  it('承認を経ずに PATCH で completed にはできない', async () => {
    resetRateLimits();
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM case_handovers
      WHERE case_id = ${CASE_ID} AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    let handoverId = rows[0]?.id;
    if (!handoverId) {
      const shared = await app.inject({
        method: 'POST',
        url: '/api/case-handovers',
        payload: { caseId: CASE_ID },
      });
      expect(shared.statusCode, shared.body).toBe(200);
      handoverId = shared.json().handover.id as string;
    }
    const claimed = await app.inject({
      method: 'POST',
      url: `/api/case-handovers/${handoverId}/claim`,
      payload: {},
    });
    expect(claimed.statusCode, claimed.body).toBe(200);

    const blocked = await app.inject({
      method: 'PATCH',
      url: `/api/case-handovers/${handoverId}`,
      payload: { status: 'completed' },
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json().error.code).toBe('APPROVAL_REQUIRED');

    const resolved = await app.inject({
      method: 'PATCH',
      url: `/api/case-handovers/${handoverId}`,
      payload: { status: 'resolved' },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
  });

  describe('引継ぎ通知の送信キュー', () => {
    async function latestHandoverId(): Promise<string> {
      const rows = await sql<{ id: string }[]>`
      SELECT id FROM case_handovers WHERE case_id = ${CASE_ID}
      ORDER BY created_at DESC LIMIT 1
    `;
      const id = rows[0]?.id;
      expect(id, '引継ぎが存在すること').toBeTruthy();
      return id as string;
    }

    it('送信に成功すると sent になり、宛先へ 1 通だけ渡す', async () => {
      const handoverId = await latestHandoverId();
      await sql`
      INSERT INTO case_handover_notifications (handover_id, recipient_email, subject, body)
      VALUES (${handoverId}, 'notify-test@example.com', 'テスト件名', 'テスト本文')
      ON CONFLICT (handover_id, recipient_email) DO NOTHING
    `;
      const delivered: string[] = [];
      const result = await flushHandoverNotifications({
        transport: {
          name: 'sendmail',
          send: async (message) => {
            delivered.push(message.to);
          },
        },
      });
      expect(delivered).toContain('notify-test@example.com');
      expect(result.sent).toBeGreaterThanOrEqual(1);
      const stored = await sql<{ status: string }[]>`
      SELECT status FROM case_handover_notifications
      WHERE handover_id = ${handoverId} AND recipient_email = 'notify-test@example.com'
    `;
      expect(stored[0]?.status).toBe('sent');
      await sql`
      DELETE FROM case_handover_notifications
      WHERE handover_id = ${handoverId} AND recipient_email = 'notify-test@example.com'
    `;
    });

    it('送信に失敗すると pending のまま再試行され、5 回で failed になる', async () => {
      const handoverId = await latestHandoverId();
      await sql`
      INSERT INTO case_handover_notifications (
        handover_id, recipient_email, subject, body, attempts
      )
      VALUES (${handoverId}, 'notify-fail@example.com', 't', 'b', 4)
      ON CONFLICT (handover_id, recipient_email) DO NOTHING
    `;
      const result = await flushHandoverNotifications({
        transport: {
          name: 'sendmail',
          send: async () => {
            throw new Error('smtp down');
          },
        },
      });
      expect(result.failed).toBeGreaterThanOrEqual(1);
      const stored = await sql<{ status: string; attempts: number; last_error: string | null }[]>`
      SELECT status, attempts, last_error FROM case_handover_notifications
      WHERE handover_id = ${handoverId} AND recipient_email = 'notify-fail@example.com'
    `;
      expect(stored[0]?.status).toBe('failed');
      expect(stored[0]?.attempts).toBe(5);
      expect(stored[0]?.last_error).toContain('smtp down');
      await sql`
      DELETE FROM case_handover_notifications
      WHERE handover_id = ${handoverId} AND recipient_email = 'notify-fail@example.com'
    `;
    });
  });

  describe('引継ぎの権限（F-01）とサーバ監査（F-02）', () => {
    let authzSeq = 0;

    function validSnapshot(caseId: string) {
      return {
        caseId,
        case: { id: caseId, subject: '権限テスト案件' },
        chat: null,
        ticket: null,
        inc: null,
        draft: null,
        kb: null,
        proposals: [],
        extractedAt: new Date().toISOString(),
      };
    }

    async function insertHandover(input: {
      ownerEmail: string;
      recipientNo?: string | null;
      recipientName?: string | null;
      status?: 'pending' | 'claimed';
      claimedBy?: string | null;
    }): Promise<{ id: string; caseId: string }> {
      authzSeq += 1;
      const caseId = `${AUTHZ_CASE_PREFIX}-${authzSeq}`;
      const rows = await sql<{ id: string }[]>`
        INSERT INTO case_handovers (
          case_id, owner_email, recipient_no, recipient_name, status, claimed_by, snapshot
        ) VALUES (
          ${caseId},
          ${input.ownerEmail},
          ${input.recipientNo ?? null},
          ${input.recipientName ?? null},
          ${input.status ?? 'pending'},
          ${input.claimedBy ?? null},
          ${jsonbValue(validSnapshot(caseId))}
        )
        RETURNING id
      `;
      const id = rows[0]?.id;
      expect(id, '引継ぎの作成').toBeDefined();
      return { id: id as string, caseId };
    }

    async function putStates(email: string): Promise<void> {
      await putStatesFor(email);
    }

    async function auditRows(
      handoverId: string,
      action: string,
    ): Promise<{ action: string; detail: Record<string, unknown>; created_at: Date }[]> {
      return sql<{ action: string; detail: Record<string, unknown>; created_at: Date }[]>`
        SELECT action, detail, created_at FROM audit_log
        WHERE target_type = 'case_handover'
          AND target_id = ${handoverId}
          AND action = ${action}
        ORDER BY id ASC
      `;
    }

    it('一般社員は受信箱・claim・PATCH・承認が 403、自分の案件の詳細だけ閲覧できる', async () => {
      const other = await insertHandover({ ownerEmail: DX1_EMAIL });

      config.DEV_AUTH_EMAIL = GENERAL_EMAIL;
      const inbox = await app.inject({ method: 'GET', url: '/api/case-handovers/inbox' });
      expect(inbox.statusCode, inbox.body).toBe(403);
      expect(inbox.json().error.code).toBe('FORBIDDEN');

      const claim = await app.inject({
        method: 'POST',
        url: `/api/case-handovers/${other.id}/claim`,
        payload: {},
      });
      expect(claim.statusCode, claim.body).toBe(403);

      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/case-handovers/${other.id}`,
        payload: { status: 'resolved' },
      });
      expect(patch.statusCode, patch.body).toBe(403);

      const approve = await app.inject({
        method: 'POST',
        url: `/api/case-handovers/${other.id}/approve`,
        payload: {},
      });
      expect(approve.statusCode, approve.body).toBe(403);

      // 自分の案件（owner）の詳細だけは参照できる。
      const own = await insertHandover({ ownerEmail: GENERAL_EMAIL });
      const ownDetail = await app.inject({ method: 'GET', url: `/api/case-handovers/${own.id}` });
      expect(ownDetail.statusCode, ownDetail.body).toBe(200);
      expect(ownDetail.json().handover.id).toBe(own.id);

      const otherDetail = await app.inject({
        method: 'GET',
        url: `/api/case-handovers/${other.id}`,
      });
      expect(otherDetail.statusCode, otherDetail.body).toBe(403);
    });

    it('指名外の DX 担当は claim できず、受信箱にも指名分は出ない', async () => {
      // DX1（MK1073）宛の指名。
      const designated = await insertHandover({
        ownerEmail: GENERAL_EMAIL,
        recipientNo: DX1.employeeNo,
        recipientName: DX1.name,
      });
      // 指名なし（グループ宛）。
      const group = await insertHandover({ ownerEmail: GENERAL_EMAIL });

      config.DEV_AUTH_EMAIL = DX2_EMAIL;
      const dx2Inbox = await app.inject({ method: 'GET', url: '/api/case-handovers/inbox' });
      expect(dx2Inbox.statusCode, dx2Inbox.body).toBe(200);
      const dx2Ids = (dx2Inbox.json().items as { id: string }[]).map((item) => item.id);
      expect(dx2Ids).toContain(group.id);
      expect(dx2Ids).not.toContain(designated.id);

      const mismatch = await app.inject({
        method: 'POST',
        url: `/api/case-handovers/${designated.id}/claim`,
        payload: {},
      });
      expect(mismatch.statusCode, mismatch.body).toBe(403);
      expect(mismatch.json().error.code).toBe('RECIPIENT_MISMATCH');

      config.DEV_AUTH_EMAIL = DX1_EMAIL;
      const dx1Inbox = await app.inject({ method: 'GET', url: '/api/case-handovers/inbox' });
      expect(dx1Inbox.statusCode, dx1Inbox.body).toBe(200);
      const dx1Ids = (dx1Inbox.json().items as { id: string }[]).map((item) => item.id);
      expect(dx1Ids).toContain(designated.id);
    });

    it('別の DX 担当が claim 済みなら 409 で横取りできない', async () => {
      const claimed = await insertHandover({
        ownerEmail: GENERAL_EMAIL,
        status: 'claimed',
        claimedBy: DX1_EMAIL,
      });

      config.DEV_AUTH_EMAIL = DX2_EMAIL;
      const result = await app.inject({
        method: 'POST',
        url: `/api/case-handovers/${claimed.id}/claim`,
        payload: {},
      });
      expect(result.statusCode, result.body).toBe(409);
      expect(result.json().error.code).toBe('ALREADY_CLAIMED');
    });

    it('claim・解決記録・承認の監査は 1 操作 1 行で、actor は実行者メール', async () => {
      await putStates(DX1_EMAIL);
      const target = await insertHandover({ ownerEmail: GENERAL_EMAIL });
      config.DEV_AUTH_EMAIL = DX1_EMAIL;

      const claimed = await app.inject({
        method: 'POST',
        url: `/api/case-handovers/${target.id}/claim`,
        payload: {},
      });
      expect(claimed.statusCode, claimed.body).toBe(200);

      // 再送（冪等）では監査行を増やさない。
      const claimedAgain = await app.inject({
        method: 'POST',
        url: `/api/case-handovers/${target.id}/claim`,
        payload: {},
      });
      expect(claimedAgain.statusCode, claimedAgain.body).toBe(200);

      const claimAudit = await auditRows(target.id, 'case_handover.claim');
      expect(claimAudit, 'claim の監査は 1 行だけ').toHaveLength(1);
      expect(claimAudit[0]?.detail.actorEmail).toBe(DX1_EMAIL);
      expect(claimAudit[0]?.detail.caseId).toBe(target.caseId);
      expect(claimAudit[0]?.created_at).toBeInstanceOf(Date);

      const resolved = await app.inject({
        method: 'PATCH',
        url: `/api/case-handovers/${target.id}`,
        payload: { status: 'resolved' },
      });
      expect(resolved.statusCode, resolved.body).toBe(200);
      const resolveAudit = await auditRows(target.id, 'case_handover.resolve');
      expect(resolveAudit).toHaveLength(1);
      expect(resolveAudit[0]?.detail.actorEmail).toBe(DX1_EMAIL);

      const approved = await app.inject({
        method: 'POST',
        url: `/api/case-handovers/${target.id}/approve`,
        payload: { note: '監査テスト' },
      });
      expect(approved.statusCode, approved.body).toBe(200);
      const approveAudit = await auditRows(target.id, 'case_handover.approve');
      expect(approveAudit).toHaveLength(1);
      expect(approveAudit[0]?.detail.actorEmail).toBe(DX1_EMAIL);
      expect(approveAudit[0]?.detail.selfApproved).toBe(true);
    });

    it('名簿で本人確認できないアカウントは指名 claim を拒否する（fail-closed）', async () => {
      const target = await insertHandover({
        ownerEmail: GENERAL_EMAIL,
        recipientNo: DX1.employeeNo,
        recipientName: DX1.name,
      });
      config.DEV_AUTH_EMAIL = 'not-in-directory@example.com';
      const result = await app.inject({
        method: 'POST',
        url: `/api/case-handovers/${target.id}/claim`,
        payload: {},
      });
      expect(result.statusCode, result.body).toBe(403);
      expect(result.json().error.code).toBe('RECIPIENT_UNVERIFIED');
    });

    it('作成・claim・承認がそれぞれ監査1行になる（F-02 create の漏れ）', async () => {
      // 作成（依頼者）。作成成功時点で case_handover.create が1行だけ入る。
      await putStatesFor(config.DEV_AUTH_EMAIL);
      const shared = await app.inject({
        method: 'POST',
        url: '/api/case-handovers',
        payload: { caseId: CASE_ID },
      });
      expect(shared.statusCode, shared.body).toBe(200);
      const handoverId = shared.json().handover.id as string;

      const createAudit = await auditRows(handoverId, 'case_handover.create');
      expect(createAudit, 'create の監査は1行だけ').toHaveLength(1);
      expect(createAudit[0]?.detail.actorEmail).toBe(config.DEV_AUTH_EMAIL);
      expect(createAudit[0]?.detail.caseId).toBe(CASE_ID);
      expect(createAudit[0]?.detail.recipient_no).toBeNull();
      expect(createAudit[0]?.created_at).toBeInstanceOf(Date);

      // claim（DX 担当）→ 承認（DX 担当）。
      await putStatesFor(DX1_EMAIL);
      const claimed = await app.inject({
        method: 'POST',
        url: `/api/case-handovers/${handoverId}/claim`,
        payload: {},
      });
      expect(claimed.statusCode, claimed.body).toBe(200);

      const approved = await app.inject({
        method: 'POST',
        url: `/api/case-handovers/${handoverId}/approve`,
        payload: { note: 'create監査テスト' },
      });
      expect(approved.statusCode, approved.body).toBe(200);

      const claimAudit = await auditRows(handoverId, 'case_handover.claim');
      expect(claimAudit, 'claim の監査は1行だけ').toHaveLength(1);
      expect(claimAudit[0]?.detail.actorEmail).toBe(DX1_EMAIL);
      const approveAudit = await auditRows(handoverId, 'case_handover.approve');
      expect(approveAudit, 'approve の監査は1行だけ').toHaveLength(1);
      expect(approveAudit[0]?.detail.actorEmail).toBe(DX1_EMAIL);

      // 監査 action 名は一意で、/api/audit の action としてそのまま判別できる。
      const actions = await sql<{ action: string; count: string }[]>`
        SELECT action, count(*)::text AS count FROM audit_log
        WHERE target_type = 'case_handover' AND target_id = ${handoverId}
        GROUP BY action ORDER BY action ASC
      `;
      expect(actions.map((row) => row.action)).toEqual([
        'case_handover.approve',
        'case_handover.claim',
        'case_handover.create',
      ]);
      for (const row of actions) expect(row.count).toBe('1');

      // /api/audit の一覧でも action 名と対象で判別できる。
      const cookie = await loginApprover();
      const auditList = await app.inject({
        method: 'GET',
        url: '/api/audit?limit=100',
        headers: { cookie },
      });
      expect(auditList.statusCode, auditList.body).toBe(200);
      const entry = (auditList.json().audit as Array<{ action: string; targetId: string }>).find(
        (row) => row.action === 'case_handover.create' && row.targetId === handoverId,
      );
      expect(entry, '/api/audit に case_handover.create が出る').toBeDefined();
    });

    it('inbox は自分の案件も返し、指名外は返さない（SM-01）', async () => {
      // cloudflare-access（本番相当）でも「依頼者＝自分」の案件が受信箱に出ることを確認する。
      const selfEmail = 'dx1@mirai-const.co.jp'; // allowlist 対象ドメイン
      directory.byEmail.set(selfEmail, DX1);
      try {
        const own = await insertHandover({ ownerEmail: selfEmail });
        const designatedToOther = await insertHandover({
          ownerEmail: selfEmail,
          recipientNo: DX2.employeeNo,
          recipientName: DX2.name,
        });

        config.AUTH_MODE = 'cloudflare-access';
        const inbox = await app.inject({
          method: 'GET',
          url: '/api/case-handovers/inbox',
          headers: { 'cf-access-authenticated-user-email': selfEmail },
        });
        expect(inbox.statusCode, inbox.body).toBe(200);
        const ids = (inbox.json().items as Array<{ id: string }>).map((item) => item.id);
        expect(ids, '自分の案件も受信箱に出る').toContain(own.id);
        expect(ids, '指名外の案件は受信箱に出ない').not.toContain(designatedToOther.id);
      } finally {
        config.AUTH_MODE = originalAuthMode;
        directory.byEmail.delete(selfEmail);
      }
    });

    it('ALLOW_SELF_APPROVAL=false は自己承認を 403、true は self_approved=true で許可する（SM-02）', async () => {
      config.DEV_AUTH_EMAIL = DX1_EMAIL;
      const selfRow = await insertHandover({
        ownerEmail: GENERAL_EMAIL,
        status: 'claimed',
        claimedBy: DX1_EMAIL,
      });
      const otherRow = await insertHandover({
        ownerEmail: GENERAL_EMAIL,
        status: 'claimed',
        claimedBy: DX2_EMAIL,
      });

      try {
        config.ALLOW_SELF_APPROVAL = false;

        // 自分が引き受けた案件は承認できない（職務分離）。
        const denied = await app.inject({
          method: 'POST',
          url: `/api/case-handovers/${selfRow.id}/approve`,
          payload: {},
        });
        expect(denied.statusCode, denied.body).toBe(403);
        expect(denied.json().error.code).toBe('SELF_APPROVAL_FORBIDDEN');
        const stillClaimed = await sql<{ status: string }[]>`
          SELECT status FROM case_handovers WHERE id = ${selfRow.id}
        `;
        expect(stillClaimed[0]?.status).toBe('claimed');
        expect(await auditRows(selfRow.id, 'case_handover.approve')).toHaveLength(0);

        // 他者が引き受けた案件は false でも承認できる（過剰ブロックしない）。
        const allowedOther = await app.inject({
          method: 'POST',
          url: `/api/case-handovers/${otherRow.id}/approve`,
          payload: {},
        });
        expect(allowedOther.statusCode, allowedOther.body).toBe(200);
        expect(allowedOther.json().handover.selfApproved).toBe(false);

        // true（既定）では自己承認を許可し、self_approved=true を記録する。
        config.ALLOW_SELF_APPROVAL = true;
        const allowedSelf = await app.inject({
          method: 'POST',
          url: `/api/case-handovers/${selfRow.id}/approve`,
          payload: {},
        });
        expect(allowedSelf.statusCode, allowedSelf.body).toBe(200);
        expect(allowedSelf.json().handover.selfApproved).toBe(true);

        const stored = await sql<
          { status: string; self_approved: boolean; approved_by: string | null }[]
        >`
          SELECT status, self_approved, approved_by FROM case_handovers WHERE id = ${selfRow.id}
        `;
        expect(stored[0]?.status).toBe('completed');
        expect(stored[0]?.self_approved).toBe(true);
        expect(stored[0]?.approved_by).toBe(DX1_EMAIL);
      } finally {
        config.ALLOW_SELF_APPROVAL = originalAllowSelfApproval;
      }
    });
  });

  describe('引継ぎの件名（F-05）と保存前 PII 伏せ字（F-04）', () => {
    it('クライアントが送った件名を snapshot と通知件名に使う', async () => {
      await putStatesFor(config.DEV_AUTH_EMAIL);
      // 通知キューに積めるよう、このテストだけ送信手段を差し替える（実メールは送らない）。
      mailState.transport = { name: 'sendmail', send: async () => {} };
      config.HANDOVER_NOTIFY_EMAIL = 'notify-subject@example.com';
      const subject = '画面の件名（F-05 回帰テスト）';

      const shared = await app.inject({
        method: 'POST',
        url: '/api/case-handovers',
        payload: { caseId: CASE_ID, subject },
      });
      expect(shared.statusCode, shared.body).toBe(200);
      expect(shared.json().notify.queued).toBe(1);
      const handoverId = shared.json().handover.id as string;

      const snapshots = await sql<{ subject: string | null }[]>`
        SELECT snapshot #>> '{case,subject}' AS subject
        FROM case_handovers WHERE id = ${handoverId}
      `;
      expect(snapshots[0]?.subject).toBe(subject);

      const notified = await sql<{ subject: string }[]>`
        SELECT subject FROM case_handover_notifications
        WHERE handover_id = ${handoverId}
      `;
      expect(notified.length).toBeGreaterThan(0);
      expect(notified[0]?.subject).toContain(subject);
    });

    it('AI 追加質問で snapshot を更新する前に PII を伏せ字にする', async () => {
      config.DEV_AUTH_EMAIL = DX1_EMAIL;
      const caseId = `${AUTHZ_CASE_PREFIX}-PII`;
      // 旧データ（保存前に伏せ字化されていないスナップショット）を再現する。
      const snapshot = {
        caseId,
        case: {
          id: caseId,
          subject: 'PII テスト',
          body: '連絡先は taro@example.com、電話は 090-1234-5678 です。',
        },
        chat: {
          id: `chat-${caseId}`,
          messages: [{ id: 'm1', kind: 'user', text: 'taro@example.com に連絡しました' }],
        },
        ticket: null,
        inc: null,
        draft: null,
        kb: null,
        proposals: [],
        extractedAt: new Date().toISOString(),
      };
      const rows = await sql<{ id: string }[]>`
        INSERT INTO case_handovers (case_id, owner_email, status, snapshot)
        VALUES (${caseId}, ${DX1_EMAIL}, 'pending', ${jsonbValue(snapshot)})
        RETURNING id
      `;
      const handoverId = rows[0]?.id as string;

      const answer = await app.inject({
        method: 'POST',
        url: '/api/ai/answer-case',
        payload: { caseId, text: '次に電話 090-1234-5678 へ確認してよいですか？' },
      });
      expect(answer.statusCode, answer.body).toBe(200);

      const stored = await sql<{ text: string }[]>`
        SELECT snapshot::text AS text FROM case_handovers WHERE id = ${handoverId}
      `;
      expect(stored[0]?.text).not.toContain('taro@example.com');
      expect(stored[0]?.text).not.toContain('090-1234-5678');
    });
  });
});
