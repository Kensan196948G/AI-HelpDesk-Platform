import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { sql } from '../db.js';

const VERSION = '0.1.0';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    try {
      const rows = await sql<{ now: Date }[]>`SELECT now() AS now`;
      return {
        ok: true,
        service: 'ai-helpdesk-api',
        version: VERSION,
        commit: config.COMMIT_SHA ?? '',
        db: 'ok',
        time: rows[0]?.now ?? new Date().toISOString(),
        env: config.NODE_ENV,
      };
    } catch {
      reply.code(503);
      return {
        ok: false,
        service: 'ai-helpdesk-api',
        version: VERSION,
        commit: config.COMMIT_SHA ?? '',
        db: 'error',
        time: new Date().toISOString(),
        env: config.NODE_ENV,
      };
    }
  });
}
