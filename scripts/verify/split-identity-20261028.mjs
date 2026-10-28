/**
 * 同一人物のメール別名を解除した状態（EMAIL_ALIASES=''）で、
 * 運用（k-aritoh）と承認（gmail）が別アカウントとして扱われることを実測する。
 *
 * 対象は検証インスタンス（:18962）と検証 DB（ai_helpdesk_verify）のみ。
 * 本番 DB には書き込まない。
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
const password = hashPassword(`split-${randomUUID()}`);
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

async function upsertUser(email, name, primary, roles) {
  const found = await db`SELECT id FROM users WHERE lower(email) = lower(${email}) LIMIT 1`;
  let id = found[0]?.id;
  if (id) {
    await db`UPDATE users SET role = ${primary}, is_active = true WHERE id = ${id}`;
  } else {
    const ins = await db`
      INSERT INTO users (id, email, name, role, password_hash, is_active)
      VALUES (${randomUUID()}, ${email}, ${name}, ${primary}, ${password}, true)
      RETURNING id
    `;
    id = ins[0].id;
  }
  await db`DELETE FROM user_roles WHERE user_id = ${id}`;
  for (const role of roles) {
    await db`INSERT INTO user_roles (user_id, role, source, granted_by)
             VALUES (${id}, ${role}, 'manual', 'split-verify')`;
  }
  return id;
}

// ---- 前提: 分離後のアカウントとロール --------------------------------
const opId = await upsertUser(OPERATOR, '有**', 'helpdesk', ['helpdesk']);
const apId = await upsertUser(APPROVER, 'kensan1969', 'helpdesk', ['helpdesk', 'approver']);
console.log(`BASE=${BASE} DB=${dbName}`);

// ---- 1. 状態キーの分離 ----------------------------------------------
const s1 = await call(OPERATOR, 'GET', '/api/state');
const s2 = await call(APPROVER, 'GET', '/api/state');
const opState = String(s1.json?.email ?? '');
const apState = String(s2.json?.email ?? '');
if (opState === OPERATOR && apState === APPROVER) {
  ok('状態キーが分離される', `operator=${opState} / approver=${apState}`);
} else {
  ng('状態キーが分離される', `operator=${opState || '-'} / approver=${apState || '-'}`);
}

// ---- 2. 名簿解決（運用は DX、承認は demo） --------------------------
const meOp = await call(OPERATOR, 'GET', '/api/me');
const meAp = await call(APPROVER, 'GET', '/api/me');
const opEmp = meOp.json?.employee?.employeeNo ?? null;
const apEmp = meAp.json?.employee?.employeeNo ?? null;
if (opEmp && !apEmp) {
  ok('名簿解決が分離される', `operator=${opEmp}（DX） / approver=null（demo 扱い）`);
} else {
  ng('名簿解決が分離される', `operator=${opEmp} / approver=${apEmp}`);
}

// ---- 3. 別アカウント承認（handover） --------------------------------
const caseId = `CASE-SPLIT-${Date.now().toString().slice(-6)}`;
const ownerEmail = `split-owner@mirai-const.co.jp`;
await upsertUser(ownerEmail, '検証依頼者', 'requester', ['requester']);
const cowork = {
  v: 31,
  ui: { user: 'u-split', screen: 'home' },
  counters: {},
  cases: [
    {
      id: caseId,
      userId: 'u-split',
      chatId: `chat-${caseId}`,
      subject: '分離検証: 共有フォルダが開けません',
      body: '分離検証用の合成データです。',
      step: 4,
      pc: { state: 'done', snap: { items: [] } },
    },
  ],
  chats: [
    {
      id: `chat-${caseId}`,
      userId: 'u-split',
      title: '分離検証',
      messages: [{ id: 'm1', kind: 'user', text: '共有フォルダが開けません' }],
    },
  ],
  tickets: [],
  proposals: {},
  audit: [],
};
const helpdeskState = {
  actor: 'split',
  seq: { inc: 1, draft: 1, kb: 1 },
  tickets: [],
  drafts: [],
  kb: [],
  audit: [],
};
await call(ownerEmail, 'PUT', '/api/state/cowork', { data: cowork });
await call(ownerEmail, 'PUT', '/api/state/helpdesk', { data: helpdeskState });
const shared = await call(ownerEmail, 'POST', '/api/case-handovers', {
  caseId,
  subject: '分離検証: 共有フォルダが開けません',
  recipientNo: opEmp,
});
const handoverId = shared.json?.handover?.id ?? null;
if (!handoverId) ng('引継ぎ作成', `HTTP ${shared.status} ${JSON.stringify(shared.json)}`);

// 運用者が引き受ける（名簿で本人確認できるため成功する想定）
for (const name of ['cowork', 'helpdesk']) {
  const data = name === 'cowork' ? { ...cowork, cases: [], chats: [] } : helpdeskState;
  await call(OPERATOR, 'PUT', `/api/state/${name}`, { data });
}
const claim = handoverId
  ? await call(OPERATOR, 'POST', `/api/case-handovers/${handoverId}/claim`, {})
  : { status: 0, json: {} };
if (claim.status === 200) {
  ok('運用者（k-aritoh）が指名引継ぎを claim', `HTTP 200 / ${handoverId}`);
} else {
  ng('運用者の claim', `HTTP ${claim.status} ${JSON.stringify(claim.json)}`);
}

// 承認者は別アカウント（gmail）で承認する
const approve = handoverId
  ? await call(APPROVER, 'POST', `/api/case-handovers/${handoverId}/approve`, {})
  : { status: 0, json: {} };
const selfApproved = approve.json?.handover?.selfApproved;
const row = handoverId
  ? await db`SELECT self_approved, approved_by, claimed_by FROM case_handovers WHERE id = ${handoverId}`
  : [];
if (approve.status === 200 && selfApproved === false && row[0]?.self_approved === false) {
  ok(
    '別アカウント承認が成立（self_approved=false）',
    `HTTP 200 / claimed_by=${row[0]?.claimed_by} / approved_by=${row[0]?.approved_by}`,
  );
} else {
  ng(
    '別アカウント承認',
    `HTTP ${approve.status} / selfApproved=${selfApproved} / db=${row[0]?.self_approved} / ${JSON.stringify(approve.json)}`,
  );
}

// ---- 3-2. 同一人物フラグ（sharedIdentity） ---------------------------
if (approve.status === 200) {
  if (approve.json?.handover?.sharedIdentity === true) {
    ok('応答に sharedIdentity=true（別アカウント・同一人物）', 'handover.sharedIdentity=true');
  } else {
    ng(
      '応答の sharedIdentity',
      `handover.sharedIdentity=${approve.json?.handover?.sharedIdentity}`,
    );
  }
}

// ---- 4. 監査に両アカウントが残る ------------------------------------
if (handoverId) {
  const audits = await db`
    SELECT action, detail->>'actorEmail' AS actor,
           detail->>'sharedIdentity' AS shared_identity
    FROM audit_log WHERE target_id = ${handoverId}
    ORDER BY id
  `;
  const actors = [...new Set(audits.map((a) => a.actor).filter(Boolean))];
  const approveAudit = audits.find((a) => a.action === 'case_handover.approve');
  if (approveAudit?.shared_identity === 'true') {
    ok('監査の承認行に sharedIdentity=true', `action=${approveAudit.action}`);
  } else {
    ng('監査の sharedIdentity', `value=${approveAudit?.shared_identity}`);
  }
  if (actors.includes(OPERATOR) && actors.includes(APPROVER)) {
    ok('監査に運用者と承認者が別々に残る', `actors=${actors.join(' / ')}`);
  } else {
    ng('監査の actor', `actors=${actors.join(' / ') || 'なし'}`);
  }
}

// ---- 4-2. ナレッジ承認でも sharedIdentity を記録 --------------------
const kbClientRef = `split-kb-${Date.now()}`;
const kbBody = {
  clientRef: kbClientRef,
  title: '分離検証ナレッジ',
  symptom: '症状',
  cause: '原因',
  steps: '手順',
  keywords: ['検証'],
};
await call(OPERATOR, 'POST', '/api/knowledge/ui-sync', { ...kbBody, status: 'draft' });
await call(OPERATOR, 'POST', '/api/knowledge/ui-sync', { ...kbBody, status: 'pending' });
const kbApprove = await call(APPROVER, 'POST', '/api/knowledge/ui-sync', {
  ...kbBody,
  status: 'approved',
  comment: '分離検証',
  checklist: { reproducible: true, noSecrets: true, noBlame: true, scopeClear: true },
});
const kbRow = await db`SELECT id FROM knowledge WHERE client_ref = ${kbClientRef} LIMIT 1`;
const kbAudit = kbRow[0]
  ? await db`
      SELECT detail->>'selfApproved' AS self_approved, detail->>'sharedIdentity' AS shared_identity
      FROM audit_log WHERE target_id = ${kbRow[0].id} AND action = 'knowledge.approve'
    `
  : [];
if (
  kbApprove.status === 200 &&
  kbApprove.json?.sharedIdentity === true &&
  kbAudit[0]?.shared_identity === 'true' &&
  kbAudit[0]?.self_approved === 'false'
) {
  ok(
    'ナレッジ承認でも sharedIdentity=true',
    'selfApproved=false / sharedIdentity=true（応答・監査）',
  );
} else {
  ng(
    'ナレッジ承認の sharedIdentity',
    `HTTP ${kbApprove.status} / 応答=${kbApprove.json?.sharedIdentity} / 監査=${kbAudit[0]?.shared_identity} / ${JSON.stringify(kbApprove.json).slice(0, 160)}`,
  );
}
if (kbRow[0]) {
  await db`DELETE FROM knowledge_reviews WHERE knowledge_id = ${kbRow[0].id}`;
  await db`DELETE FROM audit_log WHERE target_id = ${kbRow[0].id}`;
  await db`DELETE FROM knowledge WHERE id = ${kbRow[0].id}`;
}

// ---- 5. 後始末（検証 DB のみ） --------------------------------------
if (handoverId) {
  await db`DELETE FROM audit_log WHERE target_id = ${handoverId}`;
  await db`DELETE FROM case_handovers WHERE id = ${handoverId}`;
}
await db`DELETE FROM prototype_states WHERE user_email IN (${ownerEmail}, ${OPERATOR}, ${APPROVER})`;
await db`DELETE FROM users WHERE email = ${ownerEmail}`;
console.log(`\n結果: ${results.filter((r) => r.verdict === 'PASS').length}/${results.length} PASS`);
await db.end();
