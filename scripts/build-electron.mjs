import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The Electron shell for Windows: compiled main process and bridge, the built board, and rendered icons.
const root = path.resolve('desktop/build');
fs.rmSync(root, { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.desktop.json'], { stdio: 'inherit' });
for (const folder of ['roles', '.claude-plugin', 'board/dist']) {
  fs.cpSync(`plugin/${folder}`, path.join(root, 'plugin', folder), { recursive: true });
}
// The compiled bridge carries the source's fingerprint, so the app and a plugin install agree on whose daemon is current.
const { installed } = await import(pathToFileURL(path.resolve('plugin/bridge/config.ts')).href);
fs.writeFileSync(path.join(root, 'plugin/.claude-plugin/build'), `${installed().build}\n`);
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
fs.writeFileSync(
  path.join(root, 'package.json'),
  JSON.stringify(
    { name: 'crew-desktop', productName: 'Crew', version, type: 'module', main: 'desktop/main.js', description: 'Crew agent board' },
    null,
    2,
  ),
);

// Icons are rendered from the board's app mark; an .ico holds PNG images, which Windows reads since Vista.
// The app mark is square art; its corners are cut here as the sidebar's .brand-mark cuts them (12px of 30px, smoothed).
const appIcon = `<div style="width:100%;height:100%;overflow:hidden;border-radius:40%;corner-shape:superellipse(1.35)">${fs.readFileSync('plugin/board/src/icons/CrewAppIcon.svg', 'utf8')}</div>`;
const badge = '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="7" fill="#e5484d"/></svg>';
const browser = await chromium.launch();
const render = async (svg, size) => {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`);
  const png = await page.screenshot({ omitBackground: true });
  await page.close();
  return png;
};
const out = path.join(root, 'desktop');
try {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = [];
  for (const size of sizes) images.push(await render(appIcon, size));
  fs.writeFileSync(path.join(out, 'icon.png'), images.at(-1));
  fs.writeFileSync(path.join(out, 'tray.png'), images[0]);
  fs.writeFileSync(path.join(out, 'tray@2x.png'), images[2]);
  fs.writeFileSync(path.join(out, 'badge.png'), await render(badge, 16));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map((png, i) => {
    const entry = Buffer.alloc(16);
    entry[0] = sizes[i] % 256; // 0 means 256.
    entry[1] = sizes[i] % 256;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([header, ...entries, ...images]));
} finally {
  await browser.close();
}

const licenses = ['react', 'react-dom', 'scheduler', 'lucide-react'].map(
  (name) => `${name}\n${fs.readFileSync(`node_modules/${name}/LICENSE`, 'utf8')}`,
);
licenses.push(`Inter\n${fs.readFileSync('plugin/board/inter-LICENSE.txt', 'utf8')}`);
fs.writeFileSync(path.join(root, 'THIRD-PARTY-NOTICES.txt'), licenses.join('\n\n'));
console.log(root);
