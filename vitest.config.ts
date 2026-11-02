import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // 既定は off。②を試験する間だけ on にする（off と drain は個別の試験で切り替える）。
    env: { RESOLVE_PATH_MODE: 'on' },
    include: ['apps/api/src/**/*.test.ts', 'worker/src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    globalSetup: ['./tests/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 10_000,
  },
});
