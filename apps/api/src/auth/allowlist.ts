import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { config, repoRoot } from '../config.js';

/**
 * Cloudflare Access 後のアプリケーション層アクセス制御で使う許可リスト。
 *
 * 正本は `docs/MailAddress.txt`（`ACCESS_ALLOWLIST_FILE` で変更可能）。
 * 人間向けの自由記述から許可エントリだけを抽出する。
 *
 * - `user@example.com` … 完全一致
 * - `@example.co.jp` / `*@example.co.jp` … ドメイン一致（サブドメインは許可しない）
 * - `#` 以降のコメント、`例：` / `e.g.` 以降の例示は無視する
 *   （例示用の typo メールを誤って許可しないため）
 *
 * ファイルが無い・空・読めない場合は **全拒否（fail-closed）**。
 * 許可リストの変更は次回リクエスト時に mtime/size を見て自動反映する。
 */

export interface Allowlist {
  readonly emails: ReadonlySet<string>;
  readonly domains: ReadonlySet<string>;
  readonly source: string;
}

/** 全角英数字・記号（！〜～）を ASCII に寄せる。 */
const FULL_WIDTH = /[\uFF01-\uFF5E]/g;
/** `例：` `e.g.` など、以降が例示であることを示すマーカー。 */
const EXAMPLE_MARKER = /(?:例|たとえば|e\.g\.|example)\s*[:：]/i;
/** 完全一致させるメールアドレス。 */
const EMAIL_TOKEN =
  /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;
/** `@domain` / `*@domain`。メールアドレスの一部は直前がローカル部文字なので一致しない。 */
const DOMAIN_TOKEN = /(?:^|[^A-Za-z0-9._%+-])\*?@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

const EMPTY: Allowlist = { emails: new Set(), domains: new Set(), source: '' };

function normalizeWidth(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(FULL_WIDTH, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

function stripExamplesAndComments(text: string): string {
  return normalizeWidth(text)
    .split(/\r?\n/)
    .map((line) => {
      const withoutComment = line.replace(/(^|\s)#.*$/, '$1');
      const exampleIndex = withoutComment.search(EXAMPLE_MARKER);
      return exampleIndex >= 0 ? withoutComment.slice(0, exampleIndex) : withoutComment;
    })
    .join('\n');
}

function normalizeDomain(value: string): string | null {
  const domain = value
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/^\*\.?/, '')
    .replace(/\.$/, '');
  if (!domain || domain.length > 253) return null;
  const labels = domain.split('.');
  if (labels.length < 2) return null;
  if (labels.some((label) => label.length === 0 || label.length > 63)) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    return null;
  }
  return domain;
}

function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length > 254) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const local = email.slice(0, at);
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return null;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  const domain = normalizeDomain(email.slice(at + 1));
  if (!domain) return null;
  return `${local}@${domain}`;
}

export function parseAllowlist(text: string, source = 'inline'): Allowlist {
  const cleaned = stripExamplesAndComments(text);
  const emails = new Set<string>();
  const domains = new Set<string>();

  for (const match of cleaned.matchAll(EMAIL_TOKEN)) {
    const email = normalizeEmail(match[0]);
    if (email) emails.add(email);
  }
  for (const match of cleaned.matchAll(DOMAIN_TOKEN)) {
    const candidate = match[1];
    if (!candidate) continue;
    const domain = normalizeDomain(candidate);
    if (domain) domains.add(domain);
  }

  return { emails, domains, source };
}

export function isEmailAllowed(allowlist: Allowlist, email: string): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  if (allowlist.emails.has(normalized)) return true;
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
  // 完全一致のみ。`foo@sub.example.com` や `foo@example.com.evil` は許可しない。
  return allowlist.domains.has(domain);
}

export function allowlistSize(allowlist: Allowlist): number {
  return allowlist.emails.size + allowlist.domains.size;
}

export function resolveAllowlistPath(filePath: string = config.ACCESS_ALLOWLIST_FILE): string {
  return path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
}

interface CacheEntry {
  path: string;
  mtimeMs: number;
  size: number;
  allowlist: Allowlist;
}

let cache: CacheEntry | null = null;
/** 同じ失敗をリクエストごとにログへ出さないための抑制キー。 */
let lastErrorKey: string | null = null;

function unavailable(filePath: string): Allowlist {
  return { ...EMPTY, source: filePath };
}

export function getAllowlist(): Allowlist {
  const filePath = resolveAllowlistPath();

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch (error) {
    if (lastErrorKey !== `missing:${filePath}`) {
      lastErrorKey = `missing:${filePath}`;
      console.error(
        `[access] 許可リストを読み込めません。全リクエストを拒否します（fail-closed）: ${filePath}: ${(error as Error).message}`,
      );
    }
    cache = null;
    return unavailable(filePath);
  }

  if (
    cache &&
    cache.path === filePath &&
    cache.mtimeMs === stat.mtimeMs &&
    cache.size === stat.size
  ) {
    return cache.allowlist;
  }

  try {
    const allowlist = parseAllowlist(readFileSync(filePath, 'utf8'), filePath);
    if (allowlistSize(allowlist) === 0) {
      console.warn(
        `[access] 許可リストが空です。全リクエストを拒否します（fail-closed）: ${filePath}`,
      );
    }
    cache = { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, allowlist };
    lastErrorKey = null;
    return allowlist;
  } catch (error) {
    if (lastErrorKey !== `read:${filePath}`) {
      lastErrorKey = `read:${filePath}`;
      console.error(
        `[access] 許可リストの読み込みに失敗しました。全リクエストを拒否します（fail-closed）: ${filePath}: ${(error as Error).message}`,
      );
    }
    cache = null;
    return unavailable(filePath);
  }
}

/** テスト用。設定やファイルを差し替えた後に呼ぶ。 */
export function resetAllowlistCache(): void {
  cache = null;
  lastErrorKey = null;
}
