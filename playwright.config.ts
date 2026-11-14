import { defineConfig, devices } from '@playwright/test';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Each project gets its own fixture server on a free port, so projects run side by side and concurrent
// worktrees never collide. Workers inherit the ports the main process picked. Firefox is left out: Playwright's
// Firefox 159 does not start on macOS 27 ("Could not find profile folder").
const PROJECTS = [
  { name: 'chromium', use: devices['Desktop Chrome'] },
  { name: 'webkit', use: devices['Desktop Safari'] },
  // A development build keeps React's StrictMode checks, such as mounting effects twice.
  { name: 'development', use: devices['Desktop Chrome'], plugin: '.e2e/development' },
];
if (!process.env.CREW_E2E_PORTS) {
  const ports = [];
  for (const _ of PROJECTS) {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    ports.push((probe.address() as net.AddressInfo).port);
    await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  }
  process.env.CREW_E2E_PORTS = ports.join(',');
}
const ports = process.env.CREW_E2E_PORTS.split(',').map(Number);
const url = (index: number) => `http://127.0.0.1:${ports[index]}`;

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '*.spec.ts',
  // The fixture server holds state, so tests within a project run one at a time.
  fullyParallel: false,
  workers: PROJECTS.length,
  outputDir: process.env.CREW_E2E_OUTPUT ?? path.join(os.tmpdir(), `crew-board-e2e-${process.pid}`),
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}{-snapshotSuffix}{ext}',
  use: {
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: PROJECTS.map(({ name, use }, index) => ({
    name,
    use: { ...use, viewport: { width: 1440, height: 1000 }, baseURL: url(index) },
  })),
  webServer: PROJECTS.map(({ plugin }, index) => ({
    command: 'node test/e2e/server.ts',
    url: `${url(index)}/api/state`,
    env: { CREW_E2E_PORT: String(ports[index]), ...(plugin ? { CREW_E2E_PLUGIN: plugin } : {}) },
    reuseExistingServer: false,
  })),
});
