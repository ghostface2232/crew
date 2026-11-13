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

test('Antigravity is refused the daemon token file, whatever the role or the kind of call', async () => {
  const { tokenFile } = await import('../plugin/bridge/auth.ts');
  const { HOME } = await import('../plugin/bridge/config.ts');
  const secret = tokenFile(HOME);
  for (const role of ['delegate', 'review', 'polish'] as const) {
    for (const kind of ['read', 'search', 'edit', 'execute']) {
      assert.deepEqual(decide(role, path.dirname(secret), { kind, locations: [{ path: secret }], rawInput: { command: 'x' } }), { refuse: 'the Crew token file' }, `${role} ${kind}`);
    }
  }
  assert.equal(decide('delegate', path.dirname(secret), { kind: 'read', locations: [{ path: path.join(path.dirname(secret), 'config.json') }] }), 'allow');
});

test('Windows agent commands resolve PATH and PATHEXT and quote batch paths', async (t) => {
  const { agentCommand } = await import('../plugin/bridge/config.ts');
  const file = fs.statSync(import.meta.filename);
  const files = new Set([
    'c:\\npm tools\\codex.cmd',
    'c:\\other\\codex.exe',
    'c:\\npm tools\\agy.bat',
    'c:\\npm tools\\native.exe',
    'c:\\npm tools\\native.cmd',
  ]);
  const lookedUp: string[] = [];
  t.mock.method(fs, 'statSync', (candidate: string) => {
    lookedUp.push(candidate);
    return files.has(candidate.toLowerCase()) ? file : undefined;
  });
  const env = { Path: '"C:\\npm tools";C:\\other', Pathext: '.EXE;.CMD;.BAT' };
  assert.deepEqual(agentCommand('codex', env, 'win32'), { bin: '"C:\\npm tools\\codex.CMD"', shell: true });
  assert.deepEqual(lookedUp, ['C:\\npm tools\\codex.EXE', 'C:\\npm tools\\codex.CMD']);
  assert.deepEqual(agentCommand('agy', env, 'win32'), { bin: '"C:\\npm tools\\agy.BAT"', shell: true });
  assert.deepEqual(agentCommand('native', env, 'win32'), { bin: 'C:\\npm tools\\native.EXE', shell: false });
  assert.deepEqual(agentCommand('C:\\npm tools\\codex', env, 'win32'), { bin: '"C:\\npm tools\\codex.CMD"', shell: true });
  assert.deepEqual(agentCommand('C:\\npm tools\\codex.cmd', {}, 'win32'), { bin: '"C:\\npm tools\\codex.cmd"', shell: true });
  assert.deepEqual(agentCommand('agy.BAT', {}, 'win32'), { bin: '"agy.BAT"', shell: true });
  assert.deepEqual(agentCommand('codex', { PATH: 'C:\\npm tools' }, 'win32'), { bin: '"C:\\npm tools\\codex.CMD"', shell: true });
  assert.deepEqual(agentCommand('missing', env, 'win32'), { bin: 'missing', shell: false });
  assert.throws(() => agentCommand('bad"path.cmd', {}, 'win32'), /Invalid agent binary path/);
  lookedUp.length = 0;
  for (const bin of ['codex', '/tools with spaces/codex', '/tools/codex.cmd']) {
    assert.deepEqual(agentCommand(bin, env, 'darwin'), { bin, shell: false });
    assert.deepEqual(agentCommand(bin, env, 'linux'), { bin, shell: false });
  }
  assert.deepEqual(lookedUp, []);
});

