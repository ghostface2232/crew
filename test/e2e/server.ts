import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, job } from './fixtures.ts';
import { boardAsset, BOARD_CSP } from '../../plugin/bridge/assets.ts';

let state = fixture();
let instructions = 'Prefer minimal changes.\n';
let requests: { route: string; body: unknown }[] = [];
const streams = new Set<http.ServerResponse>();
const send = (type: string, data: unknown) => {
  for (const stream of streams) stream.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1');
  let body: any = {};
  if (req.method === 'POST') {
    let text = '';
    for await (const chunk of req) text += chunk;
    body = JSON.parse(text || '{}');
  }
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (url.pathname === '/__reset') {
    state = fixture();
    instructions = 'Prefer minimal changes.\n';
    requests = [];
    send('state', state);
    return json({});
  }
  if (url.pathname === '/__requests') return json(requests);
  if (url.pathname === '/__push') {
    if (body.type === 'job')
      state.jobs = state.jobs.map((job) => (job.id === body.data.id ? { ...job, ...body.data } : job));
    if (body.type === 'state') state = body.data;
    if (body.type === 'disconnect') {
      for (const stream of streams) stream.end();
      return json({});
    }
    send(body.type, body.type === 'job' ? state.jobs.find((job) => job.id === body.data.id) : body.data);
    return json({});
  }
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    streams.add(res);
    res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    req.on('close', () => streams.delete(res));
    return;
  }
  if (url.pathname === '/api/state') return json(state);
  if (req.method === 'POST') requests.push({ route: url.pathname, body });
  if (url.pathname === '/api/instructions') {
    if (req.method === 'POST') instructions = body.text.trimEnd() + '\n';
    return json({
      text: instructions,
      file: `${body.project ?? url.searchParams.get('project') ?? '/global'}/.crew/instructions.md`,
    });
  }
  if (url.pathname === '/api/roles') {
    state.roles = body.roles;
    send('roles', state.roles);
    return json(state.roles);
  }
  if (url.pathname === '/api/jobs' && req.method === 'POST') {
    const created = job({ id: 'cx-direct', mission: undefined, title: body.task, kind: body.kind });
    state.jobs.push(created);
    send('job', created);
    return json(created);
  }
  const match = /^\/api\/jobs\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname);
  if (match) {
    const found = state.jobs.find((job) => job.id === match[1]);
    if (!found) return json({ error: 'Job not found' }, 404);
    if (match[2] === 'events') return json(state.events.filter((event) => event.job_id === found.id));
    if (req.method === 'GET') return json({ ...found, prompt: 'Inspect the existing implementation first. <task>' });
    if (match[2] === 'cancel') {
      found.state = 'cancelled';
      found.endedAt = state.now;
      send('job', found);
    }
    return json(found);
  }
  const asset = boardAsset(path.resolve('plugin'), url.pathname);
  if (asset) {
    res.writeHead(200, { 'content-type': asset.type, 'content-security-policy': BOARD_CSP });
    fs.createReadStream(asset.file).pipe(res);
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(47755, '127.0.0.1', () => console.log('Fixture board: http://127.0.0.1:47755'));
