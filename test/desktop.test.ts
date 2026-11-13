import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { boardAsset, BOARD_CSP } from '../plugin/bridge/assets.ts';

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
