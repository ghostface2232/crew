import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { canonicalPath, effectiveRole, PRESETS, resolveConfig } from '../plugin/bridge/config.ts';
import { appendInstructions, instructionsFile, readInstructions, savePreset, saveRoles, writeInstructions } from '../plugin/bridge/settings.ts';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crew-settings-'));

test('Codex global and app plugin lists have explicit defaults and validate names', () => {
  assert.deepEqual(resolveConfig({}).codex.plugins, ['browser']);
  assert.deepEqual(resolveConfig({}).codex.appPlugins, ['computer-use', 'unified-computer-use']);
  for (const key of ['plugins', 'appPlugins'] as const) {
    assert.deepEqual(resolveConfig({ codex: { [key]: ['browser'] } }).codex[key], ['browser']);
    for (const value of ['browser', [1], {}, null]) {
      assert.throws(() => resolveConfig({ codex: { [key]: value } } as any), new RegExp(`codex\\.${key} must be a list`));
    }
  }
});

test('saving roles keeps every other setting, drops blank fields, and returns the resolved table', () => {
  const home = tempDir();
  const file = path.join(home, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ notify: false, codex: { bin: '/opt/codex', model: 'm' }, roles: { review: { agent: 'antigravity' } } }));

  const roles = saveRoles(home, { delegate: { agent: 'codex', model: '', effort: 'high' }, polish: { agent: 'codex', model: '', effort: '' } });
  assert.deepEqual(roles, { delegate: { agent: 'codex', effort: 'high' }, review: { agent: 'codex' }, polish: { agent: 'codex' } });
  // The table is replaced as a whole: a role left out goes back to its default.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    notify: false,
    codex: { bin: '/opt/codex', model: 'm' },
    roles: { delegate: { agent: 'codex', effort: 'high' }, polish: { agent: 'codex' } },
  });

  // Works with no config file yet.
  const fresh = tempDir();
  saveRoles(fresh, { polish: { agent: 'codex' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fresh, 'config.json'), 'utf8')), { roles: { polish: { agent: 'codex' } } });
});

