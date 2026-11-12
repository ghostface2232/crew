import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { windowBounds, isBoardNavigation } from '../desktop/window-state.ts';
import { boardAsset, BOARD_CSP } from '../plugin/bridge/assets.ts';

test('restores visible bounds but recenters a removed monitor or malformed values', () => {
  const displays = [{ x: 0, y: 0, width: 1440, height: 900 }];
  assert.deepEqual(windowBounds({ x: 20, y: 40, width: 900, height: 600, maximized: true }, displays), {
    x: 20,
    y: 40,
    width: 900,
    height: 600,
    maximized: true,
  });
  assert.equal(windowBounds({ x: 2000, y: 0, width: 900, height: 600 }, displays).x, undefined);
  assert.equal(windowBounds({ width: NaN, height: -5 }, displays).width, 1380);
  assert.equal(windowBounds({ height: -5 }, displays).height, 480);
});

test('desktop navigation is confined to the board, never API routes or remote pages', () => {
  const base = 'http://127.0.0.1:47615';
  assert.equal(isBoardNavigation(`${base}/#cx-1`, base), true);
  for (const url of [
    `${base}/api/state`,
    'https://example.com',
    'javascript:alert(1)',
    'http://127.0.0.1:47616/',
    'http://user@127.0.0.1:47615/',
  ])
    assert.equal(isBoardNavigation(url, base), false);
});

test('serves only built assets with explicit types and a renderer security policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-assets-'));
  try {
    fs.mkdirSync(path.join(root, 'board/dist/assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'board/dist/index.html'), '<html></html>');
    fs.writeFileSync(path.join(root, 'board/dist/assets/index-ab12.js'), '');
    assert.equal(boardAsset(root, '/')?.immutable, false);
    assert.equal(boardAsset(root, '/assets/index-ab12.js')?.type, 'text/javascript; charset=utf-8');
    for (const url of [
      '/src/main.tsx',
      '/assets/../../bridge/config.ts',
      '/assets/%2e%2e/config.js',
      '/assets/missing.js',
      '/assets/index.map',
    ])
      assert.equal(boardAsset(root, url), null);
    assert.match(BOARD_CSP, /script-src 'self'/);
    assert.match(BOARD_CSP, /object-src 'none'/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
