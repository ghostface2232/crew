import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { boardAsset, BOARD_CSP } from './assets.ts';
import { boardCredential, boardExpiry, ensureToken, evidenceSeal, sameToken, SESSION_COOKIE } from './auth.ts';
import { AntigravityAdapter } from './adapters/antigravity.ts';
import { CodexAdapter } from './adapters/codex.ts';
import { ClaudeSessions } from './claude.ts';
import type { ClaudeSession } from './claude.ts';
import { canonicalPath, HOME, installed, isRole, loadConfig, PLUGIN_ROOT, PORTS, ROLE_INFO, ROLES, VERSION, WORKERS } from './config.ts';
import type { Config } from './config.ts';
import { evidenceType, openEvidence } from './evidence.ts';
import { projectRoot } from './git.ts';
import { followUps, isTerminal, Jobs } from './jobs.ts';
import { missionPreset, Missions } from './missions.ts';
import type { Mission } from './missions.ts';
import { addEvidence, addRating, loadNotes, notesFile, renderNotes, scoreAll, setSummary, WORKER_ITEMS } from './notes.ts';
import type { NotesFile } from './notes.ts';
import { outcomeContradiction } from './render.ts';
import { runbook } from './runbook.ts';
import { checks as setupChecks, PACKAGED, prunePlugins, register, registered, registrationMoved } from './setup.ts';
import type { Registration, SetupItem } from './setup.ts';
import { toastCommand } from './toast.ts';
import { ANTIGRAVITY_MODELS, codexModels } from './tiers.ts';
import { appendInstructions, instructionsFile, readInstructions, savePeerRatings, savePreset, saveRoles, writeInstructions } from './settings.ts';
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
const WORKER_ROUTE = /^\/api\/jobs\/[\w-]+\/(?:questions|siblings|browser|rating)$/;

const server = http.createServer((req, res) => {
  // A browser that signed in while a cookie carried the secret still sends it to every port on this host. It is no longer read.
  if (req.headers.cookie?.includes(`${SESSION_COOKIE}=`)) res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
  // Reserve before reading the body: idle replacement must not interrupt an unrecorded worktree.
  // Open and worker routes are left out, so an unauthenticated stalled body cannot hold off a replacement;
  // a request without the secret is rejected before route() first awaits, so it is counted only briefly.
  // Lead delivery commits synchronously after checking stopping; its long polls must not pin an idle daemon.
  // Parsed as route() parses it, so a path with dot segments is counted as the route it reaches.
  const pathname = URL.canParse(req.url ?? '/', 'http://127.0.0.1') ? new URL(req.url ?? '/', 'http://127.0.0.1').pathname : '/';
  const mutating = req.method === 'POST' && pathname !== '/api/shutdown' && !pathname.startsWith('/api/lead/') && !isOpen('POST', pathname) && !WORKER_ROUTE.test(pathname);
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

/** Whether something accepts connections on the port, as opposed to the system holding it with nothing behind it. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/** The port of a daemon that is running for this Crew home, as it recorded it. */
async function recorded(): Promise<{ pid: number; port: number } | null> {
  try {
    const { pid, port } = JSON.parse(fs.readFileSync(path.join(HOME, 'daemon.json'), 'utf8'));
    process.kill(pid, 0);
    return await listening(port) ? { pid, port } : null;
  } catch {
    return null;
  }
}

/**
 * Bind a port before writing any state on disk. If two daemons start at once, both try the same ports in the same
 * order, so the loser finds the winner listening and exits before creating a token or deleting the winner's scratch
 * directories and review snapshots. A port the system reserves has no listener, so it is skipped. Reservations move,
 * so a daemon on a fallback port does not hold the ports before it: a later daemon checks the record first.
 */
async function bind(): Promise<number> {
  const running = await recorded();
  if (running) {
    log(`port ${running.port} is already in use by the running daemon (process ${running.pid})`);
    process.exit(0);
  }
  for (const port of PORTS) {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      server.once('error', resolve);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', resolve);
        resolve(null);
      });
    });
    if (!err) return port;
    if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') {
      log(`server error: ${err.message}`);
      process.exit(1);
    }
    // Another daemon won the race for the port; the client will find it via /api/health.
    if (await listening(port)) {
      log(`port ${port} is already in use`);
      process.exit(0);
    }
    log(`port ${port} is reserved by the system with nothing listening on it`);
  }
  log(`no port Crew can use is free: ${PORTS.join(', ')}`);
  process.exit(1);
}
const PORT = await bind();
server.on('error', (err) => {
  log(`server error: ${err.message}`);
  process.exit(1);
});
// Only the daemon that holds the port makes the secret, or replaces one made before tickets; see ensureToken.
const TOKEN = ensureToken(HOME);
// Initialization below is synchronous, so no request is handled until setup finishes.

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
  if (!config.notify || (process.platform !== 'darwin' && process.platform !== 'win32') || ((kind === 'waiting' || (kind === 'done' && desktopHandlesCompletion)) && Date.now() - desktopSeenAt < 15_000)) return;
  const title = `${AGENT_NAMES[agent]} ${NOTIFY_TITLES[kind] ?? kind}`;
  if (process.platform === 'win32') {
    const toast = toastCommand(title, subject, detail);
    execFile(toast.bin, toast.args, { env: toast.env, windowsHide: true }, () => {});
    return;
  }
  const quote = (s: string) => `"${s.replace(/[\\"]/g, '\\$&').slice(0, 200)}"`;
  const script = `display notification ${quote(detail)} with title ${quote(title)} subtitle ${quote(subject)}`;
  execFile('osascript', ['-e', script], () => {});
}

