import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.AGENTHUB_E2E_PORT ?? 3107);

// Fresh, seeded data dir per run. Set once so worker processes inherit the same value.
process.env.AGENTHUB_E2E_DATA_DIR ??= path.join(tmpdir(), `agenthub-e2e-${Date.now()}`);
process.env.AGENTHUB_E2E_ADMIN_TOKEN ??= `e2e-admin-${'k'.repeat(40)}`;

/**
 * Browser tests run against the production build (`npm run build -w apps/web` first) using the
 * system Microsoft Edge. No browsers are downloaded.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'msedge',
    headless: true,
  },
  projects: [{ name: 'msedge', use: { channel: 'msedge' } }],
  webServer: {
    command: `npm run seed && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/guidelines`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    env: {
      AGENTHUB_DATA_DIR: process.env.AGENTHUB_E2E_DATA_DIR,
      AGENTHUB_ADMIN_TOKEN: process.env.AGENTHUB_E2E_ADMIN_TOKEN,
      AGENTHUB_SECURITY_CONTACT: 'security@agenthub.example',
    },
  },
});
