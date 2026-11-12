import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { instructionsFile, readInstructions, saveRoles, writeInstructions } from '../plugin/bridge/settings.ts';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crew-settings-'));

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
