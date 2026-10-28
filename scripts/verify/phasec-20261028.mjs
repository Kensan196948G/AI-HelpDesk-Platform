/**
 * Phase C（ALLOW_SELF_APPROVAL=false）の実測。
 * - 同一アカウントの承認 → 403 SELF_APPROVAL_FORBIDDEN
 * - 別アカウント（同一人物）の承認 → 200 / self_approved=false / sharedIdentity=true
 * 対象は検証インスタンス（:18962）と検証 DB（ai_helpdesk_verify）のみ。
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { hashPassword } from '../../apps/api/dist/auth/password.js';

const BASE = process.env.BASE || 'http://127.0.0.1:18962';
const DBURL = process.env.DATABASE_URL;
if (!DBURL) {
  console.error('DATABASE_URL（検証 DB）を指定してください。');
  process.exit(2);
}
const dbName = decodeURIComponent(new URL(DBURL).pathname.replace(/^\//, ''));
if (dbName !== 'ai_helpdesk_verify') {
  console.error(`検証 DB 以外は拒否します（DB=${dbName}）。`);
  process.exit(2);
}
const db = postgres(DBURL, { max: 2, onnotice: () => {} });
const OPERATOR = 'k-aritoh@mirai-const.co.jp';
const APPROVER = 'kensan1969@gmail.com';
const password = hashPassword(`phasec-${randomUUID()}`);
const results = [];
const ok = (name, detail) => {
  results.push({ name, verdict: 'PASS', detail });
  console.log(`  OK  ${name} :: ${detail}`);
};
const ng = (name, detail) => {
  results.push({ name, verdict: 'FAIL', detail });
  console.log(`  NG  ${name} :: ${detail}`);
};

async function call(email, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'cf-access-authenticated-user-email': email },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

async function upsertUser(email, name, roles) {
  const found = await db`SELECT id FROM users WHERE lower(email) = lower(${email}) LIMIT 1`;
  let id = found[0]?.id;
  if (id) {
    await db`UPDATE users SET is_active = true WHERE id = ${id}`;
  } else {
    const ins = await db`
      INSERT INTO users (id, email, name, role, password_hash, is_active)
      VALUES (${randomUUID()}, ${email}, ${name}, ${roles[0]}, ${password}, true)
      RETURNING id
    `;
    id = ins[0].id;
  }
  await db`DELETE FROM user_roles WHERE user_id = ${id}`;
  for (const role of roles) {
    await db`INSERT INTO user_roles (user_id, role, source, granted_by)
             VALUES (${id}, ${role}, 'manual', 'phasec-verify')`;
  }
  return id;
}

async function makeClaimedHandover(tag) {
  const caseId = `CASE-PC-${tag}-${Date.now().toString().slice(-5)}`;
  await db`
    INSERT INTO cases (id, case_no, requester_id, category, subject, body, urgency, signal, current_step, status, ai_resolved)
    VALUES (${randomUUID()}, ${caseId}, ${ownerId}, 'file_share', ${'Phase C 検証 ' + tag}, '合成データ', 'normal', 'blue', 4, 'in_progress', false)
  `;
  const cowork = {
    v: 31,
    ui: { user: 'u-pc', screen: 'home' },
    counters: {},
    cases: [
      {
        id: caseId,
        userId: 'u-pc',
        chatId: `chat-${caseId}`,
        subject: `Phase C 検証 ${tag}`,
        body: '合成データ',
        step: 4,
        pc: { state: 'done', snap: { items: [] } },
      },
    ],
    chats: [{ id: `chat-${caseId}`, userId: 'u-pc', title: tag, messages: [] }],
    tickets: [],
    proposals: {},
    audit: [],
  };
  await call(ownerEmail, 'PUT', '/api/state/cowork', { data: cowork });
  await call(ownerEmail, 'PUT', '/api/state/helpdesk', {
    data: {
      actor: 'pc',
      seq: { inc: 1, draft: 1, kb: 1 },
      tickets: [],
      drafts: [],
      kb: [],
      audit: [],
    },
  });
  const shared = await call(ownerEmail, 'POST', '/api/case-handovers', { caseId, subject: tag });
  const handoverId = shared.json?.handover?.id ?? null;
  if (!handoverId) throw new Error(`handover 作成失敗 ${shared.status}`);
  await call(OPERATOR, 'PUT', '/api/state/cowork', {
    data: {
      v: 31,
      ui: { user: 'u-op', screen: 'home' },
      counters: {},
      cases: [],
      chats: [],
      tickets: [],
      proposals: {},
      audit: [],
    },
  });
  await call(OPERATOR, 'PUT', '/api/state/helpdesk', {
    data: {
      actor: 'op',
      seq: { inc: 1, draft: 1, kb: 1 },
      tickets: [],
      drafts: [],
      kb: [],
      audit: [],
    },
  });
  const claim = await call(OPERATOR, 'POST', `/api/case-handovers/${handoverId}/claim`, {});
  if (claim.status !== 200) throw new Error(`claim 失敗 ${claim.status}`);
  return handoverId;
}

const ownerEmail = `pc-owner@mirai-const.co.jp`;
await upsertUser(OPERATOR, '有**', ['helpdesk', 'approver']);
await upsertUser(APPROVER, 'kensan1969', ['helpdesk', 'approver']);
const ownerId = await upsertUser(ownerEmail, '検証依頼者', ['requester']);
console.log(`BASE=${BASE} DB=${dbName}`);

const created = [];
try {
  // 1) 同一アカウントの自己承認 → 403
  const h1 = await makeClaimedHandover('self');
  created.push(h1);
  const selfApprove = await call(OPERATOR, 'POST', `/api/case-handovers/${h1}/approve`, {});
  const code = selfApprove.json?.error?.code;
  if (selfApprove.status === 403 && code === 'SELF_APPROVAL_FORBIDDEN') {
    ok('同一アカウントの承認は拒否', `HTTP 403 / ${code}`);
  } else {
    ng('同一アカウントの承認', `HTTP ${selfApprove.status} / code=${code}`);
  }

  // 2) 別アカウント（同一人物）の承認 → 200
  const h2 = await makeClaimedHandover('other');
  created.push(h2);
  const otherApprove = await call(APPROVER, 'POST', `/api/case-handovers/${h2}/approve`, {});
  const row =
    otherApprove.status === 200
      ? await db`SELECT self_approved FROM case_handovers WHERE id = ${h2}`
      : [];
  if (otherApprove.status === 200 && row[0]?.self_approved === false) {
    ok(
      '別アカウントの承認は成立',
      `HTTP 200 / self_approved=false / sharedIdentity=${otherApprove.json?.handover?.sharedIdentity}`,
    );
  } else {
    ng(
      '別アカウントの承認',
      `HTTP ${otherApprove.status} / ${JSON.stringify(otherApprove.json).slice(0, 160)}`,
    );
  }
} finally {
  for (const id of created) {
    await db`DELETE FROM audit_log WHERE target_id = ${id}`;
    await db`DELETE FROM case_handovers WHERE id = ${id}`;
  }
  await db`DELETE FROM cases WHERE requester_id = ${ownerId}`;
  await db`DELETE FROM case_handovers WHERE owner_email = ${ownerEmail}`;
  await db`DELETE FROM prototype_states WHERE user_email IN (${ownerEmail}, ${OPERATOR}, ${APPROVER})`;
  await db`DELETE FROM users WHERE email = ${ownerEmail}`;
}
console.log(`\n結果: ${results.filter((r) => r.verdict === 'PASS').length}/${results.length} PASS`);
await db.end();
