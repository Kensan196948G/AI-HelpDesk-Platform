import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../..');

// 本番（systemd）では Environment= を優先し、ローカルの .env.local を読み込まない。
const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';
const localEnvFile = isTest ? '.env.test.local' : '.env.local';
if (!isProduction && existsSync(path.join(repoRoot, localEnvFile))) {
  loadEnv({ path: path.join(repoRoot, localEnvFile), override: true });
} else {
  loadEnv({ path: path.join(repoRoot, '.env') });
}

// 空文字（`KEY=`）は未設定として扱う。
const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

// サービス間の共有キー。短い値を誤って設定しても起動しない（fail-fast）。
const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(32).optional(),
);

// 監査ハッシュ鎖の「既知の移行点」（`id:保存hash:再計算hash` のカンマ区切り）。
// 既定値は 2026-10-26 に ai_helpdesk_ui で実測した 2 行。環境ごとに
// `scripts/audit-find-breaks.ts` の出力で上書きする（本番は env AUDIT_KNOWN_BREAKS を設定）。
// 形式が不正な場合は起動時に fail-fast する（domain/audit.ts の parseKnownAuditBreaks）。
const DEFAULT_AUDIT_KNOWN_BREAKS = [
  '10010:08fcd225c456240c3bdb687a98522456af67270a5134a70385455227e6f3ed84:db7c5e9993ee16452ce3e5cb1d6ac9a03c7af72e433e0c85438ad888b832286b',
  '10013:2b892d4c52a54a1d5e39669e8df427ec92c8d67ed789950dfd308acdef07c61a:d1313e1ac06025670722e685d701dc09fb35a1bbc222e50d630f7e9c0a9f022a',
].join(',');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(18950),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  // 監査ハッシュ鎖の既知破断。空文字なら「既知破断なし」。
  AUDIT_KNOWN_BREAKS: z.string().default(DEFAULT_AUDIT_KNOWN_BREAKS),
  PROXY_SECRET: z.string().min(16).optional(),
  REQUIRE_PROXY_SECRET: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ALLOWED_ORIGINS: z.string().default(''),
  // 引継ぎの自己承認を許可するか（既定 true）。職務分離を強制する場合は false。
  // z.coerce.boolean('false') は true になるため、必ず enum で厳密にパースする。
  ALLOW_SELF_APPROVAL: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  LOG_LEVEL: z.string().default('info'),
  COMMIT_SHA: z.string().optional(),
  // 認証: local（開発/テスト）または cloudflare-access（本番/Preview）
  AUTH_MODE: z.enum(['local', 'cloudflare-access']).default('local'),
  DEV_AUTH_EMAIL: z.string().email().default('dev@example.com'),
  // アクセス許可リストの正本（完全一致メール / @domain）。repo ルート相対。
  ACCESS_ALLOWLIST_FILE: z.string().trim().min(1).default('docs/MailAddress.txt'),
  // Cloudflare Access の JWT（Cf-Access-Jwt-Assertion）検証。
  // off: 検証しない / report: 検証結果をログに出すだけ（段階導入用） / enforce: 不正なら 401。
  ACCESS_JWT_MODE: z.enum(['off', 'report', 'enforce']).default('off'),
  // 例: <team>.cloudflareaccess.com
  ACCESS_TEAM_DOMAIN: optionalText,
  // Access アプリケーションの AUD タグ（秘密ではない）
  ACCESS_AUD: optionalText,
  // 非推奨: 単一メール指定。許可リストは ACCESS_ALLOWLIST_FILE に統一した。
  ACCESS_ALLOWED_EMAIL: z.string().email().optional(),
  // 「操作する人」の切替を許可するメール（カンマ区切り）。本番（cloudflare-access）では
  // 既定で本人以外に切り替えられない。デモ用アカウントだけここに列挙する。
  PERSONA_SWITCH_ALLOWLIST: z.string().default(''),
  // 同一人物のメール別名（カンマ区切り `alias=primary`）。状態・権限は primary に正規化する。
  EMAIL_ALIASES: z.string().default(''),
  // 別アカウントだが同一人物の組（`a@x|b@y;c@z|d@w`）。正規化はせず、監査・応答に
  // 「同一人物である」事実を残すためだけに使う（自己承認の誤読を防ぐ）。
  SHARED_IDENTITY_GROUPS: z.string().default(''),

  // 解決ループ（Phase C）: 端末オフライン判定の閾値（秒）。設計 §4-3 の「2 分応答なし」。
  RESOLVE_DEVICE_OFFLINE_SEC: z.coerce.number().int().positive().default(120),
  // リスク 4 以上の Skill を承認できる IT 管理者（カンマ区切り）。
  // 既定は空＝誰も承認できない（fail-closed）。比較は canonicalEmail を通す。
  RESOLVE_ADMIN_ALLOWLIST: z.string().default(''),

  // Phase 1 遠隔対応: RSP サービス認証（サーバ間のみ。ブラウザへ返さない）
  RSP_SERVICE_KEY: optionalText,
  // RSP → HelpDesk の統合認証（RSP WebUI の AI支援パネル用）。
  // 未設定なら統合経路は無効。32文字以上のランダム値を .env に設定する。
  RSP_INTEGRATION_KEY: optionalSecret,
  // 担当者に返す RSP の公開 URL（ブラウザのリンク用。サーバ間接続には RSP_BASE_URL）
  RSP_PUBLIC_URL: z.string().url().default('https://rsp.mirai-remotetools.com'),

  // 本人同意付きフォルダ一覧（docs/62）。無効時は全 API が 404、画面の導線も出ない。
  FOLDER_ACCESS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // 検証専用: 貸与情報を確認できなくても担当者の指定端末で進める。production では起動を拒否する。
  FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  // Mirai-Info の PII API（/api/device-staff）と Cloudflare Access サービストークン（2 値の組）。
  // 未設定なら LEASE_UNAVAILABLE で留まる（fail-closed）。
  LEASE_API_URL: optionalText,
  LEASE_API_TOKEN_ID: optionalText,
  LEASE_API_TOKEN_SECRET: optionalText,
  LEASE_MAX_AGE_HOURS: z.coerce.number().int().positive().default(72),
  // 同意の終了からこの日数を過ぎた行の識別子（SID・端末など）を定期処理で消す。
  FOLDER_ACCESS_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  // Mirai-Info の社員名簿を読むための接続先（未設定なら Unix ソケット + OS ユーザー）。
  MIRAI_INFO_DATABASE_URL: optionalText,
  // DeepSeek API（MVP / Staging のみ）
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_MODEL: z.string().default('deepseek-flash'),
  // ヘルプデスクの一次回答は速度と安定性を優先し、既定では thinking を無効にする。
  DEEPSEEK_THINKING: z.enum(['disabled', 'enabled']).default('disabled'),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  DEEPSEEK_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

  // 最終報告書の PDF 生成（ヘッドレス Chrome）。未設定なら自動検出する。
  REPORT_PDF_BIN: optionalText,
  REPORT_PDF_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

  // RSP / MeshCentral（B さんの GUI / PowerShell 操作の既存基盤）。
  MESHCENTRAL_URL: z.string().url().default('https://mesh.mirai-remotetools.com/'),
  RSP_BASE_URL: z.string().url().default('https://rsp.mirai-remotetools.com/'),

  // --- 引継ぎのメール通知 -------------------------------------------------
  // auto: SMTP_HOST があれば smtp、無ければ disabled（sendmail は明示指定）。
  // テスト（NODE_ENV=test）は既定で disabled（実メールを送らない）。
  MAIL_TRANSPORT: z.enum(['auto', 'smtp', 'sendmail', 'disabled']).default('auto'),
  MAIL_FROM: optionalText,
  SMTP_HOST: optionalText,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_USER: optionalText,
  SMTP_PASS: optionalText,
  // 宛先を個人指名しなかったときの通知先（カンマ区切り。グループ受信箱など）。
  HANDOVER_NOTIFY_EMAIL: z.string().default(''),
  // メールに載せる画面の URL（受信箱がある画面）。
  NOTIFY_BASE_URL: z.string().url().default('https://ai-helpdesk.mirai-dx-platform.com'),
  NOTIFY_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] 環境変数が不足しています:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// 本番で認証なしのローカルモードが有効にならないよう、起動を拒否する（fail-closed）。
