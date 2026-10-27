import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import { sql } from '../db.js';
import { resetRateLimits } from '../lib/rate-limit.js';
import { buildServer } from '../server.js';

// 名簿（Mirai-Info）は外部 DB。テストでは固定名簿に差し替え、
// 「DX 推進部」の担当者を決定的に再現する。
const directory = vi.hoisted(() => ({
  byEmail: new Map<string, Record<string, unknown>>(),
  staff: [] as Record<string, unknown>[],
}));

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
  listEmployees: async (_scope: 'staff' | 'all') => ({
    employees: directory.staff,
    total: directory.staff.length,
    cachedAt: new Date().toISOString(),
  }),
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
const REF = 'ui-test-f06-draft';
const REF_PREFIX = 'ui-test-f06%';
const originalDevEmail = config.DEV_AUTH_EMAIL;
const originalAllowSelfApproval = config.ALLOW_SELF_APPROVAL;

const FULL_CHECKLIST = {
  reproducible: true,
  noSecrets: true,
  noBlame: true,
  scopeClear: true,
};

let app: FastifyInstance;

function draftPayload(overrides: Record<string, unknown> = {}) {
  return {
    clientRef: REF,
    status: 'draft',
    title: '共有フォルダが開けないときの対処',
    symptom: '共有フォルダをダブルクリックしても開かない。',
    cause: 'ショートカットのリンク先が古い。',
    steps: '1. ショートカットを作り直す\n2. 再ログインする',
    keywords: ['共有フォルダ'],
    ...overrides,
  };
}

async function sync(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/api/knowledge/ui-sync', payload });
}

