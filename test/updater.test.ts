import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { installerName, parseRelease, Updater } from '../desktop/updater.ts';
import type { AppUpdate } from '../plugin/board/src/types.ts';

const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const release = (version: string, url: string, digest: string, extra: object = {}) => ({
  tag_name: `v${version}`, draft: false, prerelease: false, html_url: 'https://github.com/ghostface2232/crew/releases/tag/v' + version,
  assets: [{ name: installerName(version), browser_download_url: url, digest: `sha256:${digest}`, size: 0 }],
  ...extra,
});

test('takes only a published release whose installer has a SHA-256 digest', () => {
  const digest = 'a'.repeat(64);
  const url = 'https://github.com/ghostface2232/crew/releases/download/v0.3.0/Crew-Setup-0.3.0.exe';
  assert.deepEqual(parseRelease(release('0.3.0', url, digest)), {
    version: '0.3.0', url, sha256: digest, size: 0, page: 'https://github.com/ghostface2232/crew/releases/tag/v0.3.0',
  });
  assert.equal(parseRelease(release('0.3.0', url, digest, { draft: true })), null);
  assert.equal(parseRelease(release('0.3.0', url, digest, { prerelease: true })), null);
  assert.equal(parseRelease(release('0.3.0', url, 'short')), null);
  assert.equal(parseRelease({ ...release('0.3.0', url, digest), tag_name: 'v0.3.0-beta' }), null);
  assert.equal(parseRelease({ ...release('0.3.0', url, digest), assets: [{ name: 'Crew-Setup-0.2.0.exe', browser_download_url: url, digest: `sha256:${digest}` }] }), null);
  // Only HTTPS, or a loopback server for testing.
  assert.equal(parseRelease(release('0.3.0', 'http://example.com/Crew-Setup-0.3.0.exe', digest)), null);
  assert.equal(parseRelease(release('0.3.0', 'file:///C:/Crew-Setup-0.3.0.exe', digest)), null);
  assert.ok(parseRelease(release('0.3.0', 'http://127.0.0.1:9/Crew-Setup-0.3.0.exe', digest)));
  assert.equal(parseRelease(null), null);
});

