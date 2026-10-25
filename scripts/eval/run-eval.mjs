#!/usr/bin/env node
/**
 * 解決能力の評価ハーネス（30 件）
 *
 * 目的:
 *   「AI が利用者の相談を解決に導けるか」を、同じケース集合で繰り返し測る。
 *   指標は docs/27-solution-gap-measurement.md §5 の定義に合わせる。
 *
 * 安全側の設計:
 *   - 既定は dry-run。`--execute` を付けたときだけ API を呼ぶ。
 *   - 接続先は loopback / 127.0.0.0/8 のみ許可（本番ドメインを誤って叩かない）。
 *   - 1 リクエストごとに待機（既定 3.2 秒）。API のレート制限 20 回/分を超えない。
 *   - 相談文・回答全文はレポートに保存しない（長さ・出典・判定のみ）。
 *     個人情報を含むケースがあるため、既定では本文を残さない。
 *
 * 使い方:
 *   node scripts/eval/run-eval.mjs --base http://127.0.0.1:18960            # dry-run
 *   node scripts/eval/run-eval.mjs --base http://127.0.0.1:18960 --execute  # 実行
 *   node scripts/eval/run-eval.mjs --base ... --execute --fail-on-miss       # CI 用
 *
 * 終了コード: 0 正常 / 2 引数不正 / 3 実行エラー / 4 未達あり（--fail-on-miss 時）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CASES_FILE = path.join(HERE, 'cases.jsonl');

function parseArgs(argv) {
  const out = {
    base: 'http://127.0.0.1:18960',
    execute: false,
    failOnMiss: false,
    out: null,
    paceMs: 3200,
    timeoutMs: 30_000,
    allowRemote: false,
    limit: null,
    // cloudflare-access モードの検証インスタンスへ送る利用者メール。
    // 未指定なら local 認証（DEV_AUTH_EMAIL）前提。
    as: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} に値がありません`);
      return argv[i];
    };
    switch (arg) {
      case '--base':
        out.base = next();
        break;
      case '--execute':
        out.execute = true;
        break;
      case '--fail-on-miss':
        out.failOnMiss = true;
        break;
      case '--allow-remote':
        out.allowRemote = true;
        break;
      case '--out':
        out.out = next();
        break;
      case '--pace-ms':
        out.paceMs = Number(next());
        break;
      case '--timeout-ms':
        out.timeoutMs = Number(next());
        break;
      case '--limit':
        out.limit = Number(next());
        break;
      case '--as':
        out.as = next();
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        throw new Error(`未知の引数: ${arg}`);
    }
  }
  return out;
}

function isLoopbackHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname)
  );
}

function loadCases(limit) {
  const lines = readFileSync(CASES_FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  const cases = lines.map((line) => JSON.parse(line));
  return limit ? cases.slice(0, limit) : cases;
}

const ESCALATION_HINT = /担当者へ|引き継|お引き継ぎ|判断できません|お答えできません/;

function evaluate(testCase, response) {
  const answer = typeof response?.answer === 'string' ? response.answer : '';
  const sources = Array.isArray(response?.sources) ? response.sources : [];
  const cited = sources.map((s) => s?.kbNo).filter((v) => typeof v === 'string');
  const problems = [];

  if (testCase.mustCite && !cited.includes(testCase.mustCite)) {
    problems.push(`期待する出典がない: ${testCase.mustCite}（実際: ${cited.join(',') || 'なし'}）`);
  }
  if (
    Array.isArray(testCase.mustCiteAny) &&
    !testCase.mustCiteAny.some((kb) => cited.includes(kb))
  ) {
    problems.push(`期待する出典がいずれも無い: ${testCase.mustCiteAny.join('|')}`);
  }
  if (testCase.mustEscalate === true && sources.length > 0) {
    problems.push('引継ぎを期待したが出典付きで回答した');
  }
  if (testCase.mustEscalate === true && sources.length === 0 && !ESCALATION_HINT.test(answer)) {
    problems.push('出典なしだが引継ぎの言及が無い');
  }
  for (const needle of testCase.mustNotInclude ?? []) {
    if (answer.includes(needle)) problems.push(`回答に含まれてはならない文字列: ${needle}`);
  }

  return {
    pass: problems.length === 0,
    problems,
    cited,
    sourceCount: sources.length,
    answerLength: answer.length,
    provider: response?.provider ?? null,
    confidence: response?.confidence ?? null,
    escalated: sources.length === 0,
  };
}

async function ask(base, text, timeoutMs, asEmail) {
  const started = Date.now();
  const headers = { 'content-type': 'application/json' };
  // Cloudflare Access の手前で付与されるヘッダを、検証インスタンスに対して模擬する
  // （ACCESS_JWT_MODE=off のときのみ有効）。
  if (asEmail) headers['cf-access-authenticated-user-email'] = asEmail;
  const response = await fetch(new URL('/api/ai/answer', base), {
    method: 'POST',
    headers,
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const latencyMs = Date.now() - started;
  const body = await response.json().catch(() => null);
  return { status: response.status, body, latencyMs };
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return 0;
  }
  const target = new URL(opts.base);
  if (!isLoopbackHost(target.hostname) && !opts.allowRemote) {
    console.error(
      `拒否: ${target.hostname} は loopback ではありません。本番を誤って叩かないため停止します。`,
    );
    console.error('どうしても必要なら --allow-remote を明示してください（推奨しません）。');
    return 2;
  }
  const cases = loadCases(opts.limit);

  if (!opts.execute) {
    console.log(`[dry-run] 接続先: ${opts.base}`);
    console.log(`[dry-run] ケース数: ${cases.length}`);
    for (const c of cases.slice(0, 5)) console.log(`  - ${c.id} (${c.group})`);
    console.log('[dry-run] 実行するには --execute を付けてください。');
    return 0;
  }

  const results = [];
  for (const [index, testCase] of cases.entries()) {
    if (index > 0 && opts.paceMs > 0) await new Promise((r) => setTimeout(r, opts.paceMs));
    let record;
    try {
      const { status, body, latencyMs } = await ask(
        opts.base,
        testCase.text,
        opts.timeoutMs,
        opts.as,
      );
      if (status !== 200 || !body?.answer) {
        record = {
          id: testCase.id,
          group: testCase.group,
          pass: false,
          problems: [`HTTP ${status}`],
          cited: [],
          sourceCount: 0,
          answerLength: 0,
          provider: body?.provider ?? null,
          confidence: null,
          escalated: null,
          latencyMs,
        };
      } else {
        record = { id: testCase.id, group: testCase.group, ...evaluate(testCase, body), latencyMs };
      }
    } catch (error) {
      record = {
        id: testCase.id,
        group: testCase.group,
        pass: false,
        problems: [`実行エラー: ${error.message}`],
        cited: [],
        sourceCount: 0,
        answerLength: 0,
        provider: null,
        confidence: null,
        escalated: null,
        latencyMs: null,
      };
    }
    results.push(record);
    console.log(
      `  ${record.pass ? 'PASS' : 'FAIL'} ${record.id} (${record.group})${record.pass ? '' : ' :: ' + record.problems.join(' / ')}`,
    );
  }

  const passed = results.filter((r) => r.pass).length;
  const latencies = results.map((r) => r.latencyMs).filter((v) => typeof v === 'number');
  const byGroup = {};
  for (const r of results) {
    byGroup[r.group] ??= { total: 0, pass: 0 };
    byGroup[r.group].total += 1;
    if (r.pass) byGroup[r.group].pass += 1;
  }
  const summary = {
    at: new Date().toISOString(),
    base: opts.base,
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length === 0 ? null : Number((passed / results.length).toFixed(4)),
    escalated: results.filter((r) => r.escalated === true).length,
    providerCounts: results.reduce((acc, r) => {
      const key = r.provider ?? 'unknown';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length ? Math.max(...latencies) : null,
    },
    byGroup,
  };

  console.log('');
  console.log('=== summary ===');
  console.log(
    `pass ${summary.passed}/${summary.total} (${(summary.passRate * 100).toFixed(1)}%) / escalate ${summary.escalated}`,
  );
  console.log(
    `provider: ${JSON.stringify(summary.providerCounts)} / latency p50=${summary.latencyMs.p50}ms p95=${summary.latencyMs.p95}ms`,
  );
  for (const [g, v] of Object.entries(byGroup)) console.log(`  ${g}: ${v.pass}/${v.total}`);

  const outPath = opts.out ?? path.join('/tmp', `aihd-eval-${Date.now()}.json`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2));
  console.log(`report: ${outPath}`);

  if (opts.failOnMiss && summary.failed > 0) return 4;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`ハーネスエラー: ${error.message}`);
    process.exit(3);
  });
