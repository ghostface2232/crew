import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '*.spec.ts',
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:47755',
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node test/e2e/server.ts',
    url: 'http://127.0.0.1:47755/api/state',
    reuseExistingServer: false,
  },
});
