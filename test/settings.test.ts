import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { canonicalPath, effectiveRole, PRESETS, resolveConfig } from '../plugin/bridge/config.ts';
import { sharedInstructions } from '../plugin/bridge/instructions.ts';
import { appendInstructions, instructionsFile, readInstructions, saveLanguage, savePeerRatings, savePreset, saveRoles, writeInstructions } from '../plugin/bridge/settings.ts';

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

  const saved = saveRoles(home, { delegate: { agents: ['codex'], codex: { model: '', effort: 'high' } }, polish: { agents: ['codex'], codex: { model: '', effort: '' } }, refactor: { codex: { model: '' } } });
  const delegate = { agents: ['codex'], codex: { effort: 'high' } };
  assert.deepEqual(saved.roleSettings, { delegate, polish: { agents: ['codex'] } });
  assert.deepEqual(saved.roles, {
    delegate, refactor: delegate, release: delegate, debate: delegate, review: { agents: ['codex'] }, verify: { agents: ['codex'] }, fix: { agents: ['claude'] }, polish: { agents: ['codex'] },
  });
  // The table is replaced as a whole: a role left out goes back to its default.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    notify: false,
    codex: { bin: '/opt/codex', model: 'm' },
    roles: { delegate, polish: { agents: ['codex'] } },
  });

  // Works with no config file yet.
  const fresh = tempDir();
  saveRoles(fresh, { polish: { agents: ['codex'] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fresh, 'config.json'), 'utf8')), { roles: { polish: { agents: ['codex'] } } });
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

test('a project\'s shared instructions are not read through a symbolic link', () => {
  const home = tempDir();
  const secret = path.join(home, 'token');
  fs.writeFileSync(secret, 'SECRET');

  // The file is a link to something a worker may not read.
  const project = tempDir();
  fs.mkdirSync(path.join(project, '.crew'));
  fs.symlinkSync(secret, path.join(project, '.crew', 'instructions.md'));
  assert.throws(() => sharedInstructions(home, project), /is a symbolic link/);

  // The .crew folder is a link to a folder holding one.
  const other = tempDir();
  const elsewhere = tempDir();
  fs.writeFileSync(path.join(elsewhere, 'instructions.md'), 'SECRET');
  fs.symlinkSync(elsewhere, path.join(other, '.crew'));
  assert.throws(() => sharedInstructions(home, other), /is a symbolic link/);

  // The user's own file for every project may be a link: it is theirs.
  const mine = path.join(tempDir(), 'mine.md');
  fs.writeFileSync(mine, 'Prefer small diffs.');
  fs.symlinkSync(mine, path.join(home, 'instructions.md'));
  assert.equal(sharedInstructions(home, tempDir()).text, '## From the user, for every project\nPrefer small diffs.');
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

  const best = resolveConfig({ preset: 'best', roles: { review: { codex: { effort: 'low' } }, delegate: { codex: { model: 'own' } } } });
  assert.deepEqual(effectiveRole(best, 'delegate'), { agent: 'codex', model: 'own', effort: 'high' });
  assert.deepEqual(effectiveRole(best, 'review'), { agent: 'codex', effort: 'low' });
  // The built-in presets set Codex's effort only, and name no models.
  assert.deepEqual(effectiveRole(best, 'polish'), { agent: 'antigravity' });

  // A user's preset entry adds to the built-in one of the same name.
  const tuned = resolveConfig({ preset: 'economy', presets: { economy: { codex: { model: 'small' }, antigravity: { model: 'flash' } } } });
  assert.deepEqual(tuned.presets.economy, { codex: { effort: 'low', model: 'small' }, antigravity: { model: 'flash' }, subagentModel: 'haiku', subagentMax: 'sonnet', maxTier: 'standard' });
  assert.deepEqual(effectiveRole(tuned, 'delegate'), { agent: 'codex', model: 'small', effort: 'low' });
  assert.deepEqual(effectiveRole(tuned, 'polish'), { agent: 'antigravity', model: 'flash' });
  assert.deepEqual(tuned.presets.best, PRESETS.best);
});