let server: http.Server;
let base = '';
let feed: unknown = null;
let feedStatus = 200;
const payload = Buffer.from('installer bytes '.repeat(4096));
let served = payload;
async function startServer() {
  if (server) return;
  server = http.createServer((req, res) => {
    if (req.url === '/latest') {
      res.writeHead(feedStatus, { 'content-type': 'application/json' }).end(JSON.stringify(feed));
    } else if (req.url?.startsWith('/download/')) {
      res.writeHead(200, { 'content-length': served.length }).end(served);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
after(() => server?.close());

function updater(dir: string, current = '0.2.0') {
  const seen: AppUpdate['state'][] = [];
  const instance = new Updater({ dir, current, feed: `${base}/latest`, supported: true, onChange: (status) => seen.push(status.state) });
  return { instance, seen };
}
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crew-updater-'));

test('hand-over retains the digest verified at load even if the staged files change', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, installerName('0.3.0'));
    const manifest = path.join(dir, 'staged.json');
    fs.writeFileSync(file, payload);
    fs.writeFileSync(manifest, JSON.stringify({ version: '0.3.0', sha256: sha(payload) }));
    const { instance } = updater(dir);
    await instance.load();
    fs.writeFileSync(file, 'changed');
    fs.writeFileSync(manifest, JSON.stringify({ version: '0.3.0', sha256: sha('changed') }));
    assert.ok(instance.installing());
    assert.equal(instance.installerSHA256, sha(payload));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Windows supervisor verifies every installer launch, including interactive recovery', { skip: process.platform !== 'win32' }, async () => {
  const { installScript, supervisorEnv } = await import('../desktop/updater.ts');
  const dir = tempDir();
  try {
    const file = path.join(dir, 'installer.exe');
    for (const scenario of ['intact', 'changed', 'recovery', 'changed-before-recovery']) {
      fs.writeFileSync(file, scenario === 'changed' ? 'changed' : payload);
      // Record launches without executing the fixture. WaitForExit can change it before the fallback.
      const script = `
        function Start-Process($FilePath, $ArgumentList, [switch]$PassThru, $ErrorAction) {
          [Console]::WriteLine('launch')
          $p = [PSCustomObject]@{ Handle = 0; ExitCode = 0 }
          $p | Add-Member ScriptMethod WaitForExit {
            if ($env:SCENARIO -eq 'recovery') { $this.ExitCode = 1 }
            if ($env:SCENARIO -eq 'changed-before-recovery') {
              [IO.File]::WriteAllText($env:CREW_INSTALLER, 'changed')
              $this.ExitCode = 1
            }
          }
          if ($PassThru) { return $p }
        }
        try { ${installScript} } catch { [Console]::WriteLine($_.Exception.Message); exit 1 }
      `;
      const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        env: { ...supervisorEnv(process.env), CREW_INSTALLER: file, CREW_INSTALLER_SHA256: sha(payload), CREW_APP: path.join(dir, 'missing.exe'), SCENARIO: scenario },
        encoding: 'utf8',
      });
      assert.ifError(run.error);
      const changed = scenario.startsWith('changed');
      assert.equal(run.status, changed ? 1 : 0, run.stderr);
      const launches = run.stdout.match(/^launch\r?$/gm)?.length ?? 0;
      assert.equal(launches, { intact: 1, changed: 0, recovery: 2, 'changed-before-recovery': 1 }[scenario]);
      if (changed) assert.match(run.stdout, /could not verify the update/i);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a silent install that fails reopens Crew, which is told why', { skip: process.platform !== 'win32' }, async () => {
  const { installScript, supervisorEnv, UPDATE_FAILED } = await import('../desktop/updater.ts');
  const dir = tempDir();
  try {
    const file = path.join(dir, 'installer.exe');
    fs.writeFileSync(file, payload);
    const script = `
      function Start-Process($FilePath, $ArgumentList, [switch]$PassThru, $ErrorAction) {
        [Console]::WriteLine("launch $FilePath | $env:${UPDATE_FAILED}")
        $p = [PSCustomObject]@{ Handle = 0; ExitCode = 0 }
        $p | Add-Member ScriptMethod WaitForExit { $this.ExitCode = 2 }
        if ($PassThru) { return $p }
      }
      ${installScript}
    `;
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env: { ...supervisorEnv(process.env), CREW_INSTALLER: file, CREW_INSTALLER_SHA256: sha(payload), CREW_APP: process.execPath },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.stdout.trim().split(/\r?\n/), [
      `launch ${file} | `,
      `launch ${process.execPath} | The installer stopped with exit code 2, so the update was not installed.`,
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed install stays on show through later checks until it is seen, and a new install clears it', async () => {
  await startServer();
  const dir = path.join(tempDir(), 'updates');
  served = payload;
  feedStatus = 200;
  feed = release('0.3.0', `${base}/download/Crew-Setup-0.3.0.exe`, sha(payload));
  const { instance } = updater(dir);
  instance.installFailed('The installer stopped with exit code 2, so the update was not installed.');
  await instance.check();
  await instance.download();
  assert.equal(instance.status.state, 'ready');
  assert.equal(instance.status.installError, 'The installer stopped with exit code 2, so the update was not installed.');
  instance.seen();
  assert.equal(instance.status.installError, undefined);
  // A failed check, which restores the state it started from, does not bring it back.
  feedStatus = 500;
  await instance.check();
  assert.equal(instance.status.state, 'ready');
  assert.equal(instance.status.installError, undefined);
  instance.installFailed('again');
  assert.equal(instance.installing(), true);
  assert.equal(instance.status.installError, undefined);
});

test('a check during load cannot remove the installer being restored', async () => {
  const dir = tempDir();
  try {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 1);
    const file = path.join(dir, installerName('0.3.0'));
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(path.join(dir, 'staged.json'), JSON.stringify({ version: '0.3.0', sha256: sha(bytes) }));
    const feed = 'data:application/json,' + encodeURIComponent(JSON.stringify(release('0.2.3', 'https://example.com/installer.exe', sha(bytes))));
    const instance = new Updater({ dir, current: '0.2.3', feed, supported: true });
    await Promise.all([instance.load(), instance.check()]);
    assert.equal(instance.status.state, 'ready');
    assert.ok(fs.existsSync(instance.installer!));
    await instance.check();
    assert.equal(instance.status.state, 'idle');
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloads allow ongoing data and time out on missing headers or stalled bodies', async (t) => {
  for (const scenario of ['slow', 'headers', 'body']) {
    await t.test(scenario, { timeout: 5_000 }, async (t) => {
      const dir = tempDir();
      try {
        const chunk = Buffer.from('installer chunk');
        const bytes = Buffer.concat(Array.from({ length: 11 }, () => chunk));
        const url = 'https://example.com/installer.exe';
        const feed = 'data:application/json,' + encodeURIComponent(JSON.stringify(release('0.3.0', url, sha(bytes))));
        const instance = new Updater({ dir, current: '0.2.3', feed, supported: true });
        await instance.check();
        let signal: AbortSignal | undefined;
        let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
        // Control arrival times without waiting minutes or depending on network speed.
        t.mock.method(globalThis, 'fetch', async (_input: unknown, options: RequestInit) => {
          signal = options.signal!;
          if (scenario === 'headers') {
            return new Promise<Response>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
          }
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              signal!.addEventListener('abort', () => controller.error(signal!.reason), { once: true });
            },
          }), { headers: { 'content-length': String(bytes.length) } });
        });
        t.mock.timers.enable({ apis: ['setTimeout'] });
        // AbortSignal.timeout uses intrinsic timers, so route it through the test clock too.
        t.mock.method(AbortSignal, 'timeout', (delay: number) => {
          const controller = new AbortController();
          setTimeout(() => controller.abort(), delay);
          return controller.signal;
        });
        const downloading = instance.download();
        await setImmediate();
        if (scenario !== 'headers') {
          for (let i = 0; i < 11; i++) {
            t.mock.timers.tick(59_000);
            assert.equal(signal!.aborted, false);
            stream!.enqueue(chunk);
            await setImmediate();
          }
        }
        if (scenario === 'slow') stream!.close();
        else {
          t.mock.timers.tick(60_000);
          assert.equal(signal!.aborted, true);
        }
        await downloading;
        if (scenario === 'slow') {
          assert.equal(instance.status.state, 'ready');
          assert.equal(instance.installerSHA256, sha(bytes));
          assert.deepEqual(fs.readFileSync(instance.installer!), bytes);
          t.mock.timers.tick(60_000);
          assert.equal(signal!.aborted, false);
        } else {
          assert.equal(signal!.aborted, true);
          assert.equal(instance.status.state, 'available');
          assert.match(instance.status.error!, /Could not download/);
          assert.deepEqual(fs.readdirSync(dir), []);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test('a newer release waits to download, then stays staged across launches', async () => {
  await startServer();
  const dir = path.join(tempDir(), 'updates');
  served = payload;
  feedStatus = 200;
  feed = release('0.3.0', `${base}/download/Crew-Setup-0.3.0.exe`, sha(payload));
  const { instance, seen } = updater(dir);
  await instance.check();
  assert.equal(instance.status.state, 'available');
  assert.equal(instance.status.latest, '0.3.0');
  assert.equal(instance.installer, null);
  await instance.download();
  assert.equal(instance.status.state, 'ready');
  assert.ok(seen.includes('downloading'));
  assert.deepEqual(fs.readFileSync(instance.installer!), payload);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Crew-Setup-0.3.0.exe', 'staged.json']);

  // The next launch finds it ready without downloading, and a check for the same release keeps it so.
  const next = updater(dir).instance;
  await next.load();
  assert.equal(next.status.state, 'ready');
  await next.check();
  assert.equal(next.status.state, 'ready');
  assert.ok(next.status.checkedAt);

  // Once that version is the one running, the staged copy is removed.
  const updated = updater(dir, '0.3.0').instance;
  await updated.load();
  assert.equal(updated.status.state, 'idle');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a download that does not match the digest is discarded', async () => {
  await startServer();
  const dir = path.join(tempDir(), 'updates');
  served = Buffer.from('tampered');
  feedStatus = 200;
  feed = release('0.3.0', `${base}/download/Crew-Setup-0.3.0.exe`, sha(payload));
  const { instance } = updater(dir);
  await instance.check();
  await instance.download();
  assert.equal(instance.status.state, 'available');
  assert.match(instance.status.error!, /SHA-256/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a staged installer that changed on disk is not offered', async () => {
  const dir = path.join(tempDir(), 'updates');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'Crew-Setup-0.3.0.exe'), 'changed');
  fs.writeFileSync(path.join(dir, 'staged.json'), JSON.stringify({ version: '0.3.0', sha256: sha(payload) }));
  const { instance } = updater(dir);
  await instance.load();
  assert.equal(instance.status.state, 'idle');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('no newer release, no release at all, and a failed check', async () => {
  await startServer();
  const dir = path.join(tempDir(), 'updates');
  feedStatus = 200;
  feed = release('0.2.0', `${base}/download/Crew-Setup-0.2.0.exe`, sha(payload));
  const { instance } = updater(dir);
  await instance.check();
  assert.equal(instance.status.state, 'idle');
  assert.ok(instance.status.checkedAt && !instance.status.error);
  feedStatus = 404;
  await instance.check();
  assert.equal(instance.status.state, 'idle');
  assert.equal(instance.status.error, undefined);
  feedStatus = 500;
  await instance.check();
  assert.equal(instance.status.state, 'idle');
  assert.match(instance.status.error!, /500/);
});

test('an install waits, can be called off, and an unsupported copy does nothing', async () => {
  await startServer();
  const dir = path.join(tempDir(), 'updates');
  served = payload;
  feedStatus = 200;
  feed = release('0.3.0', `${base}/download/Crew-Setup-0.3.0.exe`, sha(payload));
  const { instance } = updater(dir);
  await instance.check();
  await instance.download();
  assert.equal(instance.installing(2), true);
  assert.equal(instance.status.waiting, 2);
  assert.equal(instance.installer, path.join(dir, 'Crew-Setup-0.3.0.exe'));
  // A second install does not start over the first; the count is updated on its own.
  assert.equal(instance.installing(1), false);
  assert.equal(instance.status.waiting, 2);
  instance.waitFor(1);
  assert.equal(instance.status.waiting, 1);
  // Waiting on a daemon that has not answered can still be called off; once it is being stopped, it cannot.
  instance.waitFor(0);
  assert.equal(instance.status.waiting, 0);
  instance.stoppingDaemon();
  assert.equal(instance.status.waiting, undefined);
  assert.equal(instance.status.state, 'installing');
  // A daemon that refused to stop puts the install back to waiting.
  instance.waitFor(0);
  assert.equal(instance.status.waiting, 0);
  instance.failed();
  // An install that was called off is not revived by a late count.
  instance.waitFor(3);
  assert.equal(instance.status.state, 'ready');
  assert.equal(instance.status.state, 'ready');
  assert.equal(instance.status.error, undefined);
  assert.equal(instance.status.waiting, undefined);
  assert.equal(instance.installing(), true);
  instance.failed('spawn failed');
  assert.equal(instance.status.state, 'ready');
  assert.equal(instance.status.error, 'spawn failed');

  const unsupported = new Updater({ dir, current: '0.2.0', feed: `${base}/latest`, supported: false });
  await unsupported.load();
  await unsupported.check();
  assert.equal(unsupported.status.state, 'unsupported');
  assert.ok(fs.existsSync(path.join(dir, 'Crew-Setup-0.3.0.exe')));
});

test('a check that ends during an install leaves it alone, and a release without an installer keeps the staged one', async () => {
  await startServer();
  const dir = path.join(tempDir(), 'updates');
  served = payload;
  feedStatus = 200;
  feed = release('0.3.0', `${base}/download/Crew-Setup-0.3.0.exe`, sha(payload));
  const { instance } = updater(dir);
  await instance.check();
  await instance.download();
  assert.equal(instance.status.state, 'ready');

  // The latest release no longer offers a Windows installer: the staged one stays ready.
  feed = { ...release('0.3.0', `${base}/download/Crew-Setup-0.3.0.exe`, sha(payload)), assets: [] };
  await instance.check();
  assert.equal(instance.status.state, 'ready');
  assert.ok(fs.existsSync(instance.installer!));

  // A check still in flight when the install starts, even one that finds the app up to date, changes nothing.
  feed = release('0.2.0', `${base}/download/Crew-Setup-0.2.0.exe`, sha(payload));
  const checking = instance.check();
  assert.equal(instance.installing(), true);
  await checking;
  assert.equal(instance.status.state, 'installing');
  assert.ok(fs.existsSync(instance.installer!));
});
