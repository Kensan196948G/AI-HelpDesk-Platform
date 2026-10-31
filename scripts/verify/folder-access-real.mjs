#!/usr/bin/env node
/**
 * 本人同意付きフォルダ一覧の実機検証ドライバ（docs/62 §10）。
 * 検証インスタンス（ACCESS_JWT_MODE=off、ループバック）専用。本番へ向けない。
 *
 *   AIHD_BASE=http://127.0.0.1:18967 AIHD_OWNER=... AIHD_OPERATOR=... AIHD_HOSTNAME=... \
 *     node scripts/verify/folder-access-real.mjs <command> [args]
 *
 * 証跡に残す前提なので、名前は出力せず、件数と種別と結果コードだけを表示する。
 * enroll-code だけは install-folder-helper.ps1 -EnrollCode に渡す一回限りのコードを表示する（証跡に残さない）。
 */
import { createHash } from 'node:crypto';
import postgres from 'postgres';

const BASE = process.env.AIHD_BASE ?? 'http://127.0.0.1:18967';
const OWNER = process.env.AIHD_OWNER;
const OPERATOR = process.env.AIHD_OPERATOR;
const HOSTNAME = process.env.AIHD_HOSTNAME;
if (!/^http:\/\/127\.0\.0\.1:/.test(BASE)) {
  console.error('検証インスタンス（ループバック）以外には接続しません。');
  process.exit(2);
}

async function call(email, method, path, body) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      'cf-access-authenticated-user-email': email,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, json };
}

function brief(result) {
  const data = result.json?.request ?? result.json ?? {};
  return {
    http: result.status,
    code: result.json?.error?.code,
    status: data.status,
    reason: data.reasonCode ?? data.endReason,
  };
}

const [command, ...args] = process.argv.slice(2);
const summarize = (entries) => {
  const types = {};
  for (const entry of entries) types[entry.type] = (types[entry.type] ?? 0) + 1;
  return {
    count: entries.length,
    types,
    namesSha256: createHash('sha256')
      .update(
        entries
          .map((entry) => entry.name)
          .sort()
          .join('\n'),
      )
      .digest('hex')
      .slice(0, 16),
  };
};

switch (command) {
  case 'seed': {
    const sql = postgres(process.env.DATABASE_URL, { max: 1 });
    const rows = await sql`
      INSERT INTO case_handovers (case_id, owner_email, status, snapshot, claimed_by, claimed_at)
      VALUES (${`CASE-FA-${Date.now()}`}, ${OWNER}, 'claimed',
        ${sql.json({ case: { subject: '検証案件（合成）' } })}, ${OPERATOR}, now())
      RETURNING id`;
    console.log(rows[0].id);
    await sql.end();
    break;
  }
  case 'create': {
    const result = await call(OPERATOR, 'POST', '/api/folder-access/requests', {
      handoverId: args[0],
      hostname: HOSTNAME,
    });
    console.log(JSON.stringify({ ...brief(result), id: result.json?.request?.id }));
    break;
  }
  case 'enroll-code': {
    // 相談者本人が発行する。一回限り、10 分。
    const result = await call(
      OWNER,
      'POST',
      `/api/folder-access/requests/${args[0]}/enroll-code`,
      {},
    );
    console.log(
      JSON.stringify({
        ...brief(result),
        enrollCode: result.json?.enrollCode,
        expiresAt: result.json?.expiresAt,
      }),
    );
    break;
  }
  case 'status':
    console.log(
      JSON.stringify(brief(await call(OPERATOR, 'GET', `/api/folder-access/requests/${args[0]}`))),
    );
    break;
  case 'pair':
    console.log(
      JSON.stringify(
        brief(
          await call(OWNER, 'POST', `/api/folder-access/requests/${args[0]}/pair`, {
            code: args[1],
          }),
        ),
      ),
    );
    break;
  case 'consent':
    console.log(
      JSON.stringify(
        brief(
          await call(OWNER, 'POST', `/api/folder-access/requests/${args[0]}/consent`, {
            root: args[1],
            segments: args.slice(2),
            ttlMinutes: 15,
          }),
        ),
      ),
    );
    break;
  case 'list':
    console.log(
      JSON.stringify(
        brief(await call(OPERATOR, 'POST', `/api/folder-access/requests/${args[0]}/list`, {})),
      ),
    );
    break;
  case 'result': {
    const result = await call(OPERATOR, 'GET', `/api/folder-access/requests/${args[0]}/result`);
    const data = result.json?.result ?? result.json ?? {};
    console.log(
      JSON.stringify({
        http: result.status,
        code: result.json?.error?.code,
        status: data.status,
        reason: data.reason,
        truncated: data.truncated,
        ...(Array.isArray(data.entries) ? summarize(data.entries) : {}),
      }),
    );
    break;
  }
  case 'revoke':
    console.log(
      JSON.stringify(
        brief(await call(OWNER, 'POST', `/api/folder-access/requests/${args[0]}/revoke`, {})),
      ),
    );
    break;
  case 'end':
    console.log(
      JSON.stringify(
        brief(await call(OPERATOR, 'POST', `/api/folder-access/requests/${args[0]}/end`, {})),
      ),
    );
    break;
  case 'as': {
    // as <email> <METHOD> <path> [json]: 拒否系の確認用。
    const result = await call(args[0], args[1], args[2], args[3] ? JSON.parse(args[3]) : undefined);
    console.log(JSON.stringify(brief(result)));
    break;
  }
  default:
    console.error('usage: seed|create|status|pair|consent|list|result|revoke|end|as');
    process.exit(2);
}
