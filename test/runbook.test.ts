import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Job } from '../plugin/bridge/jobs.ts';
import type { Mission } from '../plugin/bridge/missions.ts';
import { runbook } from '../plugin/bridge/runbook.ts';

const mission: Mission = {
  id: 'm-1', title: 'Fix the parser', project: '/work/site', root: '/work/site', stage: 'final', stages: ['plan', 'implement', 'final'],
  state: 'done', outcome: 'Parser fixed', record: 'Kept the old tokenizer: the new one drops BOMs.', notes: [{ text: 'Use UTF-8 only', at: 1 }],
  createdAt: Date.UTC(2026, 10, 14), updatedAt: 0, endedAt: Date.UTC(2026, 10, 15),
};

const job = (over: Partial<Job>): Job => ({
  id: 'cx-aaaaaa', kind: 'delegate', agent: 'codex', title: 'Parser fix', state: 'done', mission: 'm-1', turns: 2, createdAt: 2, report: 'Fixed it.',
  result: { files: ['p.ts'], stat: '1 file changed', commit: 'abc1234', outOfScope: [] }, notes: [], error: null, ...over,
} as Job);

test('a runbook lists the record, the notes, and each job of the mission with what was checked', () => {
  const text = runbook(mission, [
    job({
      receipts: [
        { turn: 1, head: '1111111122', check: { command: 'npm test', exit: 1, timedOut: false, output: '', ms: 10, sandboxed: true }, stale: 'round 1 undone', at: 1 },
        { turn: 2, head: '2222222233', check: { command: 'npm test', exit: 0, timedOut: false, output: '', ms: 10, sandboxed: true }, at: 2 },
      ],
      refusals: [{ action: 'rm -rf ~/cache', reason: 'outside the workspace', turn: 1 }],
      approvals: [{ turn: 2, quote: 'ok', matched: true, recorded: 1, at: 3 }],
    }),
    job({ id: 'cx-bbbbbb', kind: 'review', title: 'Review', createdAt: 3, result: null, report: '', receipts: [{ turn: 1, head: '3333333344', reviewed: { target: 'uncommitted changes', diff: 'abc' }, at: 1 }] }),
    job({ id: 'cx-cccccc', mission: 'm-2', title: 'Other mission' }),
  ]);
  assert.match(text, /^# Fix the parser\n\nMission m-1 · done — Parser fixed · 2026-11-14 to 2026-11-15/);
  assert.match(text, /## Decisions and dead ends\n\nKept the old tokenizer/);
  assert.match(text, /## Notes pinned by the user\n\n- Use UTF-8 only/);
  assert.match(text, /- turn 1 check at 11111111: `npm test` failed \(exit 1\) \(later round 1 undone\)\n- turn 2 check at 22222222: `npm test` passed/);
  assert.match(text, /- turn 1 refused: `rm -rf ~\/cache` \(outside the workspace\)/);
  assert.match(text, /- turn 2: the lead relayed the user's approval, matching their words/);
  assert.match(text, /### cx-bbbbbb · Codex · review — Review\n\n[^]*- turn 1 reviewed uncommitted changes at 33333333/);
  assert.match(text, /<summary>Report<\/summary>\n\nFixed it\./);
  assert.doesNotMatch(text, /Other mission/);
});
