import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { AntigravityAdapter } from './adapters/antigravity.ts';
import { CodexAdapter } from './adapters/codex.ts';
import { ClaudeSessions } from './claude.ts';
import { HOME, installed, loadConfig, PLUGIN_ROOT, PORT, VERSION } from './config.ts';
import { Jobs } from './jobs.ts';
import type { EventKind, Job } from './jobs.ts';

/**
 * The Crew daemon: one long-lived process that owns the worker agents, the
 * event log, and the status board. The MCP server Claude talks to is a thin
 * client of this process, so jobs survive Claude session restarts and several
 * sessions share one view.
 */

fs.mkdirSync(HOME, { recursive: true });
const config = loadConfig();
/** Fingerprint of the code this process loaded; clients compare it with what is on disk now. */
const BUILD = installed().build;
const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

const streams = new Set<http.ServerResponse>();
function broadcast(type: string, data: unknown): void {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams) res.write(frame);
}

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
const NOTIFY_TITLES: Partial<Record<EventKind, string>> = {
  waiting: 'needs a decision',
  error: 'failed',
  limit: 'hit its usage limit',
  stalled: 'may be stuck',
  done: 'finished',
};

function notify(agent: keyof typeof AGENT_NAMES, kind: EventKind, subject: string, detail: string): void {
  if (!config.notify || process.platform !== 'darwin') return;
  const quote = (s: string) => `"${s.replace(/[\\"]/g, '\\$&').slice(0, 200)}"`;
  const script = `display notification ${quote(detail)} with title ${quote(`${AGENT_NAMES[agent]} ${NOTIFY_TITLES[kind] ?? kind}`)} subtitle ${quote(subject)}`;
  execFile('osascript', ['-e', script], () => {});
}

/** Jobs as sent to clients: without the full prompt text. */
function view(job: Job) {
  const { prompt, instructions, ...rest } = job;
  return rest;
}

const codex = new CodexAdapter(config);
const antigravity = new AntigravityAdapter(config);
codex.onLimits = (limits) => broadcast('limits', { codex: limits });

const jobs = new Jobs(HOME, config, { codex, antigravity }, {
  onEvent: (event) => broadcast('event', event),
  onJob: (job) => broadcast('job', view(job)),
  onAttention: (job, kind, detail) => notify(job.agent, kind, job.title, detail),
});

const claude = new ClaudeSessions(config.stallSeconds, {
  onSession: (session, removed) => broadcast('claude', { session, removed: Boolean(removed) }),
  onEvent: (session, kind, detail) => jobs.record('claude', session.id, kind, detail),
  onAttention: (session, kind, detail) => notify('claude', kind, session.title, detail),
});

function state() {
  return {
    version: VERSION,
    now: Date.now(),
    stallSeconds: config.stallSeconds,
    jobs: jobs.list().map(view),
    claude: [...claude.sessions.values()],
    limits: { codex: codex.limits },
    agents: { antigravity: { enabled: config.antigravity.enabled } },
    events: jobs.recent.slice(-200),
  };
}

const STATIC: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/board.css': ['board.css', 'text/css; charset=utf-8'],
  '/board.js': ['board.js', 'text/javascript; charset=utf-8'],
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) reject(new HttpError(413, 'body too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * The daemon can start agents, so a web page must not be able to reach it.
 * Checking Host defeats DNS rebinding; checking Origin defeats cross-site
 * requests from pages open in the user's browser.
 */
function guard(req: http.IncomingMessage): void {
  const hosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!hosts.includes(req.headers.host ?? '')) throw new HttpError(403, 'forbidden host');
  const origin = req.headers.origin;
  if (origin && !hosts.some((h) => origin === `http://${h}`)) throw new HttpError(403, 'forbidden origin');
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown> {
  guard(req);
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const { pathname } = url;
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const asset = STATIC[pathname];
    if (asset) {
      res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-cache' });
      fs.createReadStream(path.join(PLUGIN_ROOT, 'board', asset[0])).pipe(res);
      return undefined;
    }
    if (pathname === '/api/health') return { name: 'crew', version: VERSION, build: BUILD, root: PLUGIN_ROOT, pid: process.pid, active: jobs.activeCount };
    if (pathname === '/api/state') return state();
    if (pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return undefined;
    }
  }

  const jobRoute = /^\/api\/jobs\/([\w-]+)(?:\/(\w+))?$/.exec(pathname);
  if (jobRoute) {
    const [, id, action] = jobRoute;
    if (method === 'GET' && !action) return jobs.get(id);
    if (method === 'GET' && action === 'wait') {
      const after = Number(url.searchParams.get('after') ?? 0);
      const timeout = Math.min(Number(url.searchParams.get('timeout') ?? 25), 55);
      await jobs.wait(id, after, timeout * 1000);
      return { job: view(jobs.get(id)), events: jobs.eventsFor(id, after) };
    }
    if (method === 'POST') {
      const body = await readJson(req);
      if (action === 'reply') return view(await jobs.reply(id, body));
      if (action === 'cancel') return view(await jobs.cancel(id));
      if (action === 'discard') return view(await jobs.discard(id));
      if (action === 'delivered') {
        return { claimed: jobs.markDelivered(id, Number(body.seq)) };
      }
    }
  }

  if (method === 'POST') {
    if (pathname === '/api/jobs') return view(await jobs.create(await readJson(req)));
    if (pathname === '/api/hooks/claude') {
      claude.ingest(await readJson(req));
      return {};
    }
    if (pathname === '/api/shutdown') {
      setImmediate(shutdown);
      return {};
    }
  }
  throw new HttpError(404, 'not found');
}

const server = http.createServer((req, res) => {
  route(req, res).then(
    (result) => {
      if (result === undefined) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    },
    (err) => {
      const status = err instanceof HttpError ? err.status : 400;
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    },
  );
});

function shutdown(): void {
  log('shutting down');
  codex.shutdown();
  antigravity.shutdown();
  jobs.flush();
  fs.rmSync(path.join(HOME, 'daemon.json'), { force: true });
  process.exit(0);
}

server.on('error', (err: NodeJS.ErrnoException) => {
  // Another daemon won the race for the port; the client will find it via /api/health.
  log(err.code === 'EADDRINUSE' ? `port ${PORT} is already in use` : `server error: ${err.message}`);
  process.exit(err.code === 'EADDRINUSE' ? 0 : 1);
});

server.listen(PORT, '127.0.0.1', () => {
  fs.writeFileSync(path.join(HOME, 'daemon.json'), JSON.stringify({ pid: process.pid, port: PORT, version: VERSION, build: BUILD, root: PLUGIN_ROOT }));
  log(`crew daemon ${VERSION} (${BUILD}) listening on http://127.0.0.1:${PORT}`);
});

// Keeps idle SSE connections from being dropped by intermediaries and detects dead ones.
setInterval(() => {
  for (const res of streams) res.write(': ping\n\n');
}, 25_000).unref();

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => log('uncaught exception:', err));
process.on('unhandledRejection', (err) => log('unhandled rejection:', err));
