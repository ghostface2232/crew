import { defineConfig } from '@playwright/test';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import base from '../../playwright.config.ts';

// Keep concurrent worktrees off the default fixture port and isolate their artifacts.
if (!process.env.CREW_E2E_PORT) {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  process.env.CREW_E2E_PORT = String((probe.address() as net.AddressInfo).port);
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
}
const baseURL = `http://127.0.0.1:${process.env.CREW_E2E_PORT}`;
export default defineConfig({
  ...base,
  testDir: '.',
  outputDir: process.env.CREW_E2E_OUTPUT ?? path.join(os.tmpdir(), `crew-board-e2e-${process.pid}`),
  use: { ...base.use, baseURL },
  webServer: {
    command: 'node test/e2e/server.ts',
    cwd: path.resolve(import.meta.dirname, '../..'),
    url: `${baseURL}/api/state`,
    reuseExistingServer: false,
  },
});
