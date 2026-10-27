/**
 * 差分検証 V-01〜V-24（docs/52）を稼働中の検証インスタンス :18962 に対して実行する。
 *
 * - 対象 DB は検証専用（`ai_helpdesk_verify`）。本番 DB へは書き込まない。
 * - 認証: UI 経路は Cloudflare Access の email ヘッダー、セッション経路は
 *   `/api/auth/login` で作った Cookie を使う（検証用ユーザーはこのスクリプトが作る）。
 * - 出力: docs/evidence/verify-20261027/delta/results.json（メールは伏せ字）。
 *
 * 実行:
 *   BASE=http://127.0.0.1:18962 DATABASE_URL=<verify DB> node scripts/verify/delta-20261028.mjs
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';

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

const db = postgres(DBURL, { max: 4, onnotice: () => {} });
const info = postgres({
  host: '/var/run/postgresql',
  database: 'mirai_info',
  username: process.env.USER,
  max: 2,
});
await info.unsafe('SET default_transaction_read_only = on');

const mask = (email) => String(email || '').replace(/^([^@])[^@]*@/, '$1***@');
const results = [];
const notes = [];
function record(id, name, expected, actual, verdict, note = '') {
  results.push({ id, name, expected, actual, verdict, note });
  const mark = verdict === 'PASS' ? 'PASS' : verdict;
  console.log(`[${mark}] ${id} ${name} :: ${actual}${note ? ' :: ' + note : ''}`);
}

async function call(actor, method, path, body, extraHeaders = {}) {
  const headers = { 'content-type': 'application/json', ...extraHeaders };
  if (actor?.email) headers['cf-access-authenticated-user-email'] = actor.email;
  if (actor?.cookie) headers.cookie = actor.cookie;
  const res = await fetch(BASE + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, json, headers: res.headers };
}

const errCode = (r) => r.json?.error?.code ?? r.json?.code ?? null;
const errMsg = (r) => r.json?.error?.message ?? r.json?.message ?? r.json?.raw ?? '';

// ---- 1. 名簿から検証用の登場人物を決める --------------------------------
const dx = await info`
  SELECT DISTINCT ON (lower(btrim(email))) email, name, employee_no, section
  FROM mirai_info.employee_directory
  WHERE status = '有効' AND section = 'DX推進部' AND coalesce(btrim(email), '') <> ''
  ORDER BY lower(btrim(email)), updated_at DESC
`;
const others = await info`
  SELECT DISTINCT ON (lower(btrim(email))) email, name, employee_no, section
  FROM mirai_info.employee_directory
  WHERE status = '有効' AND coalesce(section, '') <> 'DX推進部'
    AND coalesce(btrim(email), '') <> ''
  ORDER BY lower(btrim(email)), updated_at DESC
  LIMIT 5
`;
if (dx.length < 4 || others.length < 1) {
  console.error(`名簿の件数が不足しています（DX=${dx.length} / 他=${others.length}）。`);
  process.exit(2);
}

/**
 * 別名（EMAIL_ALIASES）で同一人物に正規化されるアカウントは、状態・権限が
 * 共有されてしまうため検証の主体に使わない（E2E と同じ方針）。
 */
async function pickDistinct(list, need) {
  const picked = [];
  const seen = new Set();
  for (const person of list) {
    const email = String(person.email ?? '')
      .trim()
      .toLowerCase();
    if (!email) continue;
    const probe = await call({ email }, 'GET', '/api/state');
    const canonical = String(probe.json?.email ?? '')
      .trim()
      .toLowerCase();
    if (probe.status !== 200 || canonical !== email) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    picked.push({ email, name: person.name, no: person.employee_no });
    if (picked.length >= need) return picked;
  }
  console.error(`検証に使える主体が足りません（必要 ${need} / 取得 ${picked.length}）。`);
  process.exit(2);
}

const dxPicked = await pickDistinct(dx, 4);
const otherPicked = await pickDistinct(others, 1);
const DOMAIN = dxPicked[0].email.split('@')[1].toLowerCase();
const ownerEmail = `aihd-delta-owner@${DOMAIN}`;

