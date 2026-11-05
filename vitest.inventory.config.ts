import { defineConfig } from 'vitest/config';

// 合成ファイルだけを使う独立試験。既存の DB 用 globalSetup は継承しない。
export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test' },
    include: ['scripts/runtime-inventory.test.mjs'],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 10_000,
  },
});
