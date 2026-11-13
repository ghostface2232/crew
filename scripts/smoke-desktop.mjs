import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const appPath = path.resolve(process.env.CREW_APP_PATH ?? 'native/build/Crew.app');
const executable = path.join(appPath, 'Contents/MacOS/Crew');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-native-smoke-'));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ notify: false }));
const probe = net.createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const env = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CREW_HOME: home, CREW_PORT: String(port), CREW_TEST_MODE: '1' };
delete env.CREW_ATTACH_ONLY;
const base = `http://127.0.0.1:${port}`;
const health = async () => (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).json();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, label) => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
};
const children = [];
const launch = () => {
  const child = spawn(executable, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stderr.on('data', (data) => process.stderr.write(data));
  return child;
};
const stop = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
};
let daemonPID;
try {
  const start = performance.now();
  let app = launch();
  await waitFor(async () => {
    assert.equal(app.exitCode, null, 'native app exited before connecting');
    return health().catch(() => false);
  }, 'bundled daemon startup');
  daemonPID = (await health()).pid;
  const startupMs = Math.round(performance.now() - start);
  assert.equal((await health()).name, 'crew');
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.ok(Array.isArray(state.jobs));
  const lease = async (body) => (await fetch(`${base}/api/desktop/heartbeat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  assert.equal((await lease({ handlesCompletion: true })).completionNotifications, true);
  assert.equal((await lease({})).completionNotifications, false, 'legacy clients leave completion notifications with the daemon');
  assert.ok((await fetch(base)).ok, 'web board remains available');
  await sleep(700);
  const second = launch();
  await waitFor(async () => second.exitCode !== null, 'single-instance exit');
  assert.equal(second.exitCode, 0);
  assert.equal((await health()).pid, daemonPID);
  const rssKiB = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(app.pid)], { encoding: 'utf8' }).trim());
  await stop(app);
  assert.equal((await health()).pid, daemonPID, 'quitting the UI must preserve the daemon');
  app = launch();
  await sleep(1000);
  assert.equal(app.exitCode, null, 'reopened app remains alive');
  assert.equal((await health()).pid, daemonPID, 'reopening attaches to the same daemon');
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath]);
  assert.equal(fs.existsSync(path.join(appPath, 'Contents/Frameworks/Electron Framework.framework')), false);
  const result = { app: appPath, startupMs, nativeProcessRSSMiB: Math.round(rssKiB / 1024), daemonSurvivesQuit: true, singleInstance: true, webBoard: true };
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/native-smoke.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  for (const child of children) await stop(child);
  if (daemonPID) {
    await fetch(`${base}/api/shutdown`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }).catch(() => {});
    await waitFor(async () => !(await health().catch(() => null)), 'test daemon shutdown').catch(() => {});
  }
  fs.rmSync(home, { recursive: true, force: true });
}
