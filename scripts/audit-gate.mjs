#!/usr/bin/env node
// 依存監査ゲート: `npm audit --json` の結果を評価し、High/Critical のうち
// 「期限付き例外」に該当しないものが 1 件でもあれば exit 1 にする。
//
// 背景（2026-11-18）: 上流に修正版が存在しない勧告（picomatch <= 4.0.7 の ReDoS）が
// 公開され、`npm audit --audit-level=high` だけでは CI を恒久的に止められなくなった。
// 例外は docs/security/audit-exceptions.json に限定列挙し、次の条件をすべて満たす場合だけ許可する。
//   - 勧告 ID（GHSA-xxxx-xxxx-xxxx）が一致する
//   - scope（dev / runtime）が監査スコープに含まれる（runtime 監査に dev 例外は適用しない）
//   - expiresAt が未来である
//   - reason / approvedBy が空でない
// 例外の追加は「修正版が存在しない」「本番ランタイムに含まれない」「期限を切る」を条件とする。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

export function advisoryIdFromUrl(url) {
  const match = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(String(url ?? ''));
  return match ? match[0].toUpperCase() : null;
}

/** vulnerabilities から、各パッケージが直接持つ勧告オブジェクトを集める。 */
export function collectDirectAdvisories(vulnerabilities = {}) {
  const byPackage = new Map();
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    const list = [];
    for (const via of entry?.via ?? []) {
      if (!via || typeof via !== 'object') continue;
      const id = advisoryIdFromUrl(via.url);
      if (id)
        list.push({
          id,
          package: String(via.name || name),
          title: String(via.title || ''),
          url: String(via.url || ''),
        });
    }
    byPackage.set(name, list);
  }
  return byPackage;
}

/** via の文字列参照（推移依存）をたどり、到達できる勧告 ID をすべて集める。 */
export function reachableAdvisories(
  name,
  vulnerabilities,
  direct,
  seen = new Set(),
  acc = new Map(),
) {
  if (seen.has(name)) return acc;
  seen.add(name);
  for (const advisory of direct.get(name) ?? []) acc.set(advisory.id, advisory);
  for (const via of vulnerabilities[name]?.via ?? []) {
    if (typeof via === 'string') reachableAdvisories(via, vulnerabilities, direct, seen, acc);
  }
  return acc;
}

export function normalizeExceptions(raw = []) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.exceptions) ? raw.exceptions : [];
  return list
    .map((entry) => ({
      id: advisoryIdFromUrl(entry?.url) || String(entry?.id ?? '').toUpperCase(),
      package: String(entry?.package ?? ''),
      scope: entry?.scope === 'runtime' ? 'runtime' : 'dev',
      reason: String(entry?.reason ?? ''),
      approvedBy: String(entry?.approvedBy ?? ''),
      expiresAt: String(entry?.expiresAt ?? ''),
      upstream: String(entry?.upstream ?? ''),
    }))
    .filter((entry) => /^GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(entry.id));
}

export function evaluateAudit(
  report,
  rawExceptions = [],
  { scope = 'all', now = new Date() } = {},
) {
  const vulnerabilities = report?.vulnerabilities ?? {};
  const direct = collectDirectAdvisories(vulnerabilities);
  const nowMs = now.getTime();
  const usable = normalizeExceptions(rawExceptions).filter((entry) => {
    if (!entry.reason.trim() || !entry.approvedBy.trim()) return false;
    const expires = Date.parse(entry.expiresAt);
    if (!Number.isFinite(expires) || expires <= nowMs) return false;
    if (scope === 'runtime' && entry.scope !== 'runtime') return false;
    return true;
  });
  const exceptedIds = new Set(usable.map((entry) => entry.id));
  const blocking = [];
  const excepted = [];
  const ignored = [];
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    const severity = String(entry?.severity ?? '');
    if (!BLOCKING_SEVERITIES.has(severity)) {
      ignored.push({ name, severity });
      continue;
    }
    const advisories = [...reachableAdvisories(name, vulnerabilities, direct).values()];
    const ids = advisories.map((advisory) => advisory.id);
    const record = {
      name,
      severity,
      advisories: ids,
      titles: advisories.map((advisory) => advisory.title),
    };
    if (ids.length > 0 && ids.every((id) => exceptedIds.has(id))) excepted.push(record);
    else blocking.push(record);
  }
  return {
    ok: blocking.length === 0,
    scope,
    blocking,
    excepted,
    ignored,
    evaluatedAt: now.toISOString(),
    exceptionIds: [...exceptedIds].sort(),
  };
}

function format(result) {
  const lines = [
    `[audit-gate] scope=${result.scope} blocking=${result.blocking.length} excepted=${result.excepted.length} at=${result.evaluatedAt}`,
  ];
  for (const item of result.blocking) {
    lines.push(
      `  BLOCK ${item.name} (${item.severity}) advisories=${item.advisories.join(',') || 'unknown'}`,
    );
  }
  for (const item of result.excepted) {
    lines.push(`  ALLOW ${item.name} (${item.severity}) advisories=${item.advisories.join(',')}`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { file: '', scope: 'all', exceptions: 'docs/security/audit-exceptions.json' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--scope') {
      options.scope = argv[index + 1] === 'runtime' ? 'runtime' : 'all';
      index += 1;
      continue;
    }
    if (arg === '--exceptions') {
      options.exceptions = argv[index + 1] ?? options.exceptions;
      index += 1;
      continue;
    }
    if (!options.file) options.file = arg;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.file) {
    console.error(
      '[audit-gate] usage: node scripts/audit-gate.mjs <npm-audit.json> [--scope all|runtime] [--exceptions path]',
    );
    process.exit(2);
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(options.file, 'utf8'));
  } catch (error) {
    console.error(`[audit-gate] npm audit の JSON を読めません: ${error.message}`);
    process.exit(2);
  }
  let exceptions = [];
  try {
    exceptions = JSON.parse(fs.readFileSync(path.resolve(options.exceptions), 'utf8'));
  } catch {
    exceptions = [];
  }
  const result = evaluateAudit(report, exceptions, { scope: options.scope });
  console.log(format(result));
  if (!result.ok) {
    console.error(
      '[audit-gate] High/Critical の未承認の勧告があります。修正するか、docs/security/audit-exceptions.json に期限付き例外を追加してください。',
    );
    process.exit(1);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) main();
