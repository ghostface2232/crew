import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runsCommands, WORKERS } from '../plugin/bridge/config.ts';
import type { WorkerAgent } from '../plugin/bridge/config.ts';
import type { JobSpec } from '../plugin/bridge/jobs.ts';
import { buildPrompt } from '../plugin/bridge/prompts.ts';

// Fixed paths, so a snapshot changes only when the wording does. Regenerate with:
//   node --test --test-update-snapshots test/prompts.test.ts
const CWD = '/repo';
const WORKTREE = { path: '/crew/worktrees/x', branch: 'crew-x', base: 'abc123' };
const SCRATCH = '/crew/scratch/x';
const DIFF = '/crew/diffs/x.diff';
const SHARED = 'Answer in English.';
const target = { type: 'uncommittedChanges' as const };

type Role = 'delegate' | 'review' | 'polish' | 'question';
interface Case { name: string; agent: WorkerAgent; role: Role; runsApp?: boolean; exclusive?: boolean; scratch?: boolean; native?: boolean }

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
  return buildPrompt(spec, worktree, diffFile, SHARED, c.scratch ? SCRATCH : undefined, runsCommands(c.agent, spec));
}

const cases: Case[] = [];
for (const agent of ['codex', 'antigravity'] as const) {
  for (const runsApp of [false, true]) for (const exclusive of [false, true]) cases.push({ name: `${agent} delegate${runsApp ? ' runs_app' : ''}${exclusive ? ' exclusive' : ''}`, agent, role: 'delegate', runsApp, exclusive });
  cases.push({ name: `${agent} polish`, agent, role: 'polish' });
}
// A read-only job on Codex gets a scratch directory; without one is how it ran before, and must still be coherent.
for (const scratch of [true, false]) {
  cases.push({ name: `codex question${scratch ? ' scratch' : ''}`, agent: 'codex', role: 'question', scratch });
  cases.push({ name: `codex review${scratch ? ' scratch' : ''}`, agent: 'codex', role: 'review', scratch });
}
cases.push({ name: 'codex review standard scratch', agent: 'codex', role: 'review', native: true, scratch: true });
cases.push({ name: 'codex review runs_app', agent: 'codex', role: 'review', runsApp: true });
cases.push({ name: 'antigravity question', agent: 'antigravity', role: 'question' });
cases.push({ name: 'antigravity review', agent: 'antigravity', role: 'review' });

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
      assert.ok(text.indexOf('# This machine is shared') < text.indexOf('# Running the app'));
    }
    if (c.role === 'question') assert.ok(has('Do not start the app') && !has('# Running the app'));
    // Measuring needs the machine rules to say it is allowed, and is only for an engineer.
    assert.equal(has('# Measurement'), Boolean(c.exclusive));
    // The shared instructions come last, subordinate to everything the role says.
    assert.ok(text.endsWith(SHARED) && text.indexOf('# Shared instructions') > text.indexOf('# Questions for the lead'));
  });
}
