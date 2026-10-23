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
}
