import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runsCommands, WORKERS } from '../plugin/bridge/config.ts';
import type { WorkerAgent } from '../plugin/bridge/config.ts';
import type { JobSpec } from '../plugin/bridge/jobs.ts';
import { buildPrompt } from '../plugin/bridge/prompts.ts';
import { findSkills, listSkills } from '../plugin/bridge/skills.ts';

// Fixed paths, so a snapshot changes only when the wording does. Regenerate with:
//   node --test --test-update-snapshots test/prompts.test.ts
const CWD = '/repo';
const WORKTREE = { path: '/crew/worktrees/x', branch: 'crew-x', base: 'abc123' };
const SCRATCH = '/crew/scratch/x';
const DIFF = '/crew/diffs/x.diff';
const SHARED = 'Answer in English.';
const target = { type: 'uncommittedChanges' as const };

type Role = 'delegate' | 'review' | 'polish' | 'question';
interface Case { name: string; agent: WorkerAgent; role: Role; runsApp?: boolean; exclusive?: boolean; scratch?: boolean; native?: boolean; skills?: boolean }
const SKILL = { name: 'better-ui', description: 'Polishes surfaces.', file: '/skills/better-ui/SKILL.md' };

/** Arguments the way Jobs.start derives them; the combinations it refuses are not listed. */
function build(c: Case) {
  const spec: JobSpec = c.role === 'question' ? { kind: 'delegate', cwd: CWD, ask: true, task: 'How does it work?' }
    : c.role === 'review' ? { kind: 'review', cwd: CWD, review: { target, mode: c.native ? 'standard' : 'adversarial' }, task: 'The parser.' }
      : c.role === 'polish' ? { kind: 'polish', cwd: CWD, targets: ['README.md'] }
        : { kind: 'delegate', cwd: CWD, task: 'Add a flag.', done_when: 'Tests pass.' };
  if (c.runsApp) spec.runsApp = true;
  if (c.exclusive) spec.exclusive = true;
  const worktree = (spec.kind !== 'review' && !spec.ask) || c.runsApp ? WORKTREE : null;
  const diffFile = spec.kind === 'review' && !WORKERS[c.agent].reviewerRunsGit ? DIFF : null;
  return buildPrompt(spec, worktree, diffFile, SHARED, c.scratch ? SCRATCH : undefined, runsCommands(c.agent, spec), c.skills ? [SKILL] : []);
}

const cases: Case[] = [];
for (const agent of ['codex', 'antigravity'] as const) {
  for (const runsApp of [false, true]) for (const exclusive of [false, true]) cases.push({ name: `${agent} delegate${runsApp ? ' runs_app' : ''}${exclusive ? ' exclusive' : ''}`, agent, role: 'delegate', runsApp, exclusive });
  cases.push({ name: `${agent} polish`, agent, role: 'polish' });
}
// A read-only job on Codex always gets a scratch directory. The cases without one are how it ran before, which
// Jobs.start no longer produces; they stay because buildPrompt still has to make sense without one.
for (const scratch of [true, false]) {
  cases.push({ name: `codex question${scratch ? ' scratch' : ''}`, agent: 'codex', role: 'question', scratch });
  cases.push({ name: `codex review${scratch ? ' scratch' : ''}`, agent: 'codex', role: 'review', scratch });
}
cases.push({ name: 'codex review standard scratch', agent: 'codex', role: 'review', native: true, scratch: true });
cases.push({ name: 'codex review runs_app', agent: 'codex', role: 'review', runsApp: true });
cases.push({ name: 'antigravity question', agent: 'antigravity', role: 'question' });
cases.push({ name: 'antigravity review', agent: 'antigravity', role: 'review' });
// Skills the lead picked, for a worker that runs commands and for one that only reads.
cases.push({ name: 'codex delegate skills', agent: 'codex', role: 'delegate', skills: true });
cases.push({ name: 'antigravity polish skills', agent: 'antigravity', role: 'polish', skills: true });