const people = {
  deskB: dxPicked[0],
  deskC: dxPicked[1],
  auditor: dxPicked[2],
  multi: dxPicked[3],
  outside: otherPicked[0],
};
console.log(
  `BASE=${BASE} DB=${dbName} DX=${dx.length} 名 / B=${mask(people.deskB.email)} C=${mask(
    people.deskC.email,
  )} audit=${mask(people.auditor.email)} multi=${mask(people.multi.email)} outside=${mask(
    people.outside.email,
  )}`,
);

// ---- 2. 検証用ユーザーとロールを用意する --------------------------------
const { hashPassword } = await import('../../apps/api/dist/auth/password.js');
const { validateRoleSet } = await import('../../apps/api/dist/auth/role-values.js');
const PASSWORD = `delta-${randomUUID()}`;
const passwordHash = hashPassword(PASSWORD);

async function upsertUser(email, name, primaryRole, roles) {
  const existing = await db`
    SELECT id FROM users WHERE lower(email) = lower(${email}) LIMIT 1
  `;
  let id = existing[0]?.id;
  if (id) {
    await db`
      UPDATE users SET role = ${primaryRole}, password_hash = ${passwordHash}, is_active = true
      WHERE id = ${id}
    `;
  } else {
    const rows = await db`
      INSERT INTO users (id, email, name, role, password_hash, is_active)
      VALUES (${randomUUID()}, ${email}, ${name ?? email}, ${primaryRole}, ${passwordHash}, true)
      RETURNING id
    `;
    id = rows[0].id;
  }
  await db`DELETE FROM user_roles WHERE user_id = ${id}`;
  for (const role of roles) {
    await db`INSERT INTO user_roles (user_id, role, source, granted_by)
             VALUES (${id}, ${role}, 'manual', 'delta-verify')`;
  }
  return id;
}

const ids = {};
ids.owner = await upsertUser(ownerEmail, '検証依頼者', 'requester', ['requester']);
ids.deskB = await upsertUser(people.deskB.email, people.deskB.name, 'helpdesk', ['helpdesk']);
ids.deskC = await upsertUser(people.deskC.email, people.deskC.name, 'approver', ['approver']);
ids.auditor = await upsertUser(people.auditor.email, people.auditor.name, 'auditor', ['auditor']);
ids.multi = await upsertUser(people.multi.email, people.multi.name, 'helpdesk', [
  'helpdesk',
  'itops',
]);
ids.outside = await upsertUser(people.outside.email, people.outside.name, 'requester', [
  'requester',
]);

const owner = { email: ownerEmail, id: ids.owner };
const deskB = { email: people.deskB.email, id: ids.deskB };
const deskC = { email: people.deskC.email, id: ids.deskC };

// ---- 3. 共通フィクスチャ ------------------------------------------------
const minimalCowork = (tag) => ({
  v: 31,
  ui: { user: `u-${tag}`, screen: 'home' },
  counters: {},
  cases: [],
  chats: [],
  tickets: [],
  proposals: {},
  audit: [],
});
const minimalHelpdesk = (tag) => ({
  actor: tag,
  seq: { inc: 1, draft: 1, kb: 1 },
  tickets: [],
  drafts: [],
  kb: [],
  audit: [],
});

async function primeStates(actor, tag) {
  for (const name of ['cowork', 'helpdesk']) {
    const body = name === 'cowork' ? minimalCowork(tag) : minimalHelpdesk(tag);
    const r = await call(actor, 'PUT', `/api/state/${name}`, { data: body });
    if (r.status !== 200) throw new Error(`state ${name} 保存失敗 ${r.status}`);
  }
}

async function createCase(caseId, subject) {
  await db`
    INSERT INTO cases (id, case_no, requester_id, category, subject, body, urgency, signal, current_step, status, ai_resolved)
    VALUES (${randomUUID()}, ${caseId}, ${ids.owner}, 'file_share', ${subject}, '差分検証用の合成データです。', 'normal', 'blue', 4, 'in_progress', false)
  `;
}

