import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/api/src/**/*.test.ts', 'worker/src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    globalSetup: ['./tests/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 10_000,
  },
});