async function cleanup(): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM knowledge WHERE client_ref LIKE ${REF_PREFIX}
  `;
  for (const row of rows) {
    await sql`DELETE FROM audit_log WHERE target_type = 'knowledge' AND target_id = ${row.id}`;
  }
  await sql`DELETE FROM knowledge WHERE client_ref LIKE ${REF_PREFIX}`;
}

beforeAll(async () => {
  resetRateLimits();
  directory.byEmail.set(DX1_EMAIL, DX1);
  directory.byEmail.set(DX2_EMAIL, DX2);
  directory.byEmail.set(GENERAL_EMAIL, GENERAL);
  directory.staff.push(DX1, DX2);
  app = await buildServer({ logger: false });
  await app.ready();
});

beforeEach(async () => {
  resetRateLimits();
  config.DEV_AUTH_EMAIL = DX1_EMAIL;
  config.ALLOW_SELF_APPROVAL = originalAllowSelfApproval;
  await cleanup();
});

afterAll(async () => {
  config.DEV_AUTH_EMAIL = originalDevEmail;
  config.ALLOW_SELF_APPROVAL = originalAllowSelfApproval;
  await cleanup();
  await app.close();
});

describe('F-06: 画面ナレッジのサーバ永続化', () => {
  it('下書きを申請するとサーバに残り、同じ clientRef の再送で行が増えない', async () => {
    const first = await sync(draftPayload({ status: 'pending' }));
    expect(first.statusCode, first.body).toBe(200);
    const body = first.json();
    expect(body.knowledge.status).toBe('pending');
    expect(body.knowledge.kbNo).toMatch(/^KB-\d{4}-\d{4,}$/);
    expect(body.selfApproved).toBe(true);

    // 二重クリック・再送でも一意インデックス（client_ref）で 1 行に保たれる。
    const again = await sync(draftPayload({ status: 'pending' }));
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().knowledge.id).toBe(body.knowledge.id);

    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM knowledge WHERE client_ref = ${REF}
    `;
    expect(rows[0]?.n).toBe(1);
  });

  it('自己承認は既定で許可し、承認・レビュー・監査を残す（自己承認フラグ付き）', async () => {
    const pending = await sync(draftPayload({ status: 'pending' }));
    expect(pending.statusCode, pending.body).toBe(200);
    const id = pending.json().knowledge.id as string;

    const approved = await sync(draftPayload({ status: 'approved', checklist: FULL_CHECKLIST }));
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().knowledge.status).toBe('approved');
    expect(approved.json().knowledge.version).toBe(2);
    expect(approved.json().selfApproved).toBe(true);

    const reviews = await sql<{ decision: string }[]>`
      SELECT decision FROM knowledge_reviews WHERE knowledge_id = ${id}
    `;
    expect(reviews.map((row) => row.decision)).toEqual(['approved']);

    const audits = await sql<{ action: string; detail: { selfApproved?: boolean } }[]>`
      SELECT action, detail FROM audit_log
      WHERE target_type = 'knowledge' AND target_id = ${id}
      ORDER BY id
    `;
    expect(audits.map((row) => row.action)).toEqual([
      'knowledge.create',
      'knowledge.submit',
      'knowledge.approve',
    ]);
    expect(audits[2]?.detail.selfApproved).toBe(true);
  });

  it('ALLOW_SELF_APPROVAL=false は自己承認を 403 で止め、状態を変えない（SM-02）', async () => {
    const pending = await sync(draftPayload({ status: 'pending' }));
    expect(pending.statusCode, pending.body).toBe(200);
    const id = pending.json().knowledge.id as string;

    config.ALLOW_SELF_APPROVAL = false;
    const denied = await sync(draftPayload({ status: 'approved', checklist: FULL_CHECKLIST }));
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json().error.code).toBe('SELF_APPROVAL_FORBIDDEN');

    const stored = await sql<{ status: string }[]>`SELECT status FROM knowledge WHERE id = ${id}`;
    expect(stored[0]?.status).toBe('pending');
    const reviews = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM knowledge_reviews WHERE knowledge_id = ${id}
    `;
    expect(reviews[0]?.n).toBe(0);
  });

  it('別の DX 担当者が承認すると selfApproved=false になり、承認者を記録する', async () => {
    const pending = await sync(draftPayload({ status: 'pending' }));
    expect(pending.statusCode, pending.body).toBe(200);
    const id = pending.json().knowledge.id as string;

    config.DEV_AUTH_EMAIL = DX2_EMAIL;
    const approved = await sync(draftPayload({ status: 'approved', checklist: FULL_CHECKLIST }));
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().selfApproved).toBe(false);

    const stored = await sql<{ status: string; approver_email: string | null }[]>`
      SELECT k.status, u.email AS approver_email
      FROM knowledge k
      LEFT JOIN users u ON u.id = k.approver_id
      WHERE k.id = ${id}
    `;
    expect(stored[0]?.status).toBe('approved');
    expect(stored[0]?.approver_email).toBe(DX2_EMAIL);
  });

  it('チェックリスト不足の承認は 400、差戻しは理由が必須', async () => {
    const pending = await sync(draftPayload({ status: 'pending' }));
    expect(pending.statusCode, pending.body).toBe(200);

    const incomplete = await sync(
      draftPayload({
        status: 'approved',
        checklist: { ...FULL_CHECKLIST, scopeClear: false },
      }),
    );
    expect(incomplete.statusCode, incomplete.body).toBe(400);

    const noReason = await sync(draftPayload({ status: 'rejected' }));
    expect(noReason.statusCode, noReason.body).toBe(400);

    const rejected = await sync(
      draftPayload({ status: 'rejected', comment: '手順の粒度が不足しています。' }),
    );
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json().knowledge.status).toBe('rejected');
  });

  it('承認者向け pending 一覧: 他人の draft/pending が見え、approved は出ない', async () => {
    config.DEV_AUTH_EMAIL = DX1_EMAIL;
    const draftRef = `${REF}-draft`;
    const pendingRef = `${REF}-pending`;
    const approvedRef = `${REF}-approved`;
    expect((await sync(draftPayload({ clientRef: draftRef, status: 'draft' }))).statusCode).toBe(
      200,
    );
    expect(
      (await sync(draftPayload({ clientRef: pendingRef, status: 'pending' }))).statusCode,
    ).toBe(200);
    expect(
      (
        await sync(
          draftPayload({ clientRef: approvedRef, status: 'approved', checklist: FULL_CHECKLIST }),
        )
      ).statusCode,
    ).toBe(200);

    // 別 ID（承認者）で一覧を取得する。
    config.DEV_AUTH_EMAIL = DX2_EMAIL;
    const list = await app.inject({ method: 'GET', url: '/api/knowledge/pending' });
    expect(list.statusCode, list.body).toBe(200);
    const items = list.json().items as Array<Record<string, unknown>>;
    const draftItem = items.find((item) => item.clientRef === draftRef);
    const pendingItem = items.find((item) => item.clientRef === pendingRef);

    expect(draftItem?.status).toBe('draft');
    expect(pendingItem?.status).toBe('pending');
    expect(draftItem?.authorEmail).toBe(DX1_EMAIL);
    expect(draftItem?.title).toBe('共有フォルダが開けないときの対処');
    expect(draftItem?.symptom).toContain('共有フォルダ');
    expect(draftItem?.steps).toContain('ショートカット');
    expect(draftItem?.keywords).toEqual(['共有フォルダ']);
    expect(typeof draftItem?.kbNo).toBe('string');
    expect(draftItem?.id).toBeTruthy();
    expect(draftItem?.createdAt).toBeTruthy();

    // 承認済みは pending に出さない。
    expect(items.some((item) => item.clientRef === approvedRef)).toBe(false);
  });

  it('pending 一覧は一般社員 403、DX 担当は 200', async () => {
    await sync(draftPayload({ clientRef: `${REF}-auth`, status: 'pending' }));

    config.DEV_AUTH_EMAIL = GENERAL_EMAIL;
    const denied = await app.inject({ method: 'GET', url: '/api/knowledge/pending' });
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');

    config.DEV_AUTH_EMAIL = DX2_EMAIL;
    const allowed = await app.inject({ method: 'GET', url: '/api/knowledge/pending' });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(
      (allowed.json().items as Array<{ clientRef: string }>).some(
        (item) => item.clientRef === `${REF}-auth`,
      ),
    ).toBe(true);
  });
});