async function ownerShare(caseId, subject, recipientNo) {
  const cowork = minimalCowork('delta');
  cowork.cases = [
    {
      id: caseId,
      userId: 'u-delta',
      chatId: `chat-${caseId}`,
      subject,
      body: '差分検証用の合成データです。',
      step: 4,
      pc: { state: 'done', snap: { items: [] } },
    },
  ];
  cowork.chats = [
    {
      id: `chat-${caseId}`,
      userId: 'u-delta',
      title: subject,
      messages: [{ id: 'm1', kind: 'user', text: subject }],
    },
  ];
  let r = await call(owner, 'PUT', '/api/state/cowork', { data: cowork });
  if (r.status !== 200) throw new Error(`owner state ${r.status}`);
  r = await call(owner, 'PUT', '/api/state/helpdesk', { data: minimalHelpdesk('owner') });
  if (r.status !== 200) throw new Error(`owner helpdesk state ${r.status}`);
  const res = await call(owner, 'POST', '/api/case-handovers', {
    caseId,
    subject,
    ...(recipientNo ? { recipientNo } : {}),
  });
  return res;
}

// ---- V-01: /auth/me が複数ロールを返す ----------------------------------
try {
  const me = await call(deskB, 'GET', '/api/auth/me');
  const available = me.status === 200;
  const keys = available ? Object.keys(me.json?.user ?? {}).join(',') : '';
  const hasRoles = available && Array.isArray(me.json?.user?.roles);
  record(
    'V-01',
    '/auth/me が複数ロールを返す',
    'roles[] に担当/承認等',
    available
      ? `HTTP 200 / user のキー=${keys} / roles[]=${hasRoles ? 'あり' : 'なし'}`
      : `HTTP ${me.status}（${errCode(me) ?? '-'}）＝ パスワードログインは cloudflare-access モードで無効`,
    hasRoles ? 'PASS' : 'FAIL',
    'user_roles に複数ロールは保持されるが、userDto は role のみを返し UI がロール集合を取得する経路が無い',
  );
} catch (error) {
  record('V-01', '/auth/me が複数ロールを返す', 'roles[]', String(error.message), 'FAIL');
}

// ---- V-02: auditor の併存拒否 -------------------------------------------
try {
  const conflict = validateRoleSet(['auditor', 'helpdesk']);
  const okSet = validateRoleSet(['helpdesk', 'itops']);
  record(
    'V-02',
    'auditor の併存拒否（role set 検証）',
    '400/拒否',
    `auditor+helpdesk="${conflict ?? 'null'}" / helpdesk+itops="${okSet ?? 'null'}"`,
    conflict ? 'PASS' : 'FAIL',
    'CLI/ユニット（validateRoleSet）での検証。API のロール書込みエンドポイントは無い',
  );
} catch (error) {
  record('V-02', 'auditor の併存拒否', '拒否', String(error.message), 'FAIL');
}

// ---- V-03: auditor の UI 書込み -----------------------------------------
try {
  const r = await call({ email: people.auditor.email }, 'PUT', '/api/state/cowork', {
    data: minimalCowork('auditor'),
  });
  const read = await call({ email: people.auditor.email }, 'GET', '/api/state');
  record(
    'V-03',
    'auditor の UI 書込み',
    '403',
    `書込み HTTP ${r.status}（${errCode(r) ?? '-'}）/ 読取り HTTP ${read.status}`,
    r.status === 403 && read.status === 200 ? 'PASS' : 'FAIL',
  );
} catch (error) {
  record('V-03', 'auditor の UI 書込み', '403', String(error.message), 'FAIL');
}

// ---- V-04: 一般社員の inbox / claim -------------------------------------
try {
  const inbox = await call({ email: people.outside.email }, 'GET', '/api/case-handovers/inbox');
  const claim = await call(
    { email: people.outside.email },
    'POST',
    `/api/case-handovers/${randomUUID()}/claim`,
    {},
  );
  record(
    'V-04',
    '一般社員の inbox / claim',
    '403',
    `inbox ${inbox.status}（${errCode(inbox) ?? '-'}）/ claim ${claim.status}（${errCode(claim) ?? '-'}）`,
    inbox.status === 403 && claim.status === 403 ? 'PASS' : 'FAIL',
  );
} catch (error) {
  record('V-04', '一般社員の inbox / claim', '403', String(error.message), 'FAIL');
}

