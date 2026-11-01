import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashSessionToken } from '../auth/password.js';
import { clearUiRoleCache } from '../auth/ui.js';
import { config } from '../config.js';
import { sql } from '../db.js';
import { findApprovedKnowledge } from '../lib/knowledge-search.js';
import { resetRateLimits } from '../lib/rate-limit.js';
import { buildServer } from '../server.js';

/**
 * 承認者が確認した本文だけが公開されること（docs/64 §10）。
 * 競合は sleep を使わず、別接続の未コミット更新で承認の UPDATE を待たせて決定的に作る。
 */
const directory = vi.hoisted(() => ({
  byEmail: new Map<string, Record<string, unknown>>(),
  staff: [] as Record<string, unknown>[],
}));

vi.mock('../lib/mirai-info.js', () => ({
  findEmployeeByEmail: async (email: string) =>
    directory.byEmail.get(String(email || '').toLowerCase()) ?? null,
  findEmployeeEmailByNo: async () => null,
  listEmployees: async () => ({
    employees: directory.staff,
    total: directory.staff.length,
    cachedAt: new Date().toISOString(),
  }),
  filterStaff: (rows: Record<string, unknown>[]) =>
    rows.filter((row) => row.section === 'DX推進部'),
}));

const AUTHOR = 'kbbind-author@example.com';
const APPROVER = 'kbbind-approver@example.com';
const REF_PREFIX = 'kb-bind-';
const FULL_CHECKLIST = { reproducible: true, noSecrets: true, noBlame: true, scopeClear: true };

const original = {
  devEmail: config.DEV_AUTH_EMAIL,
  allowSelf: config.ALLOW_SELF_APPROVAL,
};

let app: FastifyInstance;
let sequence = 0;
/** 作成者の更新を未コミットで保持するための別接続。 */
let other: postgres.Sql;
let approverToken = '';

function as(email: string): void {
  config.DEV_AUTH_EMAIL = email;
  clearUiRoleCache();
}

const nextRef = () => `${REF_PREFIX}${++sequence}`;

const BODY = {
  title: 'プリンタの紙詰まりの手順',
  symptom: '印刷すると紙詰まりの表示が出る',
  cause: '給紙トレイの紙が斜めに入っている',
  steps: '1. トレイを開く\n2. 紙を入れ直す',
  keywords: ['プリンタ', '紙詰まり'],
};

async function syncAs(email: string, body: Record<string, unknown>) {
  as(email);
  return app.inject({ method: 'POST', url: '/api/knowledge/ui-sync', payload: body });
}

/** 作成者が申請した行を 1 件作り、承認者の一覧から見える形で返す。 */
async function submitted(over: Partial<typeof BODY> = {}) {
  const clientRef = nextRef();
  const payload = { clientRef, status: 'pending', ...BODY, ...over };
  const res = await syncAs(AUTHOR, payload);
  expect(res.statusCode).toBe(200);
  const id = res.json().knowledge.id as string;
  return { id, clientRef, payload };
}

async function pendingItem(id: string) {
  as(APPROVER);
  const res = await app.inject({ method: 'GET', url: '/api/knowledge/pending' });
  expect(res.statusCode).toBe(200);
  return res.json().items.find((item: { id: string }) => item.id === id);
}

/** /review はセッション Cookie の API（ui-sync と認証の経路が違う）。 */
async function review(id: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/knowledge/${id}/review`,
    cookies: { aihd_session: approverToken },
    payload,
  });
}

async function rowOf(id: string) {
  const rows = await sql<any[]>`SELECT * FROM knowledge WHERE id = ${id}`;
  return rows[0];
}

/**
 * 別接続で本文を未コミットのまま更新し、`request()` が行ロックで待つのを確かめてから COMMIT する。
 * これで「本文の取得の後に作成者の更新が確定する」順序を毎回作る。
 */
async function withCommitDuringApproval<T>(
  id: string,
  change: { steps?: string; keywords?: string[] },
  request: () => Promise<T>,
): Promise<T> {
  const reserved = await other.reserve();
  try {
    await reserved`BEGIN`;
    await reserved`
      UPDATE knowledge SET
        steps = COALESCE(${change.steps ?? null}, steps),
        keywords = COALESCE(${change.keywords ?? null}::text[], keywords)
      WHERE id = ${id}
    `;
    const pendingRequest = request();
    const deadline = Date.now() + 8_000;
    let blocked = false;
    while (Date.now() < deadline) {
      const rows = await other<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%knowledge%'
      `;
      if ((rows[0]?.n ?? 0) > 0) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await reserved`COMMIT`;
    const result = await pendingRequest;
    // 待ちに入らなかったなら、この試験は競合を再現していない（順序が違えば成功扱いにしない）。
    expect(blocked, '承認の更新が行ロックを待っていません').toBe(true);
    return result;
  } finally {
    reserved.release();
  }
}