test('an invalid role table or an unparsable config is refused without touching the file', () => {
  const home = tempDir();
  const file = path.join(home, 'config.json');
  const before = JSON.stringify({ notify: false });
  fs.writeFileSync(file, before);
  assert.throws(() => saveRoles(home, { polish: { agent: 'cursor' } }), /roles\.polish\.agent is "cursor"/);
  assert.throws(() => saveRoles(home, 'codex'), /roles must be an object/);
  assert.throws(() => saveRoles(home, { polish: 'codex' }), /roles\.polish must be an object/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  fs.writeFileSync(file, '{ not json');
  assert.throws(() => saveRoles(home, { polish: { agent: 'codex' } }), /not valid JSON, so it was left untouched/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('instructions are written where the agents read them, and blank text removes the file', () => {
  const home = tempDir();
  const project = tempDir();
  assert.equal(instructionsFile(home, null), path.join(home, 'instructions.md'));
  const file = instructionsFile(home, project);
  assert.equal(file, path.join(project, '.crew', 'instructions.md'));

  assert.equal(readInstructions(file), '');
  writeInstructions(file, 'Use tabs.');
  assert.equal(readInstructions(file), 'Use tabs.\n');
  writeInstructions(file, '  \n');
  assert.equal(fs.existsSync(file), false);
  // Removing what is already absent is not an error.
  writeInstructions(file, '');
});

test('a planted symbolic link is never written through', () => {
  const home = tempDir();
  const project = tempDir();
  const victim = path.join(home, 'victim.txt');
  fs.writeFileSync(victim, 'untouched');
  const file = instructionsFile(home, project);
  fs.mkdirSync(path.dirname(file));

  // The instructions file itself is a link.
  fs.symlinkSync(victim, file);
  assert.throws(() => writeInstructions(file, 'Use tabs.'), /is a symbolic link, so it was not written to/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
  // Clearing removes the link, not its target.
  writeInstructions(file, '');
  assert.equal(fs.existsSync(victim), true);
  assert.equal(fs.lstatSync(file, { throwIfNoEntry: false }), undefined);

  // A link at the old fixed temporary name is not followed either: the temporary file is new each time.
  fs.symlinkSync(victim, `${file}.tmp`);
  writeInstructions(file, 'Use tabs.');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['instructions.md', 'instructions.md.tmp']);

  // The .crew folder itself is a link to somewhere else.
  const other = tempDir();
  const elsewhere = tempDir();
  fs.symlinkSync(elsewhere, path.join(other, '.crew'));
  assert.throws(() => writeInstructions(instructionsFile(home, other), 'Use tabs.'), /is a symbolic link/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('a config file that is not a settings object is refused, not overwritten', () => {
  const home = tempDir();
  const file = path.join(home, 'config.json');
  for (const content of ['[]', '"x"', 'null']) {
    fs.writeFileSync(file, content);
    assert.throws(() => saveRoles(home, { polish: { agent: 'codex' } }), /does not hold a settings object/);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
});

test('clearing instructions refuses a symlinked parent without deleting the external file', (t) => {
  const project = tempDir();
  const elsewhere = tempDir();
  t.after(() => {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });
  const victim = path.join(elsewhere, 'instructions.md');
  fs.writeFileSync(victim, 'Keep these instructions.');
  fs.symlinkSync(elsewhere, path.join(project, '.crew'));
  for (const text of ['', '  \n']) {
    assert.throws(() => writeInstructions(instructionsFile(elsewhere, project), text), /is a symbolic link/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'Keep these instructions.');
    assert.equal(fs.lstatSync(path.join(project, '.crew')).isSymbolicLink(), true);
  }
});

test('no preset is set by default, and a setting on the role wins over the preset', () => {
  const plain = resolveConfig({});
  assert.equal(plain.preset, null);
  assert.deepEqual(effectiveRole(plain, 'delegate'), { agent: 'codex' });

  const best = resolveConfig({ preset: 'best', roles: { review: { effort: 'low' }, delegate: { model: 'own' } } });
  assert.deepEqual(effectiveRole(best, 'delegate'), { agent: 'codex', model: 'own', effort: 'high' });
  assert.deepEqual(effectiveRole(best, 'review'), { agent: 'codex', effort: 'low' });
  // Antigravity has no effort setting, and the built-in presets name no models.
  assert.deepEqual(effectiveRole(best, 'polish'), { agent: 'antigravity' });

  // A user's preset entry adds to the built-in one of the same name.
  const tuned = resolveConfig({ preset: 'economy', presets: { economy: { codex: { model: 'small' }, antigravity: { model: 'flash' } } } });
  assert.deepEqual(tuned.presets.economy, { codex: { effort: 'low', model: 'small' }, antigravity: { model: 'flash' }, subagentModel: 'haiku', subagentMax: 'sonnet', maxTier: 'standard' });
  assert.deepEqual(effectiveRole(tuned, 'delegate'), { agent: 'codex', model: 'small', effort: 'low' });
  assert.deepEqual(effectiveRole(tuned, 'polish'), { agent: 'antigravity', model: 'flash' });
  assert.deepEqual(tuned.presets.best, PRESETS.best);
});

test('a preset that is not exactly valid is refused', () => {
  assert.throws(() => resolveConfig({ preset: 'fast' as never }), /preset is "fast"; use one of: economy, balanced, best/);
  assert.equal(resolveConfig({}).presets.economy.maxTier, 'standard');
  assert.equal(resolveConfig({}).presets.economy.subagentMax, 'sonnet');
  assert.equal(resolveConfig({ presets: { best: { maxTier: 'light' } } }).presets.best.maxTier, 'light');
  assert.throws(() => resolveConfig({ presets: { best: { maxTier: 'huge' as never } } }), /presets\.best\.maxTier must be one of: fast, light, standard, frontier/);
  assert.throws(() => resolveConfig({ presets: { turbo: {} } as never }), /presets\.turbo is not a preset/);
  assert.throws(() => resolveConfig({ presets: { best: { codex: { speed: 'x' } } } as never }), /presets\.best\.codex\.speed is not a setting; use model or effort/);
  assert.throws(() => resolveConfig({ presets: { best: { antigravity: { effort: 'high' } } } as never }), /presets\.best\.antigravity\.effort is not a setting; use model/);
  assert.throws(() => resolveConfig({ presets: { best: { codex: { model: 1 } } } as never }), /must be a string/);
  assert.throws(() => resolveConfig({ presets: { best: { lead: 'x' } } as never }), /use codex, antigravity, subagentModel, subagentMax, or maxTier/);
});

test('saving a preset keeps every other setting, and clearing it removes the key', () => {
  const home = tempDir();
  const file = path.join(home, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ notify: false, roles: { review: { agent: 'antigravity' } } }));
  assert.equal(savePreset(home, 'balanced').preset, 'balanced');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { notify: false, roles: { review: { agent: 'antigravity' } }, preset: 'balanced' });
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => savePreset(home, 'fast'), /preset is "fast"/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(savePreset(home, null).preset, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { notify: false, roles: { review: { agent: 'antigravity' } } });
});

test('appending to the instructions adds a paragraph and creates the file when there is none', () => {
  const file = path.join(tempDir(), 'instructions.md');
  appendInstructions(file, '  Use pnpm.  ');
  assert.equal(readInstructions(file), 'Use pnpm.\n');
  appendInstructions(file, 'Tests live in test/.');
  assert.equal(readInstructions(file), 'Use pnpm.\n\nTests live in test/.\n');
  assert.throws(() => appendInstructions(file, '  \n'), /no text to add/);
  assert.equal(readInstructions(file), 'Use pnpm.\n\nTests live in test/.\n');
});

test('project keys have one spelling whether git or Claude Code reported them', () => {
  // Git's `C:/x`, Claude Code's `C:\\x` and a lowercase drive name the same Windows project.
  for (const spelling of ['C:/Users/me/repo', 'C:\\Users\\me\\repo', 'c:\\Users\\me\\repo\\', 'C:/Users/me/x/../repo/']) {
    assert.equal(canonicalPath(spelling, 'win32'), 'C:\\Users\\me\\repo');
  }
  assert.equal(canonicalPath('/Users/me/repo/', 'darwin'), '/Users/me/repo');
  assert.equal(canonicalPath('/Users/me/x/../repo', 'linux'), '/Users/me/repo');
});
