import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/session.js';
import { sql } from '../db.js';
import { GENESIS_HASH, verifyAuditChain } from '../domain/audit.js';
import { asJsonObject } from '../lib/json.js';
import { auditDto } from '../lib/serializers.js';

const LimitSchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/audit', { preHandler: requireRole('approver') }, async (request) => {
    const query = LimitSchema.parse(request.query);
    const rows = await sql<any[]>`
      SELECT a.*, u.name AS actor_name
      FROM audit_log a
      LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.id DESC
      LIMIT ${query.limit}
    `;
    return { audit: rows.map(auditDto) };
  });

  app.post('/audit/verify', { preHandler: requireRole('approver') }, async () => {
    const rows = await sql<any[]>`
      SELECT id, actor_id, action, target_type, target_id, detail, prev_hash, hash
      FROM audit_log
      ORDER BY id ASC
    `;
    const mapped = rows.map((row) => ({
      id: Number(row.id),
      actorId: row.actor_id ?? null,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      detail: asJsonObject(row.detail),
      prevHash: row.prev_hash,
      hash: row.hash,
    }));
    const result = verifyAuditChain(mapped, GENESIS_HASH);
    return result;
  });
}
