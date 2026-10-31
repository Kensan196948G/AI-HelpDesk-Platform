import { config } from '../config.js';
import { forbidden } from '../errors.js';
import { type EmployeeRow, findEmployeeByEmail } from '../lib/mirai-info.js';
import { canonicalEmail, emailVariants } from './email-alias.js';
import type { Role } from './types.js';

/**
 * 「ヘルプデスク相当」の権限判定（F-01 修正）。
 *
 * 正本は Mirai-Info の社員名簿（`employee_directory`）。ヘルプデスク相当は、
 * 名簿の所属（section / division）が DX 推進部 の社員、または
 * `docs/20-employee-directory.md` で DX 推進部 に割り当てられている
 * 4 ロール（ヘルプデスク担当・ナレッジ承認者・監査担当者・IT端末管理者）である。
 * 4 ロールはいずれも DX 推進部 メンバー全員に割り当てられているため、
 * サーバ側では所属で判定する（クライアントが選ぶロールは信用しない）。
 *
 * 名簿から本人を解決できない場合は fail-closed（403）。
 * 例外は次の 2 つだけで、どちらも明示的な設定に基づく。
 * - ローカル開発/テスト（AUTH_MODE=local）の `DEV_AUTH_EMAIL` アカウント
 * - `PERSONA_SWITCH_ALLOWLIST` に列挙されたデモ用アカウント
 */

/** ヘルプデスク相当と見なす所属。 */
export const HELPDESK_AFFILIATIONS = ['DX推進部'] as const;

/** ヘルプデスク相当と見なすロール（表示名）。所属で判定するための根拠。 */
export const HELPDESK_ROLE_LABELS = [
  'ヘルプデスク担当',
  'ナレッジ承認者',
  '監査担当者',
  'IT端末管理者',
] as const;

export interface HelpdeskActor {
  /** 正規化済みのログインメール。 */
  email: string;
  /** 名簿の社員番号。名簿で解決できない開発/デモ用アカウントは null。 */
  employeeNo: string | null;
  /** 名簿の氏名。名簿で解決できない場合は null。 */
  name: string | null;
  section: string | null;
  /** dx: 名簿で DX 推進部 / dev: ローカル開発 / demo: デモ用アカウント / approver: 承認ロール。 */
  via: 'dx' | 'dev' | 'demo' | 'approver';
}

/** 名簿参照の差し替え口（テスト用）。 */
export interface HelpdeskDirectory {
  findByEmail(email: string): Promise<EmployeeRow | null>;
}

export const defaultHelpdeskDirectory: HelpdeskDirectory = {
  findByEmail: (email) => findEmployeeByEmail(email),
};

export interface HelpdeskPolicyOptions {
  directory?: HelpdeskDirectory;
  /** 既定は `config.AUTH_MODE`。 */
  authMode?: 'local' | 'cloudflare-access';
  /** 既定は `config.DEV_AUTH_EMAIL`。 */
  devEmail?: string;
  /** 既定は `config.PERSONA_SWITCH_ALLOWLIST`。 */
  demoAllowlist?: string;
  /** 既定は `config.EMAIL_ALIASES`。 */
  aliases?: string;
}

function normalizeAffiliation(value: string | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '');
}

/** 名簿の所属が DX 推進部（ヘルプデスク相当）かどうか。 */
export function isHelpdeskEmployee(employee: Pick<EmployeeRow, 'section' | 'division'>): boolean {
  const affiliations = HELPDESK_AFFILIATIONS.map(normalizeAffiliation);
  return [employee.section, employee.division].some((value) => {
    const normalized = normalizeAffiliation(value);
    return normalized.length > 0 && affiliations.includes(normalized);
  });
}

