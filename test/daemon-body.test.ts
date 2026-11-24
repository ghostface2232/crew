import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { clientJson } from '../plugin/bridge/text.ts';

function reader() {
  const source = fs.readFileSync(new URL('../plugin/bridge/daemon.ts', import.meta.url), 'utf8');
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
  });
  const readJson = vm.runInContext(stripTypeScriptTypes(source.slice(start, source.indexOf('\n/**', start))) + '; readJson', context) as (req: EventEmitter) => Promise<unknown>;
  const routes = source.slice(source.indexOf('function isOpen('), source.indexOf('\nlet stopping = false;'));
  const route = vm.runInContext(stripTypeScriptTypes(routes) + '; route', context) as (req: EventEmitter, res: object) => Promise<unknown>;
  return { readJson, route, parses: () => parses };
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

test('an event stream whose reader has stopped is dropped once its backlog passes the cap, and a reading one is kept', async (t) => {
  const source = fs.readFileSync(new URL('../plugin/bridge/daemon.ts', import.meta.url), 'utf8');
  const slice = source.slice(source.indexOf('const streams = new Set'), source.indexOf('\nconst AGENT_NAMES'));
  const { streams, broadcast } = vm.runInNewContext(stripTypeScriptTypes(slice) + '; ({ streams, broadcast })', { clientJson }) as { streams: Set<http.ServerResponse>; broadcast: (type: string, data: unknown) => void };
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

  // 64 MiB in all: what the system buffers for a socket is a small part of it, and the rest waits in the daemon.
  const data = 'x'.repeat(1024 * 1024);
  let peak = 0;
  for (let i = 0; i < 64; i++) {
    broadcast('job', data);
    peak = Math.max(peak, stalledStream.writableLength);
    // Lets the reading stream drain, as a live board does between events.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(stalledStream.destroyed, true);
  assert.ok(peak < 10 * 1024 * 1024, `queued ${peak} bytes`);
  assert.equal(streams.size, 1);
  assert.equal(reading.destroyed, false);
  // The dropped client sees its connection end, which is what makes it reconnect.
  const closed = new Promise((resolve) => stalled.once('close', resolve));
  stalled.resume();
  await closed;
});
