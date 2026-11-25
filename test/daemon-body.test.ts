import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { canonicalPath, projectSettings, resolveConfig } from '../plugin/bridge/config.ts';
import { projectRoot } from '../plugin/bridge/git.ts';
import { autoResumesLeft, Jobs } from '../plugin/bridge/jobs.ts';
import type { Adapter, Job } from '../plugin/bridge/jobs.ts';
import { memoryFor, missionPreset } from '../plugin/bridge/missions.ts';
import { saveProjectSettings } from '../plugin/bridge/settings.ts';
import { parseCache } from '../plugin/bridge/usage.ts';
import { clientJson } from '../plugin/bridge/text.ts';

const source = fs.readFileSync(new URL('../plugin/bridge/daemon.ts', import.meta.url), 'utf8');

function reader(overrides: Record<string, unknown> = {}) {
  const start = source.indexOf('function readJson(');
  let parses = 0;
  const context = vm.createContext({
    Buffer, StringDecoder, URL, PORT: 0, stopping: false, guard: () => {}, signedIn: () => false, sameToken: () => false, TOKEN: '',
    WORKER_ROUTE: /^\/api\/jobs\/[\w-]+\/(?:questions|siblings|browser)$/,
    claude: { ingest: () => {}, sessions: new Map() }, locate: () => {},
    JSON: { parse: (body: string) => { parses++; return JSON.parse(body); } },
    HttpError: class extends Error {
      status: number;
      constructor(status: number, message: string) { super(message); this.status = status; }
    },
    ...overrides,
  });
  const readJson = vm.runInContext(stripTypeScriptTypes(source.slice(start, source.indexOf('\n/**', start))) + '; readJson', context) as (req: EventEmitter) => Promise<unknown>;
  const routes = source.slice(source.indexOf('function isOpen('), source.indexOf('\nlet stopping = false;'));
  const route = vm.runInContext(stripTypeScriptTypes(routes) + '; route', context) as (req: EventEmitter, res: object) => Promise<unknown>;
  const post = (url: string, body: object) => {
    const req = Object.assign(new EventEmitter(), { method: 'POST', url });
    const result = route(req, {});
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
    return result;
  };
  return { readJson, route, post, parses: () => parses };
}

test('oversized JSON stops reading chunks and never parses at end', async (t) => {
  const h = reader();
  const req = new EventEmitter();
  const result = h.readJson(req);
  const rejected = assert.rejects(result, { status: 413, message: 'body too large' });
  req.emit('data', Buffer.alloc(4 * 1024 * 1024, ' '));
  req.emit('data', Buffer.from('x'));
  const further = Buffer.alloc(1024);
  const decode = t.mock.method(further, 'toString');
  for (let i = 0; i < 10; i++) req.emit('data', further);
  req.emit('end');
  await rejected;
  assert.equal(decode.mock.callCount(), 0);
  assert.equal(h.parses(), 0);
});

test('JSON limit counts bytes, including non-ASCII input', async () => {
  const h = reader();
  const req = new EventEmitter();
  const rejected = assert.rejects(h.readJson(req), { status: 413 });
  req.emit('data', Buffer.from(JSON.stringify('가'.repeat(2 * 1024 * 1024))));
  req.emit('end');
  await rejected;
  assert.equal(h.parses(), 0);
});

test('JSON exactly at the body limit is accepted', async () => {
  const h = reader();
  const req = new EventEmitter();
  const result = h.readJson(req);
  req.emit('data', Buffer.from('"' + 'a'.repeat(4 * 1024 * 1024 - 2) + '"'));
  req.emit('end');
  assert.equal((await result as string).length, 4 * 1024 * 1024 - 2);
});

test('a route open without the secret rejects an oversized upload before it ends', async () => {
  const h = reader();
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/api/session' });
  const rejected = assert.rejects(h.route(req, {}), { status: 413, message: 'body too large' });
  req.emit('data', Buffer.alloc(4 * 1024 * 1024));
  req.emit('data', Buffer.from('x'));
  await rejected;
  req.emit('end');
  assert.equal(h.parses(), 0);
});