test('a role without agents follows its parent; one with agents starts fresh', () => {
  const config = resolveConfig({ roles: { delegate: { codex: { model: 'gpt-x', effort: 'high' } }, refactor: { agents: ['antigravity'] }, debate: { codex: { effort: 'medium' } }, review: { agents: ['antigravity'] } } });
  // The parent's settings belong to its agents, so they never reach a role given other agents.
  assert.deepEqual(config.roles.refactor, { agents: ['antigravity'] });
  assert.deepEqual(config.roles.release, { agents: ['codex'], codex: { model: 'gpt-x', effort: 'high' } });
  assert.deepEqual(config.roles.debate, { agents: ['codex'], codex: { model: 'gpt-x', effort: 'medium' } });
  assert.deepEqual(config.roles.verify, { agents: ['antigravity'] });
  assert.throws(() => resolveConfig({ roles: { deploy: { agents: ['codex'] } } as never }), /roles\.deploy is not a role; use one of: delegate, refactor, release, debate, review, verify, fix, polish/);
  assert.throws(() => resolveConfig({ roles: { verify: { agent: 'cursor' } } as never }), /roles\.verify\.agent is "cursor"/);
  // Written before agents, a model that follows its parent's agent could reach an agent that does not have it.
  assert.throws(() => resolveConfig({ roles: { delegate: { agent: 'antigravity' }, refactor: { model: 'gpt-x' } } }), /roles\.refactor\.model needs roles\.refactor\.agent/);
  // Following its parent, a role's settings apply only while that agent holds it.
  assert.deepEqual(resolveConfig({ roles: { delegate: { agents: ['antigravity'] }, refactor: { codex: { model: 'gpt-x' } } } }).roles.refactor, { agents: ['antigravity'] });
});

test('a mission\'s preset replaces the global one for its jobs', () => {
  const config = resolveConfig({ preset: 'best', roles: { review: { codex: { effort: 'low' } } } });
  assert.deepEqual(effectiveRole(config, 'delegate', 'economy'), { agent: 'codex', effort: 'low' });
  assert.deepEqual(effectiveRole(config, 'delegate', null), { agent: 'codex' });
  // A role's own setting still wins.
  assert.deepEqual(effectiveRole(config, 'review', 'balanced'), { agent: 'codex', effort: 'low' });
});

