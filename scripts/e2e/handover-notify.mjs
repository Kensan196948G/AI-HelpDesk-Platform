import { readFileSync } from 'node:fs';
import postgres from 'postgres';

if (process.env.AIHD_E2E_ALLOW !== '1') {
  console.error(
    '稼働中インスタンスへテスト案件を作り、メールを送ります。\n' +
      '実行するには AIHD_E2E_ALLOW=1・DATABASE_URL・送信先 SMTP シンクが必要です。',
  );
  process.exit(2);
}

const BASE = process.env.AIHD_E2E_BASE ?? 'http://127.0.0.1:18972';
const A = 'aihd-e2e-a@mirai-const.co.jp';
const CASE_ID = `CASE-NOTIFY-${Date.now().toString().slice(-6)}`;
const app = postgres(process.env.DATABASE_URL, { max: 2 });
const results = [];
const ok = (n, d = '') => (
  results.push([true, n]), console.log(`  OK  ${n}${d ? ' :: ' + d : ''}`)
);
const ng = (n, d = '') => (
  results.push([false, n]), console.log(`  NG  ${n}${d ? ' :: ' + d : ''}`)
);

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'cf-access-authenticated-user-email': A },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

const cowork = {
  v: 31,
  ui: { user: 'u-n', screen: 'home' },
  counters: { case: 1, ticket: 1, prop: 1 },
  cases: [
    {
      id: CASE_ID,
      userId: 'u-n',
      chatId: 'chat-n',
      subject: '通知テスト: 印刷ができません',
      body: 'テスト本文（メールには載らないこと）',
      step: 4,
    },
  ],
  chats: [
    { id: 'chat-n', userId: 'u-n', title: 't', messages: [{ id: 'm1', kind: 'user', text: 'hi' }] },
  ],
  tickets: [{ id: 'TKT-N-1', chatId: 'chat-n', incId: 'INC-N-1', userId: 'u-n', status: '受付' }],
  proposals: {},
  audit: [],
};
const helpdesk = {
  actor: 'E2E',
  seq: { inc: 1, draft: 1, kb: 1 },
  tickets: [
    { id: 'INC-N-1', coworkTicket: 'TKT-N-1', status: 'escalated', requester: '通知 太郎' },
  ],
  drafts: [],
  kb: [],
  audit: [],
};

let handoverId = null;
try {
  let r = await call('PUT', '/api/state/cowork', { data: cowork });
  if (r.status !== 200) throw new Error(`state cowork ${r.status}`);
  r = await call('PUT', '/api/state/helpdesk', { data: helpdesk });
  if (r.status !== 200) throw new Error(`state helpdesk ${r.status}`);

  r = await call('POST', '/api/case-handovers', { caseId: CASE_ID });
  if (r.status !== 200) throw new Error(`share ${r.status} ${JSON.stringify(r.json)}`);
  handoverId = r.json.handover.id;
  if (r.json.notify && r.json.notify.queued === 1 && r.json.notify.transport === 'smtp') {
    ok('共有時に通知キューへ 1 件積んだ', JSON.stringify(r.json.notify));
  } else {
    ng('通知がキューに積まれていない', JSON.stringify(r.json.notify));
  }

  // ワーカー（1 秒間隔）が送るのを待つ
  let sent = false;
  for (let i = 0; i < 15; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const rows =
      await app`SELECT status FROM case_handover_notifications WHERE handover_id = ${handoverId}`;
    if (rows[0]?.status === 'sent') {
      sent = true;
      break;
    }
  }
  if (sent) ok('ワーカーが送信し、キューが sent になった');
  else ng('キューが sent にならない');

  // SMTP シンクが受信したか
  let raw = '';
  const sinkFile = process.env.AIHD_E2E_SINK ?? '/tmp/smtp-sink.jsonl';
  try {
    raw = readFileSync(sinkFile, 'utf8');
  } catch {}
  const messages = raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  // 件名は RFC2047、本文は base64 なので、復号してから照合する。
  const decodedOf = (m) =>
    Buffer.from(m.raw.split('\n\n').slice(1).join('\n\n') || '', 'base64').toString('utf8');
  const mine = messages.filter((m) => String(m.to).includes('dx-group@mirai-const.co.jp'));
  if (mine.length === 1) ok('SMTP シンクが 1 通受信した');
  else ng('SMTP シンクの受信数が想定と違う', String(mine.length));

  const msg = mine[0] ?? { raw: '', to: [] };
  const decoded = decodedOf(msg);
  if (decoded.includes(CASE_ID) && decoded.includes('印刷ができません'))
    ok('本文に案件 ID と件名が入っている');
  else ng('本文の内容が足りない', decoded.slice(0, 120));
  if (!decoded.includes('テスト本文（メールには載らないこと）'))
    ok('相談の本文はメールに載っていない');
  else ng('相談の本文がメールに載っている');
  if (decoded.includes('自動送信')) ok('自動送信の注記がある');
  else ng('注記が無い');
  // 個人指名の通知先（社員番号 → メールアドレス）も確認する
  const info = postgres({
    host: '/var/run/postgresql',
    database: 'mirai_info',
    username: process.env.USER,
    max: 1,
  });
  const staff = await info`
    SELECT DISTINCT ON (lower(btrim(email))) employee_no, email, name
    FROM mirai_info.employee_directory
    WHERE status = '有効' AND section = 'DX推進部' AND coalesce(btrim(email), '') <> ''
    ORDER BY lower(btrim(email)), updated_at DESC
    LIMIT 1
  `;
  await info.end({ timeout: 5 });
  const person = staff[0];
  if (person) {
    const r2 = await call('POST', '/api/case-handovers', {
      caseId: CASE_ID,
      recipientNo: person.employee_no,
    });
    if (r2.status === 200 && r2.json.notify?.queued === 1) ok('個人指名でも通知を積んだ');
    else ng('個人指名の通知が積まれない', JSON.stringify(r2.json));
    let delivered = false;
    for (let i = 0; i < 15; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const rows =
        await app`SELECT status FROM case_handover_notifications WHERE handover_id = ${r2.json.handover.id}`;
      if (rows[0]?.status === 'sent') {
        delivered = true;
        break;
      }
    }
    if (delivered) ok('個人指名の通知も送信された');
    else ng('個人指名の通知が送信されない');
    const raw2 = readFileSync(sinkFile, 'utf8');
    const toPerson = raw2
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .some((m) => String(m.to).includes(person.email));
    if (toPerson) ok('宛先は指名された担当者のアドレス');
    else ng('指名された担当者へ届いていない');
  } else {
    ng('DX 推進部のメール付き社員が見つからない');
  }
} catch (error) {
  ng('例外', String(error.message || error));
} finally {
  if (handoverId) await app`DELETE FROM case_handovers WHERE id = ${handoverId}`;
  await app`DELETE FROM case_handovers WHERE case_id = ${CASE_ID}`;
  await app`DELETE FROM prototype_states WHERE user_email = ${A}`;
  const left =
    await app`SELECT count(*)::int AS n FROM case_handover_notifications WHERE handover_id = ${handoverId ?? '00000000-0000-0000-0000-000000000000'}`;
  console.log(`  後片付け: 残った通知=${left[0].n} 件`);
  await app.end({ timeout: 5 });
  const failed = results.filter(([passed]) => !passed).length;
  console.log(`\n結果: ${results.length - failed}/${results.length} OK`);
  process.exit(failed ? 1 : 0);
}