// ---- V-05 / V-06 / V-07: 宛先指名と自己承認 -----------------------------
let v06HandoverId = null;
try {
  const caseId = `CASE-DLT-56-${Date.now().toString().slice(-5)}`;
  await createCase(caseId, '差分検証: 共有フォルダが開けません');
  const shared = await ownerShare(caseId, '差分検証: 共有フォルダが開けません', people.deskB.no);
  if (shared.status !== 200)
    throw new Error(`handover 作成失敗 ${shared.status} ${errMsg(shared)}`);
  const handoverId = shared.json?.handover?.id;
  v06HandoverId = handoverId;

  await primeStates({ email: people.deskB.email }, 'B');
  await primeStates({ email: people.deskC.email }, 'C');

  const inboxC = await call({ email: people.deskC.email }, 'GET', '/api/case-handovers/inbox');
  const seenByC = (inboxC.json?.items ?? []).some((item) => item.id === handoverId);
  const claimC = await call(
    { email: people.deskC.email },
    'POST',
    `/api/case-handovers/${handoverId}/claim`,
    {},
  );
  record(
    'V-05',
    '指名外 DX の claim',
    '403 RECIPIENT_MISMATCH',
    `claim ${claimC.status}（${errCode(claimC) ?? '-'}）/ C の inbox に表示=${seenByC ? 'あり' : 'なし'}`,
    claimC.status === 403 && errCode(claimC) === 'RECIPIENT_MISMATCH' && !seenByC ? 'PASS' : 'FAIL',
  );

  const claimB = await call(
    { email: people.deskB.email },
    'POST',
    `/api/case-handovers/${handoverId}/claim`,
    {},
  );
  const inboxB = await call({ email: people.deskB.email }, 'GET', '/api/case-handovers/inbox');
  const seenByB = (inboxB.json?.items ?? []).some((item) => item.id === handoverId);
  record(
    'V-06',
    '指名 DX の claim / inbox 分離',
    '200・他担当に出ない',
    `claim ${claimB.status} / B の inbox=${seenByB ? 'あり' : 'なし'} / C の inbox=${seenByC ? 'あり' : 'なし'}`,
    claimB.status === 200 && seenByB && !seenByC ? 'PASS' : 'FAIL',
  );

  const approve = await call(
    { email: people.deskB.email },
    'POST',
    `/api/case-handovers/${handoverId}/approve`,
    {},
  );
  record(
    'V-07',
    '自己承認（ALLOW_SELF_APPROVAL=true）',
    '200・self_approved=true',
    `HTTP ${approve.status} / selfApproved=${approve.json?.handover?.selfApproved}`,
    approve.status === 200 && approve.json?.handover?.selfApproved === true ? 'PASS' : 'FAIL',
  );
} catch (error) {
  record('V-05', '指名外 DX の claim', '403', String(error.message), 'FAIL');
  record('V-06', '指名 DX の claim', '200', String(error.message), 'FAIL');
  record('V-07', '自己承認', '200', String(error.message), 'FAIL');
}

// ---- V-08: 承認なし完了 --------------------------------------------------
try {
  const caseId = `CASE-DLT-08-${Date.now().toString().slice(-5)}`;
  await createCase(caseId, '差分検証: 承認なし完了');
  const shared = await ownerShare(caseId, '差分検証: 承認なし完了');
  const handoverId = shared.json?.handover?.id;
  await primeStates({ email: people.deskB.email }, 'B');
  const claim = await call(
    { email: people.deskB.email },
    'POST',
    `/api/case-handovers/${handoverId}/claim`,
    {},
  );
  const complete = await call(
    { email: people.deskB.email },
    'PATCH',
    `/api/case-handovers/${handoverId}`,
    { status: 'completed' },
  );
  record(
    'V-08',
    '承認なし完了',
    '409 APPROVAL_REQUIRED',
    `claim ${claim.status} / complete ${complete.status}（${errCode(complete) ?? '-'}）`,
    complete.status === 409 && errCode(complete) === 'APPROVAL_REQUIRED' ? 'PASS' : 'FAIL',
  );
} catch (error) {
  record('V-08', '承認なし完了', '409', String(error.message), 'FAIL');
}

