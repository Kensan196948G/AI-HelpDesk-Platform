#!/usr/bin/env node
/**
 * 経路②、③の受付を止めた後に、終わっていない処理の件数を読み取りだけで数える（docs/68 §7）。
 *
 * - 書き込まない: 取引を READ ONLY にする。出力は件数だけ。
 * - 接続先は AUDIT_DATABASE_URL だけを読む。DB 名が `_test` で終わらなければ `--allow-db=<DB 名>` が要る。
 * - 終了コード: 0 = off へ進める。3 = 終わっていない処理がある。4 = 結果不明があり、人の確認が要る。
 *   結果不明は待っても消えない。確認した後に `--accept-unknown` を付けて記録する。結果不明を消さない。
 */
import postgres from 'postgres';
import { isMainModule } from './lib/is-main.mjs';

async function tableExists(tx, name) {
  const [row] = await tx`SELECT to_regclass(${`public.${name}`}) AS t`;
  return row.t !== null;
}

/**
 * 件数を返す。`blocking` は待てば終わるもの。`resultUnknown` は待っても終わらない、人の確認が要るもの。
 */
export async function drainStatus(sql) {
  return sql.begin('READ ONLY', async (tx) => {
    const [resolve] = await tx`
      SELECT
        (SELECT count(*)::int FROM resolution_sessions
          WHERE status IN ('active', 'waiting_execute', 'executing')
             OR (status = 'waiting_continue' AND expires_at > now())) AS open_sessions,
        (SELECT count(*)::int FROM resolution_sessions
          WHERE status = 'waiting_continue' AND expires_at <= now()) AS decision_left,
        (SELECT count(*)::int FROM device_commands WHERE status = 'queued') AS queued_commands,
        (SELECT count(*)::int FROM device_commands c
          WHERE c.status = 'delivered' AND EXISTS (
            SELECT 1 FROM resolution_steps st
            WHERE st.id = c.step_id AND st.status IN ('approved', 'executing')
          )) AS running_commands,
        (SELECT count(*)::int FROM device_commands c
          WHERE c.status = 'delivered' AND NOT EXISTS (
            SELECT 1 FROM resolution_steps st
            WHERE st.id = c.step_id AND st.status IN ('approved', 'executing')
          )) AS unknown_commands
    `;
    const out = {
      path2: {
        openSessions: resolve.open_sessions,
        decisionLeftAfterExpiry: resolve.decision_left,
        queuedCommands: resolve.queued_commands,
        runningCommands: resolve.running_commands,
        resultUnknownCommands: resolve.unknown_commands,
      },
      path3: null,
    };
    let path3Blocking = 0;
    let path3Unknown = 0;
    if (await tableExists(tx, 'support_sessions')) {
      const [assist] = await tx`
        SELECT
          (SELECT count(*)::int FROM support_sessions WHERE ended_at IS NULL) AS open_sessions,
          (SELECT count(*)::int FROM assist_executions
            WHERE status IN ('queued', 'delivered', 'executing')) AS running,
          (SELECT count(*)::int FROM assist_executions
            WHERE stop_outcome = 'stop_unconfirmed') AS stop_unconfirmed,
          (SELECT count(*)::int FROM folder_access_requests
            WHERE status IN ('device_pending', 'helper_pending', 'consent_pending', 'active')) AS open_folder,
          (SELECT count(*)::int FROM folder_access_ops
            WHERE status IN ('queued', 'delivered')) AS folder_ops
      `;
      out.path3 = {
        openSessions: assist.open_sessions,
        runningExecutions: assist.running,
        stopUnconfirmed: assist.stop_unconfirmed,
        openFolderRequests: assist.open_folder,
        folderOps: assist.folder_ops,
      };
      path3Blocking =
        assist.open_sessions + assist.running + assist.open_folder + assist.folder_ops;
      path3Unknown = assist.stop_unconfirmed;
    }
    out.blocking =
      out.path2.openSessions + out.path2.queuedCommands + out.path2.runningCommands + path3Blocking;
    out.resultUnknown = out.path2.resultUnknownCommands + path3Unknown;
    return out;
  });
}

/** 0: off へ進める。3: 終わっていない処理がある。4: 結果不明があり、人の確認が要る。 */
export function drainExitCode(status, acceptUnknown = false) {
  if (status.blocking > 0) return 3;
  if (status.resultUnknown > 0 && !acceptUnknown) return 4;
  return 0;
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
    return drainExitCode(status, process.argv.includes('--accept-unknown'));
  } finally {
    await sql.end();
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exit(await main());
}
