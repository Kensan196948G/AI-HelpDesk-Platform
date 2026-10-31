/**
 * 一時スクリプト: 稼働中インスタンスに対する 2 アカウント引継ぎの実測。
 * - A（合成アドレス・allowed ドメイン）が案件を共有
 * - B（DX 推進部の実在社員）が受信箱から引き受け、AI 追加質問
 * - C（別の DX 推進部社員）がナレッジ承認
 * 実行後に A/B/C の状態・引継ぎ行を元へ戻し、内容が一致することを検証する。
 * 実行: AIHD_E2E_ALLOW=1 AIHD_E2E_CONFIRM_DB=<DB名> とサービス用 DATABASE_URL を設定して
 *   node scripts/e2e/two-account-handover.mjs
 * メールアドレスは出力しない（マスクのみ）。
 *
 * 注意: これは稼働中 DB を一時的に書き換える。必ず検証用 DB（例 ai_helpdesk_verify）で
 * 実行し、preview で実行する場合は事前にバックアップを取ること。
 * 同じ DB に対して同時に 2 つ実行しないこと（排他はしていない）。
 */
import postgres from 'postgres';

if (process.env.AIHD_E2E_ALLOW !== '1') {
  console.error(
    'このスクリプトは稼働中インスタンスの DB を一時的に書き換えます。\n' +
      '実行するには AIHD_E2E_ALLOW=1 とサービス用の DATABASE_URL が必要です。',
  );
  process.exit(2);
}