// ---- V-09: 承認チェックリスト未確認（F-12 回帰） -----------------------
try {
  const clientRef = `delta-nocheck-${Date.now()}`;
  const base = {
    clientRef,
    title: 'チェックリスト未確認の承認',
    symptom: '症状',
    cause: '原因',
    steps: '手順',
    keywords: ['検証'],
  };
  const noCheck = await call(deskB, 'POST', '/api/knowledge/ui-sync', {
    ...base,
    status: 'approved',
  });
  const withCheck = await call(deskC, 'POST', '/api/knowledge/ui-sync', {
    ...base,
    status: 'approved',
    checklist: { reproducible: true, noSecrets: true, noBlame: true, scopeClear: true },
  });
  record(
    'V-09',
    '承認チェックリスト未確認（F-12 回帰）',
    '承認が先に成立しない',
    `チェックなし承認 ${noCheck.status}（${errCode(noCheck) ?? '-'}）/ チェックあり ${withCheck.status}`,
    noCheck.status === 400 ? 'PASS' : 'FAIL',
    'サーバ側の検証を実測。ブラウザでの F-12 回帰（承認→完了の詰み）は未実施',
  );
} catch (error) {
  record('V-09', '承認チェックリスト未確認', '400', String(error.message), 'FAIL');
}

// ---- V-10 / V-11 / V-13: ナレッジ承認 -----------------------------------
let kbClientRef = null;
let kbNoSeen = null;
try {
  const pending = await call(deskB, 'GET', '/api/knowledge/pending');
  record(
    'V-10',
    'GET /knowledge/pending',
    '承認待ち一覧',
    `HTTP ${pending.status} / items=${Array.isArray(pending.json?.items) ? pending.json.items.length : '-'}`,
    pending.status === 200 ? 'PASS' : 'FAIL',
  );

  // cloudflare-access モードでは /knowledge/:id/submit|review（セッション認証）が無効なため、
  // UI が実際に使う /knowledge/ui-sync（Access 認証）で同じ遷移を実測する。
  kbClientRef = `delta-kb-${Date.now()}`;
  const base = {
    clientRef: kbClientRef,
    title: '共有フォルダが開けない',
    symptom: '共有フォルダを開くとエラーになる',
    cause: 'ネットワークドライブの資格情報が失効している',
    steps: '資格情報を再入力して再接続する',
    keywords: ['共有フォルダ', 'ネットワークドライブ'],
  };
  const draft = await call(deskB, 'POST', '/api/knowledge/ui-sync', { ...base, status: 'draft' });
  const submitted = await call(deskB, 'POST', '/api/knowledge/ui-sync', {
    ...base,
    status: 'pending',
  });
  const approved = await call(deskC, 'POST', '/api/knowledge/ui-sync', {
    ...base,
    status: 'approved',
    comment: '差分検証',
    checklist: { reproducible: true, noSecrets: true, noBlame: true, scopeClear: true },
  });
  const row = await db`
    SELECT id, kb_no, status, approver_id FROM knowledge WHERE client_ref = ${kbClientRef} LIMIT 1
  `;
  if (row[0]?.kb_no) kbNoSeen = row[0].kb_no;
  record(
    'V-11',
    '下書き→申請→承認→knowledge 永続化',
    'draft→pending→approved',
    `draft ${draft.status} / pending ${submitted.status} / approved ${approved.status} / db=${row[0]?.status}（${row[0]?.kb_no ?? '-'}）`,
    draft.status === 200 &&
      submitted.status === 200 &&
      approved.status === 200 &&
      row[0]?.status === 'approved'
      ? 'PASS'
      : 'FAIL',
    'セッション認証の submit/review は cloudflare-access モードでは未登録（UI は ui-sync を使用）',
  );
} catch (error) {
  record('V-10', 'GET /knowledge/pending', '200', String(error.message), 'FAIL');
  record('V-11', '下書き→承認', '200', String(error.message), 'FAIL');
}

