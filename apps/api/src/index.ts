import { config } from './config.js';
import { sql } from './db.js';
import { startHandoverNotificationWorker } from './lib/handover-notify.js';
import { describeMailTransport } from './lib/mailer.js';
import { buildServer } from './server.js';

const app = await buildServer();
const stopNotificationWorker = startHandoverNotificationWorker(app.log);

try {
  app.log.info({ transport: describeMailTransport() }, 'メール通知の送信手段');
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(
    {
      port: config.PORT,
      host: config.HOST,
      nodeEnv: config.NODE_ENV,
      commit: config.COMMIT_SHA ?? '',
      db: 'postgresql://.../' + (config.DATABASE_URL.split('/').pop() ?? ''),
    },
    'AI HelpDesk API started',
  );
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  await sql.end({ timeout: 5 });
  process.exit(1);
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  stopNotificationWorker();
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