const dbName = (() => {
  try {
    return decodeURIComponent(new URL(process.env.DATABASE_URL || '').pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
})();
if (
  /^ai_helpdesk_preview/.test(dbName.trim().toLowerCase()) &&
  process.env.AIHD_E2E_ALLOW_PREVIEW !== '1'
) {
  console.error(
    'preview（本番相当）DB への書き込みは既定で拒否します。\n' +
      '意図して実行する場合だけ AIHD_E2E_ALLOW_PREVIEW=1 を設定してください。',
  );
  process.exit(2);
}
if (!dbName || process.env.AIHD_E2E_CONFIRM_DB !== dbName) {
  console.error(
    `対象 DB を確認できません（DB=${dbName || '不明'}）。\n` +
      '誤った DB を書き換えないよう、AIHD_E2E_CONFIRM_DB=<DATABASE_URL の DB 名> を明示してください。',
  );
  process.exit(2);
}

const BASE = process.env.AIHD_E2E_BASE || 'http://127.0.0.1:18950';
const app = postgres(process.env.DATABASE_URL, { max: 2 });
const info = postgres({
  host: '/var/run/postgresql',
  database: 'mirai_info',
  username: process.env.USER,
  max: 2,
});
await info.unsafe('SET default_transaction_read_only = on');

const CASE_ID = `CASE-E2E-${Date.now().toString().slice(-6)}`;
const results = [];
function ok(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`  OK  ${name}${detail ? ' :: ' + detail : ''}`);
}
function ng(name, detail = '') {
  results.push({ name, ok: false, detail });
  console.log(`  NG  ${name}${detail ? ' :: ' + detail : ''}`);
}
const mask = (email) => email.replace(/^([^@])[^@]*@/, '$1***@');

async function call(email, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'cf-access-authenticated-user-email': email,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

// ---- 登場人物 -----------------------------------------------------------
const dx = await info`
  SELECT DISTINCT ON (lower(btrim(email))) email, name, employee_no, section
  FROM mirai_info.employee_directory
  WHERE status = '有効' AND section = 'DX推進部'
    AND coalesce(btrim(email), '') <> ''
  ORDER BY lower(btrim(email)), updated_at DESC
`;
if (dx.length < 2) {
  console.error('DX 推進部のメール付き社員が 2 名未満のため中止します。');
  process.exit(2);
}
const B = dx[0];
const C = dx[1];
const domain = B.email.split('@')[1].toLowerCase();
const A_EMAIL = `aihd-e2e-a@${domain}`;

// 別名（EMAIL_ALIASES）はサーバーだけが知る。GET /api/state は正規化後の email を返すため、
// それを正本にしてバックアップ・復元のキーを決める（環境変数の取りこぼしで復元漏れしない）。
async function canonicalEmailOf(email) {
  const result = await call(email, 'GET', '/api/state');
  if (result.status !== 200 || typeof result.json?.email !== 'string') {
    throw new Error(`正規化後のメールを取得できません（${mask(email)} / HTTP ${result.status}）。`);
  }
  return result.json.email.trim().toLowerCase();
}

let A_KEY;
let B_KEY;
let C_KEY;
try {
  A_KEY = await canonicalEmailOf(A_EMAIL);
  B_KEY = await canonicalEmailOf(B.email);
  C_KEY = await canonicalEmailOf(C.email);
} catch (error) {
  console.error(String(error.message || error));
  process.exit(2);
}
const stateKeys = [A_KEY, B_KEY, C_KEY];
if (new Set(stateKeys).size !== stateKeys.length) {
  console.error(
    'A/B/C の正規化後メールが重複しています（別名設定を確認してください）。状態を分離できないため中止します。',
  );
  process.exit(2);
}

// API（BASE）が実際に使っている DB と DATABASE_URL が同じかを、一意なトークンで確認する。
// 別 DB を指したまま B/C の状態を書き換える事故を防ぐ（A は合成アカウント）。
const probeToken = `probe-${Date.now()}`;
const probe = await call(A_EMAIL, 'PUT', '/api/state/cowork', {
  data: { v: 31, __e2eProbe: probeToken },
});
if (probe.status !== 200) {
  console.error(`プリフライト（状態の書き込み）に失敗しました: HTTP ${probe.status}`);
  process.exit(2);
}
const probeRows = await app`
  SELECT count(*)::int AS n FROM prototype_states
  WHERE user_email = ${A_KEY} AND data::text LIKE ${`%${probeToken}%`}
`;
if (probeRows[0]?.n !== 1) {
  console.error(
    'API（BASE）と DATABASE_URL の DB が一致しません。書き込みは行っていません。\n' +
      'BASE のサービスが使う DATABASE_URL を指定してください。',
  );
  process.exit(2);
}
await app`DELETE FROM prototype_states WHERE user_email = ${A_KEY}`;

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
};
const digest = (value) => JSON.stringify(stable(value));

console.log(
  `A=${mask(A_EMAIL)} (合成) / B=${mask(B.email)} / C=${mask(C.email)} / case=${CASE_ID} / DB=${dbName}`,
);

const cowork = {
  v: 31,
  ui: { user: 'u-e2e', screen: 'home' },
  counters: { case: 1, ticket: 1, prop: 1 },
  cases: [
    {
      id: CASE_ID,
      userId: 'u-e2e',
      chatId: 'chat-e2e',
      subject: 'E2E: 共有フォルダが開けません',
      body: 'E2E 用の相談本文です。',
      step: 4,
      pc: {
        state: 'done',
        snap: {
          items: [
            { grp: 'ネットワーク', k: 'IPアドレス', v: '192.168.10.34', lv: 'ok' },
            { grp: '端末', k: 'シリアル', v: 'SN-E2E-0001', lv: 'ok' },
          ],
        },
      },
    },
  ],
  chats: [
    {
      id: 'chat-e2e',
      userId: 'u-e2e',
      title: '共有フォルダ',
      messages: [{ id: 'm1', kind: 'user', text: '共有フォルダが開けません' }],
    },
  ],
  tickets: [
    { id: 'TKT-E2E-1', chatId: 'chat-e2e', incId: 'INC-E2E-1', userId: 'u-e2e', status: '受付' },
  ],
  proposals: {},
  audit: [],
};
const helpdeskForA = {
  actor: 'E2E',
  seq: { inc: 1, draft: 1, kb: 1 },
  tickets: [{ id: 'INC-E2E-1', coworkTicket: 'TKT-E2E-1', status: 'escalated' }],
  drafts: [],
  kb: [],
  audit: [],
};
const minimal = {
  cowork: {
    v: 31,
    ui: { user: 'u-b', screen: 'home' },
    counters: {},
    cases: [],
    chats: [],
    tickets: [],
    proposals: {},
    audit: [],
  },
  helpdesk: {
    actor: 'B',
    seq: { inc: 1, draft: 1, kb: 1 },
    tickets: [],
    drafts: [],
    kb: [],
    audit: [],
  },
};

// ---- 既存状態のバックアップ --------------------------------------------
// 別名は正規化後のキーで保存されるため、A/B/C すべてを正規化キーで退避する。
const backupRows = await app`
  SELECT user_email, name, data FROM prototype_states
  WHERE user_email IN (${A_KEY}, ${B_KEY}, ${C_KEY})
`;
const backup = new Map(backupRows.map((r) => [`${r.user_email}|${r.name}`, r.data]));

let handoverId = null;
try {
  // 1) A の案件を共有（宛先は名簿から選択）
  let r = await call(A_EMAIL, 'PUT', '/api/state/cowork', { data: cowork });
  if (r.status !== 200) throw new Error(`A cowork 保存失敗 ${r.status} ${JSON.stringify(r.json)}`);
  r = await call(A_EMAIL, 'PUT', '/api/state/helpdesk', { data: helpdeskForA });
  if (r.status !== 200) throw new Error(`A helpdesk 保存失敗 ${r.status}`);

  r = await call(A_EMAIL, 'POST', '/api/case-handovers', {
    caseId: CASE_ID,
    recipientNo: B.employee_no,
  });
  if (r.status === 200 && r.json?.handover?.id) {
    handoverId = r.json.handover.id;
    ok('A: DX グループへ共有（宛先=B を名簿から選択）', `recipient=${mask(B.email)}`);
  } else {
    throw new Error(`共有失敗 ${r.status} ${JSON.stringify(r.json)}`);
  }

  // 2) B の受信箱
  r = await call(B.email, 'GET', '/api/case-handovers/inbox');
  const item = (r.json?.items || []).find((x) => x.caseId === CASE_ID);
  if (r.status === 200 && item) {
    ok('B: 受信箱に案件が出る', `宛先表示=${item.recipientName === B.name ? '一致' : '不一致'}`);
  } else {
    throw new Error(`受信箱に無い ${r.status} ${JSON.stringify(r.json)}`);
  }

  // 3) B が引き受ける（B の状態を一時的に用意）
  await call(B.email, 'PUT', '/api/state/cowork', { data: minimal.cowork });
  await call(B.email, 'PUT', '/api/state/helpdesk', { data: minimal.helpdesk });
  r = await call(B.email, 'POST', `/api/case-handovers/${handoverId}/claim`, {});
  if (r.status === 200) ok('B: 引き受け（claim）');
  else throw new Error(`claim 失敗 ${r.status} ${JSON.stringify(r.json)}`);

  // 4) マージ結果
  r = await call(B.email, 'GET', '/api/state');
  const c = (r.json?.cowork?.cases || []).find((x) => x.id === CASE_ID);
  if (c?.shared === true && c?.handoverId === handoverId && Number(c?.step) === 3) {
    const chatMsg = (r.json.cowork.chats.find((x) => x.id === 'chat-e2e')?.messages || []).length;
    ok('B: 案件・チャットが状態へマージされ STEP3 で開く', `messages=${chatMsg}`);
  } else {
    ng('B: マージ結果が不正', JSON.stringify(c));
  }

  // 5) AI 追加質問（IP・シリアルがマスクされ、回答が返る）
  r = await call(B.email, 'POST', '/api/ai/answer-case', {
    caseId: CASE_ID,
    text: 'この端末で次に確認すべきことは？',
  });
  if (r.status === 200 && String(r.json?.answer || '').length > 0) {
    ok('B: AI 追加質問に回答', `provider=${r.json.provider} model=${r.json.model}`);
  } else {
    ng('B: AI 追加質問が失敗', `${r.status} ${JSON.stringify(r.json)}`);
  }
  const afterAnswer = await app`SELECT snapshot FROM case_handovers WHERE id = ${handoverId}`;
  const snapText = JSON.stringify(afterAnswer[0]?.snapshot || {});
  // スナップショットは F-04 で保存時に伏せ字化される（`[IPアドレス]` / `[シリアル番号]`）。
  // 生値が残っていないことと、項目名に応じた伏せ字が入っていることを確認する。
  // （B が参照するのは伏せ字後の値。AI へ渡す文脈のマスクは buildPcContext の単体テストで検証）
  const masked = ['[IPアドレス]', '[シリアル番号]'].filter((v) => snapText.includes(v));
  const leaked = ['192.168.10.34', 'SN-E2E-0001'].filter((v) => snapText.includes(v));
  if (masked.length === 2 && leaked.length === 0) {
    ok('共有スナップショット: PC 情報は伏せ字化して保持される（F-04）');
  } else {
    ng(
      '共有スナップショットの伏せ字化が想定と違う',
      `masked=${masked.join(',')} leaked=${leaked.join(',')}`,
    );
  }

  // 6) 承認なしの completed は拒否される
  r = await call(B.email, 'PATCH', `/api/case-handovers/${handoverId}`, { status: 'completed' });
  if (r.status === 409 && r.json?.error?.code === 'APPROVAL_REQUIRED') {
    ok('B: 承認を経ない completed は 409 APPROVAL_REQUIRED');
  } else {
    ng('承認迂回の拒否が効いていない', `${r.status} ${JSON.stringify(r.json)}`);
  }

  // 7) 別の DX 担当者 C が承認
  // 承認は approver ロールが必要（docs/61）。C に付与する（未登録なら users も作る）。
  await app`
    WITH u AS (
      INSERT INTO users (email, name, role, password_hash)
      VALUES (${C_KEY}, ${C_KEY}, 'helpdesk', 'access-only$no-login')
      ON CONFLICT (lower(email)) DO UPDATE SET updated_at = now()
      RETURNING id
    )
    INSERT INTO user_roles (user_id, role, source, granted_by)
    SELECT id, 'approver', 'manual', 'e2e' FROM u
    ON CONFLICT DO NOTHING
  `;
  r = await call(C.email, 'POST', `/api/case-handovers/${handoverId}/approve`, {
    note: 'E2E 実測',
  });
  if (r.status === 200 && r.json?.handover?.status === 'completed') {
    ok(
      'C（別の DX 担当者）: ナレッジ承認で completed',
      `selfApproved=${r.json.handover.selfApproved}`,
    );
  } else {
    ng('C の承認が失敗', `${r.status} ${JSON.stringify(r.json)}`);
  }
  const row =
    await app`SELECT status, approved_by, self_approved FROM case_handovers WHERE id = ${handoverId}`;
  if (
    row[0]?.status === 'completed' &&
    row[0]?.approved_by === C_KEY &&
    row[0]?.self_approved === false
  ) {
    ok('DB: completed / 承認者=C / 自己承認ではない');
  } else {
    ng('DB の承認記録が不一致', JSON.stringify(row[0]));
  }
} catch (error) {
  ng('例外', String(error.message || error));
} finally {
  // ---- 復元（1 トランザクションで行う。途中失敗でも部分復元を残さない） ----
  let restoredCount = 0;
  let leftoverHandovers = -1;
  try {
    const outcome = await app.begin(async (tx) => {
      if (handoverId) await tx`DELETE FROM case_handovers WHERE id = ${handoverId}`;
      await tx`DELETE FROM case_handovers WHERE case_id = ${CASE_ID}`;
      // E2E で付与した approver を残さない（除外対象の DX 担当者に権限を残さないため）。
      await tx`DELETE FROM user_roles WHERE granted_by = 'e2e' AND role = 'approver'`;
      // A/B/C の状態を一度消し、退避した内容だけを戻す（検証用フィクスチャを残さない）。
      await tx`DELETE FROM prototype_states WHERE user_email IN (${A_KEY}, ${B_KEY}, ${C_KEY})`;
      for (const [key, data] of backup) {
        const [email, name] = key.split('|');
        await tx`
          INSERT INTO prototype_states (user_email, name, data)
          VALUES (${email}, ${name}, ${app.json(data)})
          ON CONFLICT (user_email, name) DO UPDATE SET data = EXCLUDED.data
        `;
      }
      const restoredRows = await tx`
        SELECT user_email, name, data FROM prototype_states
        WHERE user_email IN (${A_KEY}, ${B_KEY}, ${C_KEY})
      `;
      const restored = new Map(restoredRows.map((r) => [`${r.user_email}|${r.name}`, r.data]));
      const mismatched = [...backup.keys()].filter(
        (key) => !restored.has(key) || digest(restored.get(key)) !== digest(backup.get(key)),
      );
      const extra = [...restored.keys()].filter((key) => !backup.has(key));
      const left = await tx`
        SELECT count(*)::int AS n FROM case_handovers WHERE case_id = ${CASE_ID}
      `;
      return { restored, mismatched, extra, left: left[0].n };
    });
    restoredCount = outcome.restored.size;
    leftoverHandovers = outcome.left;
    if (outcome.mismatched.length === 0 && outcome.extra.length === 0) {
      ok('状態を元へ戻した（復元後に内容が一致）', `${backup.size} 件`);
    } else {
      ng(
        '状態の復元が一致しない',
        `戻り不一致=${outcome.mismatched.length} 件 / 残存=${outcome.extra.length} 件。手動での復元が必要です`,
      );
    }
  } catch (error) {
    ng('復元処理が失敗しました', String(error.message || error));
  }
  console.log(
    `  復元: 対象状態=${restoredCount} 件（退避=${backup.size} 件） / 残った引継ぎ=${leftoverHandovers} 件`,
  );
  await app.end({ timeout: 5 });
  await info.end({ timeout: 5 });
  const failed = results.filter((x) => !x.ok);
  console.log(
    `\n結果: ${results.length - failed.length}/${results.length} OK${failed.length ? ' / 失敗あり' : ''}`,
  );
  process.exit(failed.length ? 1 : 0);
}
