import { defineConfig } from 'vitest/config';

// DB・環境ファイルに触れない試験の明示リスト。通常の globalSetup は継承しない。
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'scripts/lib/test-database-guard.test.mjs',
      'scripts/lib/dist-manifest.test.mjs',
      'scripts/lib/smoke-guards.test.mjs',
      'scripts/lib/is-main.test.mjs',
      'scripts/staging-smoke.test.mjs',
      'apps/api/src/lib/test-database.test.ts',
      'scripts/ops-readiness.test.mjs',
      'scripts/scan-secrets.test.mjs',
    ],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 10_000,
  },
});