if (isProduction && parsed.data.AUTH_MODE === 'local') {
  console.error(
    '[config] NODE_ENV=production では AUTH_MODE=local を使えません。AUTH_MODE=cloudflare-access を設定してください。',
  );
  process.exit(1);
}
// 貸与情報の検証を省く検証用フラグを本番で有効にさせない（fail-closed）。
if (isProduction && parsed.data.FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE) {
  console.error(
    '[config] NODE_ENV=production では FOLDER_ACCESS_ALLOW_UNVERIFIED_LEASE=true を使えません。',
  );
  process.exit(1);
}
if (
  parsed.data.ACCESS_JWT_MODE !== 'off' &&
  (!parsed.data.ACCESS_TEAM_DOMAIN || !parsed.data.ACCESS_AUD)
) {
  console.error(
    '[config] ACCESS_JWT_MODE を有効にする場合は ACCESS_TEAM_DOMAIN と ACCESS_AUD が必要です。',
  );
  process.exit(1);
}
if (
  isProduction &&
  parsed.data.AUTH_MODE === 'cloudflare-access' &&
  parsed.data.ACCESS_JWT_MODE === 'off'
) {
  console.warn(
    '[config] ACCESS_JWT_MODE=off です。Cloudflare Access の JWT を検証していません（report → enforce の順に有効化してください）。',
  );
}

if (parsed.data.ACCESS_ALLOWED_EMAIL) {
  console.warn(
    '[config] ACCESS_ALLOWED_EMAIL は非推奨です。許可リストは ACCESS_ALLOWLIST_FILE（既定: docs/MailAddress.txt）が正本です。',
  );
}
if (parsed.data.AUTH_MODE === 'cloudflare-access') {
  console.info(
    `[config] アクセス許可リスト: ${parsed.data.ACCESS_ALLOWLIST_FILE}（Cloudflare Access の allow ポリシーと同じ内容にすること）`,
  );
}
if (!parsed.data.DEEPSEEK_API_KEY) {
  console.warn(
    '[config] DEEPSEEK_API_KEY が未設定です。AI 回答は承認済みナレッジのフォールバックになります。',
  );
}

export const config = {
  ...parsed.data,
  allowedOrigins: parsed.data.ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  isProduction,
};
