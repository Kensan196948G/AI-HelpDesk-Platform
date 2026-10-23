import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default function globalSetup(): void {
  const root = path.resolve(import.meta.dirname, '..');
  const env = { ...process.env, NODE_ENV: 'test' };
  execFileSync('npx', ['tsx', 'scripts/migrate.ts'], { cwd: root, stdio: 'inherit', env });
  execFileSync('npx', ['tsx', 'scripts/seed.ts'], { cwd: root, stdio: 'inherit', env });
}