test('a character split across two chunks of a body is read whole', async () => {
  const h = reader();
  const req = new EventEmitter();
  const result = h.readJson(req);
  const body = Buffer.from(JSON.stringify({ task: '한글 지시문' }));
  // Cut inside the three bytes of the first Hangul syllable.
  const cut = body.indexOf(Buffer.from('한')) + 1;
  req.emit('data', body.subarray(0, cut));
  req.emit('data', body.subarray(cut));
  req.emit('end');
  assert.deepEqual(await result, { task: '한글 지시문' });
});

test('an incomplete UTF-8 sequence after valid JSON makes the body malformed', async () => {
  const h = reader();
  const req = new EventEmitter();
  const rejected = assert.rejects(h.readJson(req), { status: 400, message: 'invalid JSON' });
  req.emit('data', Buffer.from('{}'));
  req.emit('data', Buffer.from([0xe2]));
  req.emit('end');
  await rejected;
});

test('an event stream whose reader has stopped is dropped once it is behind at two pings running, and a reading one is kept', async (t) => {
  const source = fs.readFileSync(new URL('../plugin/bridge/daemon.ts', import.meta.url), 'utf8');
  const slice = source.slice(source.indexOf('const streams = new Set'), source.indexOf('\nconst AGENT_NAMES'));
  const { streams, broadcast, dropStalled } = vm.runInNewContext(stripTypeScriptTypes(slice) + '; ({ streams, broadcast, dropStalled })', { clientJson }) as
    { streams: Set<http.ServerResponse>; broadcast: (type: string, data: unknown) => void; dropStalled: () => void };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': open\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const connect = (reads: boolean) => new Promise<net.Socket>((resolve) => {
    const socket = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1', () => {
      socket.write('GET /api/stream HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n');
      socket.on('error', () => {});
      if (reads) socket.resume();
      resolve(socket);
    });
    t.after(() => socket.destroy());
  });
  const opened = async (count: number) => {
    while (streams.size < count) await new Promise((resolve) => setImmediate(resolve));
  };
  const stalled = await connect(false);
  await opened(1);
  const [stalledStream] = streams;
  const reading = await connect(true);
  await opened(2);

  // 16 MiB in all: what the system buffers for a socket is a small part of it, and the rest waits in the daemon.
  const data = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 16; i++) {
    broadcast('job', data);
    // Lets the reading stream drain, as a live board does between events.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // Behind at one ping is not yet stalled: a whole state on its way to a reader that keeps up looks the same.
  dropStalled();
  assert.deepEqual([stalledStream.destroyed, streams.size], [false, 2]);
  // A reader that caught up in between is not counted as behind from before.
  const [, readingStream] = streams;
  assert.ok(readingStream.writableLength <= 8 * 1024 * 1024);
  dropStalled();
  assert.equal(stalledStream.destroyed, true);
  assert.equal(streams.size, 1);
  assert.equal(reading.destroyed, false);
  // The dropped client sees its connection end, which is what makes it reconnect.
  const closed = new Promise((resolve) => stalled.once('close', resolve));
  stalled.resume();
  await closed;
});

test('an auto-resume promise requires an AgentGauge window reading for that agent', (t) => {
  const gaugeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-gauge-'));
  t.after(() => fs.rmSync(gaugeDir, { recursive: true, force: true }));
  const job = {
    state: 'failed', error: { limit: true }, mission: 'mission', sessionId: 'thread',
    worktree: {}, project: gaugeDir, agent: 'codex',
  } as Job;
  const config = resolveConfig({ projects: { [canonicalPath(gaugeDir)]: { autoResume: true } } });
  const resumes = vm.runInNewContext(stripTypeScriptTypes(source.slice(source.indexOf('function resumesAfterLimit('),
    source.indexOf('/** For display only'))) + '; resumesAfterLimit', {
    gaugeDir, fs, path, parseCache, projectSettings, autoResumesLeft,
    liveConfig: () => config, missions: { list: () => [{ id: 'mission', state: 'active' }] },
    // The app-server supplement can supply a reading even with an empty AgentGauge cache.
    usage: { current: () => ({ source: 'agentgauge', providers: [{ agent: 'codex', capturedAt: Date.now(), status: 'exhausted' }] }) },
  }) as (job: Job) => boolean;
  assert.equal(resumes(job), false);
  const writeReading = (tool: string) => fs.writeFileSync(path.join(gaugeDir, 'usage-cache.json'), JSON.stringify({
    version: 1, snapshots: [{ tool, capturedAt: new Date().toISOString(), windows: [{ type: 'weekly', usedRatio: 1 }] }],
  }));
  writeReading('claude');
  assert.equal(resumes(job), false);
  writeReading('codex');
  assert.equal(resumes(job), true);
  job.error!.fixedLimit = true;
  assert.equal(resumes(job), false);
});

