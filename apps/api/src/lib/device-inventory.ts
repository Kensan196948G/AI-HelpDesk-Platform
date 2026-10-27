import { sql } from '../db.js';
import {
  type DeviceInventoryData,
  type DeviceSource,
  mergeDeviceInventories,
} from '../domain/device.js';
import { asJsonObject } from './json.js';
import { jsonbValue } from './jsonb-value.js';
import { sanitizeForJson } from './unicode.js';

interface StoredRow {
  data: unknown;
  collected_at: Date;
  device_id: string;
}

function asInventory(row: StoredRow | undefined, source: DeviceSource): DeviceInventoryData | null {
  if (!row?.data) return null;
  const data = asJsonObject(row.data) as unknown as DeviceInventoryData;
  if (!data.deviceId || !Array.isArray(data.software)) return null;
  return {
    ...data,
    source,
    deviceId: row.device_id || data.deviceId,
    hardware: data.hardware ?? {},
    security: data.security ?? {},
    collectedAt: data.collectedAt || row.collected_at.toISOString(),
  };
}

/** source + device_id を指定して1行取得する。deviceId 省略時は最新行。 */
export async function loadDeviceInventory(
  email: string,
  source: DeviceSource,
  deviceId?: string,
): Promise<DeviceInventoryData | null> {
  const rows = deviceId
    ? await sql<StoredRow[]>`
        SELECT data, collected_at, device_id
        FROM device_inventories
        WHERE user_email = ${email} AND source = ${source} AND device_id = ${deviceId}
        LIMIT 1
      `
    : await sql<StoredRow[]>`
        SELECT data, collected_at, device_id
        FROM device_inventories
        WHERE user_email = ${email} AND source = ${source}
        ORDER BY updated_at DESC
        LIMIT 1
      `;
  return asInventory(rows[0], source);
}

export async function loadLatestBrowserInventory(
  email: string,
): Promise<DeviceInventoryData | null> {
  return loadDeviceInventory(email, 'browser');
}

export async function loadLatestAgentInventory(email: string): Promise<DeviceInventoryData | null> {
  return loadDeviceInventory(email, 'agent');
}

/**
 * ログイン中ブラウザの端末情報を基準に、その端末にリンクされたエージェント情報だけをマージする。
 * - ブラウザがない場合は agent（最新）へフォールバック
 * - ブラウザがある場合、別端末の agent は混ぜない（サーバー上の agent がクライアントを上書きする事故を防ぐ）
 */
export async function loadClientInventory(
  email: string,
  browserDeviceId?: string,
): Promise<DeviceInventoryData | null> {
  const browser = browserDeviceId
    ? await loadDeviceInventory(email, 'browser', browserDeviceId)
    : await loadLatestBrowserInventory(email);
  if (!browser) return loadLatestAgentInventory(email);
  const agent = await loadDeviceInventory(email, 'agent', browser.deviceId);
  return agent ? mergeDeviceInventories(browser, agent) : browser;
}

/** 画面に表示された WEB-XXXXXXXX から、ブラウザ端末の device_id を解決する。 */
export async function resolveBrowserDeviceId(email: string, code: string): Promise<string | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;
  const raw = trimmed.replace(/^WEB-/i, '').toLowerCase();
  if (!/^[a-z0-9-]{4,64}$/i.test(raw)) return null;
  const rows = await sql<{ device_id: string }[]>`
    SELECT device_id
    FROM device_inventories
    WHERE user_email = ${email}
      AND source = 'browser'
      AND (lower(device_id) = ${raw} OR lower(device_id) LIKE ${`${raw}%`})
    LIMIT 2
  `;
  if (rows.length !== 1) return null;
  return rows[0]?.device_id ?? null;
}

export async function storeDeviceInventory(
  email: string,
  inventory: DeviceInventoryData,
): Promise<void> {
  // 端末エージェントの文字列には U+0000 や単独サロゲートが混ざりうる。
  // jsonb / text へ入れると PostgreSQL が 500 で拒否するため、取り込み境界で落とす
  // （2026-10-27: `POST /api/device/agent` が `unsupported Unicode escape sequence`
  // で失敗し、PC 情報の更新が止まった）。
  const safe = sanitizeForJson(inventory);
  await sql`
    INSERT INTO device_inventories (
      user_email, source, device_id, hostname, os, data, collected_at, updated_at
    ) VALUES (
      ${email}, ${safe.source}, ${safe.deviceId}, ${safe.hostname ?? null},
      ${safe.os ?? null}, ${jsonbValue(safe)}, ${safe.collectedAt}, now()
    )
    ON CONFLICT (user_email, source, device_id) DO UPDATE SET
      hostname = EXCLUDED.hostname,
      os = EXCLUDED.os,
      data = EXCLUDED.data,
      collected_at = EXCLUDED.collected_at,
      updated_at = now()
  `;
}

export function inventorySummary(inventory: DeviceInventoryData) {
  return {
    deviceId: inventory.deviceId,
    hostname: inventory.hostname ?? null,
    os: inventory.os ?? null,
    platform: inventory.platform ?? null,
    arch: inventory.arch ?? null,
    source: inventory.source,
    collectedAt: inventory.collectedAt,
    hardware: inventory.hardware,
    softwareCount: inventory.software.length,
    software: inventory.software.slice(0, 300),
    security: inventory.security,
    browser: inventory.browser ?? null,
  };
}