test('a preset that is not exactly valid is refused', () => {
  assert.throws(() => resolveConfig({ preset: 'fast' as never }), /preset is "fast"; use one of: economy, balanced, best/);
  assert.equal(resolveConfig({}).presets.economy.maxTier, 'standard');
  assert.equal(resolveConfig({}).presets.economy.subagentMax, 'sonnet');
  assert.equal(resolveConfig({ presets: { best: { maxTier: 'light' } } }).presets.best.maxTier, 'light');
  assert.throws(() => resolveConfig({ presets: { best: { maxTier: 'huge' as never } } }), /presets\.best\.maxTier must be one of: fast, light, standard, frontier/);
  assert.throws(() => resolveConfig({ presets: { turbo: {} } as never }), /presets\.turbo is not a preset/);
  assert.throws(() => resolveConfig({ presets: { best: { codex: { speed: 'x' } } } as never }), /presets\.best\.codex\.speed is not a setting; use model or effort/);
  assert.deepEqual(effectiveRole(resolveConfig({ preset: 'best', presets: { best: { antigravity: { effort: 'high' } } } }), 'polish'), { agent: 'antigravity', effort: 'high' });
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

test('a role may hold Claude and several workers, each with its own settings', () => {
  const config = resolveConfig({ roles: {
    review: { agents: ['claude', 'antigravity', 'codex'], codex: { model: 'gpt-x', effort: 'high' }, antigravity: { model: 'gemini-y' } },
    verify: { codex: { effort: 'low' } },
    polish: { agents: ['claude'] },
  } });
  // Listed in one order whatever order they were written in, workers first.
  assert.deepEqual(config.roles.review, { agents: ['codex', 'antigravity', 'claude'], codex: { model: 'gpt-x', effort: 'high' }, antigravity: { model: 'gemini-y' } });
  // verify follows review's holders, with its own settings laid over review's for the same agent.
  assert.deepEqual(config.roles.verify, { agents: ['codex', 'antigravity', 'claude'], codex: { model: 'gpt-x', effort: 'low' }, antigravity: { model: 'gemini-y' } });
  assert.deepEqual(effectiveRole(config, 'review', null, 'antigravity'), { agent: 'antigravity', model: 'gemini-y' });
  // Named no holder, a job goes to the first worker.
  assert.deepEqual(effectiveRole(config, 'review', null), { agent: 'codex', model: 'gpt-x', effort: 'high' });
  assert.throws(() => effectiveRole(config, 'polish'), /held only by Claude, so a lead session takes it/);
  assert.throws(() => resolveConfig({ roles: { review: { agents: ['cursor'] } } as never }), /roles\.review\.agents must be a non-empty list of: codex, antigravity, claude/);
  assert.throws(() => resolveConfig({ roles: { review: { agents: [] } } }), /non-empty list/);
  assert.throws(() => resolveConfig({ roles: { review: { agents: ['codex', 'codex'] } } }), /names a holder twice/);
  assert.throws(() => resolveConfig({ roles: { review: { agents: ['codex'], antigravity: { speed: 'high' } } } as never }), /antigravity\.speed is not a setting; use model or effort/);
  assert.throws(() => resolveConfig({ roles: { review: { agent: 'codex', agents: ['codex'] } } as never }), /mixes agent with agents/);
  // Settings for an agent that does not hold the role are left out.
  assert.deepEqual(resolveConfig({ roles: { review: { agents: ['codex'], antigravity: { model: 'gemini-y' } } } }).roles.review, { agents: ['codex'] });
});

test('a role written before agents becomes a list of holders, the model going to its agent', () => {
  const config = resolveConfig({ roles: { review: { agent: 'antigravity', also: ['claude', 'codex'], model: 'gemini-y', effort: 'high' }, polish: { agent: 'claude', model: 'x' } } });
  assert.deepEqual(config.roles.review, { agents: ['codex', 'antigravity', 'claude'], antigravity: { model: 'gemini-y' } });
  assert.deepEqual(config.roleSettings.review, { agents: ['codex', 'antigravity', 'claude'], antigravity: { model: 'gemini-y' } });
  assert.deepEqual(config.roles.polish, { agents: ['claude'] });
  assert.throws(() => resolveConfig({ roles: { review: { also: ['cursor'] } } as never }), /roles\.review\.also must be a list of: codex, antigravity, claude/);
  // also alone added holders to those the role had unwritten, keeping their settings.
  const added = resolveConfig({ roles: { delegate: { agent: 'antigravity', model: 'gemini-y' }, refactor: { also: ['codex'], effort: 'low' }, review: { also: ['claude'] } } });
  assert.deepEqual(added.roles.refactor, { agents: ['codex', 'antigravity'], antigravity: { model: 'gemini-y' }, codex: { effort: 'low' } });
  assert.deepEqual(added.roles.review, { agents: ['codex', 'claude'] });
});

test('the interface language follows the system unless the file names one, and clearing it removes the key', () => {
  const home = tempDir();
  const file = path.join(home, 'config.json');
  assert.equal(resolveConfig({}).language, null);
  assert.throws(() => resolveConfig({ language: 'ja' as never }), /language is "ja"; use one of: en, ko/);
  fs.writeFileSync(file, JSON.stringify({ notify: false }));
  assert.deepEqual(saveLanguage(home, 'ko'), { language: 'ko' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { notify: false, language: 'ko' });
  assert.throws(() => saveLanguage(home, 'Korean'), /use one of: en, ko/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { notify: false, language: 'ko' });
  assert.deepEqual(saveLanguage(home, null), { language: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { notify: false });
});

test('peer ratings are on unless the file says false, and turning them back on removes the key', () => {
  const home = tempDir();
  const file = path.join(home, 'config.json');
  assert.equal(resolveConfig({}).peerRatings, true);
  assert.throws(() => resolveConfig({ peerRatings: 'false' as never }), /peerRatings must be true or false/);
  fs.writeFileSync(file, JSON.stringify({ notify: false }));
  assert.deepEqual(savePeerRatings(home, false), { peerRatings: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { notify: false, peerRatings: false });
  assert.throws(() => savePeerRatings(home, 'off'), /true or false/);
  assert.deepEqual(savePeerRatings(home, true), { peerRatings: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { notify: false });
});
