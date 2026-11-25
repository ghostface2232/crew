import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './git.ts';
import { clip } from './text.ts';

export interface Issue {
  number: number;
  title: string;
  url: string;
  assignees: string[];
  labels: string[];
  updatedAt: string;
}

interface IssueList {
  project: string;
  repo: string | null;
  issues: Issue[];
  checkedAt: number;
  error?: string;
}

interface GhIssue extends Omit<Issue, 'assignees' | 'labels'> {
  assignees: { login: string }[];
  labels: { name: string }[];
}

const CACHE_MS = 10 * 60_000;
const ISSUE_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)\/?$/i;
type Gh = (args: string[], cwd: string) => Promise<string>;

function issueKey(url: unknown): string {
  const match = typeof url === 'string' && ISSUE_URL.exec(url);
  if (!match || [match[1], match[2]].some((part) => part === '.' || part === '..')) throw new Error('Expected an HTTPS GitHub issue URL.');
  return match[0].toLowerCase().replace(/\/$/, '');
}

export class Issues {
  private file: string;
  private gh: Gh;
  private root: typeof projectRoot;
  private cache = new Map<string, IssueList>();
  private pending = new Map<string, Promise<IssueList>>();
  private login?: { value: Promise<string>; at: number };
  private dismissed?: Set<string>;

  constructor(home: string, gh: Gh, root = projectRoot) {
    this.file = path.join(home, 'issues.json');
    this.gh = gh;
    this.root = root;
  }

  async list(project: string, refresh = false): Promise<IssueList> {
    const cached = this.cache.get(project);
    if (cached && Date.now() - cached.checkedAt < (refresh ? 60_000 : CACHE_MS)) return cached;
    const running = this.pending.get(project);
    if (running) return running;
    const request = this.read(project).finally(() => this.pending.delete(project));
    this.pending.set(project, request);
    return request;
  }

  private user(cwd: string): Promise<string> {
    if (!this.login || Date.now() - this.login.at >= CACHE_MS) {
      const value = this.gh(['api', 'user', '--jq', '.login'], cwd).then((text) => {
        if (!text.trim()) throw new Error('Sign in with gh auth login.');
        return text.trim().toLowerCase();
      }).catch((err) => {
        if (this.login?.value === value) this.login = undefined;
        throw err;
      });
      this.login = { value, at: Date.now() };
    }
    return this.login.value;
  }

  private async read(project: string): Promise<IssueList> {
    let repo: string | null = null;
    let answer: IssueList;
    try {
      const cwd = await this.root(project);
      if (!cwd) throw new Error('This project is outside a Git repository.');
      const name = (await this.gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], cwd)).trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error('No GitHub repository found for this project.');
      repo = name;
      const me = await this.user(cwd);
      const fields = 'number,title,url,assignees,labels,updatedAt';
      const rows: GhIssue[] = JSON.parse(await this.gh(['issue', 'list', '--state', 'open', '--limit', '50', '--json', fields], cwd));
      const dismissed = this.dismissals();
      const issues = rows.filter((row) => !dismissed.has(issueKey(row.url)) &&
        (!row.assignees.length || row.assignees.some((a) => a.login.toLowerCase() === me)))
        .sort((a, b) => Number(!!b.assignees.length) - Number(!!a.assignees.length) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, 10)
        .map(({ number, title, url, assignees, labels, updatedAt }) => ({
          number, title: clip(title, 200), url, assignees: assignees.map((a) => a.login), labels: labels.map((l) => l.name), updatedAt,
        }));
      answer = { project, repo, issues, checkedAt: Date.now() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      answer = { project, repo, issues: [], checkedAt: Date.now(), error: clip(message.split(/[\r\n]/, 1)[0], 200) || 'Could not read GitHub issues.' };
    }
    this.cache.set(project, answer);
    return answer;
  }

  private dismissals(): Set<string> {
    if (!this.dismissed) {
      try {
        const { dismissed } = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.dismissed = new Set(dismissed.map(issueKey));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        this.dismissed = new Set();
      }
    }
    return this.dismissed;
  }

  dismiss(url: unknown): void {
    const key = issueKey(url);
    const next = [...this.dismissals()].filter((old) => old !== key);
    next.push(key);
    const dismissed = next.slice(-500);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ dismissed }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.dismissed = new Set(dismissed);
    for (const answer of this.cache.values()) answer.issues = answer.issues.filter((issue) => issueKey(issue.url) !== key);
  }
}
