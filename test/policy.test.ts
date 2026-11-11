import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { refuse } from '../plugin/bridge/adapters/antigravity.ts';
import { isNewer } from '../plugin/bridge/client.ts';

test('the editor role may read anywhere but edit only inside its workspace', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-policy-')));
  const cwd = path.join(base, 'workspace');
  const outside = path.join(base, 'main');
  fs.mkdirSync(cwd);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(cwd, 'link'));
  const edit = (...paths: string[]) => refuse(cwd, { kind: 'edit', locations: paths.map((p) => ({ path: p })) });

  assert.equal(edit(path.join(cwd, 'README.md')), null);
  assert.equal(edit(path.join(cwd, 'docs', 'new.md')), null);
  assert.equal(edit(path.join(outside, 'README.md')), 'edit outside the workspace');
  assert.equal(edit(path.join(cwd, '..', 'main', 'README.md')), 'edit outside the workspace');
  // A symlink inside the workspace must not be a way out of it.
  assert.equal(edit(path.join(cwd, 'link', 'README.md')), 'edit outside the workspace');
  assert.equal(edit(path.join(cwd, 'a.md'), path.join(outside, 'b.md')), 'edit outside the workspace');
  assert.equal(edit(), 'edit without a path');

  assert.equal(refuse(cwd, { kind: 'read', locations: [{ path: path.join(outside, 'README.md') }] }), null);
  assert.equal(refuse(cwd, { kind: 'execute' }), 'execute');
  assert.equal(refuse(cwd, {}), 'other');
});

test('a daemon is only replaced by a newer version', () => {
  assert.equal(isNewer('0.2.0', '0.1.9'), true);
  assert.equal(isNewer('0.1.10', '0.1.9'), true);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.1.0', '0.2.0'), false);
  assert.equal(isNewer('1.0', '0.9.9'), true);
});