test('agentEnv adds the Windows npm bin and keeps the existing macOS PATH behavior', async () => {
  const { agentEnv } = await import('../plugin/bridge/config.ts');
  const win = agentEnv('win32', { Path: 'C:\\Windows', APPDATA: 'C:\\Users\\A B\\AppData\\Roaming', ELECTRON_RUN_AS_NODE: '1' });
  assert.ok(win.PATH!.split(';').includes('C:\\Users\\A B\\AppData\\Roaming\\npm'));
  assert.equal(win.PATH!.split(';')[0], 'C:\\Windows');
  assert.equal(win.Path, undefined);
  assert.equal(win.ELECTRON_RUN_AS_NODE, undefined);
  assert.ok(!win.PATH!.includes('/opt/homebrew/bin'));
  const source = { PATH: '/usr/bin:/usr/local/bin', ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes' };
  const extra = [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', path.dirname(process.execPath)];
  const current = source.PATH.split(path.delimiter);
  assert.deepEqual(agentEnv('darwin', source), {
    PATH: [...current, ...extra.filter((p) => !current.includes(p))].join(path.delimiter), KEEP: 'yes',
  });
  assert.equal(source.ELECTRON_RUN_AS_NODE, '1');
});

test('detaching links leaves files and external link targets untouched', async (t) => {
  const { detachLinks } = await import('../plugin/bridge/git.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-links-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tree = path.join(dir, 'tree');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(path.join(tree, 'nested'), { recursive: true });
  fs.mkdirSync(path.join(outside, '.bin'), { recursive: true });
  fs.writeFileSync(path.join(outside, '.bin', 'tool'), 'keep');
  fs.writeFileSync(path.join(tree, 'regular'), 'keep too');
  fs.symlinkSync(outside, path.join(tree, 'node_modules'), 'junction');
  fs.symlinkSync(path.join(outside, '.bin', 'tool'), path.join(tree, 'nested', 'file'));
  fs.symlinkSync(path.join(outside, 'missing'), path.join(tree, 'broken'));
  fs.symlinkSync(tree, path.join(tree, 'nested', 'cycle'), 'junction');
  fs.symlinkSync(path.join(outside, '.bin', 'tool'), path.join(outside, 'untouched'));
  await detachLinks(tree);
  assert.deepEqual(fs.readdirSync(tree).sort(), ['nested', 'regular']);
  assert.deepEqual(fs.readdirSync(path.join(tree, 'nested')), []);
  assert.equal(fs.readFileSync(path.join(tree, 'regular'), 'utf8'), 'keep too');
  assert.equal(fs.readFileSync(path.join(outside, '.bin', 'tool'), 'utf8'), 'keep');
  assert.ok(fs.lstatSync(path.join(outside, 'untouched')).isSymbolicLink());
  await detachLinks(tree);
  await detachLinks(path.join(dir, 'missing'));
});


test('a Crew title cannot disguise an Antigravity command', () => {
  for (const role of ['delegate', 'review', 'polish'] as const) {
    for (const readOnly of [false, true]) {
      for (const title of ['mcp_crew_search', 'Run mcp_crew_search']) {
        for (const kind of ['other', 'execute']) {
          for (const rawInput of ['rm -rf ~', { command: 'rm -rf ~' }, { CommandLine: 'rm -rf ~' }, { command: '' }]) {
            assert.notEqual(decide(role, '/workspace', { kind, title, rawInput }, readOnly), 'allow', JSON.stringify({ role, readOnly, kind, title, rawInput }));
          }
        }
        assert.notEqual(decide(role, '/workspace', { kind: 'execute', title }, readOnly), 'allow');
        assert.equal(decide(role, '/workspace', { kind: 'other', title, rawInput: { query: 'hello' } }, readOnly), 'allow');
      }
    }
  }
});

test('Windows batch paths cannot expand environment variables', async (t) => {
  const { agentCommand } = await import('../plugin/bridge/config.ts');
  for (const bin of ['C:\\%AGENT%\\codex.cmd', 'agy%.BAT']) {
    assert.throws(() => agentCommand(bin, {}, 'win32'), /Invalid agent binary path/);
    assert.deepEqual(agentCommand(bin, {}, 'darwin'), { bin, shell: false });
  }
  const file = fs.statSync(import.meta.filename);
  t.mock.method(fs, 'statSync', () => file);
  assert.throws(() => agentCommand('codex', { PATH: 'C:\\%AGENT%', PATHEXT: '.CMD' }, 'win32'), /Invalid agent binary path/);
  assert.deepEqual(agentCommand('C:\\%AGENT%\\codex.exe', {}, 'win32'), { bin: 'C:\\%AGENT%\\codex.exe', shell: false });
});

test('only Windows agents launched through a shell need a tree kill command', async () => {
  const { treeKillCommand } = await import('../plugin/bridge/rpc.ts');
  assert.deepEqual(treeKillCommand(1234, true, 'win32'), { bin: 'taskkill', args: ['/pid', '1234', '/T', '/F'] });
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    assert.equal(treeKillCommand(1234, false, platform), null);
    if (platform !== 'win32') assert.equal(treeKillCommand(1234, true, platform), null);
    assert.equal(treeKillCommand(undefined, true, platform), null);
  }
});
