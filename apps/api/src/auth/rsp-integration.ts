import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { forbidden, unauthorized } from '../errors.js';
import { getAllowlist, isEmailAllowed } from './allowlist.js';
import { canonicalEmail } from './email-alias.js';
import { authenticateUi } from './ui.js';

/**
 * RSP → HelpDesk のサーバ間連携（[docs/36-rsp-integration.md]）。
 *
 * RSP の WebUI（AI支援パネル）は、ブラウザから HelpDesk を直接呼ばず、
 * RSP のバックエンド（/api/v1/helpdesk/*）経由で HelpDesk を呼ぶ。
 * そのリクエストだけを、Access ではなく「共有キー + 操作者メール + loopback」で認証する。
 *
 * 適用範囲は `/api/terminal/*` だけ（この関数を preHandler に使うルート）。
 * 他の API は従来どおり Cloudflare Access のまま。
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const SERVICE_KEY_HEADER = 'x-helpdesk-service-key';
const OPERATOR_HEADER = 'x-operator-email';

function headerValue(request: FastifyRequest, name: string): string {
  const raw = request.headers[name];
  if (Array.isArray(raw)) return String(raw[0] ?? '').trim();
  return typeof raw === 'string' ? raw.trim() : '';
}

function secretsMatch(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 統合ヘッダーが付いているか（付いていれば UI 認証へフォールバックしない）。 */
export function hasRspIntegrationHeaders(request: FastifyRequest): boolean {
  return Boolean(headerValue(request, SERVICE_KEY_HEADER) || headerValue(request, OPERATOR_HEADER));
}

/**
 * ターミナル API の認証。
 * - 統合ヘッダーなし: 従来の `authenticateUi`（Cloudflare Access / 開発モード）
 * - 統合ヘッダーあり: RSP 連携として検証（不正なら 401/403。曖昧に通さない）
 */
export async function authenticateTerminal(request: FastifyRequest): Promise<void> {
  if (!hasRspIntegrationHeaders(request)) {
    await authenticateUi(request);
    return;
  }

  const expectedKey = config.RSP_INTEGRATION_KEY;
  if (!expectedKey) {
    throw unauthorized('RSP 連携が設定されていません。');
  }
  const providedKey = headerValue(request, SERVICE_KEY_HEADER);
  if (!providedKey || !secretsMatch(providedKey, expectedKey)) {
    throw unauthorized('RSP 連携の認証に失敗しました。');
  }

  const rawOperator = headerValue(request, OPERATOR_HEADER).toLowerCase();
  if (!rawOperator || !EMAIL_PATTERN.test(rawOperator)) {
    throw unauthorized('操作者のメールが不正です。');
  }

  // サーバ間呼び出しのみ許可する（公開経路はプロキシ経由で別ヘッダーが付く）。
  const address = request.socket.remoteAddress ?? '';
  if (!LOOPBACK_ADDRESSES.has(address)) {
    throw forbidden('この経路から RSP 連携は利用できません。');
  }

  // 本番は Access の許可リストと同じ名簿で照合する（fail-closed）。
  if (config.AUTH_MODE === 'cloudflare-access' && !isEmailAllowed(getAllowlist(), rawOperator)) {
    throw forbidden('このメールアドレスは許可されていません。');
  }

  request.integration = 'rsp';
  request.loginEmail = rawOperator;
  request.uiEmail = canonicalEmail(rawOperator);
}
