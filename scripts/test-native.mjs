import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';

const build = path.resolve('native/build');
const state = JSON.parse(fs.readFileSync('native/Tests/CrewTests/Fixtures/state.json', 'utf8'));
let streams = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/active') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ count: streams }));
    return;
  }
  if (req.url !== '/api/stream') { res.writeHead(404).end(); return; }
  streams++;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const job = { ...state.jobs[0], phase: '실제 스트림 연결 확인 🙂' };
  const wire = Buffer.from(`event: state\r\ndata: ${JSON.stringify(state)}\r\n\r\nevent: desktopLease\ndata: {"completionNotifications":true,"from":1000,"until":16000}\n\nevent: job\ndata: ${JSON.stringify(job)}\n\n`);
  let offset = 0;
  const timer = setInterval(() => {
    if (offset < wire.length) { res.write(wire.subarray(offset, offset + 127)); offset += 127; }
    else res.write(': heartbeat\n\n');
  }, 2);
  res.on('close', () => { streams--; clearInterval(timer); });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const child = spawn('swift', ['test', '--package-path', 'native', '--scratch-path', path.join(build, 'swift'), '--disable-sandbox'], {
    stdio: 'inherit',
    env: { ...process.env, CREW_STREAM_TEST_PORT: String(server.address().port), CLANG_MODULE_CACHE_PATH: path.join(build, 'ModuleCache'), SWIFTPM_MODULECACHE_OVERRIDE: path.join(build, 'ModuleCache') },
  });
  const [code] = await once(child, 'exit');
  process.exitCode = code ?? 1;
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
