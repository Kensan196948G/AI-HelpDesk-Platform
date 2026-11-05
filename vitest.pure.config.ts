import { defineConfig } from 'vitest/config';

// DB・環境ファイルに触れない試験の明示リスト。通常の globalSetup は継承しない。
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'scripts/lib/test-database-guard.test.mjs',
      'scripts/ops-readiness.test.mjs',
      'scripts/scan-secrets.test.mjs',
    ],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 10_000,
  },
});
