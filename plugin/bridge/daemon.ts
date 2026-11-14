import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { boardAsset, BOARD_CSP } from './assets.ts';
import { ensureToken, sameToken, SESSION_COOKIE } from './auth.ts';
import { AntigravityAdapter } from './adapters/antigravity.ts';
import { CodexAdapter } from './adapters/codex.ts';
import { ClaudeSessions } from './claude.ts';
import type { ClaudeSession } from './claude.ts';
import { canonicalPath, HOME, installed, loadConfig, PLUGIN_ROOT, PORT, VERSION, WORKERS } from './config.ts';
import type { Config } from './config.ts';
import { projectRoot } from './git.ts';
import { isTerminal, Jobs } from './jobs.ts';
import { Missions, STAGES } from './missions.ts';
import type { Mission } from './missions.ts';
import { appendInstructions, instructionsFile, readInstructions, savePreset, saveRoles, writeInstructions } from './settings.ts';
import { agentGaugeDir, fromCodexLimits, route as routeWork, UsageMonitor } from './usage.ts';
import type { RouteKind } from './usage.ts';
import type { EventKind, Job } from './jobs.ts';

/**
 * The Crew daemon: one long-lived process that owns the worker agents, the
 * event log, and the status board. The MCP server Claude talks to is a thin
 * client of this process, so jobs survive Claude session restarts and several
 * sessions share one view.
 */

fs.mkdirSync(HOME, { recursive: true });
const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);
let mutatingPosts = 0;
/** Routes a worker's own MCP server calls; they are checked against the job's token, not the user's secret. */
const WORKER_ROUTE = /^\/api\/jobs\/[\w-]+\/(?:questions|siblings)$/;

