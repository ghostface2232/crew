import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';

execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.desktop.json'], {
  stdio: 'inherit',
});
const root = 'desktop/build';
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
for (const folder of ['roles', '.claude-plugin', 'board/dist']) {
  fs.cpSync(`plugin/${folder}`, `${root}/plugin/${folder}`, { recursive: true });
}
fs.writeFileSync(
  `${root}/package.json`,
  JSON.stringify(
    {
      name: 'crew-desktop',
      productName: 'Crew',
      version,
      type: 'module',
      main: 'desktop/main.js',
      description: 'Crew agent control board',
      author: 'baemingwan',
    },
    null,
    2,
  ),
);
// A monochrome Crew mark at 1x and 2x; no image toolchain is needed for the tray.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
for (const scale of [1, 2]) {
  const size = 18 * scale;
  const bytes = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / scale;
      const alpha = distance < 2 || (distance > 4 && distance < 6.5) ? 255 : 0;
      bytes[y * (1 + size * 4) + 1 + x * 4 + 3] = alpha;
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  fs.writeFileSync(
    path.join(root, 'desktop', `trayTemplate${scale === 2 ? '@2x' : ''}.png`),
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(bytes)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

const licenses = ['react', 'react-dom', 'scheduler', 'lucide-react'].map(
  (name) => `${name}\n${fs.readFileSync(`node_modules/${name}/LICENSE`, 'utf8')}`,
);
licenses.push(`Inter\n${fs.readFileSync('plugin/board/inter-LICENSE.txt', 'utf8')}`);
fs.writeFileSync(`${root}/THIRD-PARTY-NOTICES.txt`, licenses.join('\n\n'));