// ---- V-13: 別ID承認（claimant 以外） ------------------------------------
try {
  const caseId = `CASE-DLT-13-${Date.now().toString().slice(-5)}`;
  await createCase(caseId, '差分検証: 別担当承認');
  const shared = await ownerShare(caseId, '差分検証: 別担当承認');
  const handoverId = shared.json?.handover?.id;
  await primeStates({ email: people.deskB.email }, 'B');
  await primeStates({ email: people.deskC.email }, 'C');
  await call({ email: people.deskB.email }, 'POST', `/api/case-handovers/${handoverId}/claim`, {});
  const approve = await call(
    { email: people.deskC.email },
    'POST',
    `/api/case-handovers/${handoverId}/approve`,
    {},
  );
  const row =
    await db`SELECT self_approved, approved_by FROM case_handovers WHERE id = ${handoverId}`;
  record(
    'V-13',
    '別ID承認（claimant 以外）',
    'self_approved=false',
    `HTTP ${approve.status} / api=${approve.json?.handover?.selfApproved} / db=${row[0]?.self_approved}`,
    approve.status === 200 &&
      approve.json?.handover?.selfApproved === false &&
      row[0]?.self_approved === false
      ? 'PASS'
      : 'FAIL',
  );
} catch (error) {
  record('V-13', '別ID承認', '200/false', String(error.message), 'FAIL');
}

// ---- V-14: final_reports 一意制約（021） --------------------------------
try {
  const idx = await db`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'final_reports' AND indexname = 'final_reports_user_sha256_uq'
  `;
  const sha = `delta-sha-${Date.now()}`;
  const email = `delta-${Date.now()}@example.invalid`;
  const ins = () => db`
    INSERT INTO final_reports (id, user_email, case_id, kind, payload, html, html_filename, sha256)
    VALUES (${randomUUID()}, ${email}, 'CASE-DLT-14', 'helpdesk_resolved', '{}'::jsonb, '<html></html>', 'x.html', ${sha})
  `;
  await ins();
  let duplicate = 'inserted';
  try {
    await ins();
  } catch (error) {
    duplicate = error.code ?? 'error';
  }
  record(
    'V-14',
    'final_reports 一意制約（021）',
    '二重作成されない',
    `部分一意 index=${idx.length === 1 ? 'あり' : 'なし'} / 同一 (user,sha256) の2回目=${duplicate}`,
    idx.length === 1 && duplicate === '23505' ? 'PASS' : 'FAIL',
    'API の再利用（reused=true）は既存ユニットテストで担保',
  );
} catch (error) {
  record('V-14', 'final_reports 一意制約', '23505', String(error.message), 'FAIL');
}

// ---- V-17 / V-19: 引継ぎ概要と承認情報 ----------------------------------
try {
  const caseId = `CASE-DLT-17-${Date.now().toString().slice(-5)}`;
  const subject = '差分検証: 件名が正（SM-03）';
  await createCase(caseId, subject);
  const shared = await ownerShare(caseId, subject);
  const handoverId = shared.json?.handover?.id;
  const detail = await call(
    { email: people.deskB.email },
    'GET',
    `/api/case-handovers/${handoverId}`,
  );
  const s = detail.json?.handover ?? {};
  record(
    'V-17',
    '引継ぎ概要（SM-03）が件名と一致',
    '最後の発言で上書きされない',
    `subject="${String(s.subject ?? '').slice(0, 30)}" / 一致=${s.subject === subject}`,
    s.subject === subject ? 'PASS' : 'FAIL',
  );

  await primeStates({ email: people.deskB.email }, 'B');
  await call({ email: people.deskB.email }, 'POST', `/api/case-handovers/${handoverId}/claim`, {});
  const approve = await call(
    { email: people.deskB.email },
    'POST',
    `/api/case-handovers/${handoverId}/approve`,
    {},
  );
  const after = await call(
    { email: people.deskB.email },
    'GET',
    `/api/case-handovers/${handoverId}`,
  );
  const a = after.json?.handover ?? {};
  record(
    'V-19',
    'STEP7 の承認者・承認日時（F-13）',
    '表示される（API が返す）',
    `approve ${approve.status} / approvedBy=${a.approvedBy ? mask(a.approvedBy) : 'なし'} / approvedAt=${a.approvedAt ?? 'なし'}`,
    a.approvedBy && a.approvedAt ? 'PASS' : 'FAIL',
    'UI 表示（常設表示）のクリック確認は未実施（API 実測）',
  );
} catch (error) {
  record('V-17', '引継ぎ概要（SM-03）', '件名一致', String(error.message), 'FAIL');
  record('V-19', '承認者・承認日時', 'あり', String(error.message), 'FAIL');
}

