import type { News } from './delivery.ts';

/** The fields every query asks `gh pr view` for. */
export const PULL_FIELDS = 'url,number,title,state,headRefOid,mergeable,reviewDecision,author,statusCheckRollup,reviews';

/** A check run or commit status, as `gh pr view --json statusCheckRollup` lists it. */
export interface PullCheck {
  __typename: 'CheckRun' | 'StatusContext';
  /** CheckRun */
  name?: string;
  workflowName?: string;
  status?: string;
  conclusion?: string;
  /** StatusContext */
  context?: string;
  state?: string;
}

export interface PullReview {
  id: string;
  author?: { login?: string };
  state: string;
  body?: string;
}

/** One answer of `gh pr view <url> --json` with PULL_FIELDS. */
export interface PullView {
  url: string;
  number: number;
  title: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  headRefOid: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  reviewDecision: string;
  author?: { login?: string };
  statusCheckRollup?: PullCheck[] | null;
  reviews?: PullReview[] | null;
}

/**
 * A pull request linked to a mission: what was last observed of it, and what its lead has already been told, so
 * that a poll sends only what is new. A mission's pull requests are the watches that name it, as its jobs are.
 */
export interface PullWatch {
  /** `pr-` and six hex digits: the subject id its news and receipts carry. */
  id: string;
  /** The pull request's page, which every query after the link names. */
  url: string;
  /** owner/name */
  repo: string;
  number: number;
  title: string;
  mission: string;
  /** The mission's owner session when the pull request was linked. Its news goes there; without one nothing is delivered. */
  lead?: string;
  state: 'open' | 'merged' | 'closed';
  /** No longer polled: the pull request ended, or its mission was abandoned or forgotten. */
  ended?: true;
  /** The head commit last observed. */
  head: string;
  /** The head's checks as last observed. `none` also covers a head whose only checks were cancelled or skipped. */
  checks: 'none' | 'pending' | 'failing' | 'passing';
  /** GitHub's review decision in lower case (`approved`, `changes_requested`, `review_required`), or empty. */
  review: string;
  conflict: boolean;
  /** The failed checks already sent for `told.head`, so one failure is sent once. */
  told: { head: string; checks: string[] };
  /** Distinct heads in the current run of failures for which a check failure was recorded. Back to 0 when a head passes. */
  failingHeads: number;
  /** Set at the third such head: later check failures are recorded but not sent, until a head passes or the lead links the pull request again. */
  held?: true;
  /** A conflict was sent, and the pull request has not been mergeable since. */
  conflictTold?: true;
  /** Ids of the reviews already seen, oldest first. */
  reviews: string[];
  news?: News[];
  newsSeq?: number;
  createdAt: number;
  /** The last poll that got an answer, and the last that found a change. */
  checkedAt: number;
  changedAt: number;
  /** Why the last poll failed, until one succeeds. */
  error?: string;
}

/** What the watches need of the daemon. */
export interface PullDeps {
  /** Runs `gh` with these arguments and resolves with what it printed; rejects with its error text. */
  gh(args: string[], cwd?: string): Promise<string>;
  /** The mission as the daemon knows it now; undefined once it is forgotten. */
  mission(id: string): { state: 'active' | 'done' | 'abandoned'; owner?: string; root: string } | undefined;
  /** Whether that lead session is open in Claude Code now. A closed session's pull requests are not polled. */
  present(session: string): boolean;
  /** Writes the snapshot that holds the watches, their news and the receipts; throws when it cannot. */
  save(): void;
  /** A watch gained news, or changed in what is shown of it. */
  changed(watch: PullWatch): void;
  now?(): number;
}

/**
 * Applies one observation to a watch and returns the news it calls for, oldest first. It changes the watch's
 * memory (`told`, `failingHeads`, `held`, `conflictTold`, `reviews`) and what is shown (`state`, `head`, `checks`,
 * `review`, `conflict`, `title`, `ended`), and nothing else: the caller adds the news and saves.
 */
export function observe(_watch: PullWatch, _view: PullView): { kind: News['kind']; reason: string }[] {
  throw new Error('not implemented');
}

export class Pulls {
  constructor(_deps: PullDeps) {}

  list(): PullWatch[] {
    throw new Error('not implemented');
  }

  /**
   * Links a pull request (`12`, `#12` or its URL) to a mission and observes it once without sending news: `summary`
   * says what stands now. Linking the same pull request to the same mission again returns the watch it has, and
   * lifts `held` if it was set (`resumed`).
   */
  async link(_mission: string, _ref: string): Promise<{ watch: PullWatch; resumed: boolean; summary: string }> {
    throw new Error('not implemented');
  }

  /** Polls every watch that is due, one at a time. `session`: that lead session just appeared, so its watches are due now. */
  async tick(_session?: string): Promise<void> {
    throw new Error('not implemented');
  }

  /** What the snapshot keeps. `named` holds the subject ids an unacknowledged receipt still names. */
  saved(_named: Set<string>): PullWatch[] {
    throw new Error('not implemented');
  }

  /** Takes the watches a snapshot held; anything that is not a watch is left out. */
  restore(_saved: unknown): void {
    throw new Error('not implemented');
  }
}