async function ensureUser(email: string, roles: string[]): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, role, password_hash)
    VALUES (${email}, ${email}, 'helpdesk', 'access-only$no-login')
    ON CONFLICT (lower(email)) DO UPDATE SET updated_at = now()
    RETURNING id
  `;
  const id = rows[0]?.id ?? '';
  for (const role of roles) {
    await sql`
      INSERT INTO user_roles (user_id, role, source, granted_by)
      VALUES (${id}, ${role}, 'manual', 'test')
      ON CONFLICT DO NOTHING
    `;
  }
  return id;
}

beforeAll(async () => {
  other = postgres(config.DATABASE_URL, { max: 2, onnotice: () => {} });
  config.ALLOW_SELF_APPROVAL = false;
  directory.byEmail.set(AUTHOR, { employeeNo: 'B1', name: '作成者', section: 'DX推進部' });
  directory.byEmail.set(APPROVER, { employeeNo: 'B2', name: '承認者', section: 'DX推進部' });
  directory.staff.push(
    directory.byEmail.get(AUTHOR) as Record<string, unknown>,
    directory.byEmail.get(APPROVER) as Record<string, unknown>,
  );
  await ensureUser(AUTHOR, ['helpdesk']);
  const approverId = await ensureUser(APPROVER, ['helpdesk', 'approver']);
  approverToken = `kbbind-approver-${randomUUID()}`;
  await sql`DELETE FROM sessions WHERE user_id = ${approverId}`;
  await sql`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${approverId}, ${hashSessionToken(approverToken, config.SESSION_SECRET)},
      now() + interval '1 hour')
  `;
  clearUiRoleCache();
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  config.DEV_AUTH_EMAIL = original.devEmail;
  config.ALLOW_SELF_APPROVAL = original.allowSelf;
  await sql`DELETE FROM knowledge WHERE client_ref LIKE ${`${REF_PREFIX}%`}`;
  await app.close();
  await other.end();
});

beforeEach(() => {
  resetRateLimits();
  clearUiRoleCache();
});

afterEach(async () => {
  await sql`DELETE FROM knowledge WHERE client_ref LIKE ${`${REF_PREFIX}%`}`;
});

describe('本文の束縛: POST /knowledge/:id/review', () => {
  it('一覧と詳細が本文のハッシュを返す', async () => {
    const { id } = await submitted();
    const item = await pendingItem(id);
    expect(item.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(item.version).toBe(1);
  });

  it('本文のハッシュが無い承認は拒否する', async () => {
    const { id } = await submitted();
    const res = await review(id, { decision: 'approved', checklist: FULL_CHECKLIST });
    expect(res.statusCode).toBe(400);
    expect((await rowOf(id)).status).toBe('pending');
  });

  it('確認の後に本文が変わっていれば 409 で公開しない', async () => {
    const { id, payload } = await submitted();
    const item = await pendingItem(id);
    const changed = await syncAs(AUTHOR, { ...payload, steps: '1. 確認していない手順' });
    expect(changed.statusCode).toBe(200);
    const res = await review(id, {
      decision: 'approved',
      checklist: FULL_CHECKLIST,
      contentHash: item.contentHash,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('KB_CONTENT_CHANGED');
    const row = await rowOf(id);
    expect(row.status).toBe('pending');
    expect(row.approver_id).toBeNull();
  });

  it('確認の後に keywords だけ変わっても 409 で公開しない', async () => {
    const { id, payload } = await submitted();
    const item = await pendingItem(id);
    await syncAs(AUTHOR, { ...payload, keywords: ['別の語'] });
    const res = await review(id, {
      decision: 'approved',
      checklist: FULL_CHECKLIST,
      contentHash: item.contentHash,
    });
    expect(res.statusCode).toBe(409);
    expect((await rowOf(id)).status).toBe('pending');
  });

  it('競合: 本文の読み取りの後に更新が確定しても未確認の本文を公開しない', async () => {
    const { id } = await submitted();
    const item = await pendingItem(id);
    const res = await withCommitDuringApproval(id, { steps: '1. 競合で入った未確認の手順' }, () =>
      review(id, {
        decision: 'approved',
        checklist: FULL_CHECKLIST,
        contentHash: item.contentHash,
      }),
    );
    expect(res.statusCode).toBe(409);
    const row = await rowOf(id);
    expect(row.status).toBe('pending');
    expect(row.steps).toBe('1. 競合で入った未確認の手順');
    const reviews = await sql`SELECT id FROM knowledge_reviews WHERE knowledge_id = ${id}`;
    expect(reviews).toHaveLength(0);
  });

  it('一致すれば公開し、確認した本文のハッシュと公開版を記録する', async () => {
    const { id } = await submitted();
    const item = await pendingItem(id);
    const res = await review(id, {
      decision: 'approved',
      checklist: FULL_CHECKLIST,
      contentHash: item.contentHash,
    });
    expect(res.statusCode).toBe(200);
    const row = await rowOf(id);
    expect(row.status).toBe('approved');
    expect(row.version).toBe(2);
    const reviews = await sql<any[]>`
      SELECT content_hash, published_version FROM knowledge_reviews WHERE knowledge_id = ${id}
    `;
    expect(reviews[0]?.content_hash).toBe(item.contentHash);
    expect(reviews[0]?.published_version).toBe(2);
    const audit = await sql<any[]>`
      SELECT detail FROM audit_log
      WHERE target_id = ${id} AND action = 'knowledge.approve'
    `;
    const detail =
      typeof audit[0]?.detail === 'string' ? JSON.parse(audit[0].detail) : audit[0]?.detail;
    expect(detail.contentHash).toBe(item.contentHash);
    expect(detail.publishedVersion).toBe(2);
  });
});

describe('下書き番号が重なるとき', () => {
  it('指紋つきの承認は一覧で読んだ他人の行に当たり、自分の同じ番号の行を上書きしない', async () => {
    const { id, clientRef, payload } = await submitted();
    // 承認者にも同じ番号の下書きがある（衝突すると別の行になる）。
    const own = await syncAs(APPROVER, {
      ...payload,
      title: '承認者の別の下書き',
      status: 'draft',
    });
    expect(own.statusCode).toBe(200);
    const ownId = own.json().knowledge.id;
    expect(ownId).not.toBe(id);
    const item = await pendingItem(id);
    const res = await syncAs(APPROVER, {
      clientRef,
      status: 'approved',
      title: item.title,
      symptom: item.symptom,
      cause: item.cause,
      steps: item.steps,
      keywords: item.keywords,
      checklist: FULL_CHECKLIST,
      contentHash: item.contentHash,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().selfApproved).toBe(false);
    expect((await rowOf(id)).status).toBe('approved');
    const mine = await rowOf(ownId);
    expect(mine.status).toBe('draft');
    expect(mine.title).toBe('承認者の別の下書き');
  });
});

describe('本文の束縛: POST /knowledge/ui-sync', () => {
  const approvePayload = (item: Record<string, unknown>, clientRef: string) => ({
    clientRef,
    status: 'approved',
    title: item.title,
    symptom: item.symptom,
    cause: item.cause,
    steps: item.steps,
    keywords: item.keywords,
    checklist: FULL_CHECKLIST,
    contentHash: item.contentHash,
  });

  it('本文のハッシュが無い他人の KB の承認は拒否する', async () => {
    const { id, clientRef } = await submitted();
    const item = await pendingItem(id);
    const { contentHash: _omit, ...payload } = approvePayload(item, clientRef);
    const res = await syncAs(APPROVER, payload);
    expect(res.statusCode).toBe(400);
    expect((await rowOf(id)).status).toBe('pending');
  });

  it('確認の後に keywords だけ変わっていれば 409 で公開しない', async () => {
    const { id, clientRef, payload } = await submitted();
    const item = await pendingItem(id);
    await syncAs(AUTHOR, { ...payload, keywords: ['差し替えた語'] });
    const res = await syncAs(APPROVER, approvePayload(item, clientRef));
    expect(res.statusCode).toBe(409);
    expect((await rowOf(id)).status).toBe('pending');
  });

  it('送った本文と確認したハッシュが違えば 409 で公開しない', async () => {
    const { id, clientRef } = await submitted();
    const item = await pendingItem(id);
    const res = await syncAs(APPROVER, {
      ...approvePayload(item, clientRef),
      contentHash: `sha256:${createHash('sha256').update('別の本文').digest('hex')}`,
    });
    expect(res.statusCode).toBe(409);
    expect((await rowOf(id)).status).toBe('pending');
  });

  it('競合: 本文の読み取りの後に本文の更新が確定しても公開しない', async () => {
    const { id, clientRef } = await submitted();
    const item = await pendingItem(id);
    as(APPROVER);
    const res = await withCommitDuringApproval(id, { steps: '1. 競合で入った未確認の手順' }, () =>
      app.inject({
        method: 'POST',
        url: '/api/knowledge/ui-sync',
        payload: approvePayload(item, clientRef),
      }),
    );
    expect(res.statusCode).toBe(409);
    expect((await rowOf(id)).status).toBe('pending');
  });

  it('競合: 本文の読み取りの後に keywords の更新が確定しても公開しない', async () => {
    const { id, clientRef } = await submitted();
    const item = await pendingItem(id);
    as(APPROVER);
    const res = await withCommitDuringApproval(id, { keywords: ['競合で入った語'] }, () =>
      app.inject({
        method: 'POST',
        url: '/api/knowledge/ui-sync',
        payload: approvePayload(item, clientRef),
      }),
    );
    expect(res.statusCode).toBe(409);
    expect((await rowOf(id)).status).toBe('pending');
  });

  it('一致すれば公開し、確認した本文のハッシュと公開版を記録する', async () => {
    const { id, clientRef } = await submitted();
    const item = await pendingItem(id);
    const res = await syncAs(APPROVER, approvePayload(item, clientRef));
    expect(res.statusCode).toBe(200);
    expect((await rowOf(id)).status).toBe('approved');
    const reviews = await sql<any[]>`
      SELECT content_hash, published_version FROM knowledge_reviews WHERE knowledge_id = ${id}
    `;
    expect(reviews[0]?.content_hash).toBe(item.contentHash);
    expect(reviews[0]?.published_version).toBe(2);
  });
});

describe('メタデータの保護: keywords', () => {
  const DEVICE_WORD = 'DESKTOP-ABC1234';

  it('保存時に keywords の端末情報を伏せる', async () => {
    const { id } = await submitted({ keywords: ['プリンタ', DEVICE_WORD] });
    const row = await rowOf(id);
    expect(row.keywords.join(' ')).not.toContain(DEVICE_WORD);
  });

  it('承認時に保存済みの keywords に端末情報があれば公開しない', async () => {
    const { id } = await submitted();
    // 修正前に保存された行を作る。
    await sql`UPDATE knowledge SET keywords = ${[DEVICE_WORD]}::text[] WHERE id = ${id}`;
    const item = await pendingItem(id);
    const res = await review(id, {
      decision: 'approved',
      checklist: FULL_CHECKLIST,
      contentHash: item.contentHash,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('KB_CONTAINS_DEVICE_INFO');
    expect((await rowOf(id)).status).toBe('pending');
  });

  it('公開済みの行は閲覧時と AI の入力で伏せ、行そのものは書き換えない', async () => {
    const { id } = await submitted();
    const item = await pendingItem(id);
    await review(id, {
      decision: 'approved',
      checklist: FULL_CHECKLIST,
      contentHash: item.contentHash,
    });
    // 修正前に公開された行を作る（更新時刻で根拠から外れないよう承認時刻も揃える）。
    await sql`
      UPDATE knowledge SET keywords = ${['プリンタ', DEVICE_WORD]}::text[], approved_at = now()
      WHERE id = ${id}
    `;
    const res = await app.inject({
      method: 'GET',
      url: `/api/knowledge/${id}`,
      cookies: { aihd_session: approverToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().knowledge.keywords).toEqual(['プリンタ']);
    const found = await findApprovedKnowledge(sql, 'プリンタの紙詰まり', ['プリンタ']);
    const hit = found.find((row) => row.id === id);
    expect(hit?.keywords).toEqual(['プリンタ']);
    expect((await rowOf(id)).keywords).toEqual(['プリンタ', DEVICE_WORD]);
  });
});

describe('承認者の画面の API（docs/14 §2-17）', () => {
  const REQUESTER = 'kbbind-requester@example.com';

  async function handover(status: string, claimedBy: string | null) {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO case_handovers (case_id, owner_email, status, snapshot, claimed_by)
      VALUES (${`KB-BIND-${++sequence}`}, ${REQUESTER}, ${status},
        ${sql.json({
          case: { subject: '印刷できない DESKTOP-ABC1234', body: '本文は返さない' },
          inc: { requester: REQUESTER },
        })}, ${claimedBy})
      RETURNING id
    `;
    return rows[0]?.id ?? '';
  }

  afterEach(async () => {
    await sql`DELETE FROM case_handovers WHERE case_id LIKE 'KB-BIND-%'`;
  });

  it('完了待ちだけを最小限の項目で返し、相談者と端末を返さない', async () => {
    const resolved = await handover('resolved', AUTHOR);
    const claimed = await handover('claimed', AUTHOR);
    const pending = await handover('pending', null);
    as(APPROVER);
    const res = await app.inject({ method: 'GET', url: '/api/case-handovers/awaiting-approval' });
    expect(res.statusCode, res.body).toBe(200);
    const ids = res.json().items.map((item: { id: string }) => item.id);
    expect(ids).toContain(resolved);
    expect(ids).not.toContain(claimed);
    expect(ids).not.toContain(pending);
    const text = res.body;
    expect(text).not.toContain(REQUESTER);
    expect(text).not.toContain('DESKTOP-ABC1234');
    expect(text).not.toContain('本文は返さない');
  });

  it('承認者でなければ一覧を見られない', async () => {
    as(AUTHOR);
    const res = await app.inject({ method: 'GET', url: '/api/case-handovers/awaiting-approval' });
    expect(res.statusCode).toBe(403);
  });
});
