import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { answerWithDeepSeek } from '../ai/deepseek.js';
import { authenticateUi } from '../auth/ui.js';
import { repoRoot } from '../config.js';
import { sql } from '../db.js';
import { badRequest } from '../errors.js';

const PROTOTYPE_FILE = 'Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html';
const BRIDGE_FILE = path.join('apps', 'api', 'src', 'prototype', 'bridge.js');
const COWORK_KEY = 'mirai-wizard-v31-cowork';
const HELPDESK_KEY = 'mirai-wizard-v31-helpdesk';

const StateParamsSchema = z.object({ name: z.enum(['cowork', 'helpdesk']) });
const StateBodySchema = z.object({ data: z.unknown() });
const AiBodySchema = z.object({ text: z.string().trim().min(1).max(4000) });

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  'img-src data: blob:',
  "connect-src 'self'",
  "font-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

let cachedHtml: string | null = null;
let cachedBridge: string | null = null;

function readSource(): string {
  if (!cachedHtml) {
    cachedHtml = readFileSync(path.join(repoRoot, PROTOTYPE_FILE), 'utf8');
  }
  return cachedHtml;
}

function readBridge(): string {
  if (!cachedBridge) {
    cachedBridge = readFileSync(path.join(repoRoot, BRIDGE_FILE), 'utf8');
  }
  return cachedBridge;
}

function normalizeState(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

async function loadState(email: string): Promise<{
  email: string;
  cowork: Record<string, unknown> | null;
  helpdesk: Record<string, unknown> | null;
}> {
  const rows = await sql<{ name: string; data: unknown }[]>`
    SELECT name, data FROM prototype_states WHERE user_email = ${email}
  `;
  const byName = new Map(rows.map((row) => [row.name, normalizeState(row.data)]));
  return {
    email,
    cowork: byName.get('cowork') ?? null,
    helpdesk: byName.get('helpdesk') ?? null,
  };
}

function renderPrototype(boot: {
  email: string;
  cowork: Record<string, unknown> | null;
  helpdesk: Record<string, unknown> | null;
}): string {
  const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');
  const bootScript = `<script>window.__AIHD_BOOT__=${bootJson};(function(){try{var b=window.__AIHD_BOOT__||{};if(b.email){var e=localStorage.getItem('aihd.access.email');if(e!==b.email){localStorage.removeItem('${COWORK_KEY}');localStorage.removeItem('${HELPDESK_KEY}');localStorage.setItem('aihd.access.email',b.email)}}var orig=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){var r=orig.call(this,k,v);try{if(String(k).indexOf('mirai-wizard-v31-')===0){window.dispatchEvent(new CustomEvent('aihd-state',{detail:String(k)}))}}catch(e){}return r};if(b.cowork)localStorage.setItem('${COWORK_KEY}',JSON.stringify(b.cowork));if(b.helpdesk)localStorage.setItem('${HELPDESK_KEY}',JSON.stringify(b.helpdesk))}catch(e){}})();</script>`;

  let html = readSource();
  // 元の CSP は外部通信を禁止しているため、同一オリジンの API だけ許可する。
  html = html.replace("connect-src 'none'", "connect-src 'self'");
  // オフライン試作の表示のうち、検証環境で事実と異なる主要ラベルだけを更新する。
  // レイアウト・CSS・画面構成は変更しない。
  html = html.replace('<span>完全オフライン</span>', '<span>Cloudflare Access</span>');
  html = html.replace(
    '<div class="sidefoot"><span class="off">● 完全オフライン</span><br>外部通信なし（CSPで遮断）／データはこのブラウザ内のみ</div>',
    '<div class="sidefoot"><span class="off">● Cloudflare Access</span><br>認証済みのみ／データは PostgreSQL に保存</div>',
  );
  html = html.replace(
    'データはこのブラウザ（localStorage）にのみ保存され、外部へは送信されません。',
    'データは検証環境の PostgreSQL に保存され、AI回答は承認済みナレッジの範囲で DeepSeek API を利用します。',
  );
  html = html.replace(
    '完全オフラインのサンプルです。AIの答えはすべて模擬です。',
    '検証環境のサンプルです。自由記述のAI回答は DeepSeek API を利用します。',
  );
  html = html.replace(
    'AIは模擬で、外部へは通信しません。データはこのブラウザ内に保存されます。',
    'AI回答は DeepSeek API、データは PostgreSQL に保存されます。',
  );
  // 最初のアプリ <script> の直前に、サーバー保持の状態を localStorage へ入れる。
  html = html.replace('<script>', bootScript + '<script>');
  // 元の UI の最後に、状態同期と DeepSeek 連携のブリッジを追加する。
  html = html.replace('</body>', `<script>${readBridge()}</script></body>`);
  return html;
}

export async function prototypeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: authenticateUi }, async (request, reply) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const boot = await loadState(request.uiEmail);
    reply
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', CSP)
      .header('Cache-Control', 'no-store')
      .send(renderPrototype(boot));
  });

  app.get('/index.html', { preHandler: authenticateUi }, async (request, reply) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const boot = await loadState(request.uiEmail);
    reply
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', CSP)
      .header('Cache-Control', 'no-store')
      .send(renderPrototype(boot));
  });

  app.get('/api/state', { preHandler: authenticateUi }, async (request) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const state = await loadState(request.uiEmail);
    return { email: state.email, cowork: state.cowork, helpdesk: state.helpdesk };
  });

  app.put(
    '/api/state/:name',
    { preHandler: authenticateUi, bodyLimit: 4 * 1024 * 1024 },
    async (request) => {
      if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
      const { name } = StateParamsSchema.parse(request.params);
      const { data } = StateBodySchema.parse(request.body);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw badRequest('state は JSON オブジェクトである必要があります。');
      }
      await sql`
        INSERT INTO prototype_states (user_email, name, data)
        VALUES (${request.uiEmail}, ${name}, ${JSON.stringify(data)}::jsonb)
        ON CONFLICT (user_email, name)
        DO UPDATE SET data = EXCLUDED.data, updated_at = now()
      `;
      return { ok: true, updatedAt: new Date().toISOString() };
    },
  );

  app.post('/api/ai/answer', { preHandler: authenticateUi }, async (request, reply) => {
    const { text } = AiBodySchema.parse(request.body);
    try {
      return await answerWithDeepSeek(text);
    } catch (error) {
      request.log.warn({ err: error }, 'AI answer failed');
      reply.code(502);
      return {
        error: {
          code: 'AI_UNAVAILABLE',
          message: 'AI 回答を取得できませんでした。担当者へ引き継いでください。',
        },
      };
    }
  });
}
