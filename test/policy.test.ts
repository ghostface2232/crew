import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { refuse } from '../plugin/bridge/adapters/antigravity.ts';
import { isNewer, shouldReplace } from '../plugin/bridge/client.ts';

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

test('a daemon is replaced when its code differs from what is installed, unless jobs run or another install owns it', () => {
  const disk = { version: '0.1.0', build: 'new' };
  const daemon = { version: '0.1.0', build: 'old', root: '/plugin', pid: 1, active: 0 };
  assert.equal(shouldReplace({ ...daemon, build: 'new' }, disk, '/plugin'), false);
  // Same folder, code edited without a version bump.
  assert.equal(shouldReplace(daemon, disk, '/plugin'), true);
  assert.equal(shouldReplace({ ...daemon, active: 1 }, disk, '/plugin'), false);
  // A daemon too old to report its build or folder.
  assert.equal(shouldReplace({ version: '0.1.0', pid: 1, active: 0 }, disk, '/plugin'), true);
  // Another install with different code: only a newer version takes over.
  assert.equal(shouldReplace({ ...daemon, root: '/other' }, disk, '/plugin'), false);
  assert.equal(shouldReplace({ ...daemon, root: '/other' }, { version: '0.2.0', build: 'new' }, '/plugin'), true);
});

test('versions compare numerically', () => {
  assert.equal(isNewer('0.2.0', '0.1.9'), true);
  assert.equal(isNewer('0.1.10', '0.1.9'), true);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.1.0', '0.2.0'), false);
  assert.equal(isNewer('1.0', '0.9.9'), true);
});