// ---- V-12: 承認済み KB の AI 出典反映 -----------------------------------
try {
  const ans = await call({ email: people.deskB.email }, 'POST', '/api/ai/answer', {
    text: '共有フォルダが開けません。対処方法を教えてください。',
    mode: 'helpdesk',
  });
  const sources = ans.json?.sources ?? ans.json?.answer?.sources ?? [];
  const text = JSON.stringify(ans.json ?? {});
  const citesKb = kbNoSeen ? text.includes(kbNoSeen) : false;
  record(
    'V-12',
    '承認済み KB の AI 出典反映',
    'KB-… が出典',
    `HTTP ${ans.status} / sources=${Array.isArray(sources) ? sources.length : 'なし'} / 当該 KB(${kbNoSeen ?? '-'}) の引用=${citesKb ? 'あり' : 'なし'}`,
    ans.status === 200 && (citesKb || sources.length > 0) ? 'PASS' : 'PARTIAL',
    citesKb ? '' : 'AI 応答に当該 KB の引用が含まれない（検索条件・プロンプトの確認が必要）',
  );
} catch (error) {
  record('V-12', '承認済み KB の AI 出典反映', 'KB-', String(error.message), 'PARTIAL');
}

// ---- V-15 / V-16 / V-18 / V-20: 端末セッションと報告書 -------------------
try {
  const caseId = `CASE-DLT-15-${Date.now().toString().slice(-5)}`;
  await createCase(caseId, '差分検証: 端末セッションと中止報告書');
  const shared = await ownerShare(caseId, '差分検証: 端末セッションと中止報告書');
  const handoverId = shared.json?.handover?.id;
  await primeStates(deskB, 'B');
  await call(deskB, 'POST', `/api/case-handovers/${handoverId}/claim`, {});

  const created = await call(deskB, 'POST', '/api/terminal/sessions', {
    caseId,
    consent: { remoteControl: true, screenShare: false },
    ttlMinutes: 15,
  });
  const session = created.json?.session ?? null;
  const sessionId = session?.id ?? null;

  let stepId = null;
  if (sessionId) {
    const proposed = await call(deskB, 'POST', `/api/terminal/sessions/${sessionId}/steps`, {
      intent: 'プリンタが印刷できない原因を確認したい',
    });
    stepId = proposed.json?.step?.id ?? null;
    if (stepId) {
      await call(deskB, 'POST', `/api/terminal/steps/${stepId}/record`, {
        command: 'Get-Printer | Select-Object Name, PrinterStatus',
        output: 'Name PrinterStatus\nHP-01 Normal',
        outputSource: 'manual',
        exitStatus: 'success',
        rspSessionId: 'RSP-DELTA-SESSION-1',
      });
    }
  }
  const closed = await call(deskB, 'POST', `/api/terminal/sessions/${sessionId}/close`, {
    reason: 'stopped',
  });
  const report = await call(deskB, 'POST', `/api/terminal/sessions/${sessionId}/report`, {});
  const reportId = report.json?.report?.id ?? report.json?.id ?? null;
  const kind = report.json?.report?.kind ?? report.json?.kind ?? null;
  let html = '';
  if (reportId) {
    const res = await fetch(`${BASE}/api/reports/final/${reportId}/html`, {
      headers: { 'cf-access-authenticated-user-email': people.deskB.email },
    });
    html = await res.text();
  }
  record(
    'V-15',
    '中止セッションの報告書（023）',
    '「終了（未解決）」種別',
    `session ${created.status} / step ${stepId ? 'あり' : 'なし'} / close ${closed.status} / report ${report.status} / kind=${kind}`,
    report.status === 200 && kind === 'helpdesk_stopped' ? 'PASS' : 'FAIL',
  );
  record(
    'V-16',
    '報告書の STEP 整合・表紙バッジ',
    '解決/停止で正しい',
    `HTML ${html.length}B / 「終了（未解決）」=${html.includes('終了（未解決）') ? 'あり' : 'なし'}`,
    html.includes('終了（未解決）') ? 'PASS' : 'FAIL',
    'HTML（サーバ生成物）での確認。画面のクリック確認は未実施',
  );

  const resume = await call(
    deskB,
    'GET',
    `/api/terminal/sessions?caseId=${encodeURIComponent(caseId)}`,
  );
  record(
    'V-18',
    '完了案件の GET /terminal/sessions（SM-04）',
    '404 でなく 200/空',
    `HTTP ${resume.status} / session=${resume.json?.session ? 'あり' : 'null'}`,
    resume.status === 200 ? 'PASS' : 'FAIL',
  );

  const rsp = sessionId
    ? await db`SELECT rsp_session_id FROM terminal_sessions WHERE id = ${sessionId}`
    : [];
  record(
    'V-20',
    'RSP 相関（020/022・SM-09）',
    'rsp_session_id 保存',
    `rsp_session_id=${rsp[0]?.rsp_session_id ?? 'なし'}`,
    rsp[0]?.rsp_session_id === 'RSP-DELTA-SESSION-1' ? 'PASS' : 'PARTIAL',
    'rspCommandLogId（RSP 実コマンド相関）は実ログが必要なため未実施',
  );
} catch (error) {
  record('V-15', '中止セッションの報告書', 'helpdesk_stopped', String(error.message), 'FAIL');
  record('V-16', '報告書バッジ', '終了（未解決）', String(error.message), 'FAIL');
  record('V-18', 'GET /terminal/sessions', '200', String(error.message), 'FAIL');
  record('V-20', 'RSP 相関', '保存', String(error.message), 'PARTIAL');
}

