import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { answerWithDeepSeek } from '../ai/deepseek.js';
import { personaSwitchMode } from '../auth/persona-switch.js';
import { authenticateUi } from '../auth/ui.js';
import { config, repoRoot } from '../config.js';
import { sql } from '../db.js';
import { ApiError, badRequest } from '../errors.js';
import { jsonbValue } from '../lib/jsonb-value.js';
import { checkRateLimit } from '../lib/rate-limit.js';

const PROTOTYPE_FILE = 'Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html';
const BRIDGE_FILES = [
  path.join('apps', 'api', 'src', 'prototype', 'bridge.js'),
  path.join('apps', 'api', 'src', 'prototype', 'device-bridge.js'),
  path.join('apps', 'api', 'src', 'prototype', 'employee-bridge.js'),
  path.join('apps', 'api', 'src', 'prototype', 'assist-bridge.js'),
];
const COWORK_KEY = 'mirai-wizard-v31-cowork';
const HELPDESK_KEY = 'mirai-wizard-v31-helpdesk';

/**
 * 保存済みの状態が古い・欠けている場合でも、画面が例外で止まらないようにする。
 *
 * 画面の `load()` は `v===31` なら保存値をそのまま `S` に入れる。そのため
 * 一部のキーだけを持つ状態（検証用スクリプトが書き込んだフィクスチャ等）を
 * 読み込むと、`S.stats` や `S.faqCandidates` を参照する画面が TypeError で
 * 白画面になる。ここでは「無いキーだけ」を画面側の既定値で補い、既存の値は
 * 上書きしない（利用者のデータを失わない）。
 *
 * 既定値に `freshState()` は使わない。`freshState()` はサンプル案件・FAQ・
 * 監査ログも生成するため、補完のたびにデータが増えてしまう。端末だけは
 * `S.devices[端末ID]` を直接参照する画面があるため `seedDevices()` を使う。
 */
export const STATE_DEFAULTS_PATCH = `(function(){try{var D={v:31,ui:{view:'flow',screen:'home',case:null,user:'u1',model:'local',theme:'auto',chat:null},chats:[],proposals:{},tickets:[],audit:[],devices:(typeof seedDevices==='function'?seedDevices():{}),faqCandidates:[],faqs:[],estop:false,failNext:false,counters:{prop:0,ticket:0,faq:0,fc:0},stats:{intents:{},aiResolved:0,queries:0}};var fill=function(target,source){for(var key in source){if(!(key in target)){target[key]=source[key];}else if(source[key]&&typeof source[key]==='object'&&!Array.isArray(source[key])&&target[key]&&typeof target[key]==='object'&&!Array.isArray(target[key])){fill(target[key],source[key]);}}};fill(S,D);}catch(e){}})();`;

/** `load()` の「保存値をそのまま採用する」1 行に、欠落キー補完を差し込む。 */
export function patchStateLoad(html: string): string {
  const marker = 'if(o&&o.v===31){S=o}';
  if (!html.includes(marker)) return html;
  return html.replace(marker, () => `if(o&&o.v===31){S=o;${STATE_DEFAULTS_PATCH}}`);
}

/**
 * 依頼者以外の「操作する人」で案件を開くと、画面が `USERS[c.userId]` を解決できず
 * `asideHtml` で TypeError になる（2026-10-25 に実ブラウザで再現）。
 * 社員名簿から案件の依頼者を解決し、解決できない場合も表示を壊さないようにする。
 */
export const ENSURE_CASE_USERS =
  'function ensureCaseUsers(){try{(S.cases||[]).forEach(function(c){var id=String((c&&c.userId)||"");if(id.indexOf("emp:")===0&&!USERS[id]){var m=/^emp:(?:([a-z]+):)?([A-Za-z0-9_-]+)$/.exec(id);if(m&&m[2]){var rid=ensureRealUser(m[2],m[1]||"employee");if(rid&&rid!==id&&USERS[rid])USERS[id]=USERS[rid];}}});}catch(e){}}';

