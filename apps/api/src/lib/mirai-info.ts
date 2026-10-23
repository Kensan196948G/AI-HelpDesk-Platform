import postgres from 'postgres';
import { config } from '../config.js';

/**
 * Mirai-Info の社員名簿（employee_directory）を読み取り専用で参照する。
 *
 * - 接続はローカル PostgreSQL の Unix ソケット（peer）。パスワードは持たない。
 * - セッションを `default_transaction_read_only = on` にし、SELECT 以外を拒否する。
 * - 名簿は 10 分メモリにキャッシュする（DB へは保存しない）。
 * - PII のため、返すのは氏名・組織・部署・社員番号に限定する（メールは返さない）。
 */

export interface EmployeeRow {
  employeeNo: string;
  name: string;
  organization?: string;
  division?: string;
  section?: string;
}

export type EmployeeScope = 'staff' | 'all';

const CACHE_TTL_MS = 10 * 60 * 1000;
const STAFF_SECTION = 'DX推進部';

let client: ReturnType<typeof postgres> | null = null;
let cache: { at: number; all: EmployeeRow[]; staff: EmployeeRow[] } | null = null;

function connectionOptions(): {
  dsn?: string;
  host?: string;
  database?: string;
  username?: string;
} {
  if (config.MIRAI_INFO_DATABASE_URL) {
    return { dsn: config.MIRAI_INFO_DATABASE_URL };
  }
  return {
    host: process.env.MIRAI_INFO_DB_HOST ?? '/var/run/postgresql',
    database: process.env.MIRAI_INFO_DB_NAME ?? 'mirai_info',
    username: process.env.MIRAI_INFO_DB_USER ?? process.env.USER ?? 'kensan',
  };
}

async function getClient(): Promise<ReturnType<typeof postgres>> {
  if (client) return client;
  const options = connectionOptions();
  const created = options.dsn
    ? postgres(options.dsn, { max: 2, connect_timeout: 5, idle_timeout: 60 })
    : postgres({
        host: options.host,
        database: options.database,
        username: options.username,
        max: 2,
        connect_timeout: 5,
        idle_timeout: 60,
      });
  await created.unsafe('SET default_transaction_read_only = on');
  client = created;
  return client;
}

export function filterStaff(rows: EmployeeRow[]): EmployeeRow[] {
  return rows.filter((row) => row.section === STAFF_SECTION);
}

/** 名簿を取得（キャッシュ付き）。失敗しても throw せず空配列と理由を返す。 */
export async function listEmployees(scope: EmployeeScope): Promise<{
  employees: EmployeeRow[];
  total: number;
  cachedAt: string | null;
  error?: string;
}> {
  try {
    const now = Date.now();
    if (!cache || now - cache.at > CACHE_TTL_MS) {
      const sql = await getClient();
      const rows = await sql<EmployeeRow[]>`
        SELECT
          employee_no AS "employeeNo",
          name,
          organization,
          division,
          section
        FROM mirai_info.employee_directory
        WHERE status = '有効'
        ORDER BY division, section, name
        LIMIT 1000
      `;
      const all = rows
        .filter((row) => row.employeeNo && row.name)
        .map((row) => ({
          employeeNo: row.employeeNo,
          name: row.name,
          organization: row.organization ?? undefined,
          division: row.division ?? undefined,
          section: row.section ?? undefined,
        }));
      cache = { at: now, all, staff: filterStaff(all) };
    }
    const employees = scope === 'staff' ? cache.staff : cache.all;
    return {
      employees,
      total: employees.length,
      cachedAt: new Date(cache.at).toISOString(),
    };
  } catch (error) {
    return {
      employees: [],
      total: 0,
      cachedAt: null,
      error: error instanceof Error ? error.message.slice(0, 200) : 'mirai-info-unavailable',
    };
  }
}

/** テスト用にキャッシュをリセットする。 */
export function resetEmployeeCache(): void {
  cache = null;
  emailCache.clear();
}

/**
 * メールアドレスから社員を1件に決める。
 * 名簿に同じメールが複数ある場合は「どちらか分からない」ので null（安全側）。
 */
export function pickUniqueEmployee(rows: EmployeeRow[]): EmployeeRow | null {
  return rows.length === 1 ? (rows[0] ?? null) : null;
}

const EMAIL_CACHE_MAX = 500;
const emailCache = new Map<string, { at: number; employee: EmployeeRow | null }>();

/**
 * ログインしたメール（Cloudflare Access）から社員を引く。
 * - 返すのは氏名・所属・社員番号だけ（メールは返さない）。
 * - `status='有効'` のみ。見つからない/重複/失敗は null。
 * - 10分メモリキャッシュ（メールごと）。
 */
export async function findEmployeeByEmail(email: string): Promise<EmployeeRow | null> {
  const normalized = String(email || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  const hit = emailCache.get(normalized);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.employee;
  try {
    const sql = await getClient();
    const rows = await sql<EmployeeRow[]>`
      SELECT
        employee_no AS "employeeNo",
        name,
        organization,
        division,
        section
      FROM mirai_info.employee_directory
      WHERE status = '有効'
        AND lower(btrim(email)) = ${normalized}
      ORDER BY updated_at DESC
      LIMIT 2
    `;
    const employee = pickUniqueEmployee(
      rows
        .filter((row) => row.employeeNo && row.name)
        .map((row) => ({
          employeeNo: row.employeeNo,
          name: row.name,
          organization: row.organization ?? undefined,
          division: row.division ?? undefined,
          section: row.section ?? undefined,
        })),
    );
    if (emailCache.size >= EMAIL_CACHE_MAX) {
      const oldest = emailCache.keys().next().value;
      if (oldest) emailCache.delete(oldest);
    }
    emailCache.set(normalized, { at: Date.now(), employee });
    return employee;
  } catch {
    return null;
  }
}

/**
 * 通知のために社員番号からメールアドレスを引く（**サーバー内専用**）。
 * メールアドレスは API のレスポンス・ログ・画面に返さないこと。
 * 見つからない・複数該当の場合は null（推測で送らない）。
 */
export async function findEmployeeEmailByNo(
  employeeNo: string,
): Promise<{ email: string; name: string } | null> {
  const target = String(employeeNo || '').trim();
  if (!target) return null;
  try {
    const sql = await getClient();
    const rows = await sql<{ email: string | null; name: string }[]>`
      SELECT email, name
      FROM mirai_info.employee_directory
      WHERE status = '有効' AND employee_no = ${target}
      ORDER BY updated_at DESC
      LIMIT 2
    `;
    if (rows.length !== 1) return null;
    const row = rows[0];
    const email = String(row?.email ?? '')
      .trim()
      .toLowerCase();
    if (!email || !row?.name) return null;
    return { email, name: row.name };
  } catch {
    return null;
  }
}
