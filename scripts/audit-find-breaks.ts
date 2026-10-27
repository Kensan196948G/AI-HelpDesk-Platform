/**
 * 監査ハッシュ鎖の破断行を検出する（読み取り専用）。
 *
 * 用途: 環境ごとに audit_log の破断行を実測し、`AUDIT_KNOWN_BREAKS` に設定する値を得る。
 *
 *   # DATABASE_URL は各環境のサービスと同じものを使う（NODE_ENV=production なら .env.local を読まない）。
 *   NODE_ENV=production npx tsx scripts/audit-find-breaks.ts > audit-breaks.json
 *
 *   # 接続先だけ明示的に差し替える場合（.env の DATABASE_URL より優先。値は出力しない）:
 *   AUDIT_SCAN_DATABASE_URL='postgresql://…' npx tsx scripts/audit-find-breaks.ts
 *
 * 出力（JSON）:
 * - mismatches[]: id / action / targetType / targetId / storedHash / recomputedHash / kind など
 * - suggestedEnv.AUDIT_KNOWN_BREAKS: `id:保存hash:再計算hash` のカンマ区切り
 *
 * 注意:
 * - DB へは書き込まない（`default_transaction_read_only = on` で接続し SELECT のみ）。
 * - DATABASE_URL の値（資格情報）は出力に含めない。host / port / DB 名だけを出す。
 * - 破断行があっても終了コードは 0（検出結果は JSON で判断する）。
 */
import postgres from 'postgres';
import { config } from '../apps/api/src/config.js';
import { computeAuditHash, GENESIS_HASH } from '../apps/api/src/domain/audit.js';

interface AuditRow {
  id: string | number;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string;
  detail: Record<string, unknown> | null;
  prev_hash: string;
  hash: string;
  created_at: Date;
}

interface Mismatch {
  id: number;
  kind: 'hash_mismatch' | 'prev_hash_mismatch';
  action: string;
  targetType: string;
  targetId: string;
  storedHash: string;
  recomputedHash: string;
  storedPrevHash: string;
  expectedPrevHash: string;
  createdAt: string;
}

/** 接続先の host/port/db だけを返す（資格情報は出さない）。 */
function safeDatabaseLabel(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    const db = url.pathname.replace(/^\//, '') || '(default)';
    const port = url.port || (url.protocol === 'postgres:' ? '5432' : '');
    return `${url.hostname}${port ? `:${port}` : ''}/${db}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function main(): Promise<void> {
  // 運用時は対象環境の DATABASE_URL を使う。スキャン先だけ差し替えたい場合は
  // AUDIT_SCAN_DATABASE_URL を優先する（値は出力しない）。
  const databaseUrl = process.env.AUDIT_SCAN_DATABASE_URL?.trim() || config.DATABASE_URL;
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    // 読み取り専用を強制する（このセッションで INSERT/UPDATE/DELETE を拒否）。
    await sql.unsafe('SET default_transaction_read_only = on');
    const rows = await sql<AuditRow[]>`
      SELECT id, actor_id, action, target_type, target_id, detail, prev_hash, hash, created_at
      FROM audit_log
      ORDER BY id ASC
    `;

    const mismatches: Mismatch[] = [];
    let prev = GENESIS_HASH;
    for (const row of rows) {
      const recomputedHash = computeAuditHash(prev, {
        actorId: row.actor_id ?? null,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        detail: row.detail ?? {},
      });
      const base = {
        id: Number(row.id),
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        storedHash: row.hash,
        recomputedHash,
        storedPrevHash: row.prev_hash,
        expectedPrevHash: prev,
        createdAt:
          row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      };
      if (row.prev_hash !== prev) {
        mismatches.push({ ...base, kind: 'prev_hash_mismatch' });
      } else if (row.hash !== recomputedHash) {
        mismatches.push({ ...base, kind: 'hash_mismatch' });
      }
      // 検証と同じく、保存済み hash を次行の連結点にする。
      prev = row.hash;
    }

    // 既知破断として設定できるのは「保存 hash と再計算 hash が不一致」の行だけ。
    // prev_hash 不整合は鎖の分岐・欠損であり、既知破断では吸収しない。
    const knownBreakCandidates = mismatches.filter((item) => item.kind === 'hash_mismatch');
    const suggestedEnv = knownBreakCandidates
      .map((item) => `${item.id}:${item.storedHash}:${item.recomputedHash}`)
      .join(',');

    const output = {
      generatedAt: new Date().toISOString(),
      database: safeDatabaseLabel(databaseUrl),
      readOnly: true,
      checked: rows.length,
      mismatchCount: mismatches.length,
      mismatches,
      suggestedEnv: { AUDIT_KNOWN_BREAKS: suggestedEnv },
      note:
        'hash_mismatch は AUDIT_KNOWN_BREAKS に設定できます。prev_hash_mismatch は鎖の欠損・分岐なので、' +
        '既知破断ではなくバックアップ/復旧の調査が必要です。',
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error('[audit-find-breaks] 失敗:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
