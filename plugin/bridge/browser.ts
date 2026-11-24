import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { clipEnd } from './text.ts';

/**
 * Codex's macOS sandbox denies `mach-register`, and Chromium registers a Mach service as it starts
 * (MachPortRendezvousServer), so no browser starts inside it, even for an escalated command. The bridge
 * starts the job's own Playwright server instead, under a sandbox of its own: the same file limits as the
 * job (writes only in its directories, the daemon's token unreadable), with Mach services allowed.
 */
export function browserProfile(writable: string[], unreadable: string[]): string {
  const real = (dir: string) => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return dir;
    }
  };
  const quote = (value: string) => JSON.stringify(value);
  const roots = [...new Set(writable.flatMap((dir) => [dir, real(dir)]))];
  const git = [...new Set(roots.flatMap((dir) => {
    const file = path.join(dir, '.git');
    return [file, real(file)];
  }))];
  return [
    '(version 1)',
    '(allow default)',
    // The file limits below mean nothing to a process that has LaunchServices, another app, or launchd run something
    // for it. The worker's own sandbox denies by default and so refuses all three.
    '(deny lsopen)',
    '(deny appleevent-send)',
    '(deny job-creation)',
    ...unreadable.flatMap((file) => [...new Set([file, real(file)])]).map((file) => `(deny file-read* file-write* (literal ${quote(file)}))`),
    // The bridge runs Git outside the sandbox, where a modified pointer or config could run commands.
    ...git.map((file) => `(deny file-write* (literal ${quote(file)}) (subpath ${quote(file)}))`),
    '(deny file-write*',
    '  (require-not',
    '    (require-any',
    ...roots.map((dir) => `      (subpath ${quote(dir)})`),
    '      (literal "/dev/null")',
    '      (regex #"^/dev/(fd/|tty|ptmx|dtracehelper)"))))',
  ].join('\n');
}

/** The project's own Playwright, so the server speaks the same protocol version as its tests. */
export function playwrightCli(cwd: string): string | null {
  const require = createRequire(path.join(cwd, 'noop.js'));
  for (const name of ['playwright', 'playwright-core']) {
    try {
      // The package's exports leave out its CLI, so it is found next to the manifest, as its bin entry names it.
      const manifest = require.resolve(`${name}/package.json`);
      const bin = JSON.parse(fs.readFileSync(manifest, 'utf8')).bin?.[name];
      if (typeof bin === 'string') return path.join(path.dirname(manifest), bin);
    } catch {
      // Try the next.
    }
  }
  return null;
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

// A server must not outlive the daemon that started it.
const live = new Set<ChildProcess>();
let hooked = false;

/** What a start fills in as it goes, and a stop reads: the process once there is one. */
type Starting = { child?: ChildProcess; stopped?: boolean };
type Options = { cwd: string; writable: string[]; unreadable: string[]; tmp: string };

/** One server per job, for the turn it was asked for in. */
export class BrowserServers {
  private servers = new Map<string, Starting & { endpoint: Promise<string>; cwd: string }>();

  async start(id: string, options: Options): Promise<string> {
    // Codex's Windows sandbox lets Chromium start (checked 2026-11-16 with codex-cli 0.166), so only macOS needs this.
    if (process.platform !== 'darwin') throw new Error('Start the browser yourself, headless: on this system it starts inside your sandbox.');
    const running = this.servers.get(id);
    if (running && running.cwd === options.cwd && (!running.child || running.child.exitCode === null)) return running.endpoint;
    this.stop(id);
    const cli = playwrightCli(options.cwd);
    if (!cli) throw new Error(`No Playwright in ${options.cwd}. Install it there (npm i -D playwright), then ask again.`);
    // Kept from before the first wait, so a second call for the job shares this start and a stop reaches it.
    const starting: Starting = {};
    const server = Object.assign(starting, { endpoint: this.launch(starting, cli, options), cwd: options.cwd });
    this.servers.set(id, server);
    // A start that failed is forgotten, so the next call tries again.
    server.endpoint.catch(() => {
      if (this.servers.get(id) === server) this.servers.delete(id);
    });
    return server.endpoint;
  }

  private async launch(starting: Starting, cli: string, options: Options): Promise<string> {
    const port = await freePort();
    if (starting.stopped) throw new Error('The browser server was stopped while it started.');
    // The path is a secret, so another local process cannot drive the job's browser.
    const key = randomBytes(12).toString('hex');
    fs.mkdirSync(options.tmp, { recursive: true });
    const child = spawn('/usr/bin/sandbox-exec', ['-p', browserProfile(options.writable, options.unreadable), process.execPath, cli, 'run-server', '--host', '127.0.0.1', '--port', String(port), '--path', `/${key}`], {
      cwd: options.cwd,
      env: { ...process.env, TMPDIR: options.tmp },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    starting.child = child;
    live.add(child);
    child.on('exit', () => live.delete(child));
    if (!hooked) {
      hooked = true;
      process.on('exit', () => {
        for (const server of live) server.kill('SIGKILL');
      });
    }
    const endpoint = `ws://127.0.0.1:${port}/${key}`;
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => fail(new Error('The browser server did not start within 30 seconds.')), 30_000);
      const fail = (err: Error) => {
        clearTimeout(timer);
        child.kill();
        reject(new Error(`${err.message}${output.trim() ? `\n${clipEnd(output.trim(), 2000)}` : ''}`));
      };
      const read = (chunk: Buffer) => {
        output += chunk;
        if (output.includes('Listening on ')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout!.on('data', read);
      child.stderr!.on('data', read);
      child.on('error', fail);
      child.on('exit', (code) => fail(new Error(`The browser server exited (${code}).`)));
    });
    return endpoint;
  }

  stop(id: string): void {
    const server = this.servers.get(id);
    this.servers.delete(id);
    if (!server) return;
    server.stopped = true;
    const child = server.child;
    if (!child) return;
    child.kill();
    // The server waits on connected clients before it closes; a turn's end does not.
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 3000).unref();
  }

  stopAll(): void {
    for (const id of [...this.servers.keys()]) this.stop(id);
  }
}

/** The directories a job's processes may write: its tree, its scratch and evidence, and the temp roots Codex also opens. */
export const jobWritable = (dirs: (string | undefined | null)[]) =>
  [...dirs.filter((dir): dir is string => Boolean(dir)), os.tmpdir(), '/private/tmp'];
