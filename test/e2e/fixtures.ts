import { resolveConfig, ROLE_INFO } from '../../plugin/bridge/config.ts';
import type { BoardJob, BoardState } from '../../plugin/board/src/types.ts';

export const NOW = 1_795_000_000_000;
/** The ticket a launch address carries, and what the fixture server gives a page for it. */
export const TEST_TICKET = '0123456789abcdef'.repeat(4);
export const TEST_CREDENTIAL = `board.1.${'fedcba9876543210'.repeat(4)}`;
export function job(overrides: Partial<BoardJob> = {}): BoardJob {
  return {
    id: 'cx-build',
    kind: 'delegate',
    agent: 'codex',
    title: 'Build the agent board',
    state: 'running',
    phase: 'Checking the data flow',
    repo: '/workspace/Crew',
    project: '/workspace/Crew',
    root: '/workspace/Crew',
    mission: 'mission-1',
    cwd: '/workspace/Crew',
    worktree: { path: '/tmp/crew-worktree', branch: 'crew-cx-build', base: 'abc123456789' },
    sandbox: 'workspace-write',
    nativeReview: null,
    targets: [],
    sessionId: 'thread-1',
    createdAt: NOW - 300_000,
    activeAt: NOW - 1000,
    endedAt: null,
    turns: 1,
    rounds: [{ turn: 1, commit: 'abc123', files: ['src/board.ts'], stat: '1 file changed, 8 insertions(+)', state: 'kept', at: NOW - 120_000 }],
    stalled: false,
    waiting: null,
    report: '',
    result: null,
    notes: [],
    error: null,
    tokens: 12000,
    seq: 1,
    delivered: 0,
    ...overrides,
  };
}
export function fixture(): BoardState {
  return {
    now: NOW,
    jobs: [
      job(),
      job({
        id: 'cx-question',
        kind: 'review',
        title: '한글 입력과 아주 긴 작업 제목이 여러 줄로 이어질 때에도 승인과 질문을 잃지 않도록 검증해요',
        state: 'waiting',
        waiting: {
          id: 'request-1',
          type: 'question',
          reason: 'Should the view preserve the current selection?\n현재 선택한 항목을 유지할까요? <question>',
          since: NOW - 60_000,
        },
      }),
    ],
    missions: [
      {
        id: 'mission-1',
        title: 'Make the agent board a desktop app',
        project: '/workspace/Crew',
        root: '/workspace/Crew',
        owner: 'lead-1',
        state: 'active',
        stage: 'implement',
        outcome: '',
        notes: [{ text: 'Keep keyboard navigation available.', at: NOW - 60_000 }],
        createdAt: NOW - 600_000,
        updatedAt: NOW - 1000,
        endedAt: null,
      },
    ],
    claude: [
      {
        id: 'lead-1',
        cwd: '/workspace/Crew',
        root: '/workspace/Crew',
        title: 'Desktop migration',
        state: 'working',
        phase: 'Reviewing the implementation',
        waitingFor: null,
        inTool: false,
        stalled: false,
        startedAt: NOW - 600_000,
        activeAt: NOW - 1000,
        agents: [],
        workflows: [],
      },
      {
        id: 'lead-2',
        cwd: '/workspace/Other',
        title: 'Other project',
        state: 'idle',
        phase: '',
        waitingFor: null,
        inTool: false,
        stalled: false,
        startedAt: NOW - 600_000,
        activeAt: NOW - 1000,
        agents: [],
        workflows: [],
      },
    ],
    agents: {
      codex: { name: 'Codex', idPrefix: 'cx', resume: 'codex resume', reviewerRunsGit: true, readOnlyScratch: true, enabled: true },
      antigravity: {
        name: 'Antigravity',
        idPrefix: 'ag',
        resume: 'agy --conversation',
        reviewerRunsGit: false, readOnlyScratch: false,
        enabled: true,
      },
    },
    roles: resolveConfig({}).roles,
    roleSettings: {},
    roleInfo: ROLE_INFO,
    limits: { codex: { windows: [{ usedPercent: 42, minutes: 300 }] } },
    modelScores: [
      { model: 'gpt-6.1-sol', agent: 'codex', score: 8.6, build: 8.6, fix: 7.9, samples: 12, buildSamples: 9, difficulty: { hard: 3, standard: 5, routine: 1 }, fixSamples: 3, reviewSamples: 0, items: { correctness: 8.6, brief: null, report: null, findings: null }, ratings: 0, status: 'settled', summary: 'Solid logic; misses time zone edge cases.', lastAt: NOW, consolidate: false, adoption: { judged: 8, asIs: 6, afterReply: 2, partly: 0, rejected: 0, rounds: 3 } },
      { model: 'gemini-4-hydrogen', agent: 'antigravity', score: 7.8, build: 7.8, fix: null, samples: 5, buildSamples: 5, difficulty: { hard: 0, standard: 1, routine: 4 }, fixSamples: 0, reviewSamples: 0, items: { correctness: 7.8, brief: null, report: null, findings: null }, ratings: 0, status: 'on trial', summary: '', lastAt: NOW, consolidate: false, adoption: null },
      { model: 'gpt-6-astra', agent: 'codex', score: 6.1, build: 6.1, fix: 7.2, samples: 9, buildSamples: 6, difficulty: { hard: 2, standard: 4, routine: 0 }, fixSamples: 3, reviewSamples: 0, items: { correctness: 6.1, brief: null, report: null, findings: null }, ratings: 0, status: 'settled', summary: 'Ambitious UI work; often edits beyond the task.', lastAt: NOW, consolidate: false, adoption: null },
      { model: 'claude-opus-5-5', agent: 'claude', score: null, build: null, fix: 7.6, samples: 2, buildSamples: 0, difficulty: { hard: 0, standard: 0, routine: 0 }, fixSamples: 2, reviewSamples: 0, items: { correctness: null, brief: null, report: null, findings: null }, ratings: 0, status: 'too few samples', summary: '', lastAt: NOW, consolidate: false, adoption: null },
      { model: 'gpt-6.2-astra', agent: 'codex', score: null, build: null, fix: null, samples: 2, buildSamples: 0, difficulty: { hard: 0, standard: 0, routine: 0 }, fixSamples: 0, reviewSamples: 2, items: { correctness: null, brief: null, report: null, findings: 6.4 }, ratings: 0, status: 'too few samples', summary: '', lastAt: NOW, consolidate: false, adoption: null },
    ],
    preset: 'balanced',
    presets: {
      economy: { codex: { model: 'small', effort: 'low' }, antigravity: { model: 'flash' }, subagentModel: 'haiku' },
      balanced: { codex: { model: 'standard', effort: 'medium' }, antigravity: { model: 'pro' }, subagentModel: 'sonnet' },
      best: { codex: { model: 'large', effort: 'high' }, antigravity: { model: 'pro' }, subagentModel: 'inherit' },
    },
    usage: {
      source: 'agentgauge', generatedAt: NOW,
      providers: [
        { agent: 'claude', plan: null, capturedAt: NOW, status: 'tight', reason: 'Little room remains.', windows: [
          { key: 'fiveHour', kind: 'fiveHour', group: null, usedRatio: 0.25, resetTime: NOW + 3600_000, durationSec: 18000, projectedExhaustion: null, status: 'ok' },
          { key: 'weekly', kind: 'weekly', group: null, usedRatio: 0.9, resetTime: NOW + 86400_000, durationSec: 604800, projectedExhaustion: NOW + 7200_000, status: 'tight' },
          { key: 'fable', kind: 'weekly', group: 'Fable', usedRatio: 0.3, resetTime: NOW + 86400_000, durationSec: 604800, projectedExhaustion: null, status: 'stale' },
        ] },
        { agent: 'codex', plan: null, capturedAt: NOW, status: 'exhausted', reason: 'The account limit is reached.', windows: [
          { key: 'fiveHour', kind: 'fiveHour', group: null, usedRatio: 1, resetTime: NOW + 3600_000, durationSec: 18000, projectedExhaustion: null, status: 'exhausted' },
        ] },
        { agent: 'antigravity', plan: null, capturedAt: null, status: 'unknown', reason: 'No recent reading.', windows: [
          { key: 'billingCycle', kind: 'billingCycle', group: null, usedRatio: 0, resetTime: null, durationSec: null, projectedExhaustion: null, status: 'unknown' },
        ] },
      ],
    },
    events: [
      {
        seq: 1,
        ts: new Date(NOW - 60_000).toISOString(),
        agent: 'codex',
        session_id: 'thread-1',
        job_id: 'cx-build',
        kind: 'started',
        detail: 'Started in an isolated worktree',
      },
    ],
  };
}