export function patchCaseUserResolution(html: string): string {
  let out = html;
  if (out.includes('function renderView(){syncHd();')) {
    out = out.replace(
      'function renderView(){syncHd();',
      `${ENSURE_CASE_USERS}\nfunction renderView(){ensureCaseUsers();syncHd();`,
    );
  }
  // 名簿が未読込・名簿外でも所属と端末で落ちないようにする。
  out = out
    .split('DEPTS[USERS[c.userId].dept].name')
    .join("((USERS[c.userId]&&DEPTS[USERS[c.userId].dept])||{}).name||'所属不明'");
  out = out.split('USERS[c.userId].device').join("((USERS[c.userId]||{}).device||'（未設定）')");
  // 本文が空の案件（作成直後・受付直後）でも一覧が落ちないようにする。
  out = out.split('c.subject||c.body.slice(0,30)').join("c.subject||(c.body||'').slice(0,30)");
  out = out.split('c.subject||c.body.slice(0,40)').join("c.subject||(c.body||'').slice(0,40)");
  // 「AI相談」の挨拶はデモ利用者（u1〜u5）向けの TIPS を持つ。実在社員（emp:MK...）で
  // 開くと TIPS が無く TypeError になるため、無い場合は空のリストにする。
  out = out.split('TIPS[u.id].map(').join('(TIPS[u.id]||[]).map(');
  // 引継ぎメモの「推定分野」: 画面の旧カテゴリ名（IT端末 等）も CATS のキーへ寄せる。
  out = out
    .split('const cat=k=>CATS.find(c=>c.k===k)||CATS[6];')
    .join(
      "const cat=k=>CATS.find(c=>c.k===k)||CATS.find(c=>c.k===({IT端末:'device','ID・アクセス権':'account','業務・規程':'other','セキュリティ事故':'security','AI窓口':'other'})[k])||CATS[6];",
    );
  // 引継ぎメモの「おすすめの担当」: 社員番号（MK...）を名簿から氏名へ解決する。
  out = out
    .split("const staff=n=>STAFF.find(s=>s.name===n)||{name:n,role:''};")
    .join(
      "const staff=n=>{if(!n)return {name:'（未定）',role:''};const t=STAFF.find(s=>s.name===n)||STAFF.find(s=>s.employeeNo===n);if(t)return t;try{const e=(window.__AIHD_EMPLOYEES__&&window.__AIHD_EMPLOYEES__.all||[]).find(x=>x.employeeNo===n);if(e)return {name:e.name,role:'ヘルプデスク担当'};}catch(_){}return {name:n,role:''};};",
    );
  out = out
    .split('おすすめの担当：${t.suggest}（${staff(t.suggest).role}）')
    .join('おすすめの担当：${staff(t.suggest).name}（${staff(t.suggest).role}）');
  // 解決記録の記入例: 印刷の相談に共有フォルダの例が入らないよう、印刷を優先する。
  out = out
    .split('if(/印刷|プリンタ|複合機/.test(s))')
    .join('if(/印刷|プリンタ|複合機|プリント/.test(s))');
  out = out
    .split('if(/共有フォルダ|アクセス権|アクセスでき/.test(s))')
    .join(
      "if(!(/印刷|プリンタ|複合機|プリント/.test(t.subject)||(t.cat==='device'&&/印刷|プリンタ|複合機|プリント/.test(s)))&&/共有フォルダ|アクセス権|アクセスでき/.test(s))",
    );
  return out;
}

const StateParamsSchema = z.object({ name: z.enum(['cowork', 'helpdesk']) });
const StateBodySchema = z.object({ data: z.unknown() });
const AiBodySchema = z.object({
  text: z.string().trim().min(1).max(4000),
  deviceId: z.string().trim().max(120).optional(),
});

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
    cachedBridge = BRIDGE_FILES.map((file) => readFileSync(path.join(repoRoot, file), 'utf8')).join(
      '\n\n',
    );
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
  loginEmail?: string;
  cowork: Record<string, unknown> | null;
  helpdesk: Record<string, unknown> | null;
}): string {
  const bootJson = JSON.stringify({
    ...boot,
    // 本番では「操作する人」を本人以外へ切り替えさせない（デモ用アカウントだけ any）。
    switchMode: personaSwitchMode(boot.email),
    meshcentralUrl: config.MESHCENTRAL_URL,
    rspBaseUrl: config.RSP_BASE_URL,
  }).replace(/</g, '\\u003c');
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
  // 古い・欠けた状態を読み込んでも白画面にならないよう、欠落キーを補完する。
  html = patchStateLoad(html);
  html = patchCaseUserResolution(html);
  // 最初のアプリ <script> の直前に、サーバー保持の状態を localStorage へ入れる。
  // 置換文字列は `$'` `$&` `$$` を特殊パターンとして解釈するため、利用者データを含む文字列は関数で渡す。
  html = html.replace('<script>', () => `${bootScript}<script>`);
  // 元の UI の最後に、状態同期と DeepSeek 連携のブリッジを追加する。
  html = html.replace('</body>', () => `<script>${readBridge()}</script></body>`);
  return html;
}

export async function prototypeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: authenticateUi }, async (request, reply) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const boot = { ...(await loadState(request.uiEmail)), loginEmail: request.loginEmail };
    reply
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', CSP)
      .header('Cache-Control', 'no-store')
      .send(renderPrototype(boot));
  });

  app.get('/index.html', { preHandler: authenticateUi }, async (request, reply) => {
    if (!request.uiEmail) throw badRequest('UI の認証情報がありません。');
    const boot = { ...(await loadState(request.uiEmail)), loginEmail: request.loginEmail };
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
        VALUES (${request.uiEmail}, ${name}, ${jsonbValue(data)})
        ON CONFLICT (user_email, name)
        DO UPDATE SET data = EXCLUDED.data, updated_at = now()
      `;
      return { ok: true, updatedAt: new Date().toISOString() };
    },
  );

  app.post('/api/ai/answer', { preHandler: authenticateUi }, async (request, reply) => {
    const { text, deviceId } = AiBodySchema.parse(request.body);
    // 外部 AI の呼び出し回数（費用）を抑える。利用者（Access メール）単位で 1 分 20 回まで。
    if (!checkRateLimit(`ai-answer:${request.uiEmail ?? request.ip}`, 20, 60_000)) {
      throw new ApiError(
        429,
        'RATE_LIMITED',
        'AI への問い合わせが多すぎます。少し待ってから再試行してください。',
      );
    }
    try {
      return await answerWithDeepSeek(text, request.uiEmail, deviceId);
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
