#!/usr/bin/env node
/**
 * systemd の EnvironmentFile と同じ形式のファイルを読み、環境変数として渡してコマンドを実行する。
 * シェルとして実行しないので、値に `|` や `$` があっても解釈されない（docs/09 §4-3）。値は表示しない。
 *
 * 使い方: node scripts/run-with-env-file.mjs <file> -- <command> [args...]
 * ファイルの値を優先する（シェルに残った DATABASE_URL などで別の DB を指さない。systemd と同じ結果にする）。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** KEY=VALUE を読む。空行と # の行は無視し、値全体を囲む引用符だけを外す。 */
export function parseEnvironmentFile(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error('形式が正しくない行があります（値は表示しません）。');
    const value = match[2];
    const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
    env[match[1]] = quoted ? quoted[1] : value;
  }
  return env;
}

function main(argv) {
  const separator = argv.indexOf('--');
  if (separator !== 1 || argv.length < 3) {
    console.error('使い方: run-with-env-file.mjs <file> -- <command> [args...]');
    return 2;
  }
  const fromFile = parseEnvironmentFile(readFileSync(argv[0], 'utf8'));
  const [command, ...args] = argv.slice(2);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...fromFile },
  });
  if (result.error) {
    console.error(`コマンドを起動できません: ${result.error.code ?? 'unknown'}`);
    return 127;
  }
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
