import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { tokenFile } from '../plugin/bridge/auth.ts';
import { browserProfile, BrowserServers } from '../plugin/bridge/browser.ts';
import { resolveConfig } from '../plugin/bridge/config.ts';
import { Jobs } from '../plugin/bridge/jobs.ts';
import type { Adapter, JobCtl } from '../plugin/bridge/jobs.ts';

/** sandbox-exec cannot nest, so inside a worker's own sandbox these tests have nothing to run. */
const skip = (() => {
  if (process.platform !== 'darwin') return 'macOS only';
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' });
    return false;
  } catch {
    return 'already inside a sandbox';
  }
})();

test('the browser profile protects .git in each writable directory and its resolved path', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-profile-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const job = path.join(dir, 'job');
  const alias = path.join(dir, 'alias');
  const scratch = path.join(dir, 'scratch');
  fs.mkdirSync(job);
  fs.mkdirSync(scratch);
  fs.symlinkSync(job, alias, 'junction');
  const profile = browserProfile([alias, scratch], []);
  for (const root of [alias, job, scratch]) {
    const git = JSON.stringify(path.join(root, '.git'));
    assert.ok(profile.includes(`(deny file-write* (literal ${git}) (subpath ${git}))`));
  }
});

test('the browser profile denies the token and writes outside the job, and allows the rest', { skip }, (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-profile-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const job = path.join(dir, 'job');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(job);
  fs.mkdirSync(outside);
  const secret = path.join(dir, 'token');
  fs.writeFileSync(secret, 'secret');
  const profile = browserProfile([job], [secret]);
  // Refusing to start another app was checked by hand (`open` fails with -54); a test that tried would start one when it regressed.
  for (const operation of ['lsopen', 'appleevent-send', 'job-creation']) assert.ok(profile.includes(`(deny ${operation})`), operation);
  const run = (...args: string[]) => {
    try {
      return execFileSync('/usr/bin/sandbox-exec', ['-p', profile, ...args], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      return `failed: ${(err as { stderr: string }).stderr}`;
    }
  };
  assert.match(run('/bin/cat', secret), /failed: .*Operation not permitted/);
  assert.match(run('/usr/bin/touch', path.join(outside, 'x')), /failed: .*Operation not permitted/);
  const git = path.join(job, '.git');
  assert.match(run('/usr/bin/touch', git), /failed: .*Operation not permitted/);
  fs.mkdirSync(git);
  assert.match(run('/usr/bin/touch', path.join(git, 'config')), /failed: .*Operation not permitted/);
  assert.equal(run('/usr/bin/touch', path.join(job, 'x')), '');
  assert.equal(fs.existsSync(path.join(job, 'x')), true);
});

test('overlapping starts for a job share one server, and a stop reaches a server still starting', { skip, timeout: 30_000 }, async (t) => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-servers-')));
  // A stand-in for Playwright's CLI: it records its process and says it listens a little later, as the server does. No browser starts.
  const started = path.join(cwd, 'started');
  const stub = path.join(cwd, 'node_modules/playwright');
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, 'package.json'), JSON.stringify({ name: 'playwright', bin: { playwright: 'cli.js' } }));
  fs.writeFileSync(path.join(stub, 'cli.js'), `require('node:fs').appendFileSync(${JSON.stringify(started)}, process.pid + '\\n'); setTimeout(() => console.log('Listening on stub'), 300); setInterval(() => {}, 1000);`);
  const pids = () => (fs.existsSync(started) ? fs.readFileSync(started, 'utf8').trim().split('\n').map(Number) : []);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (check: () => boolean) => {
    for (const deadline = Date.now() + 10_000; !check(); ) {
      assert.ok(Date.now() < deadline, 'timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  t.after(() => {
    // A failed assertion must not leave a stand-in running.
    for (const pid of pids()) if (alive(pid)) process.kill(pid, 'SIGKILL');
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5 });
  });
  const servers = new BrowserServers();
  const options = { cwd, writable: [cwd], unreadable: [], tmp: path.join(cwd, 'tmp') };

  const [first, second] = await Promise.all([servers.start('cx-000001', options), servers.start('cx-000001', options)]);
  assert.equal(first, second);
  assert.equal(await servers.start('cx-000001', options), first);
  assert.equal(pids().length, 1);
  servers.stop('cx-000001');
  await until(() => !alive(pids()[0]));

  // Stopped before its process exists, and then while the process has not yet said it listens.
  const early = servers.start('cx-000002', options);
  servers.stop('cx-000002');
  await assert.rejects(early, /stopped while it started/);
  assert.equal(pids().length, 1);
  const late = servers.start('cx-000002', options);
  const rejected = assert.rejects(late, /The browser server exited/);
  await until(() => pids().length === 2);
  servers.stop('cx-000002');
  await rejected;
  await until(() => !alive(pids()[1]));
  // A start that failed is not kept: the next one starts a server.
  await servers.start('cx-000002', options);
  assert.equal(pids().length, 3);
  servers.stopAll();
  await until(() => !alive(pids()[2]));
});

test('a running app job gets a browser outside its sandbox for the turn, and only then', { skip, timeout: 60_000 }, async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-browser-')));
  // The job's tree needs Playwright; this repository's will do.
  fs.symlinkSync(path.resolve('node_modules'), path.join(home, 'node_modules'));
  const workers = new Map<string, JobCtl>();
  const adapter: Adapter = {
    start: async (ctl) => { workers.set(ctl.job.id, ctl); ctl.session(ctl.job.id); },
    reply: async () => {}, answer: async () => {}, cancel: async () => {}, shutdown: () => {},
  };
  const jobs = new Jobs(home, () => resolveConfig({ notify: false }), { codex: adapter, antigravity: adapter }, { onEvent: () => {}, onJob: () => {}, onAttention: () => {} });
  t.after(() => {
    // A failed assertion must not leave a server running, which would keep the test process alive.
    for (const [id, ctl] of workers) if (jobs.get(id).state === 'running') ctl.done('stopped');
    jobs.flush();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  fs.writeFileSync(tokenFile(home), 'daemon-secret');

  const plain = await jobs.create({ kind: 'delegate', cwd: home, isolation: 'in_place', task: 'static' });
  await assert.rejects(jobs.browser(plain.id), /may not run the app/);

  const job = await jobs.create({ kind: 'delegate', cwd: home, isolation: 'in_place', task: 'check the page', runsApp: true });
  const { endpoint } = await jobs.browser(job.id);
  assert.equal((await jobs.browser(job.id)).endpoint, endpoint);
  const browser = await chromium.connect(endpoint);
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<h1>rendered</h1>');
  assert.equal(await page.textContent('h1'), 'rendered');
  assert.ok((await page.screenshot()).length > 0);
  // The daemon's token stays out of reach, as it is in the worker's own sandbox.
  await assert.rejects(page.goto(`file://${tokenFile(home)}`), /ERR_ACCESS_DENIED|ERR_FILE_NOT_FOUND/);
  await browser.close();

  workers.get(job.id)!.done('checked');
  while (job.state === 'running') await jobs.wait(job.id, job.seq, 2000);
  await assert.rejects(chromium.connect(endpoint, { timeout: 3000 }));
  await assert.rejects(jobs.browser(job.id), /is done/);
});