/** A job's evidence with the seal that lets a board page load each file; see evidenceSeal. */
function sealed(job: Job) {
  return job.evidence ? { evidence: job.evidence.map((item) => ({ ...item, sig: evidenceSeal(TOKEN, job.id, item.file, item.modified) })) } : {};
}

/** Jobs as sent to clients: without the full prompt text. */
function view(job: Job) {
  const { prompt, instructions, ...rest } = job;
  return { ...rest, ...sealed(job), outcomeContradiction: outcomeContradiction(job) };
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
const usageModels = (live: Config) => ({ antigravity: live.roles.polish.antigravity?.model ?? live.antigravity.model });
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
  userPrompts: (session) => claude.recentPrompts(session),
});

// The board shows who holds each role and which preset is in effect, so it must hear about edits to the file.
fs.watchFile(path.join(HOME, 'config.json'), { interval: 2000 }, () => {
  const live = liveConfig();
  broadcast('roles', live.roles);
  broadcast('roleSettings', live.roleSettings);
  broadcast('preset', { preset: live.preset, presets: live.presets });
  // Turning peer ratings off or on changes what the scores are made of.
  broadcast('peerRatings', live.peerRatings);
  broadcast('modelScores', modelScores());
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
      codex: { ...WORKERS.codex, enabled: true, models: codexModels() },
      antigravity: { ...WORKERS.antigravity, enabled: live.antigravity.enabled, models: ANTIGRAVITY_MODELS },
    },
    roles: live.roles,
    roleSettings: live.roleSettings,
    roleInfo: ROLE_INFO,
    usage: usage.current(),
    preset: live.preset,
    presets: live.presets,
    peerRatings: live.peerRatings,
    modelScores: modelScores(),
    events: jobs.recent.slice(-200),
  };
}

/**
 * The model notes. A file that cannot be read is set aside, as missions.json is, so the board still shows scores and
 * the lead can keep noting; if it cannot even be moved, the error stands and noting fails with it.
 */
function readNotes(): NotesFile {
  try {
    return loadNotes(HOME);
  } catch (err) {
    const aside = `${notesFile(HOME)}.unreadable-${Date.now()}`;
    fs.renameSync(notesFile(HOME), aside);
    log(`model-notes.json could not be used and was set aside as ${aside}; starting with no notes. Cause: ${(err as Error).message}`);
    return loadNotes(HOME);
  }
}