for (const c of cases) {
  test(`instructions for ${c.name}`, (t) => {
    const built = build(c);
    // Plain text, so a change reads as a wording diff.
    t.assert.snapshot(`${built.instructions}\n\n----- prompt -----\n\n${built.prompt}`, { serializers: [(v) => v] });
    const text = built.instructions;
    const has = (s: string) => text.includes(s);
    const commands = c.role === 'delegate' || c.agent === 'codex';

    // A worker that can start nothing is not told how to share the machine, what it may run, or to run checks.
    assert.equal(has('# This machine is shared'), commands);
    if (!commands) {
      assert.ok(!has('# What you can run') && !has('# Running the app') && !has('running checks that end by themselves'));
    }
    // Write here, or write nothing: never both.
    if (has('# What you can run')) {
      assert.match(text, /if you were given a directory of your own/i, 'the role must allow the writes the scratch note invites');
      assert.ok(!has('You cannot run anything in this role'));
      assert.ok(!has('# Running the app'), 'a writable sandbox is not a scratch directory');
    }
    if (c.role === 'question' || (c.role === 'review' && !c.runsApp)) {
      assert.equal(has('# What you can run'), Boolean(c.scratch));
    }
    // Starting the app and staying static exclude each other; the app rules point back to the machine rules.
    if (has('# Running the app')) {
      assert.ok(!has('# Static review'));
      assert.ok(has('# This machine is shared') && text.indexOf('# This machine is shared') < text.indexOf('# Running the app'));
    }
    if (c.role === 'question') assert.ok(has('Do not start the app') && !has('# Running the app'));
    // Measuring needs the machine rules to say it is allowed, and is only for an engineer.
    assert.equal(has('# Measurement'), Boolean(c.exclusive));
    assert.equal(has('# Skills for this task'), Boolean(c.skills));
    // The shared instructions come last, subordinate to everything the role says.
    assert.ok(text.endsWith(SHARED) && text.indexOf('# Shared instructions') > text.indexOf('# Questions for the lead'));
  });
}

test('the lead picks skills by name from the installed ones', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'better-ui'));
  fs.writeFileSync(path.join(root, 'better-ui', 'SKILL.md'), '---\nname: better-ui\ndescription: Polishes surfaces.\n---\n\n# UI polish\ndescription: not this one\n');
  fs.mkdirSync(path.join(root, 'notes'));
  fs.writeFileSync(path.join(root, 'better-ui.zip'), '');

  assert.deepEqual(listSkills(root), ['better-ui']);
  assert.deepEqual(findSkills(['better-ui', 'better-ui'], root), [{ name: 'better-ui', description: 'Polishes surfaces.', file: path.join(root, 'better-ui', 'SKILL.md') }]);
  assert.deepEqual(findSkills([], root), []);
  // A wrong name is refused with what there is, not dropped: the lead believes the worker has it.
  assert.throws(() => findSkills(['better-ux'], root), /Unknown skill\(s\): better-ux\. Installed in .*: better-ui\./);
  assert.throws(() => findSkills(['../notes'], root), /Unknown skill/);
  assert.deepEqual(listSkills(path.join(root, 'missing')), []);
  // Only a leading frontmatter counts; a block value is joined onto one line, and an empty one stays empty.
  const describe = (text: string) => {
    fs.mkdirSync(path.join(root, 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'x', 'SKILL.md'), text);
    return findSkills(['x'], root)[0].description;
  };
  assert.equal(describe('---\ndescription: "Quoted: yes"\n---\n'), 'Quoted: yes');
  assert.equal(describe('---\ndescription: >\n  Folded\n  over two.\nname: x\n---\n'), 'Folded over two.');
  assert.equal(describe('---\ndescription: |-\n  Literal.\n---\n'), 'Literal.');
  assert.equal(describe('---\ndescription:\nlicense: MIT\n---\n'), '');
  assert.equal(describe('# Title\n---\ndescription: body\n---\n'), '');
});

