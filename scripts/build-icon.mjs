import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-icon-'));
const iconset = path.join(root, 'Crew.iconset');
fs.mkdirSync(iconset);
const svg = fs.readFileSync('desktop/icon.svg', 'utf8');
const browser = await chromium.launch();
try {
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2]) {
      const page = await browser.newPage({
        viewport: { width: size * scale, height: size * scale },
        deviceScaleFactor: 1,
      });
      await page.setContent(
        `<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`,
      );
      await page.screenshot({
        path: path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
        omitBackground: true,
      });
      if (size === 512 && scale === 2) await page.screenshot({ path: 'desktop/icon.png', omitBackground: true });
      await page.close();
    }
  if (process.platform === 'darwin') execFileSync('iconutil', ['-c', 'icns', iconset, '-o', 'desktop/icon.icns']);
} finally {
  await browser.close();
  fs.rmSync(root, { recursive: true, force: true });
}
