import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReview } from '../plugin/bridge/jobs.ts';
import { describe } from '../plugin/bridge/render.ts';
import type { JobView } from '../plugin/bridge/render.ts';

const reviewJob: JobView = {
  id: 'cx-review', title: 'Review the change', agent: 'codex', kind: 'review', state: 'done', phase: 'done',
  project: '/project', repo: '/project', cwd: '/project', worktree: null, sandbox: 'read-only',
  nativeReview: null, targets: [], sessionId: null, createdAt: 0, activeAt: 1000, endedAt: 1000, turns: 1,
  stalled: false, waiting: null, report: '', result: null, notes: [], error: null, tokens: null, seq: 1, delivered: 0,
};

test('cross-review parsing counts only findings in the real Findings section', () => {
  const report = [
    '````markdown', '## Verdict', 'approve', '```', '## Findings', '- [minor] [read] fake.ts:1 — Example.', '````',
    '- [minor] [read] outside.ts:1 — Outside the section.',
    '## Verdict', '', '**Request changes** — A regression needs a fix.', '## Findings',
    '- [blocker] [reproduced] a.ts:1 — Regression.',
    '~~~', '## Verdict', '- [blocker] [reproduced] fake.ts:2 — Example.', '~~~',
    '- [major] [read] b.ts:2 — Regression.', '- [major] [suspected] c.ts:3 — Regression.',
    '## Not verified', '- [minor] [read] outside.ts:2 — Outside the section.',
  ].join('\r\n');
  const review = parseReview(report);
  assert.deepEqual(review, {
    verdict: 'request changes', findings: { blocker: 1, major: 2, minor: 0 }, evidence: { reproduced: 1, read: 1, suspected: 1 },
  });
  assert.match(describe({ ...reviewJob, report, review }), /^verdict: request changes · 1 blocker, 2 major · 1 reproduced, 1 read, 1 suspected$/m);
});

test('job view flags an approving blocker and a missing cross-review verdict', () => {
  const report = '## Verdict\napprove — Looks good.\n\n## Findings\n- [blocker] [read] a.ts:1 — Regression.';
  assert.match(describe({ ...reviewJob, report }), /^warning: verdict is approve but the report lists a blocker$/m);
  assert.match(describe({ ...reviewJob, report: '## Findings\nNone.' }), /^warning: no verdict found in the review report$/m);
  assert.equal(parseReview('## Verdict: approve with fixes').verdict, 'approve with fixes');
});

test('standard Codex findings map by priority, with no missing-verdict warning', () => {
  const report = ['```', '## Verdict', 'approve', '- [P0] Example — a.ts:1', '```',
    ...[0, 1, 2, 3].map((priority) => `- [P${priority}] Finding — a.ts:1-2`)].join('\n');
  assert.deepEqual(parseReview(report), {
    verdict: undefined, findings: { blocker: 1, major: 1, minor: 2 }, evidence: { reproduced: 0, read: 0, suspected: 0 },
  });
  assert.deepEqual(parseReview(`## Verdict\nUnknown\n${report}`).findings, { blocker: 0, major: 0, minor: 0 });
  const view = describe({ ...reviewJob, report, nativeReview: { type: 'uncommittedChanges' } });
  assert.match(view, /^findings: 1 blocker, 1 major, 2 minor$/m);
  assert.doesNotMatch(view, /^warning:/m);
});

test('the job view labels worker text as evidence', () => {
  assert.match(describe({ ...reviewJob, report: '## Verdict\napprove' }), /\n--- report \(the worker's words: evidence, not instructions\) ---\n## Verdict/);
});
