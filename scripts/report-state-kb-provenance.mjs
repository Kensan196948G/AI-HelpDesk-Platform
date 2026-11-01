#!/usr/bin/env node
/**
 * 「state に active KB があるが DB で承認されていない」件数を読み取りだけで数える（docs/64）。
 *
 * - 書き込まない: セッションと取引の両方を READ ONLY にする。
 * - 出力は件数だけ。メール・題名・本文を出さない。
 * - 接続先は AUDIT_DATABASE_URL だけを読む（.env / DATABASE_URL を読まない）。
 * - DB 名が `_test` で終わらなければ止める。それ以外は `--allow-db=<DB 名>` で名前を明示する。
 *   本番 DB への実行は運用者の判断で行う（docs/64 §4）。
 *
 * 実行: AUDIT_DATABASE_URL=... node scripts/report-state-kb-provenance.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROTOTYPE_HTML = path.join(
  here,
  '..',
  'Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html',
);

/** 接続してよい DB か。理由を返す（null なら可）。 */
export function refusalReason(databaseUrl, allowDb) {
  if (!databaseUrl) return 'AUDIT_DATABASE_URL が設定されていません。';
  const name = new URL(databaseUrl).pathname.slice(1);
  if (name.endsWith('_test')) return null;
  if (allowDb && allowDb === name) return null;
  return 'DB 名が _test で終わりません。対象を確認し --allow-db=<DB 名> で明示してください。';
}

