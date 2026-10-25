import { describe, expect, it } from 'vitest';
import { sql } from '../db.js';
import { appendAudit } from './audit-log.js';

/**
 * アプリ経由の JSONB 書き込みが JSON 文字列（二重エンコード）になっていないことを確認する。
 * 文字列で保存されると `->>` / GIN / 制約が効かず、外部ツールから読めない。
 */
describe('JSONB の保存形式', () => {
  it('監査ログの detail を jsonb オブジェクトとして保存する', async () => {
    const action = `test.jsonb.${Date.now()}`;
    await sql.begin(async (tx) => {
      await appendAudit(tx, {
        actorId: null,
        action,
        targetType: 'test',
        targetId: 'jsonb',
        detail: { nested: { a: 1 }, list: [1, 2] },
      });
    });

    const rows = await sql<{ type: string | null; a: string | null }[]>`
      SELECT jsonb_typeof(detail) AS type, detail->'nested'->>'a' AS a
      FROM audit_log
      WHERE action = ${action}
      ORDER BY id DESC
      LIMIT 1
    `;
    expect(rows[0]?.type).toBe('object');
    expect(rows[0]?.a).toBe('1');
  });
});
