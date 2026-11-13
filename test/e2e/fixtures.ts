import type { BoardJob, BoardState } from '../../plugin/board/src/types.ts';

export const NOW = 1_795_000_000_000;
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
      },
    ],
    agents: {
      codex: { name: 'Codex', idPrefix: 'cx', resume: 'codex resume', reviewerRunsGit: true, enabled: true },
      antigravity: {
        name: 'Antigravity',
        idPrefix: 'ag',
        resume: 'agy --conversation',
        reviewerRunsGit: false,
        enabled: true,
      },
    },
    roles: { delegate: { agent: 'codex' }, review: { agent: 'codex' }, polish: { agent: 'antigravity' } },
    limits: { codex: { windows: [{ usedPercent: 42, minutes: 300 }] } },
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
