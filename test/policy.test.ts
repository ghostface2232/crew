import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { decide } from '../plugin/bridge/adapters/antigravity.ts';
import { isNewer, shouldReplace } from '../plugin/bridge/client.ts';

test('each role may read anywhere; only editors and engineers edit, inside the workspace; only an engineer may ask for more', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-policy-')));
  const cwd = path.join(base, 'workspace');
  const outside = path.join(base, 'main');
  fs.mkdirSync(cwd);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(cwd, 'link'));
  const refused = (reason: string) => ({ refuse: reason });
  const edit = (...paths: string[]) => decide('polish', cwd, { kind: 'edit', locations: paths.map((p) => ({ path: p })) });

  assert.equal(edit(path.join(cwd, 'README.md')), 'allow');
  assert.equal(edit(path.join(cwd, 'docs', 'new.md')), 'allow');
  assert.deepEqual(edit(path.join(outside, 'README.md')), refused('edit outside the workspace'));
  assert.deepEqual(edit(path.join(cwd, '..', 'main', 'README.md')), refused('edit outside the workspace'));
  // A symlink inside the workspace must not be a way out of it.
  assert.deepEqual(edit(path.join(cwd, 'link', 'README.md')), refused('edit outside the workspace'));
  assert.deepEqual(edit(path.join(cwd, 'a.md'), path.join(outside, 'b.md')), refused('edit outside the workspace'));
  assert.deepEqual(edit(), refused('edit without a path'));

  const inside = { kind: 'edit', locations: [{ path: path.join(cwd, 'README.md') }] };
  for (const role of ['delegate', 'review', 'polish'] as const) {
    assert.equal(decide(role, cwd, { kind: 'read', locations: [{ path: path.join(outside, 'README.md') }] }), 'allow');
    assert.equal(decide(role, cwd, { kind: 'search' }), 'allow');
  }
  assert.deepEqual(decide('polish', cwd, { kind: 'execute' }), refused('execute'));
  assert.deepEqual(decide('polish', cwd, {}), refused('other'));

  assert.deepEqual(decide('review', cwd, inside), refused('edit during a read-only review'));
  assert.deepEqual(decide('review', cwd, { kind: 'execute' }), refused('execute'));

  assert.equal(decide('delegate', cwd, inside), 'allow');
  // Asking the user never widens where an engineer may write.
  assert.deepEqual(decide('delegate', cwd, { kind: 'edit', locations: [{ path: path.join(outside, 'a.js') }] }), refused('edit outside the workspace'));
  for (const kind of ['execute', 'delete', 'move', 'fetch', 'something-new']) {
    assert.equal(decide('delegate', cwd, { kind, rawInput: { command: 'x' } }), 'ask');
    // The user cannot approve what the request does not spell out.
    assert.deepEqual(decide('delegate', cwd, { kind }), refused(`${kind} request without its input`));
  }
  assert.equal(decide('delegate', cwd, { rawInput: 'x' }), 'ask');
  // A read-only job (a question) reads freely and changes nothing, even as an engineer.
  assert.equal(decide('delegate', cwd, { kind: 'read' }, true), 'allow');
  assert.deepEqual(decide('delegate', cwd, inside, true), refused('edit in a read-only job'));
  assert.deepEqual(decide('delegate', cwd, { kind: 'execute', rawInput: { command: 'x' } }, true), refused('execute'));
  // No role may leave the mode in which every edit is checked.
  for (const role of ['delegate', 'review', 'polish'] as const) assert.deepEqual(decide(role, cwd, { kind: 'switch_mode', rawInput: { mode: 'accept-edits' } }), refused('switch_mode'));
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
