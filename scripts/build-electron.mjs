import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { bundlePlugin } from './bundle-plugin.mjs';

// The Electron shell for Windows: compiled main process and bridge, the built board, and rendered icons.
const root = path.resolve('desktop/build');
fs.rmSync(root, { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.desktop.json'], { stdio: 'inherit' });
await bundlePlugin(root, '../runtime/node.exe');
// The plugin's hooks run on their own Node: Crew.exe runs as Node only with ELECTRON_RUN_AS_NODE set, and a hook
// command cannot set its environment. Packaging copies this machine's Node, so it builds on Windows.
if (process.platform === 'win32') {
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(root, 'runtime/node.exe'));
  // The Node.js installer (MSI) leaves its LICENSE out; the zip distribution, which CI uses, keeps it beside node.exe.
  const license = process.env.CREW_NODE_LICENSE ?? path.resolve(path.dirname(process.execPath), 'LICENSE');
  if (!fs.existsSync(license)) throw new Error('Set CREW_NODE_LICENSE to the LICENSE of this Node.js version (the zip distribution ships it beside node.exe).');
  fs.copyFileSync(license, path.join(root, 'runtime/LICENSE'));
} else console.warn('Not on Windows: the bundled plugin has no Node runtime in this build.');
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
fs.writeFileSync(
  path.join(root, 'package.json'),
  JSON.stringify(
    { name: 'crew-desktop', productName: 'Crew', version, type: 'module', main: 'desktop/main.js', description: 'Crew agent board' },
    null,
    2,
  ),
);

// Icons are scaled from the Icon Composer export, which carries the lighting and shadow effects the layered
// icon has on macOS and already has transparent rounded corners. An .ico holds PNG images, which Windows reads since Vista.
const appIcon = `<img src="data:image/png;base64,${fs.readFileSync('assets/crew-iOS-Default-1024@2x.png').toString('base64')}">`;
const badge = '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="7" fill="#e5484d"/></svg>';
const browser = await chromium.launch();
const render = async (svg, size) => {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg,img{display:block;width:100%;height:100%}</style>${svg}`);
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

const licenses = [
  ['react', 'node_modules/react/LICENSE'],
  ['react-dom', 'node_modules/react-dom/LICENSE'],
  ['scheduler', 'node_modules/scheduler/LICENSE'],
  ['@fluentui/react-icons', 'plugin/board/fluentui-react-icons-LICENSE.txt'],
  ['@griffel/react', 'node_modules/@griffel/react/LICENSE.md'],
  ['@griffel/core', 'node_modules/@griffel/core/LICENSE.md'],
  ['@emotion/hash', 'node_modules/@emotion/hash/LICENSE'],
  ['Pretendard', 'plugin/board/pretendard-LICENSE.txt'],
].map(([name, file]) => `${name}\n${fs.readFileSync(file, 'utf8')}`);
if (process.platform === 'win32') licenses.push(`Node.js ${process.version}\nSee runtime/LICENSE for Node.js and its bundled dependencies.`);
fs.writeFileSync(path.join(root, 'THIRD-PARTY-NOTICES.txt'), licenses.join('\n\n'));
console.log(root);