const server = http.createServer((req, res) => {
  // Reserve before reading the body: idle replacement must not interrupt an unrecorded worktree.
  // Open and worker routes are left out, so an unauthenticated stalled body cannot hold off a replacement;
  // a request without the secret is rejected before route() first awaits, so it is counted only briefly.
  const pathname = req.url?.split('?')[0] ?? '/';
  const mutating = req.method === 'POST' && pathname !== '/api/shutdown' && !isOpen('POST', pathname) && !WORKER_ROUTE.test(pathname);
  if (mutating) mutatingPosts++;
  route(req, res).finally(() => { if (mutating) mutatingPosts--; }).then(
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

/**
 * Bind the port before reading or writing any state on disk. If two daemons start at once,
 * the loser exits before creating a token or deleting the winner's scratch directories and
 * review snapshots. Initialization below is synchronous, so no request is handled until setup finishes.
 */
server.on('error', (err: NodeJS.ErrnoException) => {
  // Another daemon won the race for the port; the client will find it via /api/health.
  log(err.code === 'EADDRINUSE' ? `port ${PORT} is already in use` : `server error: ${err.message}`);
  process.exit(err.code === 'EADDRINUSE' ? 0 : 1);
});
await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const config = loadConfig();
/** Fingerprint of the code this process loaded; clients compare it with what is on disk now. */
const BUILD = installed().build;

const streams = new Set<http.ServerResponse>();
function broadcast(type: string, data: unknown): void {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams) res.write(frame);
}

const AGENT_NAMES = { claude: 'Claude', codex: WORKERS.codex.name, antigravity: WORKERS.antigravity.name };
const NOTIFY_TITLES: Partial<Record<EventKind, string>> = {
  waiting: 'needs a decision',
  error: 'failed',
  limit: 'hit its usage limit',
  stalled: 'may be stuck',
  done: 'finished',
};

let desktopSeenAt = 0;
let desktopHandlesCompletion = false;

function notify(agent: keyof typeof AGENT_NAMES, kind: EventKind, subject: string, detail: string): void {
  if (!config.notify || process.platform !== 'darwin' || ((kind === 'waiting' || (kind === 'done' && desktopHandlesCompletion)) && Date.now() - desktopSeenAt < 15_000)) return;
  const quote = (s: string) => `"${s.replace(/[\\"]/g, '\\$&').slice(0, 200)}"`;
  const script = `display notification ${quote(detail)} with title ${quote(`${AGENT_NAMES[agent]} ${NOTIFY_TITLES[kind] ?? kind}`)} subtitle ${quote(subject)}`;
  execFile('osascript', ['-e', script], () => {});
}

/** Jobs as sent to clients: without the full prompt text. */
function view(job: Job) {
  const { prompt, instructions, ...rest } = job;
  return rest;
}

/** For display only: the config on disk, or the one the daemon started with while the file is invalid. */
function liveConfig(): Config {
  try {
    return loadConfig();
  } catch {
    return config;
  }
}

const codex = new CodexAdapter(config);
const antigravity = new AntigravityAdapter(config);

// Roles are read per job, so a change to config.json applies to the next one, and an invalid file fails
// that job with the reason instead of silently running old roles. Adapters keep the settings they started with.
/**
 * Missions are a view over the work, not the work itself: a file that cannot be read must not keep
 * the daemon, and with it every job, from starting. The file is set aside under a new name; if even
 * that fails, missions are kept in a scratch folder for this run so the original is never overwritten.
 */
function loadMissions(): Missions {
  const onChange = (mission: Mission) => broadcast('mission', mission);
  try {
    return new Missions(HOME, onChange);
  } catch (err) {
    const file = path.join(HOME, 'missions.json');
    const cause = (err as Error).message;
    try {
      const aside = `${file}.unreadable-${Date.now()}`;
      fs.renameSync(file, aside);
      log(`missions.json could not be used and was set aside as ${aside}; starting with no missions. Cause: ${cause}`);
      return new Missions(HOME, onChange);
    } catch (again) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-missions-'));
      log(`missions.json could not be used or set aside (${(again as Error).message}); missions for this run are kept in ${scratch} and the file is left as it is. Cause: ${cause}`);
      return new Missions(scratch, onChange);
    }
  }
}
const missions = loadMissions();

const usage = new UsageMonitor(agentGaugeDir(), (latest) => broadcast('usage', latest));
const usageModels = (live: Config) => ({ antigravity: live.roles.polish.agent === 'antigravity' ? live.roles.polish.model ?? live.antigravity.model : live.antigravity.model });
usage.setModels(usageModels(config));
usage.start().catch((err) => log('usage monitor could not start:', err));
codex.onLimits = (limits) => {
  broadcast('limits', { codex: limits });
  usage.supplement(fromCodexLimits(limits, Date.now()));
};

const jobs = new Jobs(HOME, loadConfig, { codex, antigravity }, {
  onEvent: (event) => {
    broadcast('event', event);
    // A mission is alive as long as its jobs are; the lead need not report in while it waits on them.
    const job = event.job_id ? jobs.jobs.get(event.job_id) : undefined;
    if (job?.mission) {
      missions.touch(job.mission);
      // Refresh the quiet timer before clients see the job end; routine activity stays silent.
      if (isTerminal(job)) {
        const mission = missions.list().find((mission) => mission.id === job.mission && mission.state === 'active');
        if (mission) broadcast('mission', mission);
      }
    }
    // AgentGauge may not read the agent again for half an hour; a job that just hit the limit is the fresher fact.
    if (event.kind === 'limit') usage.reportLimit(event.agent, event.detail);
  },
  onJob: (job) => broadcast('job', view(job)),
  onAttention: (job, kind, detail) => notify(job.agent, kind, job.title, detail),
  // A mission on the board lists its jobs; they stay as long as it does.
  keepsMission: (id) => missions.saved().some((mission) => mission.id === id),
});

// The board shows who holds each role and which preset is in effect, so it must hear about edits to the file.
fs.watchFile(path.join(HOME, 'config.json'), { interval: 2000 }, () => {
  const live = liveConfig();
  broadcast('roles', live.roles);
  broadcast('preset', { preset: live.preset, presets: live.presets });
  usage.setModels(usageModels(live));
});

const claude = new ClaudeSessions(config.stallSeconds, {
  onSession: (session, removed) => broadcast('claude', { session, removed: Boolean(removed) }),
  onEvent: (session, kind, detail) => jobs.record('claude', session.id, kind, detail),
  onAttention: (session, kind, detail) => notify('claude', kind, session.title, detail),
});

function state() {
  const live = liveConfig();
  return {
    version: VERSION,
    notifications: { enabled: config.notify, onDone: config.notifyOnDone },
    now: Date.now(),
    stallSeconds: config.stallSeconds,
    jobs: jobs.list().map(view),
    missions: missions.list(),
    claude: [...claude.sessions.values()],
    limits: { codex: codex.limits },
    agents: {
      codex: { ...WORKERS.codex, enabled: true },
      antigravity: { ...WORKERS.antigravity, enabled: live.antigravity.enabled },
    },
    roles: live.roles,
    usage: usage.current(),
    preset: live.preset,
    presets: live.presets,
    events: jobs.recent.slice(-200),
  };
}

/** Finds a new session's project once, so the board can group it with that project's jobs. */
function locate(session: ClaudeSession | undefined): void {
  if (!session || session.root !== undefined || !session.cwd) return;
  // Provisional until git answers; also the final value outside a repository or when git fails.
  session.root = canonicalPath(session.cwd);
  projectRoot(session.cwd).then((found) => {
    const root = found && canonicalPath(found);
    if (!root || root === session.root) return;
    session.root = root;
    if (claude.sessions.get(session.id) === session) broadcast('claude', { session, removed: false });
  }).catch(() => {});
}

/**
 * The instructions file for a project the board may edit, or the global one for no project.
 * Only projects the daemon already knows from a job or a session are accepted, so the board
 * cannot be made to write a `.crew` folder into an arbitrary directory.
 */
async function sharedFile(project: string | null): Promise<string> {
  if (!project) return instructionsFile(HOME, null);
  const known = [
    ...jobs.list().flatMap((job) => [job.project, job.root]),
    ...[...claude.sessions.values()].flatMap((s) => [s.cwd, s.root]),
    ...missions.list().flatMap((mission) => [mission.project, mission.root]),
  ];
  if (!known.includes(project)) throw new HttpError(400, 'unknown project');
  // The same lookup a job uses, so the board edits the file the agents are given.
  return instructionsFile(HOME, (await projectRoot(project)) ?? project);
}

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

const TOKEN = ensureToken(HOME);

/**
 * Host and Origin keep web pages out; they do not tell the user's own programs from any other local
 * process. The secret does: a header from programs that read the token file, a cookie from the board.
 */
function signedIn(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ') && sameToken(header.slice(7), TOKEN)) return true;
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE && sameToken(value.join('='), TOKEN)) return true;
  }
  return false;
}