function isDemoAccount(email: string, rawAllowlist: string): boolean {
  return String(rawAllowlist || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(email);
}

/**
 * ログインメールからヘルプデスク相当の実行者を解決する。
 * 権限が無い/名簿で解決できない場合は 403 を throw する（fail-closed）。
 */
export async function resolveHelpdeskActor(
  email: string | null | undefined,
  options: HelpdeskPolicyOptions = {},
): Promise<HelpdeskActor> {
  const aliases = options.aliases ?? config.EMAIL_ALIASES;
  const normalized = canonicalEmail(email, aliases);
  if (!normalized) {
    throw forbidden('ログイン情報を確認できないため、この操作は許可されません。');
  }

  const directory = options.directory ?? defaultHelpdeskDirectory;
  const authMode = options.authMode ?? config.AUTH_MODE;
  const devEmail = canonicalEmail(options.devEmail ?? config.DEV_AUTH_EMAIL, aliases);
  const demoAllowlist = options.demoAllowlist ?? config.PERSONA_SWITCH_ALLOWLIST;

  // 別名でも同じ社員に解決する（/api/me と同じ方針）。
  let employee: EmployeeRow | null = null;
  for (const candidate of emailVariants(normalized, aliases)) {
    employee = await directory.findByEmail(candidate);
    if (employee) break;
  }

  if (employee) {
    if (!isHelpdeskEmployee(employee)) {
      throw forbidden('この操作は DX 推進部（ヘルプデスク）のみ利用できます。');
    }
    return {
      email: normalized,
      employeeNo: employee.employeeNo || null,
      name: employee.name || null,
      section: employee.section ?? null,
      via: 'dx',
    };
  }

  // 名簿で解決できない場合は fail-closed。開発/テストとデモだけを明示的に許可する。
  if (authMode === 'local' && normalized === devEmail) {
    return { email: normalized, employeeNo: null, name: null, section: null, via: 'dev' };
  }
  if (isDemoAccount(normalized, demoAllowlist)) {
    return { email: normalized, employeeNo: null, name: null, section: null, via: 'demo' };
  }
  throw forbidden(
    '社員名簿で DX 推進部（ヘルプデスク）を確認できないため、この操作は許可されません。',
  );
}

/** `requireHelpdeskActor` の戻り値を使わない呼び出し向けの薄いラッパ。 */
export async function requireHelpdeskActor(
  email: string | null | undefined,
  options: HelpdeskPolicyOptions = {},
): Promise<HelpdeskActor> {
  return resolveHelpdeskActor(email, options);
}

/**
 * 承認（引継ぎの完了承認・ナレッジの承認/差戻し）の実行者を解決する。
 *
 * 判定の正本は `user_roles` の `approver`（`request.uiRoles`）で、所属は問わない。
 * DX 推進部でも approver が無ければ承認できず、DX 推進部以外や名簿外でも
 * approver があれば承認できる。claim・受信箱などの担当者権限は与えない
 * （それらは引き続き `requireHelpdeskActor`）。
 * ローカル開発の例外は設けない（ロールは seed / sync-roles で与える）。
 */
export async function requireApproverActor(
  email: string | null | undefined,
  roles: readonly Role[] | null | undefined,
  options: Pick<HelpdeskPolicyOptions, 'directory' | 'aliases'> = {},
): Promise<HelpdeskActor> {
  const aliases = options.aliases ?? config.EMAIL_ALIASES;
  const normalized = canonicalEmail(email, aliases);
  if (!normalized) {
    throw forbidden('ログイン情報を確認できないため、この操作は許可されません。');
  }
  if (!roles?.includes('approver')) {
    throw forbidden('この操作は本番承認者のみ実行できます。');
  }
  const directory = options.directory ?? defaultHelpdeskDirectory;
  let employee: EmployeeRow | null = null;
  for (const candidate of emailVariants(normalized, aliases)) {
    employee = await directory.findByEmail(candidate);
    if (employee) break;
  }
  return {
    email: normalized,
    employeeNo: employee?.employeeNo || null,
    name: employee?.name || null,
    section: employee?.section ?? null,
    via: 'approver',
  };
}

/**
 * 社内の識別子か（名簿で解決できる、またはローカル開発/デモ用アカウント）。
 * 社外の承認者（名簿外）に社員名簿を返さないために使う。名簿障害時も false（fail-closed）。
 */
export async function isInternalIdentity(
  email: string | null | undefined,
  options: HelpdeskPolicyOptions = {},
): Promise<boolean> {
  const aliases = options.aliases ?? config.EMAIL_ALIASES;
  const normalized = canonicalEmail(email, aliases);
  if (!normalized) return false;
  const directory = options.directory ?? defaultHelpdeskDirectory;
  for (const candidate of emailVariants(normalized, aliases)) {
    if (await directory.findByEmail(candidate)) return true;
  }
  const authMode = options.authMode ?? config.AUTH_MODE;
  const devEmail = canonicalEmail(options.devEmail ?? config.DEV_AUTH_EMAIL, aliases);
  if (authMode === 'local' && normalized === devEmail) return true;
  return isDemoAccount(normalized, options.demoAllowlist ?? config.PERSONA_SWITCH_ALLOWLIST);
}

export type RecipientDecision = 'open' | 'match' | 'mismatch' | 'unknown';

/**
 * 引継ぎの宛先指名と実行者を照合する。
 * - open: 指名なし（DX 推進部グループ宛）
 * - match: 指名された本人
 * - mismatch: 別の社員に指名されている
 * - unknown: 実行者を名簿で解決できず、本人確認ができない（fail-closed）
 */
export function recipientDecision(
  recipientNo: string | null | undefined,
  actor: Pick<HelpdeskActor, 'employeeNo'>,
): RecipientDecision {
  const target = String(recipientNo ?? '').trim();
  if (!target) return 'open';
  if (!actor.employeeNo) return 'unknown';
  return target === actor.employeeNo ? 'match' : 'mismatch';
}
