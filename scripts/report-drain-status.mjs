#!/usr/bin/env node
/**
 * 経路②、③の受付を止めた後に、終わっていない処理の件数を読み取りだけで数える（docs/68 §7）。
 *
 * - 書き込まない: 取引を READ ONLY にする。出力は件数だけ。
 * - 接続先は AUDIT_DATABASE_URL だけを読む。DB 名が `_test` で終わらなければ `--allow-db=<DB 名>` が要る。
 * - 終了コード: 0 = off へ進める。3 = 残りがある。結果が不明な実行は「残り」と別に数える。
 */
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';

const OPEN_RESOLVE = ['active', 'proposing', 'waiting_execute', 'executing', 'waiting_continue'];

async function tableExists(tx, name) {
  const [row] = await tx`SELECT to_regclass(${`public.${name}`}) AS t`;
  return row.t !== null;
}

/** 件数を返す。`blocking` が 0 なら off へ進める。 */
export async function drainStatus(sql) {
  return sql.begin('READ ONLY', async (tx) => {
    const [resolve] = await tx`
      SELECT
        (SELECT count(*)::int FROM resolution_sessions WHERE status = ANY(${OPEN_RESOLVE}::text[])) AS open_sessions,
        (SELECT count(*)::int FROM device_commands WHERE status = 'queued') AS queued_commands,
        (SELECT count(*)::int FROM device_commands WHERE status = 'delivered') AS delivered_commands
    `;
    const out = {
      path2: {
        openSessions: resolve.open_sessions,
        queuedCommands: resolve.queued_commands,
        deliveredCommands: resolve.delivered_commands,
      },
      path3: null,
    };
    if (await tableExists(tx, 'support_sessions')) {
      const [assist] = await tx`
        SELECT
          (SELECT count(*)::int FROM support_sessions WHERE ended_at IS NULL) AS open_sessions,
          (SELECT count(*)::int FROM assist_executions WHERE status IN ('queued', 'delivered', 'executing')) AS running,
          (SELECT count(*)::int FROM assist_executions WHERE stop_outcome = 'stop_unconfirmed') AS stop_unconfirmed,
          (SELECT count(*)::int FROM folder_access_requests WHERE status = 'active') AS active_folder
      `;
      out.path3 = {
        openSessions: assist.open_sessions,
        runningExecutions: assist.running,
        stopUnconfirmed: assist.stop_unconfirmed,
        activeFolderRequests: assist.active_folder,
      };
    }
    out.blocking =
      out.path2.openSessions +
      out.path2.queuedCommands +
      out.path2.deliveredCommands +
      (out.path3
        ? out.path3.openSessions + out.path3.runningExecutions + out.path3.activeFolderRequests
        : 0);
    return out;
  });
}

async function main() {
  const url = process.env.AUDIT_DATABASE_URL ?? '';
  const name = (() => {
    try {
      return new URL(url).pathname.slice(1);
    } catch {
      return '';
    }
  })();
  const allow = process.argv.find((arg) => arg.startsWith('--allow-db='))?.split('=')[1];
  if (!name || (!name.endsWith('_test') && allow !== name)) {
    console.error(
      'AUDIT_DATABASE_URL を確かめてください。`_test` 以外は --allow-db=<DB 名> が要ります。',
    );
    return 2;
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const status = await drainStatus(sql);
    console.log(JSON.stringify(status, null, 2));
    return status.blocking === 0 ? 0 : 3;
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
