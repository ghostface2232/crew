import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Issues } from '../plugin/bridge/issues.ts';

const minute = 60_000;
const url = (n: number) => `https://github.com/Owner/Repo/issues/${n}`;
const row = (n: number, ...logins: string[]) => ({
  number: n, title: `Issue ${n}`, url: url(n), assignees: logins.map((login) => ({ login })),
  labels: [{ name: 'help wanted' }], updatedAt: new Date(n * minute).toISOString(),
});

function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-issues-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls: string[][] = [];
  const data = { rows: [] as ReturnType<typeof row>[], errorFor: '', login: 'Mona' };
  const gh = async (args: string[], cwd: string) => {
    calls.push(args);
    assert.equal(cwd, home);
    if (data.errorFor === args[0]) throw new Error('gh unavailable\nmore detail');
    switch (args[0]) {
      case 'repo':
        assert.deepEqual(args, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
        return 'Owner/Repo\n';
      case 'api':
        assert.deepEqual(args, ['api', 'user', '--jq', '.login']);
        return data.login;
      case 'issue':
        assert.deepEqual(args, ['issue', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,url,assignees,labels,updatedAt']);
        return JSON.stringify(data.rows);
      default: throw new Error(`Unexpected gh arguments: ${args}`);
    }
  };
  const open = () => new Issues(home, gh, async () => home);
  return { home, calls, data, open, issues: open() };
}

test('suggestions are assigned to me or unassigned, newest first within each group', async (t) => {
  const { data, issues, calls } = fixture(t);
  const first = row(9, 'other', 'MONA');
  first.title = 'a'.repeat(199) + '😀';
  first.labels = [{ name: '$(example)' }];
  data.rows = [row(15, 'else'), row(3, 'mona'), first, ...Array.from({ length: 12 }, (_, i) => row(20 + i))];
  const result = await issues.list('project');
  assert.deepEqual([result.project, result.repo, result.error], ['project', 'Owner/Repo', undefined]);
  assert.ok(Number.isFinite(result.checkedAt));
  assert.deepEqual(result.issues.map((i) => i.number), [9, 3, 31, 30, 29, 28, 27, 26, 25, 24]);
  assert.deepEqual(result.issues[0], {
    number: 9, title: 'a'.repeat(199), url: first.url, assignees: ['other', 'MONA'], labels: ['$(example)'], updatedAt: first.updatedAt,
  });
  data.rows = [];
  const empty = await issues.list('other project');
  assert.deepEqual([empty.repo, empty.issues], ['Owner/Repo', []]);
  assert.equal(calls.filter((args) => args[0] === 'api').length, 1);
});

test('concurrent checks share a request, including refreshes, and failures have the same cache limits', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 25) });
  const { data, issues, calls } = fixture(t);
  data.errorFor = 'repo';
  const count = () => calls.filter((args) => args[0] === 'repo').length;
  const [failure, shared] = await Promise.all([issues.list('p'), issues.list('p', true)]);
  assert.deepEqual(failure, { project: 'p', repo: null, issues: [], checkedAt: Date.now(), error: 'gh unavailable' });
  assert.deepEqual(shared, failure);
  data.errorFor = '';
  t.mock.timers.tick(minute - 1);
  assert.deepEqual(await issues.list('p', true), failure);
  assert.equal(count(), 1);
  t.mock.timers.tick(1);
  data.login = '';
  const signedOut = await issues.list('p', true);
  assert.match(signedOut.error!, /Sign in/);
  assert.deepEqual(signedOut.issues, []);
  t.mock.timers.tick(10 * minute - 1);
  data.login = 'mona';
  assert.deepEqual(await issues.list('p'), signedOut);
  assert.equal(count(), 2);
  t.mock.timers.tick(1);
  const result = await issues.list('p');
  assert.equal(result.error, undefined);
  assert.equal(count(), 3);
  await issues.list('p', true);
  assert.equal(count(), 3);
});

test('dismissals persist, remove an issue from every project, and reject unrelated URLs', async (t) => {
  const { issues, data, open, home, calls } = fixture(t);
  data.rows = [row(1), row(2)];
  await Promise.all(['project', 'subfolder'].map((p) => issues.list(p)));
  for (const invalid of [null, 4, 'http://github.com/o/r/issues/1', 'https://github.com.example/o/r/issues/1',
    'https://github.com@example.com/o/r/issues/1', 'https://github.com/o/r/pull/1', 'https://github.com/../r/issues/1']) {
    assert.throws(() => issues.dismiss(invalid), /HTTPS GitHub issue URL/);
  }
  const before = calls.length;
  issues.dismiss(url(2).toUpperCase() + '/');
  for (const p of ['project', 'subfolder']) assert.deepEqual((await issues.list(p)).issues.map((i) => i.number), [1]);
  assert.equal(calls.length, before);
  assert.deepEqual((await open().list('restarted')).issues.map((i) => i.number), [1]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'issues.json'), 'utf8')), { dismissed: [url(2).toLowerCase()] });
});

test('the newest 500 distinct dismissals survive and dismissing again renews an entry', (t) => {
  const { issues, home } = fixture(t);
  const file = path.join(home, 'issues.json');
  fs.writeFileSync(file, JSON.stringify({ dismissed: Array.from({ length: 500 }, (_, i) => url(i + 1)) }));
  issues.dismiss(url(1));
  issues.dismiss(url(501));
  const { dismissed } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(dismissed.length, 500);
  assert.equal(dismissed[0], url(3).toLowerCase());
  assert.deepEqual(dismissed.slice(-2), [url(1).toLowerCase(), url(501).toLowerCase()]);
});
