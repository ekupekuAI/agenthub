import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/test/**/*.test.tsx',
      'apps/*/test/**/*.test.ts',
    ],
    // Fails any test file that touches the real home (see the file for details).
    setupFiles: ['packages/cli/test/setup.ts'],
    testTimeout: 30_000,
  },
});