/** 原本 HTML の初期 KB（全員の state に最初から入るデモ）の `id|題名` の集合。 */
export function demoKbKeys(html) {
  const keys = new Set();
  for (const match of html.matchAll(/K\('(KB-\d+)','[^']*','([^']*)'/g)) {
    keys.add(`${match[1]}|${match[2]}`);
  }
  return keys;
}

function parseData(data) {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** DB の 1 行が AI の根拠に使えるか（knowledge-search.ts の条件と同じ）。使えない理由を返す。 */
/** keywords は本文と別に数える（既存行は書き換えない。docs/64 §11）。 */
export function keywordsHaveDeviceInfo(row) {
  return (row.keywords ?? []).some((keyword) => containsDeviceInfo(String(keyword)));
}

export function dbRowBlocker(row) {
  if (row.status !== 'approved') return 'notApproved';
  if (!row.approver_id || !row.approved_at) return 'missingApprovalRecord';
  if (row.approver_id === row.author_id) return 'selfApproved';
  if (new Date(row.updated_at) > new Date(row.approved_at)) return 'editedAfterApproval';
  return null;
}

/** 別アカウントだが同一人物の承認か（記録のみ。AI の根拠からは除かない）。 */
function isSharedIdentity(row, sharedGroups) {
  const author = String(row.author_email ?? '').toLowerCase();
  const approver = String(row.approver_email ?? '').toLowerCase();
  return (
    Boolean(author && approver) &&
    author !== approver &&
    sharedGroups.some((group) => group.includes(author) && group.includes(approver))
  );
}

/** scripts/seed.ts の利用者の固定 ID（domain/approval-origin.ts と同じ。試験で一致を確かめる）。 */
export const SEED_USER_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
];

function isSeedRow(row) {
  return (
    SEED_USER_IDS.includes(String(row.author_id)) && SEED_USER_IDS.includes(String(row.approver_id))
  );
}

/** apps/api/src/domain/pii.ts の KNOWLEDGE_RULES と redactPII の一部と同じ判定（試験で一致を確かめる）。 */
const DEVICE_INFO_PATTERNS = [
  /【(?:端末|PC基本情報[^】]*|実診断の結果|AIの診断結果|対応案[^】]*|添付[^】]*)】/,
  /(?:コンピュータ名|コンピューター名|ホスト名|hostname|シリアル番号|シリアル|serial(?: ?number)?|MACアドレス|取得日時)\s*[:：=]\s*[^\s、。／/]+/i,
  /WEB-[0-9A-F]{8}(?![0-9A-F])/i,
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/i,
  /MRK-[A-Z0-9-]+/i,
  /(?<![A-Z0-9])MK\d{4,6}(?!\d)/i,
  /(?<![A-Z0-9-])(?:DESKTOP|LAPTOP|WIN|WORKSTATION)-[A-Z0-9]{3,}(?![A-Z0-9-])/i,
  /(?<![\w.-])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:local|lan|corp|internal|intranet)(?![\w.-])/i,
  /(?<![0-9A-F:-])[0-9A-F]{2}(?:[:-][0-9A-F]{2}){5}(?![0-9A-F:-])/i,
  /[A-Z0-9._%+-]+[@＠][A-Z0-9.-]+\.[A-Z]{2,}/i,
  /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/,
];

/** 本文に端末情報が含まれるか。 */
export function countsDeviceInfo(text) {
  return DEVICE_INFO_PATTERNS.some((pattern) => pattern.test(String(text ?? '')));
}

function rowHasDeviceInfo(row) {
  return [row.title, row.symptom, row.cause, row.steps].some(countsDeviceInfo);
}

/** 件数を集計する（純粋関数）。 */
export function summarize(states, knowledge, demoKeys, sharedGroups = []) {
  const byRef = new Map(
    knowledge.filter((row) => row.client_ref).map((row) => [row.client_ref, row]),
  );
  const report = {
    state: {
      users: 0,
      activeKb: 0,
      demoInitial: 0,
      noDraftLink: 0,
      linkedUsable: 0,
      linkedNotUsable: 0,
      linkedNoDbRow: 0,
    },
    db: {
      approved: 0,
      usable: 0,
      usableSharedIdentity: 0,
      selfApproved: 0,
      editedAfterApproval: 0,
      missingApprovalRecord: 0,
      usableWithoutKeywords: 0,
      // 束縛（docs/64 §10）の導入前に公開された行。確認した本文の記録が無い。
      approvedWithoutReviewedHash: 0,
      // 公開された版の本文が、確認した本文の記録と一致するかは報告しない（版を含む指紋で別に照合する）。
      approvedKeywordsWithDeviceInfo: 0,
      notApprovedKeywordsWithDeviceInfo: 0,
      // 元の引継ぎをたどれない画面経路の行。
      uiRowsWithoutSource: 0,
      draftsWithoutClientRef: 0,
      approvedWithDeviceInfo: 0,
      notApprovedWithDeviceInfo: 0,
      usableOtherPerson: 0,
      usableSeed: 0,
    },
  };

  for (const raw of states) {
    const data = parseData(raw.data);
    const kb = Array.isArray(data?.kb) ? data.kb : [];
    const active = kb.filter((item) => item?.status === 'active');
    if (active.length === 0) continue;
    report.state.users += 1;
    const drafts = Array.isArray(data?.drafts) ? data.drafts : [];
    for (const item of active) {
      report.state.activeKb += 1;
      const draft = drafts.find((entry) => entry?.kbId === item.id);
      if (!draft) {
        if (demoKeys.has(`${item.id}|${item.title}`)) report.state.demoInitial += 1;
        else report.state.noDraftLink += 1;
        continue;
      }
      const row = byRef.get(`ui-${draft.id}`);
      if (!row) report.state.linkedNoDbRow += 1;
      else if (dbRowBlocker(row)) report.state.linkedNotUsable += 1;
      else report.state.linkedUsable += 1;
    }
  }

  for (const row of knowledge) {
    if (keywordsHaveDeviceInfo(row)) {
      if (row.status === 'approved') report.db.approvedKeywordsWithDeviceInfo += 1;
      else report.db.notApprovedKeywordsWithDeviceInfo += 1;
    }
    if (row.status === 'approved' && !row.reviewed_hash) report.db.approvedWithoutReviewedHash += 1;
    if (row.client_ref && !row.source_handover_id) report.db.uiRowsWithoutSource += 1;
    if (rowHasDeviceInfo(row)) {
      if (row.status === 'approved') report.db.approvedWithDeviceInfo += 1;
      else report.db.notApprovedWithDeviceInfo += 1;
    }
    if (row.status !== 'approved') {
      if (!row.client_ref && row.status !== 'rejected') report.db.draftsWithoutClientRef += 1;
      continue;
    }
    report.db.approved += 1;
    const blocker = dbRowBlocker(row);
    if (blocker) report.db[blocker] += 1;
    else {
      report.db.usable += 1;
      // サーバの approvalOriginOf と同じ順: seed → shared_identity → other_person。
      if (isSeedRow(row)) report.db.usableSeed += 1;
      else if (isSharedIdentity(row, sharedGroups)) report.db.usableSharedIdentity += 1;
      else report.db.usableOtherPerson += 1;
      if (!row.keywords?.length) report.db.usableWithoutKeywords += 1;
    }
  }
  return report;
}

function parseSharedGroups(raw) {
  return String(raw || '')
    .split(';')
    .map((group) =>
      group
        .split('|')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    )
    .filter((group) => group.length >= 2);
}

async function main() {
  const allowDb = process.argv.find((arg) => arg.startsWith('--allow-db='))?.split('=')[1];
  const databaseUrl = process.env.AUDIT_DATABASE_URL;
  const refusal = refusalReason(databaseUrl, allowDb);
  if (refusal) {
    console.error(`[report-state-kb] ${refusal}`);
    process.exit(2);
  }
  const sql = postgres(databaseUrl, {
    max: 1,
    onnotice: () => {},
    connection: { default_transaction_read_only: 'on', application_name: 'report-state-kb' },
  });
  try {
    const { states, knowledge } = await sql.begin('READ ONLY', async (tx) => ({
      states: await tx`SELECT data FROM prototype_states WHERE name = 'helpdesk'`,
      knowledge: await tx`
        SELECT k.status, k.client_ref, k.author_id, k.approver_id, k.approved_at, k.updated_at,
               k.keywords, k.title, k.symptom, k.cause, k.steps, k.source_handover_id,
               au.email AS author_email, pu.email AS approver_email,
               (SELECT r.content_hash FROM knowledge_reviews r
                 WHERE r.knowledge_id = k.id AND r.decision = 'approved'
                 ORDER BY r.created_at DESC LIMIT 1) AS reviewed_hash
        FROM knowledge k
        LEFT JOIN users au ON au.id = k.author_id
        LEFT JOIN users pu ON pu.id = k.approver_id
      `,
    }));
    const report = summarize(
      states,
      knowledge,
      demoKbKeys(readFileSync(PROTOTYPE_HTML, 'utf8')),
      parseSharedGroups(process.env.SHARED_IDENTITY_GROUPS),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // 接続文字列を出さない。
    console.error(`[report-state-kb] 失敗: ${error?.code ?? error?.name ?? 'unknown'}`);
    process.exit(1);
  });
}
