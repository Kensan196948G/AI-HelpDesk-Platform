import { sql } from '../db.js';
import {
  type DeviceInventoryData,
  type DeviceSource,
  mergeDeviceInventories,
} from '../domain/device.js';
import { asJsonObject } from './json.js';

interface StoredRow {
  data: unknown;
  collected_at: Date;
}

function asInventory(row: StoredRow | undefined, source: DeviceSource): DeviceInventoryData | null {
  if (!row?.data) return null;
  const data = asJsonObject(row.data) as unknown as DeviceInventoryData;
  if (!data.deviceId || !Array.isArray(data.software)) return null;
  return {
    ...data,
    source,
    hardware: data.hardware ?? {},
    security: data.security ?? {},
    collectedAt: data.collectedAt || row.collected_at.toISOString(),
  };
}

export async function loadDeviceInventory(
  email: string,
  source: DeviceSource,
): Promise<DeviceInventoryData | null> {
  const rows = await sql<StoredRow[]>`
    SELECT data, collected_at
    FROM device_inventories
    WHERE user_email = ${email} AND source = ${source}
    LIMIT 1
  `;
  return asInventory(rows[0], source);
}

export async function loadMergedInventory(email: string): Promise<DeviceInventoryData | null> {
  const [browser, agent] = await Promise.all([
    loadDeviceInventory(email, 'browser'),
    loadDeviceInventory(email, 'agent'),
  ]);
  return mergeDeviceInventories(browser, agent);
}

export async function storeDeviceInventory(
  email: string,
  inventory: DeviceInventoryData,
): Promise<void> {
  await sql`
    INSERT INTO device_inventories (
      user_email, source, device_id, hostname, os, data, collected_at, updated_at
    ) VALUES (
      ${email}, ${inventory.source}, ${inventory.deviceId}, ${inventory.hostname ?? null},
      ${inventory.os ?? null}, ${JSON.stringify(inventory)}::jsonb, ${inventory.collectedAt}, now()
    )
    ON CONFLICT (user_email, source) DO UPDATE SET
      device_id = EXCLUDED.device_id,
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