function modelScores() {
  try {
    return scoreAll(readNotes(), { ratings: liveConfig().peerRatings });
  } catch {
    return [];
  }
}

/** Models the lead is shown at most per answer: the most recently noted, so the answer stays short as models come and go. */
const NOTES_SHOWN = 3;

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
  if (bodies.has(req)) return Promise.resolve(bodies.get(req));
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let overflow = false;
    // One decoder for the whole body: a character split across two chunks would otherwise be lost.
    const decoder = new StringDecoder('utf8');
    req.on('data', (chunk) => {
      if (overflow) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4 * 1024 * 1024) {
        overflow = true;
        body = '';
        reject(new HttpError(413, 'body too large'));
        return;
      }
      body += decoder.write(chunk);
    });
    req.on('end', () => {
      if (overflow) return;
      try {
        body += decoder.end();
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

/**
 * Host and Origin keep web pages out; they do not tell the user's own programs from any other local process. The
 * secret does. A program that can read the token file sends the secret itself. A board page cannot be handed it,
 * since whatever a browser keeps is on disk where a worker can read it, so it sends a credential that it holds in
 * memory, bought with a ticket. The answer says when a board's credential lapses; the user's own program has no such limit.
 */
function signedIn(req: http.IncomingMessage): { board?: number } | null {
  const header = req.headers.authorization;
  const given = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (sameToken(given, TOKEN)) return {};
  const board = boardExpiry(given, TOKEN);
  return board ? { board } : null;
}

/** What answers without the secret; docs/09-usage-presets-rounds.md section 12 says why for each. */
function isOpen(method: string, pathname: string): boolean {
  if (method === 'GET') return pathname === '/api/health' || !pathname.startsWith('/api/');
  if (method !== 'POST') return false;
  return pathname === '/api/session';
}

/** Sign-in tickets not yet used, each with when it lapses. They live in memory, so a restart drops them. */
const tickets = new Map<string, number>();
const TICKET_MS = 60_000;

/**
 * What a board credential may change: the requests the board's pages send. Any other change needs the secret, so a
 * route added for the lead or the CLI is not the board's until it is listed here.
 */
const BOARD_POSTS = [
  /^\/api\/jobs$/,
  /^\/api\/jobs\/[\w-]+\/(?:reply|cancel|rounds\/\d+)$/,
  /^\/api\/missions\/[\w-]+$/,
  /^\/api\/(?:instructions|setup\/repair|peer-ratings|preset|roles)$/,
];
/**
 * Parts of those requests that only the lead sends: they speak for the user or the lead, or have the daemon read a
 * file or run a command. Unlike the routes, a field is the board's unless it is listed here.
 */
const LEAD_FIELDS = ['approved_by_user', 'lead_session', 'lead', 'by', 'check', 'attachments'];
/** A body read to check it before its route runs, kept for the route to read again. */
const bodies = new WeakMap<http.IncomingMessage, unknown>();

const EVIDENCE_ROUTE = /^\/api\/jobs\/([\w-]+)\/evidence\/([^/]+)$/;
/** Whether the request is for one recorded file and carries that file's seal; see evidenceSeal. */
function sealedEvidence(method: string, url: URL): boolean {
  const match = EVIDENCE_ROUTE.exec(url.pathname);
  if (method !== 'GET' || !match) return false;
  let file: string;
  try {
    file = decodeURIComponent(match[2]);
  } catch {
    // A name that does not decode is refused like any other, not answered with an error that says the job exists.
    return false;
  }
  const item = jobs.list().find((job) => job.id === match[1])?.evidence?.find((entry) => entry.file === file);
  return Boolean(item) && sameToken(url.searchParams.get('sig'), evidenceSeal(TOKEN, match[1], item!.file, item!.modified));
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown> {
  guard(req);
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const { pathname } = url;
  const method = req.method ?? 'GET';
  const open = isOpen(method, pathname) || WORKER_ROUTE.test(pathname);
  const who = open ? null : signedIn(req);
  if (!open && !who && !sealedEvidence(method, url)) throw new HttpError(401, 'unauthorized');
  // Reject mutations once shutdown is scheduled so new work is not dropped mid-flight.
  if (stopping && method === 'POST') throw new HttpError(503, 'The Crew daemon is shutting down. Try again in a moment.');
  if (who?.board && method === 'POST') {
    if (!BOARD_POSTS.some((allowed) => allowed.test(pathname))) throw new HttpError(403, 'The board may not do this.');
    const body = await readJson(req);
    if (LEAD_FIELDS.some((field) => body?.[field] !== undefined)) throw new HttpError(403, 'The board may not send this.');
    bodies.set(req, body);
  }

  if (method === 'POST' && pathname === '/api/session/ticket') {
    for (const [ticket, lapses] of tickets) if (lapses <= Date.now()) tickets.delete(ticket);
    const ticket = randomBytes(32).toString('hex');
    tickets.set(ticket, Date.now() + TICKET_MS);
    res.setHeader('cache-control', 'no-store');
    return { ticket };
  }
  if (method === 'POST' && pathname === '/api/session') {
    const { ticket } = await readJson(req);
    // Looked up and removed in one step, so of two pages sending the same ticket only one is signed in.
    const lapses = typeof ticket === 'string' ? tickets.get(ticket) : undefined;
    tickets.delete(ticket);
    if (!lapses || lapses <= Date.now()) throw new HttpError(401, 'unauthorized');
    res.setHeader('cache-control', 'no-store');
    return boardCredential(TOKEN);
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
    if (pathname === '/api/setup') return setupState(url.searchParams.has('refresh'));
    if (pathname === '/api/route') {
      const kind = url.searchParams.get('kind');
      if (kind !== 'lead' && !isRole(kind)) throw new HttpError(400, `kind must be one of: ${ROLES.join(', ')}, lead`);
      // The config on disk, not the one for display: an invalid role table must fail the question as it would fail a job.
      const live = loadConfig();
      const id = url.searchParams.get('mission');
      const mission = id ? missions.list().find((m) => m.id === id) : undefined;
      if (id && !mission) throw new HttpError(400, `No mission with id "${id}" is known any more.`);
      // The preset the next job would run under, so the lead can pick its own subagents' models to match.
      const preset = missionPreset(mission, live.preset);
      return { ...routeWork(kind as RouteKind, usage.current(), live.roles, live.antigravity.enabled ? [] : ['antigravity']), preset, policy: preset ? live.presets[preset] : null };
    }
    if (pathname === '/api/notes') {
      // The lead's view of the notes, for route and delegate: the named agents' models, or every model.
      const agents = url.searchParams.get('agents')?.split(',').filter(Boolean);
      const evidence = Number(url.searchParams.get('evidence') ?? 5);
      const file = readNotes();
      const scores = scoreAll(file, { ratings: liveConfig().peerRatings });
      const models = scores.filter((s) => !agents || agents.includes(s.agent)).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)).slice(0, NOTES_SHOWN).map((s) => s.model);
      return { scores, text: renderNotes(scores, file, { models, evidence: Number.isInteger(evidence) && evidence >= 0 ? evidence : 5 }) };
    }
    if (pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
      streams.add(res);
      // A stream outlives the check made when it opened, so a board's is ended when its credential lapses.
      const lapse = who?.board ? setTimeout(() => {
        streams.delete(res);
        res.end();
      }, who.board - Date.now()).unref() : undefined;
      req.on('close', () => {
        streams.delete(res);
        clearTimeout(lapse);
      });
      return undefined;
    }
  }

  const questionRoute = /^\/api\/jobs\/([\w-]+)\/questions(?:\/([\w-]+))?$/.exec(pathname);
  if (questionRoute) {
    const [, id, questionId] = questionRoute;
    if (method === 'POST') {
      const body = await readJson(req);
      if (questionId) return view(jobs.answer(id, questionId, body?.answer, body?.attachments));
      if (!jobs.workerAuthorized(id, body?.token)) throw new HttpError(403, 'forbidden worker token');
      return jobs.ask(id, body.text, body.blocks, body.attachments);
    }
    if (method === 'GET' && !questionId) {
      if (!jobs.workerAuthorized(id, url.searchParams.get('token'))) throw new HttpError(403, 'forbidden worker token');
      return { questions: await jobs.leadAnswers(id, Number(url.searchParams.get('wait') ?? 0)) };
    }
  }
  const browserRoute = /^\/api\/jobs\/([\w-]+)\/browser$/.exec(pathname);
  if (browserRoute && method === 'POST') {
    const body = await readJson(req);
    if (!jobs.workerAuthorized(browserRoute[1], body?.token)) throw new HttpError(403, 'forbidden worker token');
    return jobs.browser(browserRoute[1]);
  }
  const ratingRoute = /^\/api\/jobs\/([\w-]+)\/rating$/.exec(pathname);
  if (ratingRoute && method === 'POST') {
    const body = await readJson(req);
    const id = ratingRoute[1];
    if (!jobs.workerAuthorized(id, body?.token)) throw new HttpError(403, 'forbidden worker token');
    const job = jobs.get(id);
    // Only a job that was asked to rate saw another's work: a reviewer the change, an engineer the review it got back.
    if (!job.rates || job.kind === 'polish') throw new HttpError(400, 'This job was not asked to rate. Carry on without rating.');
    if (!liveConfig().peerRatings) throw new HttpError(400, 'Ratings were turned off after this job started. Carry on without rating.');
    if (job.kind === 'review' && body?.correctness === undefined) throw new HttpError(400, 'A review rates correctness. Pass correctness from 1 to 5.');
    readNotes();
    // Everything sent but the token and the fact is an item, so one this job may not rate is refused, not ignored.
    const { token: _token, fact: _fact, ...sent } = body;
    const rating = addRating(HOME, { by: job.agent, byModel: job.resolvedModel ?? (job.agent === 'codex' ? job.model : undefined), byJob: job.id, items: sent, fact: body.fact }, WORKER_ITEMS[job.kind]);
    broadcast('modelScores', modelScores());
    return { kept: rating.items };
  }
  const siblingsRoute = /^\/api\/jobs\/([\w-]+)\/siblings$/.exec(pathname);
  if (siblingsRoute && method === 'GET') {
    const id = siblingsRoute[1];
    if (!jobs.workerAuthorized(id, url.searchParams.get('token'))) throw new HttpError(403, 'forbidden worker token');
    return jobs.siblings(id);
  }

  const evidenceRoute = EVIDENCE_ROUTE.exec(pathname);
  if (evidenceRoute && method === 'GET') {
    // Only files the job recorded are served, never a path taken from the request.
    const item = jobs.get(evidenceRoute[1]).evidence?.find((entry) => entry.file === decodeURIComponent(evidenceRoute[2]));
    const type = item && evidenceType(item.file);
    const opened = item && type ? openEvidence(item) : null;
    if (!opened) throw new HttpError(404, 'not found');
    // One byte range, which Safari asks for before it plays a video.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = opened.size - 1;
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, opened.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
      if (start > end) {
        fs.closeSync(opened.fd);
        res.writeHead(416, { 'content-range': `bytes */${opened.size}` });
        res.end();
        return undefined;
      }
    }
    const partial = Boolean(range && (range[1] || range[2]));
    res.writeHead(partial ? 206 : 200, {
      'content-type': type!,
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      ...(partial ? { 'content-range': `bytes ${start}-${end}/${opened.size}` } : {}),
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=3600',
    });
    if (end < start) {
      // An empty file: a stream cannot cover no bytes.
      fs.closeSync(opened.fd);
      res.end();
      return undefined;
    }
    // The descriptor was opened without following links, so a file swapped for one after it was recorded is not read.
    fs.createReadStream('', { fd: opened.fd, start, end }).on('error', () => res.destroy()).pipe(res);
    return undefined;
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
    if (method === 'GET' && !action) return { ...jobs.get(id), ...sealed(jobs.get(id)) };
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
      if (action === 'delivered') throw new HttpError(400, 'Delivery requires a receipt echoed through /api/lead/ack.');
    }
  }

  // Everything about a request is checked before anything is created or changed, so a refused request leaves nothing behind.
  const text = (value: unknown, name: string): string | undefined => {
    if (value !== undefined && typeof value !== 'string') throw new HttpError(400, `${name} must be a string`);
    return value;
  };
  // Missions checks the stage itself, since it may carry a name for its stop.
  const stage = (value: unknown): string | undefined => text(value, 'stage');

  const runbookRoute = /^\/api\/missions\/([\w-]+)\/runbook$/.exec(pathname);
  if (runbookRoute && method === 'GET') {
    const mission = missions.list().find((m) => m.id === runbookRoute[1]);
    if (!mission) throw new HttpError(404, `No mission with id "${runbookRoute[1]}".`);
    return { text: runbook(mission, jobs.list()) };
  }

  const missionRoute = /^\/api\/missions\/([\w-]+)$/.exec(pathname);
  if (missionRoute && method === 'POST') {
    const body = await readJson(req);
    const id = missionRoute[1];
    if (body.done && body.abandoned) throw new HttpError(400, 'pass done or abandoned, not both');
    if (body.done || body.abandoned) return missions.finish(id, { outcome: text(body.outcome, 'outcome'), record: text(body.record, 'record'), abandoned: Boolean(body.abandoned), reopen: body.reopen === true, byLead: body.by === 'lead' });
    if (body.note !== undefined) return missions.note(id, text(body.note, 'note') ?? '');
    return missions.update(id, { stage: stage(body.stage), stages: body.stages, title: text(body.title, 'title'), preset: body.preset });
  }

  if (method === 'POST') {
    if (pathname === '/api/setup/repair') {
      await registerPlugin();
      return setupState(true);
    }
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
      return missions.start({ title: text(body.title, 'title') ?? '', project: body.project, root: (await projectRoot(body.project).catch(() => null)) ?? body.project, owner: text(body.owner, 'owner'), stage: first, stages: body.stages, preset: body.preset });
    }
    if (pathname === '/api/jobs') {
      const spec = await readJson(req);
      delete spec.missionStep;
      const mission = missions.list().find((m) => m.id === spec.mission);
      // The mission's preset is a cost the user chose; running on the global one instead would quietly change it.
      if (spec.mission == null) delete spec.mission;
      if (spec.mission !== undefined && !mission) throw new HttpError(400, `No mission with id "${spec.mission}" is known any more, so its preset cannot be applied. Start the job without it, or open a new mission.`);
      spec.preset = missionPreset(mission, liveConfig().preset);
      // A job outlives its mission's tracking: it still runs under the mission's preset, on its own, and says why.
      if (mission && mission.state !== 'active') {
        spec.notes = [...(spec.notes ?? []), `Mission ${spec.mission} is ${mission.state}, so this job is shown on its own.`];
        delete spec.mission;
      }
      if (mission?.state === 'active' && mission.stages) spec.missionStep = mission.stageIndex ?? mission.stages.indexOf(mission.stage);
      return view(await jobs.create(spec));
    }
    if (pathname.startsWith('/api/lead/')) {
      const body = await readJson(req);
      if (stopping) throw new HttpError(503, 'The Crew daemon is shutting down. Try again in a moment.');
      const session = body.session;
      if (typeof session !== 'string' || !session.trim() || session.length > 200) throw new HttpError(400, 'A lead session id is required.');
      const delivery = jobs.delivery;
      switch (pathname.slice('/api/lead/'.length)) {
        case 'ack': {
          const ignored = delivery.ack(session, body.ack);
          for (const job of jobs.list().filter((job) => job.lead === session)) broadcast('job', view(job));
          return { ignored };
        }
        case 'adopt': {
          const adopted = delivery.adopt(session, body.job_ids);
          for (const id of adopted) broadcast('job', view(jobs.get(id)));
          return { adopted };
        }
        // The reminder speaks of "this message", so only a prompt from the user carries it, not a session start or compaction.
        case 'context': return { text: [delivery.context(session), body.event === 'UserPromptSubmit' ? missions.followUpHint(session) : ''].filter(Boolean).join('\n') };
        case 'watch': return { watch: delivery.watch(session, body.deadline) };
        case 'heartbeat': return { watch: delivery.heartbeat(session, body.generation) };
        case 'release':
          delivery.release(session, body.generation);
          return {};
        case 'offer': {
          if (body.automatic !== undefined && typeof body.automatic !== 'boolean') throw new HttpError(400, 'automatic must be boolean');
          const options = { automatic: body.automatic === true, watcher: body.generation, ids: body.job_ids, bytes: body.bytes };
          let offer = delivery.offer(session, options);
          if (!offer && body.wait === true) {
            const abort = new AbortController();
            const closed = () => abort.abort();
            res.once('close', closed);
            try {
              // Check and subscribe without an intervening await. Lease expiry also wakes an idle poll.
              const expiry = delivery.state.offering[session]?.expiresAt ?? 0;
              await delivery.wait(expiry > Date.now() ? Math.min(20_000, expiry - Date.now()) : 20_000, abort.signal);
              if (stopping) throw new HttpError(503, 'The Crew daemon is shutting down. Try again in a moment.');
              if (!abort.signal.aborted) offer = delivery.offer(session, options);
              else if (typeof options.watcher === 'string') delivery.disconnected(session, options.watcher);
            } finally {
              res.off('close', closed);
            }
          }
          return { offer };
        }
        default: throw new HttpError(404, 'not found');
      }
    }
    if (pathname === '/api/hooks/claude') {
      const payload = await readJson(req);
      claude.ingest(payload);
      locate(claude.sessions.get(payload?.session_id));
      return {};
    }
    if (pathname === '/api/roles') {
      const saved = saveRoles(HOME, (await readJson(req)).roles);
      broadcast('roles', saved.roles);
      broadcast('roleSettings', saved.roleSettings);
      return saved;
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
    if (pathname === '/api/notes') {
      const body = await readJson(req);
      let score;
      readNotes();
      if (body.summary !== undefined) {
        if (typeof body.model !== 'string' || !body.model) throw new HttpError(400, 'A summary needs the model it is about.');
        if (typeof body.summary !== 'string') throw new HttpError(400, 'summary must be text.');
        score = setSummary(HOME, body.model, body.summary, undefined, { ratings: liveConfig().peerRatings });
      } else {
        // A job's own record says which model did the work; the lead names it only for work done in its session.
        const job = typeof body.job === 'string' && body.job ? jobs.get(body.job) : undefined;
        const role = body.role ?? (job?.kind === 'review' && job.role !== 'debate' ? 'review' : job?.role === 'fix' ? 'fix' : 'build');
        // A debater built and reviewed nothing. A reviewer's job is judged as a review, never as the work it read.
        if (job?.role === 'debate') throw new HttpError(400, `Job ${job.id} is a debate, which builds nothing to judge.`);
        if (job && (job.kind === 'review') !== (role === 'review')) {
          throw new HttpError(400, job.kind === 'review'
            ? `Job ${job.id} is a review, which builds nothing: note it with role review, or note the job whose work it reviewed and name its agent as the reviewer.`
            : `Job ${job.id} is not a review. Give the review's own job_id with role review, and this job as of_job.`);
        }
        // The work a review covered: a worker's job names its own model, as a noted job does.
        const built = typeof body.of_job === 'string' && body.of_job ? jobs.get(body.of_job) : undefined;
        if (built && (built.kind === 'review' || built.role === 'debate')) throw new HttpError(400, `Job ${built.id} is a ${built.role ?? built.kind}, which built nothing a review could cover.`);
        const builtModel = built ? built.resolvedModel ?? (built.agent === 'codex' ? built.model : undefined) : body.of_model;
        if (built && !builtModel) throw new HttpError(400, `Job ${built.id} has no recorded model, so a review of it cannot be noted.`);
        const peerRatings = liveConfig().peerRatings;
        // Antigravity's configured model is a family name; only the model the session reported names one model.
        const model = job ? job.resolvedModel ?? (job.agent === 'codex' ? job.model : undefined) : body.model;
        if (job && !model) throw new HttpError(400, `Job ${job.id} has no recorded model, so it cannot be noted.`);
        if (job && body.model !== undefined && body.model !== model) throw new HttpError(400, `Job ${job.id} ran on ${model}, not ${String(body.model)}.`);
        score = addEvidence(HOME, {
          model,
          agent: job ? job.agent : 'claude',
          ...(job ? (job.resolvedEffort ?? job.effort ? { effort: job.resolvedEffort ?? job.effort } : {}) : {}),
          // A job's tier is its own record's. It is kept to show what work a model was given, not scored.
          ...((job ? job.tier : body.tier) ? { tier: job ? job.tier : body.tier } : {}),
          size: body.size,
          role,
          ...(job ? { job: job.id } : {}),
          // A review line is about the reviewer itself; its job says who that was.
          reviewer: role === 'review' && job ? job.agent : body.reviewer,
          ...(role === 'review' || body.of_job !== undefined || body.of_model !== undefined ? { of: { ...(built ? { job: built.id } : {}), model: builtModel, ...(built?.role === 'fix' ? { fix: true as const } : {}) } } : {}),
          // Off, a rating is not kept: the lead is told so, and the line stands without it.
          ...(body.rating !== undefined && peerRatings ? { rating: body.rating } : {}),
          findings: body.findings ?? {},
          ...(body.declined !== undefined ? { declined: body.declined } : {}),
          ...(body.outcome !== undefined ? { outcome: body.outcome } : {}),
          // The follow-up turns come from the job's own record, so the lead names only how it took the work.
          ...(body.adoption !== undefined ? { adoption: body.adoption, ...(job ? { rounds: followUps(job) } : {}) } : {}),
          text: body.text,
        }, { ratings: peerRatings }).score;
        if (body.rating !== undefined && !peerRatings) score = { ...score, ratingDropped: true };
      }
      broadcast('modelScores', modelScores());
      return score;
    }
    if (pathname === '/api/peer-ratings') {
      const saved = savePeerRatings(HOME, (await readJson(req)).enabled);
      broadcast('peerRatings', saved.peerRatings);
      broadcast('modelScores', modelScores());
      return saved;
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

// The setup checklist: what Crew needs, checked by running each CLI, so it is cached for a minute.
let registering: Promise<Registration> | null = null;
let registration: Registration | undefined;
let setupChecked: Promise<SetupItem[]> | null = null;
let setupCheckedAt = 0;
function registerPlugin(): Promise<Registration> {
  registering ??= register()
    .catch((err: Error): Registration => ({ ok: false, detail: err.message }))
    .then((result) => {
      registration = result;
      log(`plugin registration: ${result.detail}`);
      return result;
    })
    .finally(() => {
      registering = null;
      setupChecked = null;
    });
  return registering;
}
async function setupState(refresh: boolean): Promise<{ items: SetupItem[]; packaged: boolean; registering: boolean; registration?: Registration }> {
  if (refresh || !setupChecked || Date.now() - setupCheckedAt > 60_000) {
    setupCheckedAt = Date.now();
    setupChecked = (registering ?? Promise.resolve()).then(() => setupChecks());
  }
  const items = await setupChecked;
  return { items, packaged: PACKAGED, registering: registering !== null, registration };
}
// An app's copy registers itself on first launch and after each update, so its plugin matches its daemon. Copies that
// sessions were still running at the last registration are removed once they have closed, and a registration that
// another Claude Code process has undone is made again, checked after startup so the daemon does not wait on it.
if (PACKAGED && !registered()) void registerPlugin();
else if (PACKAGED && process.platform === 'win32') {
  prunePlugins();
  void registrationMoved().then(
    (moved) => {
      if (moved) void registerPlugin();
    },
    () => {},
  );
}

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