test('mission decisions reach a bodyless polish and a bodyless standard review', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-decisions-'));
  const config = resolveConfig({ roles: { polish: { agents: ['codex'] }, review: { agents: ['codex'] } } });
  const prompts: string[] = [];
  const adapter: Adapter = {
    start: async (ctl) => { prompts.push(ctl.job.prompt); ctl.done('finished'); },
    reply: async () => {}, answer: async () => {}, cancel: async () => {}, shutdown: () => {},
  };
  const jobs = new Jobs(home, () => config, { codex: adapter, antigravity: adapter },
    { onEvent: () => {}, onJob: () => {}, onAttention: () => {} });
  t.after(() => { jobs.flush(); fs.rmSync(home, { recursive: true, force: true }); });
  const mission = { id: 'mission', state: 'active', memory: [{ key: 'style', text: 'Use sentence case.' }] };
  const h = reader({ jobs, signedIn: () => ({}), memoryFor, missionPreset, liveConfig: () => config,
    missions: { list: () => [mission] }, view: (job: Job) => job });
  const common = { cwd: home, mission: mission.id };
  const polish = await h.post('/api/jobs', { ...common, kind: 'polish', isolation: 'in_place', targets: ['app.js'] }) as Job;
  assert.match(prompts[0], /Decisions the user made in this mission[\s\S]*- Use sentence case\./);
  const review = await h.post('/api/jobs', { ...common, kind: 'review', review: { mode: 'standard', target: { type: 'uncommittedChanges' } } }) as Job;
  assert.equal(polish.title, 'app.js');
  assert.equal(review.nativeReview, null);
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) assert.match(prompt, /Decisions the user made in this mission[\s\S]*- Use sentence case\./);
});

test('first session events use the canonical cwd until the session root is known', () => {
  const start = source.indexOf('const claude = new ClaudeSessions(');
  const hook = vm.runInNewContext(stripTypeScriptTypes(source.slice(start, source.indexOf('// Codex lead sessions', start)))
    + '; claude.onEvent', {
    config: {},
    ClaudeSessions: class { constructor(_seconds: unknown, hooks: object) { Object.assign(this, hooks); } },
    jobs: { record: (...args: unknown[]) => args[5] },
    canonicalPath: (cwd: string) => canonicalPath(cwd, 'win32'),
  }) as (session: { cwd: string; id: string; root?: string }, kind: string, detail: string) => string;
  assert.equal(hook({ id: 's', cwd: 'c:/repo/sub' }, 'done', 'finished'), 'C:\\repo\\sub');
  assert.equal(hook({ id: 's', cwd: 'c:/repo/sub', root: 'C:\\repo' }, 'done', 'finished'), 'C:\\repo');
});

test('a project setting sent from a session subfolder is saved at its repository root', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-project-settings-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  const sub = path.join(repo, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const h = reader({ signedIn: () => ({}), HOME: home, projectRoot, saveProjectSettings,
    knownProject: (project: string) => assert.equal(project, sub), broadcast: () => {} });
  await h.post('/api/project-settings', { project: sub, changes: { autoResume: true } });
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.deepEqual(saved.projects, { [canonicalPath(repo)]: { autoResume: true } });
});