/** What answers without the secret; docs/09-usage-presets-rounds.md section 12 says why for each. */
function isOpen(method: string, pathname: string): boolean {
  if (method === 'GET') return pathname === '/api/health' || !pathname.startsWith('/api/');
  if (method !== 'POST') return false;
  return pathname === '/api/hooks/claude' || pathname === '/api/session';
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown> {
  guard(req);
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const { pathname } = url;
  const method = req.method ?? 'GET';
  if (!isOpen(method, pathname) && !WORKER_ROUTE.test(pathname) && !signedIn(req)) throw new HttpError(401, 'unauthorized');
  // Reject mutations once shutdown is scheduled so new work is not dropped mid-flight.
  if (stopping && method === 'POST') throw new HttpError(503, 'The Crew daemon is shutting down. Try again in a moment.');

  if (method === 'POST' && pathname === '/api/session') {
    if (!sameToken((await readJson(req)).token, TOKEN)) throw new HttpError(401, 'unauthorized');
    // HttpOnly keeps it from page scripts, SameSite from other sites; it lasts as long as the token file does.
    res.setHeader('set-cookie', `${SESSION_COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    return {};
  }

  if (method === 'GET') {
    const asset = boardAsset(PLUGIN_ROOT, pathname);
    if (asset) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache', 'content-security-policy': BOARD_CSP, 'x-content-type-options': 'nosniff' });
      fs.createReadStream(asset.file).on('error', () => res.destroy()).pipe(res);
      return undefined;
    }
    if (pathname === '/') throw new HttpError(503, 'Board assets are missing. Run npm install and npm run build:board in the Crew folder.');
    const font = /^\/fonts\/([\w.-]+\.woff2)$/.exec(pathname);
    if (font) {
      // Optional fonts the user keeps beside the plugin; the board falls back to its own when they are absent.
      const file = path.join(PLUGIN_ROOT, '..', 'public', 'fonts', font[1]);
      if (!fs.existsSync(file)) throw new HttpError(404, 'not found');
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=86400' });
      fs.createReadStream(file).pipe(res);
      return undefined;
    }
    const icon = /^\/icons\/([\w.-]+\.svg)$/.exec(pathname);
    if (icon) {
      // Optional agent marks kept beside the plugin, like the fonts; without them the board shows names alone.
      const file = path.join(PLUGIN_ROOT, '..', 'public', 'icons', icon[1]);
      if (!fs.existsSync(file)) throw new HttpError(404, 'not found');
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' });
      fs.createReadStream(file).pipe(res);
      return undefined;
    }
    if (pathname === '/api/health') return { name: 'crew', version: VERSION, build: BUILD, root: PLUGIN_ROOT, pid: process.pid, active: jobs.activeCount + mutatingPosts };
    if (pathname === '/api/state') return state();
    if (pathname === '/api/instructions') {
      const file = await sharedFile(url.searchParams.get('project'));
      return { file, text: readInstructions(file) };
    }
    if (pathname === '/api/usage') return usage.current();
    if (pathname === '/api/route') {
      const kind = url.searchParams.get('kind');
      if (!['delegate', 'review', 'polish', 'lead'].includes(kind ?? '')) throw new HttpError(400, 'kind must be one of: delegate, review, polish, lead');
      // The config on disk, not the one for display: an invalid role table must fail the question as it would fail a job.
      return routeWork(kind as RouteKind, usage.current(), loadConfig().roles);
    }
    if (pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return undefined;
    }
  }

  const questionRoute = /^\/api\/jobs\/([\w-]+)\/questions(?:\/([\w-]+))?$/.exec(pathname);
  if (questionRoute) {
    const [, id, questionId] = questionRoute;
    if (method === 'POST') {
      const body = await readJson(req);
      if (questionId) return view(jobs.answer(id, questionId, body?.answer));
      if (!jobs.workerAuthorized(id, body?.token)) throw new HttpError(403, 'forbidden worker token');
      return jobs.ask(id, body.text, body.blocks);
    }
    if (method === 'GET' && !questionId) {
      if (!jobs.workerAuthorized(id, url.searchParams.get('token'))) throw new HttpError(403, 'forbidden worker token');
      return { questions: await jobs.leadAnswers(id, Number(url.searchParams.get('wait') ?? 0)) };
    }
  }
  const siblingsRoute = /^\/api\/jobs\/([\w-]+)\/siblings$/.exec(pathname);
  if (siblingsRoute && method === 'GET') {
    const id = siblingsRoute[1];
    if (!jobs.workerAuthorized(id, url.searchParams.get('token'))) throw new HttpError(403, 'forbidden worker token');
    return jobs.siblings(id);
  }

  const roundRoute = /^\/api\/jobs\/([\w-]+)\/rounds\/(\d+)$/.exec(pathname);
  if (roundRoute && method === 'POST') {
    const body = await readJson(req);
    if (Boolean(body.undo) === Boolean(body.keep)) throw new HttpError(400, 'pass undo or keep');
    return view(await jobs.round(roundRoute[1], Number(roundRoute[2]), body.undo ? 'undo' : 'keep'));
  }

  const jobRoute = /^\/api\/jobs\/([\w-]+)(?:\/(\w+))?$/.exec(pathname);
  if (jobRoute) {
    const [, id, action] = jobRoute;
    if (method === 'GET' && !action) return jobs.get(id);
    if (method === 'GET' && action === 'events') return jobs.eventsFor(id, 0);
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

  // Everything about a request is checked before anything is created or changed, so a refused request leaves nothing behind.
  const text = (value: unknown, name: string): string | undefined => {
    if (value !== undefined && typeof value !== 'string') throw new HttpError(400, `${name} must be a string`);
    return value;
  };
  const stage = (value: unknown): string | undefined => {
    if (value !== undefined && !(STAGES as readonly unknown[]).includes(value)) throw new HttpError(400, `stage must be one of: ${STAGES.join(', ')}`);
    return value as string | undefined;
  };

  const missionRoute = /^\/api\/missions\/([\w-]+)$/.exec(pathname);
  if (missionRoute && method === 'POST') {
    const body = await readJson(req);
    const id = missionRoute[1];
    if (body.done && body.abandoned) throw new HttpError(400, 'pass done or abandoned, not both');
    if (body.done || body.abandoned) return missions.finish(id, { outcome: text(body.outcome, 'outcome'), abandoned: Boolean(body.abandoned) });
    if (body.note !== undefined) return missions.note(id, text(body.note, 'note') ?? '');
    return missions.update(id, { stage: stage(body.stage), stages: body.stages, title: text(body.title, 'title') });
  }

  if (method === 'POST') {
    if (pathname === '/api/gc') {
      const body = await readJson(req);
      if (body.apply !== undefined && typeof body.apply !== 'boolean' || body.branches !== undefined && typeof body.branches !== 'boolean') {
        throw new HttpError(400, 'apply and branches must be booleans');
      }
      return { text: await jobs.gc(body) };
    }
    if (pathname === '/api/desktop/heartbeat') {
      const body = await readJson(req);
      if (body.leaving === true) {
        // The app is quitting, so notifications fall back to the daemon at once instead of after 15 s.
        desktopSeenAt = 0;
        desktopHandlesCompletion = false;
        return {};
      }
      desktopSeenAt = Date.now();
      desktopHandlesCompletion = body.handlesCompletion === true;
      const lease = { completionNotifications: desktopHandlesCompletion, from: desktopSeenAt, until: desktopSeenAt + 15_000 };
      // Order ownership before subsequent completion events, even if HTTP replies arrive late.
      broadcast('desktopLease', lease);
      return lease;
    }
    if (pathname === '/api/missions') {
      const body = await readJson(req);
      if (typeof body.project !== 'string' || !body.project) throw new HttpError(400, 'project must be the lead session\'s project directory');
      const first = stage(body.stage);
      return missions.start({ title: text(body.title, 'title') ?? '', project: body.project, root: (await projectRoot(body.project).catch(() => null)) ?? body.project, owner: text(body.owner, 'owner'), stage: first, stages: body.stages });
    }
    if (pathname === '/api/jobs') {
      const spec = await readJson(req);
      delete spec.missionStep;
      const mission = missions.list().find((m) => m.id === spec.mission);
      // A job outlives a wrong link: it still runs, on its own, and says why it is not shown with a mission.
      if (spec.mission !== undefined && mission?.state !== 'active') {
        spec.notes = [...(spec.notes ?? []), `Mission ${spec.mission} is not active, so this job is shown on its own.`];
        delete spec.mission;
      }
      if (mission?.state === 'active' && mission.stages) spec.missionStep = mission.stageIndex ?? mission.stages.indexOf(mission.stage);
      return view(await jobs.create(spec));
    }
    if (pathname === '/api/hooks/claude') {
      const payload = await readJson(req);
      claude.ingest(payload);
      locate(claude.sessions.get(payload?.session_id));
      return {};
    }
    if (pathname === '/api/roles') {
      const roles = saveRoles(HOME, (await readJson(req)).roles);
      broadcast('roles', roles);
      return roles;
    }
    if (pathname === '/api/instructions') {
      const body = await readJson(req);
      const appending = body.append !== undefined;
      if (typeof (appending ? body.append : body.text) !== 'string') throw new HttpError(400, `${appending ? 'append' : 'text'} must be a string`);
      if (appending && body.text !== undefined) throw new HttpError(400, 'pass text or append, not both');
      const file = await sharedFile(body.project ?? null);
      if (appending) appendInstructions(file, body.append);
      else writeInstructions(file, body.text);
      return { file, text: readInstructions(file) };
    }
    if (pathname === '/api/preset') {
      const saved = savePreset(HOME, (await readJson(req)).preset);
      broadcast('preset', saved);
      return saved;
    }
    if (pathname === '/api/shutdown') {
      // Re-check active jobs here in case work started after the client's health check.
      if ((await readJson(req)).ifIdle && (jobs.activeCount > 0 || mutatingPosts > 0)) throw new HttpError(409, `${jobs.activeCount} job(s) are active and ${mutatingPosts} mutating request(s) are in flight, so the daemon keeps running.`);
      stopping = true;
      setImmediate(shutdown);
      return {};
    }
  }
  throw new HttpError(404, 'not found');
}

let stopping = false;

function shutdown(): void {
  log('shutting down');
  codex.shutdown();
  antigravity.shutdown();
  usage.stop();
  jobs.flush();
  missions.flush();
  fs.rmSync(path.join(HOME, 'daemon.json'), { force: true });
  process.exit(0);
}

fs.writeFileSync(path.join(HOME, 'daemon.json'), JSON.stringify({ pid: process.pid, port: PORT, version: VERSION, build: BUILD, root: PLUGIN_ROOT }));
log(`crew daemon ${VERSION} (${BUILD}) listening on http://127.0.0.1:${PORT}`);

// Keeps idle SSE connections from being dropped by intermediaries and detects dead ones.
setInterval(() => {
  for (const res of streams) res.write(': ping\n\n');
}, 25_000).unref();

// A mission whose lead session is gone would stay open forever; one with a job still running is not stale.
setInterval(() => {
  missions.sweep(Date.now(), (id) => jobs.list().some((job) => job.mission === id && !isTerminal(job)));
}, 10 * 60_000).unref();

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', (err) => log('uncaught exception:', err));
process.on('unhandledRejection', (err) => log('unhandled rejection:', err));