// ---- V-21: 端末エージェントの NUL/サロゲート除去（#91） ------------------
try {
  const { createHash, randomBytes } = await import('node:crypto');
  const token = `aihd_${randomBytes(24).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await db`
    INSERT INTO device_tokens (token_hash, user_email, label)
    VALUES (${tokenHash}, ${people.deskB.email}, 'delta-verify')
    ON CONFLICT (token_hash) DO NOTHING
  `;
  const res = await fetch(`${BASE}/api/device/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-token': token },
    body: JSON.stringify({
      deviceId: `DELTA-PC-${Date.now().toString().slice(-5)}`,
      hostname: 'DELTA\u0000PC\uD800',
      os: 'Windows 11',
      platform: 'win32',
      arch: 'x64',
    }),
  });
  const body = await res.json().catch(() => ({}));
  const saved = await db`
    SELECT hostname FROM device_inventories WHERE device_id = ${body?.inventory?.deviceId ?? ''} LIMIT 1
  `;
  record(
    'V-21',
    '端末エージェントの NUL/サロゲート除去（#91）',
    '500 にならない',
    `HTTP ${res.status} / ok=${body?.ok} / 保存 hostname=${saved[0]?.hostname ?? '-'}`,
    res.status === 200 ? 'PASS' : 'FAIL',
    'NUL と単独サロゲートを含む payload を送信（実機の再現）',
  );
} catch (error) {
  record('V-21', 'NUL/サロゲート除去', '200', String(error.message), 'FAIL');
}

writeFileSync(
  'docs/evidence/verify-20261027/delta/results.json',
  JSON.stringify(
    {
      base: BASE,
      db: dbName,
      ranAt: new Date().toISOString(),
      people: Object.fromEntries(Object.entries(people).map(([k, v]) => [k, mask(v.email)])),
      results,
      notes,
    },
    null,
    2,
  ),
);
console.log(
  `\n合計 ${results.length} 件 / PASS ${results.filter((r) => r.verdict === 'PASS').length}`,
);
await db.end();
await info.end();
