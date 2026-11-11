import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { authenticateUi } from '../auth/ui.js';
import { config, repoRoot } from '../config.js';
import { badRequest } from '../errors.js';
import { type EmployeeRow, findEmployeeByEmail } from '../lib/mirai-info.js';
import { loadTicketsForUi } from './ops-tickets.js';

/**
 * 運用統合 UI（新しい WebUI）の配信（docs/100）。
 *
 * 旧 UI（`/`）はそのまま残し、新 UI は `/ops` で配信する。
 * 機能パリティに到達した時点で `/` を新 UI へ切り替え、旧 UI を `/legacy` へ移す（docs/100 §6）。
 *
 * P1（この段階）で配信するのは**画面の土台**だけ:
 * - 操作者は Cloudflare Access の本人（モックのログイン画面は使わない）
 * - 画面のデータはまだサンプル（localStorage）。実データ接続は画面ごとに P2 以降で行う
 * - その事実を画面下部のバナーで明示する（AGENTS.md §5）
 */

const OPS_FILE = 'Mirai_AIHelpdesk_OpsConsole_V1.0.html';

/** 旧画面と同じ CSP。外部通信は禁止し、同一オリジンの API と Cloudflare の beacon だけ許可する。 */
const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline' https://static.cloudflareinsights.com",
  'img-src data: blob:',
  "connect-src 'self' https://cloudflareinsights.com",
  "font-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** 画面下部に出す移行中の表示。実データへ接続するまで消さない。 */
export const MIGRATION_BANNER =
  '移行中：新しい運用統合 UI です。①受付と②AI一次対応は実データに接続済み。その他の画面は順次接続します（未接続の画面のデータはサンプルです）。';

let cachedHtml: string | null = null;

function readOpsSource(): string {
  if (!cachedHtml) {
    cachedHtml = readFileSync(path.join(repoRoot, OPS_FILE), 'utf8');
  }
  return cachedHtml;
}

export interface OpsActor {
  name: string;
  role: string;
  approver: boolean;
  email: string;
}

/** ロール集合から、画面に出す 1 つの肩書きを決める（表示用。権限判定はサーバ側が正本）。 */
export function actorRoleLabel(roles: readonly string[]): string {
  if (roles.includes('approver')) return 'ナレッジ承認者';
  if (roles.includes('helpdesk')) return 'ヘルプデスク担当';
  if (roles.includes('auditor')) return '監査担当者';
  return '一般社員';
}

/** 名簿の氏名を使う。名簿が引けない環境（テスト等）ではメールのローカル部で代替する。 */
async function resolveActor(email: string, roles: readonly string[]): Promise<OpsActor> {
  let employee: EmployeeRow | null = null;
  try {
    employee = await findEmployeeByEmail(email);
  } catch {
    employee = null;
  }
  const fallback = email.split('@')[0] || email;
  const name = (employee && employee.name) || fallback;
  const role = actorRoleLabel(roles);
  return { name, role, approver: roles.includes('approver'), email };
}

export function renderOps(boot: { actor: OpsActor } & Record<string, unknown>): string {
  const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');
  const bootScript = `<script>window.__OPS_BOOT__=${bootJson};</script>`;
  // 画面のアプリ <script> の直前にだけ差し込む（置換文字列の特殊パターンを避けるため関数で渡す）。
  return readOpsSource().replace('<script>', () => `${bootScript}<script>`);
}

export async function opsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ops', { preHandler: authenticateUi }, async (request, reply) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const roles = request.uiRoles ?? [];
    const actor = await resolveActor(request.uiEmail, roles);
    const tickets = await loadTicketsForUi(request.uiEmail);
    const boot = {
      actor: { name: actor.name, role: actor.role, approver: actor.approver, email: actor.email },
      // P2: 受付済みチケットは実 DB が正本。他の画面は P3 以降で順次接続する。
      state: { tickets },
      server: true,
      authMode: config.AUTH_MODE,
      banner: MIGRATION_BANNER,
    };
    return reply
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', CSP)
      .header('Cache-Control', 'no-store')
      .send(renderOps(boot));
  });
}
