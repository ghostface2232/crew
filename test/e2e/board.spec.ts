import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { resolveConfig } from '../../plugin/bridge/config.ts';
import type { BoardPull, Mission } from '../../plugin/board/src/types.ts';
import { fixture, job, NOW, TEST_CREDENTIAL, TEST_TICKET } from './fixtures.ts';

test.beforeEach(async ({ page, request }) => {
  await request.post('/__reset');
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto('/');
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
});
// The pages sit in the top bar; narrow windows name only the current one.
const needsYou = (page: Page) => page.getByRole('navigation', { name: 'Pages' }).getByRole('button', { name: /^Needs You/ }).filter({ visible: true }).click();
const openSettings = async (page: Page, tab?: string) => {
  // Narrow windows fold the sidebar away behind its toolbar button.
  const toggle = page.getByRole('button', { name: 'Show sidebar' });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  if (tab) await settingsPage(page, tab);
};
const settingsPage = (page: Page, name: string) => page.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name, exact: true }).click();
const newJob = (page: Page) => page.getByRole('button', { name: 'New Job', exact: true }).click();
/** Picks an option by its text from one of the board's own selects. */
const pick = async (select: Locator, option: string) => {
  await select.click();
  await select.page().getByRole('listbox').getByRole('option', { name: option, exact: true }).click();
};
/** The options one of the board's selects offers, read by opening it and closing it again. */
const optionsOf = async (select: Locator) => {
  await select.click();
  const list = select.page().getByRole('listbox');
  await expect(list).toBeVisible();
  const options = await list.getByRole('option').allTextContents();
  await select.page().keyboard.press('Escape');
  return options;
};
/** The body of the last request to a route, once it has arrived: settings are stored as they are changed, with no save to wait on. */
const lastBody = (request: APIRequestContext, route: string) => expect.poll(async () =>
  (await (await request.get('/__requests')).json()).findLast((call: { route: string }) => call.route === route)?.body);
/** Types a setting and leaves the field, which is when it is stored. */
const type = async (field: Locator, text: string) => {
  await field.fill(text);
  await field.press('Enter');
};
// A folding stage's heading is named by its button, which adds the job count: "Review, 2 jobs".
const stage = (card: Locator, name: string) =>
  card.locator('.stage-groups > .rows').filter({ has: card.page().getByRole('heading', { name: new RegExp(`^${name}(, \\d+ jobs?)?$`) }) });

test('a shared lead appears on one mission and linked pulls show when their status is stale', async ({ page, request }, testInfo) => {
  const data = fixture();
  const focused = data.missions[0];
  const taskStates: NonNullable<Mission['tasks']>[number]['state'][] = ['done', 'done', 'doing', 'todo', 'todo', 'dropped'];
  data.missions.push({
    ...focused, id: 'mission-follow-up', title: 'Verify the desktop release', stage: 'final',
    createdAt: NOW - 180_000, notes: undefined,
    tasks: taskStates.map((state, index) => ({ id: `task-${index}`, title: `Task ${index}`, state })),
  });
  data.claude[0].mission = focused.id;
  const pull: BoardPull = {
    id: 'pr-42', url: 'https://github.com/example/crew/pull/42', repo: 'example/crew', number: 42,
    title: 'Verify the desktop release', mission: 'mission-follow-up', state: 'open', head: 'abc',
    checks: 'failing', review: 'changes_requested', conflict: true,
    told: { head: 'abc', checks: ['build'] }, failingHeads: 1,
    createdAt: NOW - 180_000, checkedAt: NOW - 60_000, changedAt: NOW - 60_000,
  };
  data.pulls = [pull];
  await request.post('/__push', { data: { type: 'state', data } });
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Crew', exact: true }).click();
  const focusedCard = page.locator('[data-key="mission-1"]');
  const newerCard = page.locator('[data-key="mission-follow-up"]');
  const lead = '[data-session="lead-1"]';
  await expect(focusedCard.locator(lead)).toBeVisible();
  await expect(newerCard.locator(lead)).toHaveCount(0);
  await expect(newerCard.locator('.mission-meta').first()).toContainText('2/5 tasks');
  // The most urgent status names the chip, and the others the lead must act on are counted.
  const chip = newerCard.getByRole('link', { name: 'Pull request example/crew #42: Verify the desktop release · Conflict · Checks failing · Changes requested' });
  await expect(chip).toHaveAttribute('href', pull.url);
  await expect(chip).toHaveText('#42Conflict+2');
  await expect(chip).toHaveAttribute('data-state', 'failed');
  await page.screenshot({ path: testInfo.outputPath('lead-mission-placement.png'), animations: 'disabled' });

  const push = (next: BoardPull) => request.post('/__push', { data: { type: 'pull', data: next } });
  await push({ ...pull, checkedAt: NOW - 16 * 60_000 });
  await push({ ...pull, id: 'pr-43', number: 43, url: 'https://github.com/example/crew/pull/43', review: '', conflict: false });
  await push({ ...pull, id: 'pr-44', number: 44, url: 'https://github.com/example/crew/pull/44', checks: 'pending', review: 'approved', conflict: false });
  await push({ ...pull, id: 'pr-45', number: 45, url: 'https://github.com/example/crew/pull/45', state: 'merged' });
  const chips = newerCard.locator('.pull-chip');
  await expect(chips).toHaveText(['#42Conflict+216m', '#43Checks failing', '#44Checks running', '#45Merged']);
  // A stale chip keeps its words but not its color.
  await expect(chips.first()).toHaveAttribute('data-stale', 'true');
  await expect(chips.first()).toHaveAttribute('data-state', '');
  await expect(chips.first()).toHaveAttribute('title', 'Verify the desktop release · Conflict · Checks failing · Changes requested · Checked 16m ago');
  await expect(chips.nth(1)).not.toHaveAttribute('data-stale');
  await expect(chips.nth(2)).toHaveAttribute('data-state', 'running');
  await expect(chips.nth(3)).toHaveAttribute('data-state', 'merged');
  await newerCard.screenshot({ path: testInfo.outputPath('mission-tasks-and-pulls.png'), animations: 'disabled' });
  await push({ ...pull, error: 'gh: not found' });
  await expect(chips.first()).toHaveText('#42Could not be read1m');
  // An ended mission starts closed, and its PRs still show at its foot.
  data.missions = data.missions.map((mission) => (mission.id === 'mission-follow-up' ? { ...mission, state: 'done', endedAt: NOW } : mission));
  data.pulls = [{ ...pull, state: 'merged' }];
  await request.post('/__push', { data: { type: 'state', data } });
  await expect(newerCard.getByRole('button', { name: 'Expand mission' })).toBeVisible();
  await expect(newerCard.locator('.pull-chip')).toHaveText('#42Merged');
});

test('the palette offers to turn notifications on when browser permission is missing', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('crew.notify', '1');
    Object.defineProperty(Notification, 'permission', { value: 'default' });
  });
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search work, projects and actions' }).fill('notifications');
  await expect(page.getByRole('option', { name: /Turn on notifications/ })).toBeVisible();
});

test('the palette matches pages by name, not by their description', async ({ page }) => {
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const search = page.getByRole('combobox', { name: 'Search work, projects and actions' });
  await search.fill('as it happened');
  await expect(page.getByRole('option')).toHaveCount(0);
  await search.fill('activity');
  await expect(page.getByRole('option', { name: /^Activity/ })).toBeVisible();
});

test('sidebar and Settings labels update their fade when selection changes', async ({ page }) => {
  const check = async (item: Locator, other: Locator) => {
    const label = item.locator('.fade-line');
    // Model the wider text at the selected weight while keeping the label's box fixed.
    await label.evaluate((element) => {
      Object.defineProperty(element, 'scrollWidth', {
        get: () => element.clientWidth + (element.parentElement?.hasAttribute('aria-current') ? 10 : 0),
      });
    });
    await expect(label).not.toHaveAttribute('data-cut');
    await item.click();
    await expect(label).toHaveAttribute('data-cut', '');
    await other.click();
    await expect(label).not.toHaveAttribute('data-cut');
  };
  const projects = page.getByRole('navigation', { name: 'Projects' });
  await check(projects.getByRole('button', { name: 'Crew', exact: true }), projects.getByRole('button', { name: 'All projects' }));
  await openSettings(page);
  const settings = page.getByRole('navigation', { name: 'Settings pages' });
  await check(settings.getByRole('button', { name: 'Review', exact: true }), settings.getByRole('button', { name: 'Build', exact: true }));
});

test('a row shows its status as a symbol named by its word', async ({ page }) => {
  await expect(page.locator('button[data-job="cx-build"]').getByRole('img', { name: 'Working' })).toHaveAttribute('title', 'Working');
  await expect(page.locator('button[data-job="cx-build"] .chip')).toHaveCount(0);
});

test('short mission plans render in order with matching tracks', async ({ page, request }) => {
  const data = fixture();
  data.missions[0].stages = ['cross-review', 'fix', 'final'];
  data.missions[0].stage = 'cross-review';
  await request.post('/__push', { data: { type: 'state', data } });
  const card = page.locator('[data-key="mission-1"]');
  await expect(card.locator('.track-name')).toHaveText(['Review', 'Fix', 'Final']);
  await expect(card.locator('.track > li[data-pos="past"]')).toHaveCount(0);
  await expect(stage(card, 'Review').locator('button[data-job]')).toHaveCount(2);

  data.missions[0].stage = 'final';
  await request.post('/__push', { data: { type: 'state', data } });
  data.missions[0].stages = ['final'];
  await request.post('/__push', { data: { type: 'state', data } });
  await expect(card.locator('.track-name')).toHaveText(['Final']);
  await expect(stage(card, 'Final').locator('button[data-job]')).toHaveCount(2);

  // A language change streamed in after the mission is displayed renames the cached stage heading and the track together.
  await request.post('/api/language', { data: { language: 'ko' } });
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(card.locator('.track-name')).toHaveText(['마무리']);
  await expect(card.locator('.stage-groups h3.stage-name')).toHaveText(/^마무리/);
  await expect(card.locator('.stage-groups h3.stage-name', { hasText: 'Final' })).toHaveCount(0);
  await request.post('/api/language', { data: { language: 'en' } });
});

test('a mission card names its lead the same way for Claude and Codex, and keeps it after the session ends', async ({ page, request }) => {
  const data = fixture();
  const card = page.locator('[data-key="mission-1"]');
  // A mission from before the lead was recorded takes it from its owning session.
  await expect(card.locator('.mission-meta')).toContainText(/^Led by Claude · /);
  await expect(card.locator('.mission-lead .agent-mark')).toHaveCount(1);
  data.missions[0].lead = 'codex';
  data.claude = data.claude.filter((session) => session.id !== data.missions[0].owner);
  await request.post('/__push', { data: { type: 'state', data } });
  await expect(card.locator('.mission-meta')).toContainText(/^Led by Codex · /);
  delete data.missions[0].lead;
  await request.post('/__push', { data: { type: 'state', data } });
  await expect(card.locator('.mission-meta')).not.toContainText('Led by');
  await expect(card.locator('.mission-lead')).toHaveCount(0);
});

test('a mission with more than one job folds the busy stages it has moved past, and each stage folds on its own', async ({ page, request }) => {
  const data = fixture();
  data.missions[0].stages = ['plan', 'implement', 'cross-review'];
  data.missions[0].stage = 'cross-review';
  data.jobs = [
    ...Array.from({ length: 3 }, (_, at) => job({ id: `cx-plan-${at}`, title: `Plan part ${at}`, missionStep: 0, state: 'done', endedAt: NOW - 60_000 })),
    ...Array.from({ length: 4 }, (_, at) => job({ id: `cx-build-${at}`, title: `Build part ${at}`, missionStep: 1, state: 'done', endedAt: NOW - 60_000 })),
    job({ id: 'cx-review-0', title: 'Review part 0', kind: 'review', missionStep: 2 }),
  ];
  await request.post('/__push', { data: { type: 'state', data } });
  const card = page.locator('[data-key="mission-1"]');
  const plan = card.getByRole('button', { name: 'Plan, 3 jobs' });
  const build = card.getByRole('button', { name: 'Build, 4 jobs' });
  const review = card.getByRole('button', { name: 'Review, 1 job' });
  // A passed stage of three jobs or fewer stays open; a busier one folds.
  await expect(plan).toHaveAttribute('aria-expanded', 'true');
  await expect(card.getByRole('button', { name: /Plan part 0/ })).toBeVisible();
  await expect(build).toHaveAttribute('aria-expanded', 'false');
  await expect(card.getByRole('button', { name: /Build part 0/ })).toBeHidden();
  await expect(review).toHaveAttribute('aria-expanded', 'true');
  await expect(card.getByRole('button', { name: /Review part 0/ })).toBeVisible();

  await build.click();
  await expect(build).toHaveAttribute('aria-expanded', 'true');
  await expect(card.getByRole('button', { name: /Build part 0/ })).toBeVisible();
  await review.click();
  await expect(card.getByRole('button', { name: /Review part 0/ })).toBeHidden();

  // Two jobs are enough to fold.
  data.jobs = data.jobs.slice(-2);
  await request.post('/__push', { data: { type: 'state', data } });
  await expect(card.getByRole('button', { name: 'Build, 1 job' })).toBeVisible();
});

test('a quiet ended workload looks finished and the authenticated user can mark the mission done', async ({ page, request }) => {
  // From `/`, a fragment-only goto would not reload the page, so the launch ticket would never sign in.
  await page.goto('about:blank');
  await request.post('/__reset', { data: { auth: true } });
  await page.goto(`/#ticket=${TEST_TICKET}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  const data = fixture();
  data.missions[0].stages = ['implement', 'cross-review'];
  data.missions[0].stage = 'cross-review';
  data.missions[0].updatedAt = NOW - 20 * 60_000;
  data.jobs.forEach((job) => { job.state = 'done'; job.endedAt = NOW - 60_000; job.waiting = null; });
  // A working lead would keep the mission from looking finished.
  data.claude.forEach((session) => { session.state = 'idle'; });
  await request.post('/__push', { data: { type: 'state', data } });
  const card = page.locator('[data-key="mission-1"]');
  await expect(card.getByText('Looks finished', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Mission options' }).click();
  await page.getByRole('menuitem', { name: 'Mark Done' }).click();
  await expect(card.locator('.mission-head .chip')).toHaveText('Done');
  await expect(card.getByText('Looks finished', { exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Mission options' })).toHaveCount(0);
  // An ended mission starts collapsed, as in the app.
  await card.getByRole('button', { name: 'Expand mission' }).click();
  await expect(card.locator('.track > li[data-pos="past"]')).toHaveCount(2);
  const calls = await (await request.get('/__requests')).json();
  expect(calls).toEqual([{ route: '/api/missions/mission-1', body: { done: true, outcome: 'Marked done on the board.' } }]);
});

test('a mission dropped with Stop Tracking can still be marked done, reopening it explicitly', async ({ page, request }) => {
  await page.goto('about:blank');
  await request.post('/__reset', { data: { auth: true } });
  await page.goto(`/#ticket=${TEST_TICKET}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  const card = page.locator('[data-key="mission-1"]');
  await card.getByRole('button', { name: 'Mission options' }).click();
  await page.getByRole('menuitem', { name: 'Stop Tracking' }).click();
  await expect(card.locator('.mission-head .chip')).toHaveText('Abandoned');
  await card.getByRole('button', { name: 'Mission options' }).click();
  await expect(page.getByRole('menuitem', { name: 'Stop Tracking' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Mark Done' }).click();
  await expect(card.locator('.mission-head .chip')).toHaveText('Done');
  const calls = await (await request.get('/__requests')).json();
  expect(calls).toEqual([
    { route: '/api/missions/mission-1', body: { abandoned: true, outcome: 'Dismissed on the board.' } },
    { route: '/api/missions/mission-1', body: { done: true, reopen: true, outcome: 'Marked done on the board.' } },
  ]);
});

test('choosing a language switches the board in place, so a browser tab stays signed in', async ({ page, request }) => {
  // The credential lives only in the page's memory, so a reload here would end at the sign-in page. From `/`, a
  // fragment-only goto would not reload the page to sign in.
  await page.goto('about:blank');
  await request.post('/__reset', { data: { auth: true } });
  await page.goto(`/#ticket=${TEST_TICKET}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await request.post('/__push', { data: { type: 'language', data: { language: null } } });
  await openSettings(page, 'Language');
  await pick(page.getByRole('combobox', { name: 'Language' }), '한국어');
  // Settings comes back on its Language page, and text kept in tables, such as the page names, switches too.
  const pages = page.getByRole('navigation', { name: '설정 페이지' });
  await expect(pages.getByRole('button', { name: '언어', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('combobox', { name: '언어' })).toContainText('한국어');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '현황', level: 1 })).toBeVisible();
  await expect(page.getByText('실시간', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toHaveCount(0);
  // Another client clearing the setting brings the browser's language back.
  await request.post('/api/language', { headers: { authorization: `Bearer ${TEST_CREDENTIAL}` }, data: { language: null } });
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
});

test('a language change from another board preserves the open new job draft and its focus', async ({ page, request }) => {
  await newJob(page);
  const draft = page.getByRole('dialog').locator('textarea').first();
  await draft.fill('Keep the open draft');
  await request.post('/api/language', { data: { language: 'ko' } });
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(draft).toHaveValue('Keep the open draft');
  await expect(draft).toBeFocused();
});

test('repeated stops keep jobs on their original round while the remaining plan changes', async ({ page, request }) => {
  const data = fixture();
  data.missions[0].stages = ['implement', 'self-review', 'fix', 'cross-review', 'fix', 'polish', 'final'];
  data.missions[0].stage = 'fix';
  data.missions[0].stageIndex = 4;
  data.jobs[0].missionStep = 1;
  data.jobs[1].missionStep = 3;
  await request.post('/__push', { data: { type: 'state', data } });
  const card = page.locator('[data-key="mission-1"]');
  await expect(card.locator('.track-name')).toHaveText(['Build', 'Review', 'Fix', 'Review 2', 'Fix 2', 'Polish', 'Final']);
  await expect(stage(card, 'Review').locator('button[data-job="cx-build"]')).toHaveCount(1);
  await expect(stage(card, 'Review 2').locator('button[data-job="cx-question"]')).toHaveCount(1);
  await expect(card.locator('.track > li[data-pos="now"] .track-name')).toHaveText('Fix 2');
  data.missions[0].stages = [...data.missions[0].stages.slice(0, 5), 'final', 'cross-review'];
  await request.post('/__push', { data: { type: 'state', data } });
  await expect(card.locator('.track-name')).toHaveText(['Build', 'Review', 'Fix', 'Review 2', 'Fix 2', 'Final', 'Review 3']);
  await expect(stage(card, 'Review 2').locator('button[data-job="cx-question"]')).toHaveCount(1);
});

test('question drafts and focus survive stream updates and a reconnect', async ({ page, request }) => {
  await needsYou(page);
  const field = page.getByRole('textbox', { name: 'Your answer' });
  await field.fill('한글 조합 중에도 유지해요');
  await field.focus();
  await request.post('/__push', { data: { type: 'job', data: { id: 'cx-question', tokens: 15000 } } });
  await expect(field).toHaveValue('한글 조합 중에도 유지해요');
  await expect(field).toBeFocused();
  await request.post('/__push', { data: { type: 'state', data: fixture() } });
  await expect(field).toHaveValue('한글 조합 중에도 유지해요');
  await expect(page).toHaveTitle('(1) Crew');
});

test('answering in the detail panel locks the same request on Needs You', async ({ page, request }) => {
  await needsYou(page);
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('textbox', { name: 'Your answer' }).fill('Keep the current selection');
  await drawer.getByRole('button', { name: 'Send your answer' }).click();
  await expect(drawer.getByRole('button', { name: 'Yes', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close details' }).click();
  // The panel plays a short exit before it leaves, with its own copy of the buttons.
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('button', { name: 'No', exact: true })).toBeDisabled();
  const calls = await (await request.get('/__requests')).json();
  expect(calls.filter((call: { route: string }) => call.route.endsWith('/reply'))).toHaveLength(1);
  expect(calls[0].body.request_id).toBe('request-1');
});

test('a failed answer retains its text and unlocks retry', async ({ page }) => {
  await needsYou(page);
  await page.route('**/api/jobs/cx-question/reply', (route) =>
    route.fulfill({ status: 503, json: { error: 'Connection lost. Retry.' } }),
  );
  const field = page.getByRole('textbox', { name: 'Your answer' });
  await field.fill('My answer');
  await page.getByRole('button', { name: 'Send your answer' }).click();
  await expect(page.getByText('Connection lost. Retry.')).toBeVisible();
  await expect(field).toHaveValue('My answer');
  await page.unroute('**/api/jobs/cx-question/reply');
  await page.getByRole('button', { name: 'Send your answer' }).click();
  await expect(field).toHaveValue('');
});

test('saving instructions preserves edits typed while the request is in flight', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/instructions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await gate;
    await route.fulfill({ json: { file: '/global/.crew/instructions.md', text: 'First draft\n' } });
  });
  await openSettings(page, 'Instructions');
  const field = page.getByRole('textbox', { name: 'Shared instructions' });
  await expect(field).toBeEnabled();
  await field.fill('First draft');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await field.fill('First draft with a new requirement');
  release();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(field).toHaveValue('First draft with a new requirement');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
});

test('the scope cannot change during a save and failed loads cannot be saved', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/instructions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await gate;
    await route.fulfill({ json: { file: '/global/.crew/instructions.md', text: 'Old text\n' } });
  });
  await page.route('**/api/instructions?project=*', (route) =>
    route.fulfill({ status: 500, json: { error: 'Cannot read project instructions' } }),
  );
  await openSettings(page, 'Instructions');
  const field = page.getByRole('textbox', { name: 'Shared instructions' });
  await expect(field).toBeEnabled();
  await field.fill('Old text');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // As in the app, other instructions cannot load while these are being saved.
  const other = page.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Other', exact: true });
  await expect(other).toBeDisabled();
  release();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  await other.click();
  await expect(field).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry Loading' })).toBeVisible();
});

test('a question over a sheet stays on top through repeated Escape, and nothing saves behind it', async ({ page, request }) => {
  await openSettings(page, 'Instructions');
  const field = page.getByRole('textbox', { name: 'Shared instructions' });
  await expect(field).toBeEnabled();
  await field.fill('Draft');
  const ask = page.getByRole('dialog', { name: 'Close without saving your changes?' });
  for (let round = 0; round < 3; round++) {
    await page.keyboard.press('Escape');
    await expect(ask).toBeVisible();
    // Saving is the sheet's shortcut, not the question's.
    await page.keyboard.press('ControlOrMeta+s');
    await page.keyboard.press('Escape');
    await expect(ask).toHaveCount(0);
    await expect(field).toHaveValue('Draft');
  }
  await page.keyboard.press('Escape');
  // Topmost and reachable: a click on its button lands.
  await ask.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const calls = await (await request.get('/__requests')).json();
  expect(calls.filter((call: { route: string }) => call.route === '/api/instructions')).toHaveLength(0);
});

test('settings can retry failed saves and confirm unsaved close', async ({ page }) => {
  // Open from the keyboard: Safari does not focus a clicked button, so there would be no focus to return to.
  await page.getByRole('button', { name: 'Settings', exact: true }).focus();
  await page.keyboard.press('Enter');
  await settingsPage(page, 'Instructions');
  const field = page.getByRole('textbox', { name: 'Shared instructions' });
  await expect(field).toBeEnabled();
  await field.fill('Draft');
  await page.route('**/api/instructions', (route) => route.fulfill({ status: 500, json: { error: 'Save failed' } }));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Save failed', { exact: true })).toBeVisible();
  await expect(field).toHaveValue('Draft');
  await page.keyboard.press('Escape');
  const ask = page.getByRole('dialog', { name: 'Close without saving your changes?' });
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.unroute('**/api/instructions');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
});

test('detail panel cancels, follows up, and escapes task text', async ({ page, request }) => {
  await page.locator('button[data-job="cx-build"]').click();
  const drawer = page.getByRole('dialog');
  // A short task shows whole, with nothing to unfold; its markup stays text.
  await expect(drawer.getByText('Inspect the existing implementation first. <task>')).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Show the original task' })).toHaveCount(0);
  const message = drawer.getByRole('textbox', { name: 'Message to Codex' });
  await message.fill('Check the narrow layout');
  // Return adds a newline; only the button sends.
  await message.press('Enter');
  expect((await (await request.get('/__requests')).json()).some((call: { route: string }) => call.route.endsWith('/reply'))).toBe(false);
  await drawer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(message).toHaveValue('');
  await drawer.getByRole('button', { name: 'Cancel Job' }).click();
  await expect(drawer.getByText('Cancelled', { exact: true }).first()).toBeVisible();
  const calls = await (await request.get('/__requests')).json();
  expect(calls.find((call: { route: string }) => call.route.endsWith('/reply')).body).toEqual({ message: 'Check the narrow layout' });
  expect(calls.some((call: { route: string }) => call.route.endsWith('/cancel'))).toBe(true);
});

test('the detail panel shows the worker\'s evidence and the lead\'s attachments', async ({ page, request }) => {
  const data = fixture();
  data.jobs[0].evidence = [
    { file: 'narrow.png', path: '/x/narrow.png', turn: 1, from: 'worker', bytes: 10, modified: 1, sig: 'ab'.repeat(32) },
    { file: 'lead-1-design.png', path: '/x/lead-1-design.png', turn: 1, from: 'lead', bytes: 10, modified: 1 },
  ];
  await request.post('/__push', { data: { type: 'state', data } });
  await page.locator(`button[data-job="${data.jobs[0].id}"]`).click();
  const section = page.getByRole('dialog').getByRole('region', { name: 'Evidence' });
  const shot = section.getByRole('img', { name: 'narrow.png' });
  await expect(shot).toBeVisible();
  expect(await shot.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  // An image cannot send the credential, so its address carries the seal the daemon gave for the file.
  await expect(shot).toHaveAttribute('src', `/api/jobs/${data.jobs[0].id}/evidence/narrow.png?v=1&sig=${'ab'.repeat(32)}`);
  await expect(section.getByText('Turn 1 · narrow.png')).toBeVisible();
  await expect(section.getByText('Attached by the lead · lead-1-design.png')).toBeVisible();
});

test('a capture opens by itself, the strip switches between captures, and Compare puts them side by side', async ({ page, request }) => {
  const data = fixture();
  const shot = (file: string, turn: number, from: 'worker' | 'lead' = 'worker') => ({ file, path: `/x/${file}`, turn, from, bytes: 10, modified: 1 });
  data.jobs[0].turns = 3;
  data.jobs[0].evidence = [shot('hero-before.png', 1), shot('hero-after.png', 3), shot('footer.png', 2), shot('nav.png', 2), shot('lead-1-design.png', 1, 'lead')];
  await request.post('/__push', { data: { type: 'state', data } });
  await page.locator(`button[data-job="${data.jobs[0].id}"]`).click();
  const section = page.getByRole('dialog').getByRole('region', { name: 'Evidence' });
  await expect(section.getByText('Turn 1 of 3 · hero-before.png')).toBeVisible();
  await section.getByRole('img', { name: 'hero-after.png' }).click();
  const sheet = page.getByRole('dialog', { name: 'Evidence' });
  const panes = sheet.locator('.compare figure');
  await expect(panes.getByRole('link')).toHaveText(['hero-after.png']);
  await expect(panes.locator('b')).toHaveText(['Turn 3 of 3']);
  // Without Compare, the strip and the arrow keys switch the one capture shown.
  const strip = sheet.getByRole('group', { name: 'Captures', exact: true });
  await expect(strip.getByRole('button', { name: /hero-after\.png/ })).toHaveAttribute('aria-current', 'true');
  // The arrows work wherever focus is, as after a click on the image.
  await panes.locator('img').click();
  await page.keyboard.press('ArrowLeft');
  await expect(panes.getByRole('link')).toHaveText(['nav.png']);
  await strip.getByRole('button', { name: /hero-before\.png/ }).click();
  await expect(panes.getByRole('link')).toHaveText(['hero-before.png']);
  await page.keyboard.press('ArrowRight');
  await expect(panes.getByRole('link')).toHaveText(['footer.png']);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(panes.getByRole('link')).toHaveText(['lead-1-design.png']);
  await strip.getByRole('button', { name: /hero-after\.png/ }).click();
  // Compare starts from the capture shown, which cannot be taken away.
  const toggle = sheet.getByRole('button', { name: 'Compare', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  // Under the pointer that pressed it, it keeps its opaque fill behind its light label.
  await expect.poll(() => toggle.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toMatch(/rgba|\/ 0?\.\d/);
  const picker = sheet.getByRole('group', { name: /Captures to compare/ });
  await expect(picker.getByRole('button', { name: /hero-after\.png/ })).toBeDisabled();
  const nav = picker.getByRole('button', { name: /nav\.png/ });
  // Added ones go side by side at one height, in the order reference, before, after.
  await picker.getByRole('button', { name: /lead-1-design\.png/ }).click();
  await picker.getByRole('button', { name: /hero-before\.png/ }).click();
  await expect(panes.locator('b')).toHaveText(['Attached by the lead', 'Turn 1 of 3', 'Turn 3 of 3']);
  await expect(panes.getByRole('link')).toHaveText(['lead-1-design.png', 'hero-before.png', 'hero-after.png']);
  // The arrow keys leave a comparison alone.
  await page.keyboard.press('ArrowRight');
  await expect(panes).toHaveCount(3);
  const rects = () => panes.locator('img').evaluateAll((images) => images.map((image) => image.getBoundingClientRect()));
  let boxes = await rects();
  expect(new Set(boxes.map((box) => Math.round(box.top))).size).toBe(1);
  expect(new Set(boxes.map((box) => Math.round(box.height))).size).toBe(1);
  expect(boxes[0].right).toBeLessThanOrEqual(boxes[1].left);
  // A fourth makes a grid of two by two, and a fifth waits until one leaves.
  await picker.getByRole('button', { name: /footer\.png/ }).click();
  await expect(panes.getByRole('link')).toHaveText(['lead-1-design.png', 'hero-before.png', 'footer.png', 'hero-after.png']);
  boxes = await rects();
  expect(Math.round(boxes[0].top)).toBe(Math.round(boxes[1].top));
  expect(Math.round(boxes[2].top)).toBe(Math.round(boxes[3].top));
  expect(boxes[0].bottom).toBeLessThanOrEqual(boxes[2].top);
  expect(Math.round(boxes[0].left)).toBe(Math.round(boxes[2].left));
  expect(new Set(boxes.map((box) => Math.round(box.height))).size).toBe(1);
  await expect(nav).toBeDisabled();
  await picker.getByRole('button', { name: /hero-before\.png/ }).click();
  await expect(panes).toHaveCount(3);
  await nav.click();
  await expect(panes.getByRole('link')).toHaveText(['lead-1-design.png', 'footer.png', 'nav.png', 'hero-after.png']);
  // Leaving Compare keeps the one added last.
  await toggle.click();
  await expect(panes.getByRole('link')).toHaveText(['nav.png']);
  await expect(strip.getByRole('button', { name: /nav\.png/ })).toHaveAttribute('aria-current', 'true');
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);
  // The panel behind stays open.
  await expect(section).toBeVisible();
});

test('captures deleted while the viewer is open stay out of it when their names come back', async ({ page, request }) => {
  const data = fixture();
  const shot = (file: string) => ({ file, path: `/x/${file}`, turn: 1, from: 'worker' as const, bytes: 10, modified: 1 });
  const push = (files: string[]) => {
    data.jobs[0].evidence = files.map(shot);
    return request.post('/__push', { data: { type: 'state', data } });
  };
  await push(['a.png', 'b.png']);
  await page.locator(`button[data-job="${data.jobs[0].id}"]`).click();
  const section = page.getByRole('dialog').getByRole('region', { name: 'Evidence' });
  await section.getByRole('img', { name: 'b.png' }).click();
  const sheet = page.getByRole('dialog', { name: 'Evidence' });
  const toggle = sheet.getByRole('button', { name: 'Compare', exact: true });
  await toggle.click();
  await sheet.getByRole('group', { name: /Captures to compare/ }).getByRole('button', { name: /a\.png/ }).click();
  await expect(sheet.locator('.compare figure')).toHaveCount(2);
  // With one capture left Compare ends, and a new capture does not turn it back on or bring b.png back.
  await push(['a.png']);
  await expect(toggle).toHaveCount(0);
  await expect(sheet.locator('.compare figure').getByRole('link')).toHaveText(['a.png']);
  await push(['a.png', 'b.png']);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(sheet.locator('.compare figure').getByRole('link')).toHaveText(['a.png']);
  // The capture shown leaving closes the viewer, which stays closed when it comes back.
  await push(['b.png']);
  await expect(sheet).toHaveCount(0);
  await push(['a.png', 'b.png']);
  await expect(section.getByRole('img', { name: 'a.png' })).toBeVisible();
  await expect(sheet).toHaveCount(0);
});

test('the detail panel shows what verified the result and nothing for jobs without receipts', async ({ page, request }) => {
  const data = fixture();
  const check = { command: 'npm test', exit: 0, timedOut: false, output: 'ok 12 tests', ms: 4200, sandboxed: true };
  data.jobs[0].receipts = [{ turn: 1, head: 'f00dbabe12345678', check, at: NOW - 1000 }];
  data.jobs[0].capabilities = { filesystem: 'writes in the worktree only', network: 'off', plugins: ['figma'] };
  data.jobs[0].approvals = [{ turn: 1, quote: 'go ahead and push', matched: true, recorded: 2, at: NOW - 2000 }];
  data.jobs.push(
    job({
      id: 'cx-failed',
      title: 'Fix the flaky test',
      state: 'done',
      endedAt: NOW - 5000,
      turns: 2,
      receipts: [{
        turn: 2,
        head: 'deadbeef00000000',
        check: { command: 'npm run test:e2e', exit: 1, timedOut: false, output: 'FAIL board.spec.ts\nExpected 2, received 3', ms: 95_000, sandboxed: true },
        stale: 'turn 2 was undone',
        at: NOW - 6000,
      }],
      approvals: [{ turn: 2, quote: 'yes, delete it', matched: false, recorded: 0, at: NOW - 7000 }],
      exchange: [
        { turn: 1, from: 'lead', text: 'Fix the flaky test.', at: NOW - 9000 },
        { turn: 1, from: 'worker', text: 'Added a retry.', at: NOW - 8500 },
        { turn: 2, from: 'lead', text: 'No retries; find the race.', at: NOW - 8000 },
      ],
    }),
    job({
      id: 'cx-review',
      kind: 'review',
      title: 'Review the board change',
      state: 'done',
      endedAt: NOW - 5000,
      worktree: null,
      rounds: [],
      receipts: [{ turn: 1, head: 'cafe0123456789ab', reviewed: { target: 'uncommitted changes', diff: '9f8e7d6c' }, at: NOW - 6000 }],
    }),
    job({ id: 'cx-plain', title: 'Plain job', state: 'done', endedAt: NOW - 5000 }),
    job({
      id: 'cx-skipped',
      title: 'Check off macOS',
      state: 'done',
      endedAt: NOW - 5000,
      receipts: [{ turn: 1, head: null, check: { command: 'npm test', exit: null, timedOut: false, output: '', ms: 0, sandboxed: false, skipped: 'only macOS can hold the check to the worker\'s limits; run it yourself' }, at: NOW - 6000 }],
    }),
    job({
      id: 'cx-debate',
      title: 'Debate: how the lead is woken',
      // Cancelled after its last round: the daemon refuses another reply all the same.
      state: 'cancelled',
      endedAt: NOW - 5000,
      ask: true,
      worktree: null,
      rounds: [],
      turns: 2,
      debate: { rounds: 2 },
      report: 'Conclusion: wake per job.',
      exchange: [
        { turn: 1, from: 'lead', text: 'Batch the wakes.', at: NOW - 9000 },
        { turn: 1, from: 'worker', text: '1. disagree: a claimed batch can drop a result.', at: NOW - 8000 },
        { turn: 2, from: 'lead', text: 'Then wake per job.', at: NOW - 7000 },
        { turn: 2, from: 'worker', text: 'Conclusion: wake per job.', at: NOW - 6000 },
      ],
    }),
  );
  await request.post('/__push', { data: { type: 'state', data } });
  const open = async (id: string) => {
    await page.locator(`button[data-job="${id}"]`).first().click();
    return page.getByRole('dialog');
  };
  const close = () => page.getByRole('button', { name: 'Close details' }).click();

  let section = (await open('cx-build')).getByRole('region', { name: 'Verification' });
  await expect(section.getByText('Check passed')).toBeVisible();
  await expect(section.getByText('npm test', { exact: true })).toBeVisible();
  await expect(section.getByText('Turn 1 · 4s', { exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Show the end of the output' })).toHaveCount(0);
  await expect(section.getByText('writes in the worktree only · no network · plugins figma (act outside the sandbox)')).toBeVisible();
  await expect(section.getByText('Approval relayed for turn 1 — the user’s own words went with it, and the quote matches them.')).toBeVisible();
  await expect(section.getByText('“go ahead and push”')).toBeVisible();
  await close();

  section = (await open('cx-failed')).getByRole('region', { name: 'Verification' });
  await expect(section.getByText('Check failed with exit code 1')).toBeVisible();
  await expect(section.getByText('No longer current: turn 2 was undone')).toBeVisible();
  await expect(section.getByText('Expected 2, received 3')).toBeHidden();
  await section.getByRole('button', { name: 'Show the end of the output' }).click();
  await expect(section.getByText('Expected 2, received 3')).toBeVisible();
  await expect(section.getByText(/no messages of the user were recorded/)).toBeVisible();
  await expect(section.getByText('Runs with')).toHaveCount(0);
  await close();

  section = (await open('cx-review')).getByRole('region', { name: 'Verification' });
  await expect(section.getByText('Reviewed', { exact: true })).toBeVisible();
  await expect(section.getByText('uncommitted changes')).toBeVisible();
  await expect(section.getByText('Turn 1', { exact: true })).toBeVisible();
  await close();

  await expect((await open('cx-plain')).getByRole('region', { name: 'Verification' })).toHaveCount(0);
  await close();

  // A check the bridge could not hold to the worker's limits says so, instead of reading as a failure.
  section = (await open('cx-skipped')).getByRole('region', { name: 'Verification' });
  await expect(section.getByText('Check not run')).toBeVisible();
  await expect(section.getByText('Only macOS can hold the check to the worker\'s limits; run it yourself.')).toBeVisible();
  await expect(section.getByText('Check stopped before it finished')).toHaveCount(0);
  await expect(section.getByText('Turn 1', { exact: true })).toBeVisible();
  await close();

  // A debate reads as the conversation, in order, instead of only the last report.
  const debate = (await open('cx-debate')).getByRole('region', { name: 'Debate · round 2 of 2 · concluded' });
  // The latest round starts open; earlier ones fold to their heading and stances.
  await expect(debate.locator('.exchange-entry')).toHaveCount(2);
  await expect(debate.getByRole('button', { name: /^Round 1/ })).toHaveAccessibleName(/1 disagree/);
  await debate.getByRole('button', { name: /^Round 1/ }).click();
  await expect(debate.locator('.exchange-entry')).toHaveCount(4);
  await expect(debate.locator('.exchange-entry').first()).toContainText('Lead · round 1');
  await expect(debate.locator('.exchange-entry').nth(1)).toContainText('Codex · round 1');
  await expect(debate.getByText('a claimed batch can drop a result')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('region', { name: 'Report' })).toHaveCount(0);
  await expect(page.getByRole('dialog').getByRole('region', { name: 'Follow up' })).toHaveCount(0);
  await expect(page.getByRole('dialog').getByText('This debate has used all its rounds. Decide from it, or start a new debate.')).toBeVisible();
  await close();

  // A job the lead followed up shows its conversation; one with a single task and report keeps the plain report.
  const followed = (await open('cx-failed')).getByRole('region', { name: 'Conversation' });
  await expect(followed.locator('.exchange-entry').first()).toContainText('Lead · turn 2');
  await followed.getByRole('button', { name: /^Turn 1/ }).click();
  await expect(followed.locator('.exchange-entry')).toHaveCount(3);
  await expect(followed.locator('.exchange-entry').nth(2)).toContainText('Lead · turn 2');
});

test('project filtering scopes requests and New Job follows roles', async ({ page, request }) => {
  await page.getByRole('navigation').getByRole('button', { name: 'Other', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Other', exact: true, level: 1 })).toBeVisible();
  // The waiting request is Crew's: the sidebar marks Crew, and Other's page has nothing to point to.
  await expect(page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Crew', exact: true })).toHaveAccessibleDescription('Needs you');
  await expect(page.getByRole('button', { name: /needs your attention/ })).toHaveCount(0);
  await newJob(page);
  await expect(page.getByRole('textbox', { name: 'Project directory' })).toHaveValue('/workspace/Other');
  await page.getByRole('combobox', { name: 'Role', exact: true }).click();
  await page.getByRole('option', { name: 'Cross-review', exact: true }).click();
  await page.getByRole('textbox', { name: 'New job instructions' }).fill('Review the accessibility changes');
  await page.getByRole('button', { name: 'Send Job' }).click();
  await expect(page.getByRole('button', { name: 'Close details' })).toBeVisible();
  const calls = await (await request.get('/__requests')).json();
  const created = calls.find((call: { route: string }) => call.route === '/api/jobs');
  expect(created.body).toMatchObject({
    role: 'review',
    kind: 'review',
    cwd: '/workspace/Other',
    review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' },
  });
});

test('roles settings group every role, let one follow its parent, and store what the user wrote as it is changed', async ({ page, request }) => {
  await openSettings(page);
  const nav = page.getByRole('navigation', { name: 'Settings pages' });
  for (const name of ['Build', 'Review', 'Edit', 'Model Presets', 'Instructions', 'Crew', 'Other']) await expect(nav.getByRole('button', { name, exact: true })).toBeVisible();
  const refactor = page.getByRole('region', { name: 'Refactoring' });
  await expect(refactor.getByRole('checkbox', { name: 'Same as Implementation' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Refactoring: Codex' })).toBeDisabled();
  // A debate cannot be started from New Job, but it can be assigned here.
  await expect(page.getByRole('checkbox', { name: 'Debate: Codex' })).toBeVisible();
  // A typed setting is stored when its field is left, not while it is typed.
  await page.getByLabel('Implementation Codex reasoning effort').fill('high');
  await expect(page.getByLabel('Refactoring Codex reasoning effort')).toHaveAttribute('placeholder', 'Agent default');
  await page.getByLabel('Implementation Codex reasoning effort').press('Enter');
  await expect(page.getByLabel('Refactoring Codex reasoning effort')).toHaveAttribute('placeholder', 'high (same as Implementation)');
  await settingsPage(page, 'Review');
  await page.getByRole('region', { name: 'Review that runs the app' }).getByRole('checkbox', { name: 'Same as Cross-review' }).uncheck();
  await page.getByRole('checkbox', { name: 'Cross-review: Antigravity' }).check();
  await page.getByRole('checkbox', { name: 'Cross-review: Codex' }).uncheck();
  await expect(page.getByLabel('Cross-review Antigravity model')).toBeVisible();
  await expect(page.getByLabel('Cross-review Antigravity reasoning effort')).toBeVisible();
  // Nothing to press: the roles pages have no save, and the last change is the table that is stored.
  await expect(page.getByRole('button', { name: /^Save/ })).toHaveCount(0);
  await lastBody(request, '/api/roles').toEqual({
    roles: { delegate: { codex: { effort: 'high' } }, verify: { agents: ['codex'] }, review: { agents: ['antigravity'] } },
  });
  await settingsPage(page, 'Build');
  await expect(refactor.getByRole('checkbox', { name: 'Same as Implementation' })).toBeChecked();
});

test('a setting changed and changed back stores what was there, and Settings closes without a question', async ({ page, request }) => {
  await openSettings(page);
  await type(page.getByLabel('Implementation Codex reasoning effort'), 'high');
  await lastBody(request, '/api/roles').toEqual({ roles: { delegate: { codex: { effort: 'high' } } } });
  await type(page.getByLabel('Implementation Codex reasoning effort'), '');
  // Holders turned on and off again, and a role that stops and starts following its parent, leave nothing written.
  await page.getByRole('checkbox', { name: 'Implementation: Antigravity' }).check();
  await page.getByRole('checkbox', { name: 'Implementation: Antigravity' }).uncheck();
  const same = page.getByRole('region', { name: 'Refactoring' }).getByRole('checkbox', { name: 'Same as Implementation' });
  await same.uncheck();
  await same.check();
  await lastBody(request, '/api/roles').toEqual({ roles: {} });
  // Beside the sidebar there is no close button; Escape or a press outside closes, with nothing to ask about.
  await expect(page.getByRole('button', { name: 'Close settings' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a role change that cannot be stored is undone and says why under its role', async ({ page }) => {
  await openSettings(page);
  await page.route('**/api/roles', (route) => route.fulfill({ status: 500, json: { error: 'Cannot save roles' } }));
  const antigravity = page.getByRole('checkbox', { name: 'Implementation: Antigravity' });
  await antigravity.click();
  await expect(page.getByRole('region', { name: 'Implementation' }).getByRole('alert')).toHaveText('Not saved: Cannot save roles');
  await expect(antigravity).not.toBeChecked();
  // The next change that goes through clears it.
  await page.unroute('**/api/roles');
  await antigravity.check();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(antigravity).toBeChecked();
});

test('Settings wait for a change still being stored before they close, and stay open when it cannot be', async ({ page, request }) => {
  await openSettings(page);
  const antigravity = page.getByRole('checkbox', { name: 'Implementation: Antigravity' });
  const settings = page.getByRole('navigation', { name: 'Settings pages' });
  // Held at the daemon, then refused: Escape during the wait does not close Settings, and the reason shows in them.
  let release!: () => void;
  let gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/roles', async (route) => { await gate; await route.fulfill({ status: 500, json: { error: 'Cannot save roles' } }); });
  await antigravity.click();
  await page.keyboard.press('Escape');
  await expect(settings).toBeVisible();
  release();
  await expect(page.getByRole('region', { name: 'Implementation' }).getByRole('alert')).toHaveText('Not saved: Cannot save roles');
  await expect(settings).toBeVisible();
  // Held, then stored: Settings close once the daemon has answered, and not before.
  await page.unroute('**/api/roles');
  gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/roles', async (route) => { await gate; await route.continue(); });
  await antigravity.click();
  await page.keyboard.press('Escape');
  await expect(settings).toBeVisible();
  release();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await lastBody(request, '/api/roles').toEqual({ roles: { delegate: { agents: ['codex', 'antigravity'] } } });
});

test('instructions typed while Settings wait to close are still asked about', async ({ page }) => {
  await openSettings(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/roles', async (route) => { await gate; await route.continue(); });
  await page.getByRole('checkbox', { name: 'Implementation: Antigravity' }).click();
  await page.keyboard.press('Escape');
  // Still open while the change is stored, so the user goes on and types.
  await settingsPage(page, 'Instructions');
  const field = page.getByRole('textbox', { name: 'Shared instructions' });
  await expect(field).toBeEnabled();
  await field.fill('Typed while closing.');
  release();
  await page.getByRole('dialog', { name: 'Close without saving your changes?' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(field).toHaveValue('Typed while closing.');
});

test('on a phone, settings move between the list and a page with focus kept, and the drawer hands focus back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Settings', exact: true }).click();
  const back = page.getByRole('dialog').getByRole('button', { name: 'Settings', exact: true });
  await page.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review', level: 2 })).toBeVisible();
  await expect(back).toBeFocused();
  await back.click();
  await expect(page.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Review', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeFocused();
});

test('a role can hold Claude and several workers, each with its own settings, and keeps at least one', async ({ page, request }) => {
  await openSettings(page, 'Review');
  const claude = page.getByRole('checkbox', { name: 'Cross-review: Claude' });
  await claude.check();
  await lastBody(request, '/api/roles').toEqual({ roles: { review: { agents: ['codex', 'claude'] } } });
  await claude.uncheck();
  await lastBody(request, '/api/roles').toEqual({ roles: {} });
  // The only holder cannot be turned off.
  await expect(page.getByRole('checkbox', { name: 'Cross-review: Codex' })).toBeDisabled();
  // The verify role follows review, its holders included, until it is given its own.
  await claude.check();
  await expect(page.getByRole('checkbox', { name: 'Review that runs the app: Claude' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Cross-review: Antigravity' }).check();
  await type(page.getByLabel('Cross-review Antigravity model'), 'gemini-y');
  await type(page.getByLabel('Cross-review Codex model'), 'gpt-x');
  // Turning an agent off drops its settings.
  await page.getByRole('checkbox', { name: 'Cross-review: Codex' }).uncheck();
  await settingsPage(page, 'Edit');
  await page.getByRole('checkbox', { name: 'Wording: Claude' }).check();
  await page.getByRole('checkbox', { name: 'Wording: Antigravity' }).uncheck();
  await lastBody(request, '/api/roles').toEqual({
    roles: { review: { agents: ['antigravity', 'claude'], antigravity: { model: 'gemini-y' } }, polish: { agents: ['claude'] } },
  });
});

test('an agent turned off and on again while Settings stays open gets its settings back', async ({ page, request }) => {
  const data = fixture();
  const config = resolveConfig({ roles: { review: { agents: ['codex', 'antigravity'], antigravity: { model: 'gemini-y' } } } });
  data.roles = config.roles;
  data.roleSettings = config.roleSettings;
  await request.post('/__push', { data: { type: 'state', data } });
  await openSettings(page, 'Review');
  const antigravity = page.getByRole('checkbox', { name: 'Cross-review: Antigravity' });
  await antigravity.uncheck();
  await expect(page.getByLabel('Cross-review Antigravity model')).toHaveCount(0);
  // Off, they are gone from what is stored.
  await lastBody(request, '/api/roles').toEqual({ roles: { review: { agents: ['codex'] } } });
  await antigravity.check();
  await expect(page.getByLabel('Cross-review Antigravity model')).toHaveValue('gemini-y');
  await lastBody(request, '/api/roles').toEqual({ roles: { review: { agents: ['codex', 'antigravity'], antigravity: { model: 'gemini-y' } } } });
});

test('models and efforts are picked from what each agent offers, and a hand-written one stays', async ({ page, request }) => {
  const data = fixture();
  data.agents.codex.models = [{ id: 'gpt-sol', name: 'GPT Sol', efforts: ['low', 'high'] }, { id: 'gpt-luna', name: 'GPT Luna', efforts: ['low'] }];
  data.agents.antigravity.models = [{ id: 'hydrogen', name: 'Hydrogen' }, { id: 'argon', name: 'Argon' }];
  const config = resolveConfig({ roles: { delegate: { agents: ['codex', 'antigravity'], codex: { model: 'gpt-custom' } } } });
  data.roles = config.roles;
  data.roleSettings = config.roleSettings;
  await request.post('/__push', { data: { type: 'state', data } });
  await openSettings(page);
  const model = page.getByLabel('Implementation Codex model');
  await expect(model).toHaveText('gpt-custom');
  // A model that does not accept the chosen effort drops it.
  await pick(model, 'GPT Sol');
  await pick(page.getByLabel('Implementation Codex reasoning effort'), 'high');
  await pick(model, 'GPT Luna');
  await expect(page.getByLabel('Implementation Codex reasoning effort')).toHaveText('Agent default');
  // The efforts follow the chosen model; a following role offers its parent's value as its blank.
  const effort = page.getByLabel('Implementation Codex reasoning effort');
  expect(await optionsOf(effort)).toEqual(['Agent default', 'low']);
  await pick(effort, 'low');
  expect((await optionsOf(page.getByLabel('Refactoring Codex reasoning effort')))[0]).toBe('low (same as Implementation)');
  await pick(page.getByLabel('Implementation Antigravity model'), 'Argon');
  // Antigravity cannot run the app, so it is not offered for that review.
  await settingsPage(page, 'Review');
  const verify = page.getByRole('region', { name: 'Review that runs the app' });
  await verify.getByRole('checkbox', { name: 'Same as Cross-review' }).uncheck();
  await expect(page.getByRole('checkbox', { name: 'Review that runs the app: Antigravity' })).toBeDisabled();
  await lastBody(request, '/api/roles').toEqual({
    roles: { delegate: { agents: ['codex', 'antigravity'], codex: { model: 'gpt-luna', effort: 'low' }, antigravity: { model: 'argon' } }, verify: { agents: ['codex'] } },
  });
});

test('a role changed elsewhere while Settings is open is kept by the next change here, and by text being typed', async ({ page, request }) => {
  await openSettings(page);
  const model = page.getByLabel('Implementation Codex model');
  const effort = page.getByLabel('Implementation Codex reasoning effort');
  const elsewhere = (roles: object) => request.post('/api/roles', { data: { roles } });

  // Another window stores two roles. Once the form shows that, a change made here does not undo either.
  await elsewhere({ delegate: { codex: { effort: 'low' } }, review: { codex: { model: 'remote-review' } } });
  await expect(effort).toHaveValue('low');
  const answered = page.waitForResponse((response) => response.url().endsWith('/api/roles'));
  await type(model, 'local-build');
  await lastBody(request, '/api/roles').toEqual({ roles: { delegate: { codex: { model: 'local-build', effort: 'low' } }, review: { codex: { model: 'remote-review' } } } });
  // The form takes an outside table only once its own change is stored, so let the page handle the answer first.
  await (await answered).finished();
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));

  // Text being typed in a field stays when that field's stored value changes elsewhere, and is what leaving the field stores.
  await model.fill('local-draft');
  await elsewhere({ delegate: { codex: { model: 'remote-build', effort: 'high' } }, review: { codex: { model: 'remote-review' } } });
  await expect(effort).toHaveValue('high');
  await expect(model).toHaveValue('local-draft');
  await model.press('Enter');
  await lastBody(request, '/api/roles').toEqual({ roles: { delegate: { codex: { model: 'local-draft', effort: 'high' } }, review: { codex: { model: 'remote-review' } } } });
});

test('New Job gives wording to Antigravity and other work to Codex when a role has both', async ({ page }) => {
  const data = fixture();
  data.roles = resolveConfig({ roles: { delegate: { agents: ['codex', 'antigravity'] }, polish: { agents: ['codex', 'antigravity'] } } }).roles;
  await page.request.post('/__push', { data: { type: 'state', data } });
  await newJob(page);
  const assigned = page.getByRole('combobox', { name: 'Assigned to' });
  await expect(assigned).toHaveText('Codex');
  await pick(page.getByRole('combobox', { name: 'Role', exact: true }), 'Wording');
  await expect(assigned).toHaveText('Antigravity');
});

test('New Job picks among a role\'s worker holders, and a role only Claude holds starts from Claude', async ({ page, request }) => {
  const data = fixture();
  data.roles = resolveConfig({ roles: { delegate: { agents: ['codex', 'antigravity'] }, polish: { agents: ['claude'] } } }).roles;
  await request.post('/__push', { data: { type: 'state', data } });
  await newJob(page);
  await page.getByRole('textbox', { name: 'Project directory' }).fill('/workspace/Crew');
  const assigned = page.getByRole('combobox', { name: 'Assigned to' });
  await expect(assigned).toHaveText('Codex');
  await pick(assigned, 'Antigravity');
  await page.getByRole('textbox', { name: 'New job instructions' }).fill('Build the piece');
  await pick(page.getByRole('combobox', { name: 'Role', exact: true }), 'Wording');
  await expect(page.getByText('Claude, in a lead session', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send Job' })).toBeDisabled();
  await pick(page.getByRole('combobox', { name: 'Role', exact: true }), 'Implementation');
  await page.getByRole('button', { name: 'Send Job' }).click();
  await expect(page.getByRole('button', { name: 'Close details' })).toBeVisible();
  const calls = await (await request.get('/__requests')).json();
  expect(calls.find((call: { route: string }) => call.route === '/api/jobs').body).toMatchObject({ role: 'delegate', agent: 'antigravity' });
});

test('each project has its own instructions page', async ({ page, request }) => {
  await openSettings(page, 'Other');
  // Beside the sidebar the page has no title row; its stage carries the name.
  await expect(page.getByRole('dialog').getByRole('region', { name: 'Other', exact: true })).toBeVisible();
  const field = page.getByRole('textbox', { name: 'Shared instructions' });
  await expect(field).toBeEnabled();
  await field.fill('Use tabs here.');
  // Leaving for another set of instructions asks first; staying keeps the draft.
  await settingsPage(page, 'Instructions');
  await page.getByRole('dialog', { name: 'Discard the unsaved changes to these instructions?' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(field).toHaveValue('Use tabs here.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  const calls = await (await request.get('/__requests')).json();
  expect(calls.findLast((call: { route: string }) => call.route === '/api/instructions').body).toEqual({ project: '/workspace/Other', text: 'Use tabs here.' });
});

test('a mission\'s preset can be chosen from its options menu', async ({ page, request }) => {
  const mission = page.locator('.mission[data-state="active"]').first();
  const options = mission.getByRole('button', { name: 'Mission options' });
  // The default preset goes unnamed.
  await expect(mission.locator('.mission-meta')).not.toContainText('Economy');
  await options.click();
  await mission.getByRole('menuitemradio', { name: 'Economy' }).click();
  await expect(mission.locator('.mission-meta')).toContainText('Economy');
  // The menu stays usable after a preset change, and the choice shows.
  await options.click();
  await expect(mission.getByRole('menuitemradio', { name: 'Economy' })).toHaveAttribute('aria-checked', 'true');
  await mission.getByRole('menuitemradio', { name: 'Default' }).click();
  await expect(mission.locator('.mission-meta')).not.toContainText('Economy');
  const calls = await (await request.get('/__requests')).json();
  const sent = calls.filter((call: { route: string }) => call.route.startsWith('/api/missions/')).map((call: { body: unknown }) => call.body);
  expect(sent.slice(-2)).toEqual([{ preset: 'economy' }, { preset: null }]);
});

// Waits out the entrance animations; looping ones, such as a spinner, never finish.
const settle = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
  .map((animation) => animation.finished)));

test('the live Overview has no endless animations during active work', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await request.post('/__push', { data: { type: 'job', data: { id: 'cx-question', state: 'running', waiting: null } } });
  const mission = page.locator('[data-key="mission-1"]');
  await expect(mission.locator('.mission-head .chip[data-state="running"]')).toBeVisible();
  await expect(mission.locator('.track > li[data-pos="now"] .track-node b')).toBeVisible();
  await expect(page.locator('.nav-dot[data-state="working"]')).toBeVisible();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await settle(page);
  expect(await page.evaluate(() => document.getAnimations()
    .filter((animation) => animation.effect?.getTiming().iterations === Infinity)
    .map((animation) => (animation as CSSAnimation).animationName))).toEqual([]);
});

test('entrances let go once played, so a mission\'s menu opens above the cards after it', async ({ page, request }) => {
  const data = fixture();
  data.missions.push({ ...data.missions[0], id: 'mission-2', title: 'Ship the next one', state: 'done', endedAt: NOW - 1000 });
  await request.post('/__push', { data: { type: 'state', data } });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('[data-key="mission-2"]')).toBeVisible();
  await settle(page);
  // An entrance that fills forwards keeps its element a stacking context in Chromium, trapping any menu inside it
  // beneath the cards painted after it. Headless Chromium does not show that, so the cause itself is checked.
  expect(await page.evaluate(() => document.getAnimations()
    .filter((animation) => animation.playState === 'finished')
    .map((animation) => `${(animation as CSSAnimation).animationName} on ${(animation.effect as KeyframeEffect).target?.className}`))).toEqual([]);
  const mission = page.locator('[data-key="mission-1"]');
  await mission.getByRole('button', { name: 'Mission options' }).click();
  const last = mission.getByRole('menuitemradio', { name: 'Best' });
  await settle(page);
  await last.scrollIntoViewIfNeeded();
  // A click lands on the item itself, not on a later card painted over it.
  expect(await last.evaluate((item) => {
    const box = item.getBoundingClientRect();
    return item.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  })).toBe(true);
});

test('New Job sends the role, so a review that runs the app goes to its holder', async ({ page, request }) => {
  await newJob(page);
  await page.getByRole('textbox', { name: 'Project directory' }).fill('/workspace/Crew');
  await pick(page.getByRole('combobox', { name: 'Role', exact: true }), 'Review that runs the app');
  await expect(page.locator('#dispatch-caption')).toHaveText('Reviews uncommitted changes by running the app in a snapshot of them.');
  expect(await optionsOf(page.getByRole('combobox', { name: 'Role', exact: true }))).not.toContain('Debate');
  await page.getByRole('textbox', { name: 'New job instructions' }).fill('Check the board runs');
  await page.getByRole('button', { name: 'Send Job' }).click();
  await expect(page.getByRole('button', { name: 'Close details' })).toBeVisible();
  const calls = await (await request.get('/__requests')).json();
  expect(calls.find((call: { route: string }) => call.route === '/api/jobs').body).toMatchObject({ role: 'verify', kind: 'review' });
});

test('a chosen project survives reload and All projects lets New Job go elsewhere', async ({ page, request }) => {
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Crew', exact: true }).click();
  await page.reload();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Crew', exact: true, level: 1 })).toBeVisible();
  await newJob(page);
  const directory = page.getByRole('textbox', { name: 'Project directory' });
  await expect(directory).toHaveValue('/workspace/Crew');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'All projects' }).click();
  await newJob(page);
  await expect(directory).toHaveValue('');
  await directory.fill('/workspace/New');
  await page.getByRole('textbox', { name: 'New job instructions' }).fill('Implement the new project');
  await page.getByRole('button', { name: 'Send Job' }).click();
  await expect(page.getByRole('button', { name: 'Close details' })).toBeVisible();
  const calls = await (await request.get('/__requests')).json();
  expect(calls.find((call: { route: string }) => call.route === '/api/jobs').body).toMatchObject({
    cwd: '/workspace/New', project: '/workspace/New',
  });
  // The new job's project opens, so the job is in view, as the app goes there.
  expect(await page.evaluate(() => [localStorage.getItem('crew.scope'), localStorage.getItem('crew.page')])).toEqual(['/workspace/New', 'overview']);
});

test('a project keeps the page, and its pages show only its own work', async ({ page }) => {
  const projects = page.getByRole('navigation', { name: 'Projects' });
  const pages = page.getByRole('navigation', { name: 'Pages' });
  await needsYou(page);
  await expect(pages.getByRole('button', { name: /^Needs You/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: 'Yes', exact: true })).toBeVisible();
  // The waiting question belongs to Crew, so Other has nothing for you and its tab no count.
  await projects.getByRole('button', { name: 'Other', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Other', level: 1 })).toBeVisible();
  await expect(pages.getByRole('button', { name: /^Needs You/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('All caught up')).toBeVisible();
  await expect(pages.getByRole('button', { name: 'Needs You', exact: true })).toBeVisible();
  await pages.getByRole('button', { name: 'Activity' }).click();
  await expect(page.getByText('No activity yet.')).toBeVisible();
  await projects.getByRole('button', { name: 'Crew', exact: true }).click();
  await expect(pages.getByRole('button', { name: 'Activity' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Started in an isolated worktree')).toBeVisible();
  // The browser tab's title still counts every project's requests.
  await projects.getByRole('button', { name: 'Other', exact: true }).click();
  await expect(page).toHaveTitle('(1) Crew');
  // An earlier board's saved selection opens the same project's overview.
  await page.evaluate(() => {
    localStorage.removeItem('crew.page');
    localStorage.setItem('crew.selection', 'project:/workspace/Other');
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Other', level: 1 })).toBeVisible();
  await expect(pages.getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
});

test('a closed slow drawer never opens itself again', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/jobs/cx-build', async (route) => {
    await gate;
    await route.continue();
  });
  await page.locator('button[data-job="cx-build"]').click();
  await page.getByRole('button', { name: 'Close details' }).click();
  release();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
});

for (const width of [1440, 390])
  test(`layout at ${width}px has no overflow, consistent marks, and readable multiple requests`, async ({
    page,
    request,
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    const data = fixture();
    data.jobs[0] = {
      ...data.jobs[0],
      state: 'waiting',
      waiting: { type: 'approval', id: 'approval-1', reason: 'Allow the app verification command?', since: data.now },
    };
    await request.post('/__push', { data: { type: 'state', data } });
    await expect(page.locator('[data-key="mission-1"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // The stage scrolls in its own box, so the document alone would not show its overflow.
    const stage = page.locator('main.page');
    expect(await stage.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(stage.locator('.share')).toHaveCSS('padding-inline-start', width === 390 ? '16px' : '22px');
    await expect(page.locator('.topbar .prominent')).toHaveCSS('background-image', 'none');
    expect(await page.locator('.chip svg').first().evaluate((element) => element.tagName)).toBe('svg');
    expect(await page.locator('.agent-mark').first().evaluate((element) => getComputedStyle(element).maskImage)).not.toBe('none');
    // A window as tall as the stage's content captures the whole page, which the document's full-page capture no longer reaches.
    // Measured once the font has loaded, as wrapping depends on it.
    await page.evaluate(() => document.fonts.ready);
    await page.setViewportSize({ width, height: 1000 + (await stage.evaluate((element) => element.scrollHeight - element.clientHeight)) });
    // One baseline, Chromium's on macOS: text renders differently in other engines and systems, where the checks above still run.
    if (testInfo.project.name === 'chromium' && process.platform === 'darwin') await expect(page).toHaveScreenshot(`board-${width}.png`, { animations: 'disabled' });
    await page.screenshot({ path: testInfo.outputPath(`board-${width}.png`) });
    await page.setViewportSize({ width, height: 1000 });
    await needsYou(page);
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Your answer' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await stage.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(errors).toEqual([]);
  });

test('stage scrolls with keyboard focus outside it, out under its own rounded edge', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  const stage = page.locator('main.page');
  await page.getByRole('button', { name: 'New Job', exact: true }).focus();
  await page.keyboard.press('PageDown');
  await expect.poll(() => stage.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  // No inset border clips the content along a line inside the stage, in forced colors or otherwise.
  await page.emulateMedia({ forcedColors: 'active' });
  expect(await stage.evaluate((element) => getComputedStyle(element).borderTopWidth + getComputedStyle(element).borderBottomWidth)).toBe('0px0px');
});

test('Return adds a newline in an answer and the next question gets a fresh draft', async ({ page, request }) => {
  await needsYou(page);
  const field = page.getByRole('textbox', { name: 'Your answer' });
  await field.fill('조합 중');
  await field.press('Enter');
  await expect(field).toHaveValue('조합 중\n');
  expect(await (await request.get('/__requests')).json()).toHaveLength(0);
  await request.post('/__push', { data: { type: 'job', data: { id: 'cx-question', waiting: { id: 'request-2', type: 'question', reason: 'A new question', since: NOW } } } });
  await expect(field).toHaveValue('');
  await field.fill('새 답변');
  await page.getByRole('button', { name: 'Send your answer' }).click();
  await expect(field).toHaveValue('');
  const calls = await (await request.get('/__requests')).json();
  expect(calls[0].body).toMatchObject({ message: '새 답변', request_id: 'request-2' });
});

test('the top bar keeps its controls on one row at every width', async ({ page }) => {
  const bar = page.locator('.topbar');
  const split: number[] = [];
  for (let width = 320; width <= 1000; width += 10) {
    await page.setViewportSize({ width, height: 800 });
    const rows = await bar.evaluate((element) => {
      const middle = (selector: string) => {
        const box = element.querySelector(selector)!.getBoundingClientRect();
        return Math.round(box.top + box.height / 2);
      };
      return [middle('.search-pill'), middle('.new-job'), middle('.tabs')];
    });
    if (rows.some((row) => Math.abs(row - rows[0]) > 2) || await bar.evaluate((element) => element.scrollWidth > element.clientWidth)) split.push(width);
  }
  expect(split, 'widths where the top bar splits or overflows').toEqual([]);
});

test('320px sheets keep controls within the viewport and support reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('main.page').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  // The sidebar floats out over the page and folds away again once a project is chosen.
  const toggle = page.getByRole('button', { name: 'Show sidebar' });
  await expect(page.getByRole('navigation', { name: 'Projects' })).toBeHidden();
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Crew', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Crew', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Projects' })).toBeHidden();
  await toggle.click();
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await toggle.click();
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'All projects' }).click();
  await newJob(page);
  const job = page.getByRole('dialog');
  expect(await job.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Send Job' })).toBeInViewport();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('button[data-job="cx-build"]').click();
  const panel = page.getByRole('dialog');
  expect(await panel.evaluate((element) => element.getBoundingClientRect().right <= innerWidth)).toBe(true);
  expect(await panel.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  await page.getByRole('button', { name: 'Close details' }).click();
  await openSettings(page, 'Instructions');
  const settings = page.getByRole('dialog');
  await expect(page.getByRole('textbox', { name: 'Shared instructions' })).toBeEnabled();
  expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
});

test('usage windows show every status and reset, with model limits in the help text', async ({ page, request }) => {
  const cards = page.locator('.agent-cards');
  await expect(cards.locator('.usage')).toHaveCount(3);
  for (const status of ['ok', 'tight', 'exhausted', 'unknown'])
    await expect(cards.locator(`.usage-window[data-status="${status}"]`)).toBeVisible();
  const claude = cards.locator('[data-agent="claude"] .usage');
  await expect(claude.locator('.usage-line').first()).toHaveText(['5-hour25%Resets in 1h']);
  await expect(claude.locator('.usage-line').nth(1)).toHaveText(['Weekly90%Resets in 1d']);
  await expect(cards.locator('[data-agent="antigravity"] .usage-line')).toHaveText(['Billing cycle0%unknown']);
  await expect(claude).toHaveAttribute('title', 'Little room remains.\nFable: Weekly, 30%, stale');
  await expect(cards.locator('.usage-window[data-status="stale"]')).toHaveCount(0);
  const usage = fixture().usage!;
  usage.providers[0].windows[0].usedRatio = 0.5;
  await request.post('/__push', { data: { type: 'usage', data: usage } });
  await expect(claude.locator('.usage-line').first()).toHaveText(['5-hour50%Resets in 1h']);
});

for (const source of ['absent', 'none'])
  test(`legacy limit line is unchanged when usage is ${source}`, async ({ page, request }) => {
    const data = fixture();
    if (source === 'absent') delete data.usage;
    else data.usage!.source = 'none';
    delete data.preset;
    delete data.presets;
    await request.post('/__push', { data: { type: 'state', data } });
    await expect(page.locator('.usage')).toHaveCount(0);
    const limit = page.locator('.agent-cards .usage-limit');
    await expect(limit).toHaveText('42% of limit');
    await expect(limit).toHaveAttribute('title', '42% of 300-minute limit');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('Model preset')).toHaveCount(0);
  });

test('model scores list each model with its score and status, and have nothing to save', async ({ page }) => {
  await openSettings(page, 'Model Scores');
  // The best three stand on a podium, first in the middle.
  const podium = page.getByRole('region', { name: 'Top models' });
  await expect(podium.getByText(/^gpt-6\.1-sol$|^gemini-4-hydrogen$|^gpt-6-astra$/)).toHaveText(['gemini-4-hydrogen', 'gpt-6.1-sol', 'gpt-6-astra']);
  await expect(podium.locator('[data-place="1"] svg').first()).toHaveCSS('fill', 'rgb(230, 184, 0)');
  const standings = page.getByRole('region', { name: 'Standings' });
  const sol = standings.getByRole('article').filter({ hasText: 'gpt-6.1-sol' });
  await expect(sol.getByRole('img', { name: '8.6 out of 10' })).toBeVisible();
  await expect(sol.getByText('Strong')).toBeVisible();
  await expect(sol.getByText('Settled · 9 builds', { exact: true })).toBeVisible();
  // The row stops at the status: no per-item bars, adoption counts, or the lead's notes.
  await expect(sol.getByText(/Merged|Brief|Solid logic/)).toHaveCount(0);
  // A model short of reviews is not ranked and gets no verdict word.
  await expect(standings.getByRole('article')).toHaveCount(3);
  const opus = page.getByRole('region', { name: 'Too early to rank' }).getByRole('article').filter({ hasText: 'claude-opus-5-5' });
  await expect(opus.getByLabel(/^Rank/)).toHaveCount(0);
  await expect(opus.getByText('Too few reviews · 0 builds', { exact: true })).toBeVisible();
  await expect(opus.getByText(/Strong|Solid|Mixed|Shaky|Outstanding/)).toHaveCount(0);
  // A model that only reviewed stands apart, with its reviews and how its findings held up.
  const astra = page.getByRole('region', { name: 'Reviewers' }).getByRole('article').filter({ hasText: 'gpt-6.2-astra' });
  await expect(astra.getByText('Too few reviews · 2 reviews', { exact: true })).toBeVisible();
  await expect(astra.getByRole('img', { name: '6.4 out of 10' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Save/ })).toHaveCount(0);
  // Fixing is assigned with the reviews it answers.
  await settingsPage(page, 'Review');
  await expect(page.getByRole('checkbox', { name: 'Fix: Claude', exact: true })).toBeChecked();
});

test('a preset is stored as it is picked, describes its models, and permits none', async ({ page, request }) => {
  await openSettings(page, 'Model Presets');
  const select = page.getByRole('combobox', { name: 'Model preset' });
  await expect(select).toHaveText('Balanced');
  await pick(select, 'Economy');
  await expect(page.getByText('small · Low effort', { exact: true })).toBeVisible();
  await expect(page.getByText('flash', { exact: true })).toBeVisible();
  await expect(page.getByText('Haiku', { exact: true })).toBeVisible();
  await expect(page.getByText('Lower cost and faster runs for straightforward tasks.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Save/ })).toHaveCount(0);
  await lastBody(request, '/api/preset').toEqual({ preset: 'economy' });
  await pick(select, 'None');
  await expect(page.getByText("Uses each agent's own model and effort settings.")).toBeVisible();
  await lastBody(request, '/api/preset').toEqual({ preset: null });
});

test('the turn token budget follows difficulty, or is one of its caps, or unlimited', async ({ page, request }) => {
  await openSettings(page, 'Model Presets');
  const select = page.getByRole('combobox', { name: 'Tokens per Turn' });
  await expect(select).toHaveText('By Difficulty');
  await expect(page.getByText('A worker turn stops at 60M tokens for a routine job, 80M for a standard one, and 120M for a hard one.', { exact: false })).toBeVisible();
  await pick(select, '5M');
  await expect(select).toHaveText('5M');
  await expect(page.getByText('Every worker turn stops at this many tokens, whatever its difficulty.', { exact: false })).toBeVisible();
  await lastBody(request, '/api/turn-token-budget').toEqual({ budget: 5_000_000 });
  if (process.env.CREW_E2E_SHOT) await page.screenshot({ path: process.env.CREW_E2E_SHOT });
  await pick(select, '100M');
  await lastBody(request, '/api/turn-token-budget').toEqual({ budget: 100_000_000 });
  await pick(select, 'Unlimited');
  await expect(page.getByText('so one that goes in circles keeps spending them until its time runs out', { exact: false })).toBeVisible();
  await lastBody(request, '/api/turn-token-budget').toEqual({ budget: 'unlimited' });
  await pick(select, 'By Difficulty');
  await lastBody(request, '/api/turn-token-budget').toEqual({ budget: null });
});

test('an open preset selector adopts changes made from another client', async ({ page, request }) => {
  await openSettings(page, 'Model Presets');
  const select = page.getByRole('combobox', { name: 'Model preset' });
  await expect(select).toHaveText('Balanced');
  await request.post('/api/preset', { data: { preset: 'economy' } });
  await expect(select).toHaveText('Economy');
  await pick(select, 'Balanced');
  await lastBody(request, '/api/preset').toEqual({ preset: 'balanced' });
});

test('a delayed preset save response cannot replace a newer streamed preset', async ({ page, request }) => {
  await openSettings(page, 'Model Presets');
  const saved = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route('**/api/preset', async (route) => {
    const response = await route.fetch();
    saved.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  const select = page.getByRole('combobox', { name: 'Model preset' });
  try {
    await pick(select, 'Economy');
    await saved.promise;
    await request.post('/api/preset', { data: { preset: 'best' } });
    // The following event on the same stream shows the newer preset arrived before the held response.
    await request.post('/api/language', { data: { language: 'ko' } });
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await request.post('/api/language', { data: { language: 'en' } });
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  } finally {
    release.resolve();
  }
  await expect(select).toHaveText('Best');
});

test('an external preset event cannot make Settings skip a queued local selection', async ({ page, request }) => {
  await openSettings(page, 'Model Presets');
  const posted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const submissions: string[] = [];
  await page.route('**/api/preset', async (route) => {
    submissions.push(route.request().postDataJSON().preset);
    if (submissions.length !== 1) return route.continue();
    posted.resolve();
    await release.promise;
    // This successful write is acknowledged before its stream update.
    await route.fulfill({ json: { preset: 'economy' } });
  });
  const select = page.getByRole('combobox', { name: 'Model preset' });
  try {
    await pick(select, 'Economy');
    await posted.promise;
    await request.post('/api/preset', { data: { preset: 'best' } });
    await request.post('/api/language', { data: { language: 'ko' } });
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await request.post('/api/language', { data: { language: 'en' } });
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await pick(select, 'Best');
  } finally {
    release.resolve();
  }
  await expect.poll(() => submissions).toEqual(['economy', 'best']);
  await expect(select).toHaveText('Best');
});

test('a preset that cannot be stored is undone, and one picked during a save is stored after it', async ({ page, request }) => {
  await openSettings(page, 'Model Presets');
  const select = page.getByRole('combobox', { name: 'Model preset' });
  await page.route('**/api/preset', (route) => route.fulfill({ status: 500, json: { error: 'Cannot save preset' } }));
  await pick(select, 'Best');
  await expect(page.getByRole('alert')).toHaveText('Not saved: Cannot save preset');
  await expect(select).toHaveText('Balanced');
  await page.unroute('**/api/preset');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/preset', async (route) => { await gate; await route.continue(); });
  await pick(select, 'Best');
  await pick(select, 'Economy');
  release();
  await lastBody(request, '/api/preset').toEqual({ preset: 'economy' });
  await expect(select).toHaveText('Economy');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('rounds are ordered and locked while active, then undo and keep with exact bodies', async ({ page, request }) => {
  await page.locator('button[data-job="cx-build"]').click();
  const rounds = page.getByRole('region', { name: 'Rounds' });
  await expect(rounds.getByRole('button', { name: 'Undo' })).toBeDisabled();
  await expect(rounds.getByRole('button', { name: 'Undo' })).toHaveAttribute('title', /Wait until/);
  await request.post('/__push', { data: { type: 'job', data: { id: 'cx-build', state: 'done', endedAt: NOW } } });
  await rounds.getByRole('button', { name: 'Undo' }).click();
  await expect(rounds.getByText('Undone', { exact: true })).toBeVisible();
  await rounds.getByRole('button', { name: 'Keep' }).click();
  await expect(rounds.getByText('Kept', { exact: true })).toBeVisible();
  const calls = await (await request.get('/__requests')).json();
  expect(calls.filter((call: { route: string }) => call.route.includes('/rounds/'))).toEqual([
    { route: '/api/jobs/cx-build/rounds/1', body: { undo: true } },
    { route: '/api/jobs/cx-build/rounds/1', body: { keep: true } },
  ]);
  await request.post('/__push', { data: { type: 'job', data: { id: 'cx-build', worktree: null } } });
  await expect(rounds.getByRole('button', { name: 'Undo' })).toBeDisabled();
  await expect(rounds.getByRole('button', { name: 'Undo' })).toHaveAttribute('title', 'This job has no worktree.');
});

test('a round lock survives reopening and errors can retry', async ({ page, request }) => {
  await request.post('/__push', { data: { type: 'job', data: { id: 'cx-build', state: 'done', endedAt: NOW } } });
  await page.locator('button[data-job="cx-build"]').click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  await page.route('**/api/jobs/cx-build/rounds/1', async (route) => {
    calls++;
    await gate;
    await route.fulfill({ status: 409, json: { error: 'Revert conflicts with a later round.' } });
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close details' }).click();
  await page.locator('button[data-job="cx-build"]').click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  release();
  await expect(page.getByText('Revert conflicts with a later round.')).toBeVisible();
  expect(calls).toBe(1);
  await page.unroute('**/api/jobs/cx-build/rounds/1');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Keep', exact: true })).toBeVisible();
});

test('command intent retains the existing implementation request', async ({ page, request }) => {
  await newJob(page);
  await page.getByLabel('Project directory').fill('/workspace/Crew');
  await expect(page.getByRole('radio', { name: 'Command' })).toBeChecked();
  await page.getByRole('textbox', { name: 'New job instructions' }).fill('Implement the feature');
  await page.getByRole('button', { name: 'Send Job' }).click();
  await expect(page.getByRole('button', { name: 'Close details' })).toBeVisible();
  const calls = await (await request.get('/__requests')).json();
  expect(calls.find((call: { route: string }) => call.route === '/api/jobs').body).toEqual({
    role: 'delegate', kind: 'delegate', cwd: '/workspace/Crew', project: '/workspace/Crew', task: 'Implement the feature', isolation: 'worktree',
  });
});

test('question intent hides command options, keeps Return as a newline, and labels the read-only job', async ({ page, request }) => {
  await newJob(page);
  await page.getByLabel('Project directory').fill('/workspace/Crew');
  await pick(page.getByRole('combobox', { name: 'Role', exact: true }), 'Wording');
  await expect(page.getByRole('textbox', { name: 'Allowed files or directories' })).toBeVisible();
  await page.getByRole('radio', { name: 'Question' }).click();
  await expect(page.getByRole('combobox', { name: 'Role', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Allowed files or directories' })).toHaveCount(0);
  const field = page.getByRole('textbox', { name: 'New job instructions' });
  await field.fill('이 코드는 어떻게 동작하나요?');
  await field.press('Enter');
  expect(await (await request.get('/__requests')).json()).toHaveLength(0);
  await page.getByRole('button', { name: 'Ask Question', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.facts')).toContainText('RoleQuestion');
  await page.getByRole('button', { name: 'Close details' }).click();
  await expect(page.locator('button[data-job="cx-direct"] .job-row-text span')).toContainText('Question');
  const calls = await (await request.get('/__requests')).json();
  expect(calls.find((call: { route: string }) => call.route === '/api/jobs').body).toEqual({
    kind: 'delegate', ask: true, task: '이 코드는 어떻게 동작하나요?', cwd: '/workspace/Crew',
  });
});

for (const target of ['mission:mission-1', 'project', 'global'])
  test(`information intent saves to ${target} without starting a job`, async ({ page, request }) => {
    await newJob(page);
    await page.getByLabel('Project directory').fill('/workspace/Crew');
    await page.getByRole('radio', { name: 'Information' }).click();
    const destinations: Record<string, string> = {
      'mission:mission-1': fixture().missions[0].title, project: "This project's shared instructions", global: "Every project's shared instructions",
    };
    await pick(page.getByLabel('Information destination'), destinations[target]);
    await expect(page.getByText('Adds information only. This starts no work.')).toBeVisible();
    await page.getByRole('textbox', { name: 'New job instructions' }).fill('Keep this requirement');
    await page.getByRole('button', { name: 'Save Information' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const calls = await (await request.get('/__requests')).json();
    expect(calls).toEqual(target.startsWith('mission:')
      ? [{ route: '/api/missions/mission-1', body: { note: 'Keep this requirement' } }]
      : [{ route: '/api/instructions', body: { append: 'Keep this requirement', project: target === 'global' ? null : '/workspace/Crew' } }]);
    if (target.startsWith('mission:')) await expect(page.locator('[data-key="mission-1"]').getByText('Keep this requirement')).toBeVisible();
  });

test('mission notes show when expanded', async ({ page }) => {
  const card = page.locator('[data-key="mission-1"]');
  await expect(card.getByText('Keep keyboard navigation available.')).toBeVisible();
  await card.getByRole('button', { name: 'Collapse mission' }).click();
  // A closed body stays mounted so it can animate; it is hidden, not removed.
  await expect(card.getByText('Keep keyboard navigation available.')).toBeHidden();
});

test('rounds render oldest first and waiting jobs cannot change them', async ({ page, request }) => {
  const round = fixture().jobs[0].rounds![0];
  await request.post('/__push', { data: { type: 'job', data: {
    id: 'cx-build', state: 'waiting', rounds: [{ ...round, turn: 2, state: 'undone' }, round],
  } } });
  await page.locator('button[data-job="cx-build"]').click();
  const rounds = page.getByRole('region', { name: 'Rounds' });
  await expect(rounds.locator('.round').first()).toContainText('Turn 1');
  await expect(rounds.locator('.round').last()).toContainText('Turn 2');
  await expect(rounds.getByRole('button', { name: 'Undo' })).toBeDisabled();
  await expect(rounds.getByRole('button', { name: 'Keep' })).toBeDisabled();
});

test('information offers only active missions in the chosen project and retains failed drafts', async ({ page, request }) => {
  const data = fixture();
  data.missions.push(
    { ...data.missions[0], id: 'ended', title: 'Ended mission', state: 'done' },
    { ...data.missions[0], id: 'elsewhere', title: 'Another project mission', project: '/workspace/Other', root: '/workspace/Other' },
  );
  await request.post('/__push', { data: { type: 'state', data } });
  await newJob(page);
  await page.getByLabel('Project directory').fill('/workspace/Crew');
  await page.getByRole('radio', { name: 'Information' }).click();
  const destination = page.getByRole('combobox', { name: 'Information destination' });
  expect(await optionsOf(destination)).toHaveLength(3);
  await pick(destination, data.missions[0].title);
  const field = page.getByRole('textbox', { name: 'New job instructions' });
  await field.fill('정보를 유지해요');
  await field.press('Enter');
  expect(await (await request.get('/__requests')).json()).toHaveLength(0);
  await page.route('**/api/missions/mission-1', (route) => route.fulfill({ status: 409, json: { error: 'Mission is no longer active' } }));
  await page.getByRole('button', { name: 'Save Information' }).click();
  await expect(page.getByText('Mission is no longer active')).toBeVisible();
  await expect(field).toHaveValue('정보를 유지해요\n');
});

test.describe('authenticated daemon', () => {
  test.beforeEach(async ({ page, request }) => {
    await page.goto('about:blank');
    await request.post('/__reset', { data: { auth: true } });
    await page.addInitScript(() => {
      Object.defineProperty(window, '__secretStorageWrite', { value: false, writable: true });
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (/[a-f0-9]{64}/i.test(`${key} ${value}`)) {
          Object.defineProperty(window, '__secretStorageWrite', { value: true });
        }
        return setItem.call(this, key, value);
      };
    });
  });

  test('a launch ticket signs in before other requests, clears the fragment, and leaves nothing in the browser', async ({ page, context, request }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/?view=board#ticket=${TEST_TICKET}`);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/\?view=board$/);
    await expect(page.locator('button[data-job="cx-build"]')).toBeVisible();
    const traffic = await (await request.get('/__traffic')).json();
    expect(traffic[0]).toEqual({ route: '/api/session', method: 'POST' });
    expect(traffic.filter((call: { route: string }) => call.route === '/api/session')).toHaveLength(1);
    expect(traffic.some((call: { route: string }) => call.route === '/api/stream')).toBe(true);
    expect(traffic.every((call: { route: string }) => !call.route.includes(TEST_TICKET) && !call.route.includes(TEST_CREDENTIAL))).toBe(true);
    // Whatever a browser keeps is on disk: the credential is in neither a cookie nor web storage.
    expect(await context.cookies()).toEqual([]);
    expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })))
      .toEqual({ local: {}, session: {} });
    expect(await page.evaluate(() => Reflect.get(window, '__secretStorageWrite'))).toBe(false);
    expect(errors).toEqual([]);
    // So a reload signs the page out, and the screen says how to come back.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toBeVisible();
    await expect(page.getByText('a reload signs it out')).toBeVisible();
  });

  test('without a ticket, explains sign-in and stops retrying until asked', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toBeVisible();
    await expect(page.getByText('crew board', { exact: true })).toBeVisible();
    await expect(page.getByText('Open Web Board', { exact: true })).toBeVisible();
    await expect(page.getByText('Reconnecting…')).toHaveCount(0);
    await expect(page.locator('button[data-job]')).toHaveCount(0);
    const before = await (await request.get('/__traffic')).json();
    expect(before.length).toBeGreaterThan(0);
    // The stream and the Overview's setup check, each sent twice by a development build.
    expect(before.length).toBeLessThanOrEqual(4);
    await page.waitForTimeout(2000);
    expect(await (await request.get('/__traffic')).json()).toEqual(before);
    await page.setViewportSize({ width: 390, height: 180 });
    await page.mouse.wheel(0, 300);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  test('a wrong ticket shows the same screen and removes the fragment', async ({ page, request }) => {
    await page.goto(`/#ticket=${'f'.repeat(64)}`);
    await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    expect(await (await request.get('/__traffic')).json()).toEqual([{ route: '/api/session', method: 'POST' }]);
  });

  test('Retry loads the board once its requests are signed again, as the desktop app signs them', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toBeVisible();
    await request.post('/__auth', { data: { required: false } });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await expect(page.locator('button[data-job="cx-build"]')).toBeVisible();
  });

  test('an action returning 401 replaces the board and closes its stream', async ({ page, request }) => {
    await page.goto(`/#ticket=${TEST_TICKET}`);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await needsYou(page);
    await request.post('/__auth', { data: { holds: false } });
    await page.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toBeVisible();
    await request.post('/__push', { data: { type: 'state', data: fixture() } });
    await expect(page.getByRole('textbox', { name: 'Your answer' })).toHaveCount(0);
    const before = await (await request.get('/__traffic')).json();
    await page.waitForTimeout(2000);
    expect(await (await request.get('/__traffic')).json()).toEqual(before);
  });

  test('a stream that ends is opened again, and a refusal then stops it', async ({ page, request }) => {
    await page.goto(`/#ticket=${TEST_TICKET}`);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await request.post('/__auth', { data: { holds: false } });
    await request.post('/__push', { data: { type: 'disconnect' } });
    await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toBeVisible();
    const before = await (await request.get('/__traffic')).json();
    expect(before.at(-1)).toEqual({ route: '/api/stream', method: 'GET' });
    await page.waitForTimeout(2000);
    expect(await (await request.get('/__traffic')).json()).toEqual(before);
  });
});

test('an unreachable stream stays a connection failure and can recover', async ({ page, request }) => {
  await page.route('**/api/stream', (route) => route.abort());
  await request.post('/__push', { data: { type: 'disconnect' } });
  await expect(page.getByText('Lost the connection to Crew. Reconnecting…')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toHaveCount(0);
  await page.unroute('**/api/stream');
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
});

for (const width of [390, 1440]) {
  test(`session workflows stay bounded at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 1000 });
    const data = fixture();
    const session = data.claude[0];
    session.workflows = [{ id: 'run-1', name: 'Review a very long workflow name '.repeat(8), startedAt: NOW - 120_000, activeAt: NOW, done: 7 }];
    session.agents = Array.from({ length: 14 }, (_, index) => ({
      id: `agent-${index}`, type: 'reviewer', title: `Agent ${index}: ${'A long description '.repeat(15)}`,
      phase: 'Bash npm test '.repeat(10), inTool: true, startedAt: NOW - 60_000, activeAt: NOW,
      ...(index >= 2 ? { workflow: 'run-1', stage: index < 5 ? 'Review' : 'Verify' } : {}),
    }));
    await request.post('/__push', { data: { type: 'state', data } });
    // The row sums the sub-agents up, as the app's does; its panel lists them.
    const row = page.locator(`button[data-session="${session.id}"]`).last();
    await expect(row.locator('.job-row-text > span')).toContainText(`2 sub-agents · ${session.workflows[0].name} 12 running`);
    expect(await row.locator('.job-row-text b').evaluate((el) => el.clientWidth)).toBeGreaterThan(80);
    await row.click();
    const view = page.getByRole('dialog');
    await expect(view.getByRole('list', { name: 'Sub-agents', exact: true }).locator('li')).toHaveCount(2);
    const run = view.getByRole('region', { name: session.workflows[0].name });
    await expect(run).toContainText('12 running · 7 done');
    await expect(run.locator('li')).toHaveCount(5);
    await expect(run.getByRole('list')).toHaveCount(2);
    const toggle = run.getByRole('button');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(run.locator('li')).toHaveCount(12);
    await toggle.click();
    await expect(run.locator('li')).toHaveCount(5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('main.page').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await run.locator('.session-agents > li > span:first-child > span:first-child').first().evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    session.agents = session.agents.filter((agent) => !agent.workflow);
    await request.post('/__push', { data: { type: 'state', data } });
    await expect(run).toContainText('0 running · 7 done');
    await expect(run).toContainText('No agent running: between phases, or finished.');
    await expect(row.locator('.job-row-text > span')).toHaveText('Reviewing the implementation · 2 sub-agents');
    await expect(run.getByRole('button')).toHaveCount(0);
  });
}

test('a session row opens its own panel and closes it again, as job rows do', async ({ page }) => {
  const row = page.locator('button[data-session="lead-1"]').last();
  await row.click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByText('Claude · Lead', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Resume Command' })).toBeVisible();
  // The page beside the panel stays usable: the same row closes it.
  await row.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a Codex lead session is shown as Codex\'s, on its card, in Needs You and in its panel', async ({ page, request }) => {
  const data = fixture();
  Object.assign(data.claude[1], { host: 'codex', state: 'waiting', waitingFor: 'needs your permission to use Bash', waitingId: 'w-3', ask: { tool: 'Bash', input: 'git push' } });
  await request.post('/__push', { data: { type: 'state', data } });
  await expect(page.locator('.agent-card[data-agent="codex"] .caption')).toContainText('Lead');
  await expect(page.locator('.agent-card[data-agent="codex"] .agent-activity')).toContainText('1 active session');
  await needsYou(page);
  const card = page.locator('article[data-session="lead-2"]');
  await expect(card.locator('.need-who')).toHaveText('Codex');
  await expect(card.getByText('Answer in Codex.')).toBeVisible();
  await card.locator('.need-title').click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByText('Codex · Lead', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Open in Codex' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close' }).click();

  // A desktop thread opens in Codex as a Claude desktop session opens in Claude; the terminal one keeps the hint.
  const thread = 'e97eb8b4-b9ff-4551-b625-3c06c77253c7';
  data.claude.push({ ...data.claude[1], id: thread, desktopId: thread, waitingId: 'w-4', title: 'Codex desktop' });
  // With no Claude session open, Claude's card no longer says Lead, as Codex's does not without one.
  data.claude = data.claude.filter((session) => session.host === 'codex');
  await request.post('/__push', { data: { type: 'state', data } });
  const desktop = page.locator(`article[data-session="${thread}"]`);
  await expect(desktop.getByRole('button', { name: 'Open in Codex' })).toBeVisible();
  await expect(desktop.getByText('Answer in Codex.')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Open in Codex' })).toHaveCount(0);
  await expect(card.getByText('Answer in Codex.')).toBeVisible();
  await page.getByRole('navigation', { name: 'Pages' }).getByRole('button', { name: 'Overview' }).filter({ visible: true }).click();
  await expect(page.locator('.agent-card[data-agent="claude"] .caption')).not.toContainText('Lead');
  await expect(page.locator('.agent-card[data-agent="codex"] .caption')).toContainText('Lead');
});

test('a waiting Claude session shows what it asks, opens in Claude, and opens its panel from the card', async ({ page, request }, testInfo) => {
  const data = fixture();
  Object.assign(data.claude[0], {
    state: 'waiting', waitingFor: 'Which layout should the drawer use?', waitingId: 'w-1',
    desktopId: 'local_e97eb8b4-b9ff-4551-b625-3c06c77253c7',
    ask: { questions: [{ question: 'Which layout should the drawer use?', options: ['Tabs (Recommended)', 'Single column'] }] },
  });
  Object.assign(data.claude[1], {
    state: 'waiting', waitingFor: 'Claude needs your permission to use Bash', waitingId: 'w-2',
    ask: { tool: 'Bash', input: 'git push origin main' },
  });
  await request.post('/__push', { data: { type: 'state', data } });
  await needsYou(page);
  const card = page.locator('article[data-session="lead-1"]');
  await expect(card.locator('.need-who')).toHaveText('Claude');
  await expect(card.getByRole('listitem')).toHaveText(['Tabs (Recommended)', 'Single column']);
  await expect(card.getByText('Answer in Claude.')).toHaveCount(0);
  // A terminal session has no desktop id, so it keeps the hint instead of the button.
  const cli = page.locator('article[data-session="lead-2"]');
  await expect(cli.locator('.ask-input')).toHaveText('git push origin main');
  await expect(cli.getByRole('button', { name: 'Open in Claude' })).toHaveCount(0);
  await expect(cli.getByText('Answer in Claude.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('claude-cards.png') });

  // The button leaves for the Claude app without opening the panel.
  await card.getByRole('button', { name: 'Open in Claude' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await card.locator('.headline').click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByRole('listitem')).toHaveText(['Tabs (Recommended)', 'Single column']);
  await expect(panel.getByRole('button', { name: 'Open in Claude' })).toBeVisible();
});

test('the panel resizes from its edge and keeps the width', async ({ page }) => {
  await page.locator('button[data-job="cx-build"]').click();
  const grip = page.getByRole('separator', { name: 'Panel width' });
  const before = Number(await grip.getAttribute('aria-valuenow'));
  await grip.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(grip).toHaveAttribute('aria-valuenow', String(before + 40));
  await page.getByRole('button', { name: 'Close details' }).click();
  await page.locator('button[data-job="cx-build"]').click();
  await expect(page.getByRole('separator', { name: 'Panel width' })).toHaveAttribute('aria-valuenow', String(before + 40));
});

test('a closed mission opens from a click anywhere on it and closes from its title row', async ({ page }) => {
  const card = page.locator('[data-key="mission-1"]');
  await card.getByRole('button', { name: 'Collapse mission' }).click();
  await expect(card.locator('.track')).toBeHidden();
  await card.locator('.mission-meta').click();
  await expect(card.locator('.track')).toBeVisible();
  await card.locator('.mission-heading').click();
  await expect(card.locator('.track')).toBeHidden();
});

test('History and Activity pair their cards on a wide page, each column stacked on its own', async ({ page, request }) => {
  const data = fixture();
  // Newest first on the page: a, b, c.
  data.missions.push(...['a', 'b', 'c'].map((id, index): Mission => ({
    ...data.missions[0], id: `ended-${id}`, title: `Ended ${id}`, state: 'done', createdAt: NOW - (index + 2) * 3_600_000, endedAt: NOW - 60_000,
  })));
  data.jobs.push(job({ id: 'cx-ended', state: 'done', endedAt: NOW - 60_000 }));
  await request.post('/__push', { data: { type: 'state', data } });
  const pages = page.getByRole('navigation', { name: 'Pages' }).filter({ visible: true });
  await pages.getByRole('button', { name: 'History' }).click();
  const columns = page.locator('.columns > .column');
  const keys = (column: Locator) => column.locator('.mission').evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.key));
  await expect(columns).toHaveCount(2);
  expect(await keys(columns.nth(0))).toEqual(['ended-a', 'ended-c']);
  expect(await keys(columns.nth(1))).toEqual(['ended-b']);
  // A card that opens moves the card below it, and nothing in the other column.
  const [first, beside, below] = ['a', 'b', 'c'].map((id) => page.locator(`[data-key="ended-${id}"]`));
  const top = async (card: Locator) => (await card.boundingBox())!.y;
  const before = [await top(beside), await top(below)];
  await first.getByRole('button', { name: 'Expand mission' }).click();
  await expect(first.locator('.track')).toBeVisible();
  expect(await top(beside)).toBe(before[0]);
  expect(await top(below)).toBeGreaterThan(before[1]);
  // The table keeps the page's width.
  expect((await page.locator('.table-panel').boundingBox())!.width).toBeGreaterThan((await first.boundingBox())!.width * 2);
  // A card a filter moves to the other column shows in place rather than rising in again.
  const filter = page.getByRole('searchbox', { name: 'Filter history' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await filter.fill('Ended b');
  await expect(columns).toHaveCount(1);
  expect(await keys(columns)).toEqual(['ended-b']);
  expect(await beside.evaluate((card) => card.getAnimations().filter((animation) => animation instanceof CSSAnimation).length)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await filter.fill('');
  await expect(columns).toHaveCount(2);
  await pages.getByRole('button', { name: 'Activity' }).click();
  await expect(columns.nth(0).getByRole('region', { name: 'Work started' })).toBeVisible();
  await expect(columns.nth(1).getByRole('region', { name: 'Events' })).toBeVisible();
  // A narrower page has one column, in the same order, and the opened card stays open.
  await page.setViewportSize({ width: 1200, height: 1000 });
  await expect(columns).toHaveCount(1);
  await pages.getByRole('button', { name: 'History' }).click();
  expect(await keys(columns)).toEqual(['ended-a', 'ended-b', 'ended-c']);
  await expect(first.locator('.track')).toBeVisible();
});

test('a finished-looking mission is marked done from its menu, and a dropped one marks its stopping step', async ({ page, request }) => {
  const data = fixture();
  data.missions[0].stages = ['implement', 'cross-review', 'final'];
  data.missions[0].stage = 'cross-review';
  data.missions[0].updatedAt = NOW - 20 * 60_000;
  data.jobs.forEach((job) => { job.state = 'done'; job.endedAt = NOW - 60_000; job.waiting = null; });
  data.claude.forEach((session) => { session.state = 'idle'; });
  await request.post('/__push', { data: { type: 'state', data } });
  const card = page.locator('[data-key="mission-1"]');
  await expect(card.getByText('Looks finished', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Mission options' }).click();
  await page.getByRole('menuitem', { name: 'Mark Done' }).click();
  await expect(card.locator('.mission-head .chip')).toHaveText('Done');
  data.missions[0] = { ...data.missions[0], state: 'abandoned', endedAt: NOW };
  await request.post('/__push', { data: { type: 'state', data } });
  await card.getByRole('button', { name: 'Expand mission' }).click();
  await expect(card.locator('.track > li[data-pos="stopped"] .track-name')).toHaveText('Review');
  await expect(card.locator('.track > li[data-current]')).toHaveCount(1);
});

test('a job\'s facts name its tier, and a long note is cut with what was left out', async ({ page, request }) => {
  await request.post('/__push', { data: { type: 'job', data: { id: 'cx-build', tier: 'standard', model: 'sol', notes: [`${'a'.repeat(2000)}\nsecond\nthird`] } } });
  await page.locator('button[data-job="cx-build"]').click();
  const panel = page.getByRole('dialog');
  await expect(panel.locator('.facts')).toContainText('Codex · sol · standard tier');
  await expect(panel.getByRole('region', { name: 'Notes' })).toContainText('… and 3 more lines');
});

test('New Job shows who takes a question, and says when only the lead can', async ({ page, request }) => {
  await newJob(page);
  await page.getByRole('radio', { name: 'Question' }).click();
  await expect(page.getByRole('dialog').getByText('Assigned to')).toBeVisible();
  // A changed intent is a draft, so leaving asks first.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('dialog', { name: 'Discard this job draft?' }).getByRole('button', { name: 'Discard' }).click();
  const data = fixture();
  data.roles = { ...data.roles, delegate: { agents: ['claude'] } };
  await request.post('/__push', { data: { type: 'state', data } });
  await newJob(page);
  await page.getByRole('radio', { name: 'Question' }).click();
  await expect(page.getByText('Start this job from a Claude Code or Codex session: Claude Code does it itself or in a subagent, and Codex hands it to a Claude worker.')).toBeVisible();
});

test('About Crew puts the check on the status row and an update action beside the note', async ({ page }) => {
  await page.addInitScript(() => {
    const listeners = new Set<(update: unknown) => void>();
    let update = { current: '0.7.0', state: 'idle', checkedAt: Date.now() } as Record<string, unknown>;
    Object.defineProperty(window, 'crewDesktop', { value: { update: {
      state: async () => update,
      check: async () => {
        update = { current: '0.7.0', state: 'ready', latest: '0.8.0', page: 'https://example.com/notes' };
        listeners.forEach((listener) => listener(update));
      },
      install: async () => {},
      cancel: async () => {},
      subscribe: (listener: (update: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    } } });
  });
  await page.goto('/');
  await openSettings(page, 'About Crew');
  const status = page.getByRole('status').filter({ hasText: 'Crew is up to date' });
  const check = page.getByRole('button', { name: 'Check for Updates' });
  await expect(status).toBeVisible();
  const [statusBox, checkBox] = [await status.boundingBox(), await check.boundingBox()];
  expect(Math.abs(statusBox!.y + statusBox!.height / 2 - (checkBox!.y + checkBox!.height / 2))).toBeLessThan(20);

  await check.click();
  const note = page.getByText('Updates install after running jobs finish.');
  const install = page.getByRole('dialog').getByRole('button', { name: 'Update Now', exact: true });
  await expect(install).toBeVisible();
  await expect(check).toHaveCount(0);
  // The action shares the note's line rather than sitting between the list and the note.
  const [noteBox, installBox] = [await note.boundingBox(), await install.boundingBox()];
  expect(installBox!.x).toBeGreaterThan(noteBox!.x + noteBox!.width - 1);
  expect(Math.abs(noteBox!.y + noteBox!.height / 2 - (installBox!.y + installBox!.height / 2))).toBeLessThan(12);
});

test('job details name whose instructions a job got and end Changes with Diff Command', async ({ page, request }) => {
  const data = fixture();
  data.jobs[0] = {
    ...data.jobs[0],
    shared: ['/home/me/.crew/instructions.md', '/workspace/Crew/.crew/instructions.md'],
    sharedScopes: ['every', 'project'],
    result: { files: ['src/app.ts'], stat: ' src/app.ts | 2 +-', commit: 'abc1234', outOfScope: [] },
  };
  await request.post('/__push', { data: { type: 'state', data } });
  await page.locator(`button[data-job="${data.jobs[0].id}"]`).first().click();
  const panel = page.getByRole('dialog');
  await expect(panel.getByText('Every project · This project', { exact: true })).toBeVisible();
  await expect(panel.getByText('/home/me/.crew/instructions.md')).toHaveCount(0);
  const changes = panel.getByRole('region', { name: 'Changes' });
  await expect(changes.getByText('Commit abc1234')).toBeVisible();
  await expect(changes.getByRole('button', { name: 'Diff Command' })).toBeVisible();
  await expect(panel.locator('.detail-foot').getByRole('button', { name: /Diff/ })).toHaveCount(0);
});

test('Set up Crew shows backticked names as code, a failed registration as an error, and its actions last', async ({ page }) => {
  await page.route('**/api/setup*', (route) => route.fulfill({ json: {
    packaged: false, registering: false, registration: { ok: false, detail: 'Could not register the plugin.' },
    items: [{ id: 'command', label: '`crew` command', ok: false, detail: 'Not installed.', repairable: true }],
  } }));
  await page.goto('/');
  const card = page.locator('.setup-list').locator('..');
  await expect(card.locator('code', { hasText: 'crew' })).toBeVisible();
  await expect(card.getByText('`crew`')).toHaveCount(0);
  await expect(card.locator('.error', { hasText: 'Could not register the plugin.' })).toBeVisible();
  const [list, install] = [await card.locator('.setup-list').boundingBox(), await card.getByRole('button', { name: 'Install' }).boundingBox()];
  expect(install!.y).toBeGreaterThan(list!.y + list!.height);
});

test('the desktop app greets a first install once, and the palette shows the guide again', async ({ page }) => {
  const stub = (pending: boolean) => {
    let owed = pending;
    Object.defineProperty(window, 'crewDesktop', { value: {
      update: {
        state: async () => ({ current: '0.7.2', state: 'idle' }), check: async () => {}, install: async () => {}, cancel: async () => {},
        subscribe: () => () => {},
      },
      welcome: { pending: async () => owed, done: async () => { owed = false; (window as { welcomeDone?: boolean }).welcomeDone = true; } },
    } });
  };
  // An update owes no guide.
  await page.addInitScript(stub, false);
  await page.goto('/');
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Welcome to Crew' })).toHaveCount(0);

  const installed = await page.context().newPage();
  await installed.addInitScript(stub, true);
  await installed.goto('/');
  const guide = installed.getByRole('dialog', { name: 'Welcome to Crew' });
  await expect(guide).toBeVisible();
  // Every page keeps the sheet's height, so its buttons stay put.
  const height = (await guide.boundingBox())!.height;
  for (const title of ['Start in Claude Code or Codex', 'Answer from here', 'Finish setting up']) {
    await guide.getByRole('button', { name: 'Continue' }).click();
    await expect(installed.getByRole('heading', { name: title })).toBeVisible();
    expect((await guide.boundingBox())!.height).toBe(height);
  }
  await guide.getByRole('button', { name: 'Get Started' }).click();
  await expect(guide).toHaveCount(0);
  expect(await installed.evaluate(() => (window as { welcomeDone?: boolean }).welcomeDone)).toBe(true);

  await installed.keyboard.press('/');
  await installed.keyboard.type('Welcome to Crew');
  await installed.keyboard.press('Enter');
  await expect(guide).toBeVisible();
  await installed.keyboard.press('ArrowRight');
  await expect(installed.getByRole('heading', { name: 'Start in Claude Code or Codex' })).toBeVisible();
  await installed.keyboard.press('Escape');
  await expect(guide).toHaveCount(0);
});

test('a project offers its issues as cards that open the issue or start work in New Job, and a dismissed one goes', async ({ page, request }) => {
  const issue = (number: number, title: string, labels: string[]) => ({ number, title, url: `https://github.com/octo/crew/issues/${number}`, assignees: [], labels, updatedAt: '2026-11-25T00:00:00Z' });
  let issues = [issue(12, 'Board crashes when a mission has no stages', ['bug', 'p1']), issue(13, 'Add a dark mode toggle', []), issue(14, 'Document the CLI', ['docs']), issue(15, 'Fourth issue waits its turn', [])];
  const dismissed: string[] = [];
  await page.route('**/api/issues?*', (route) => route.fulfill({ json: { project: '/workspace/Crew', repo: 'octo/crew', issues, checkedAt: NOW } }));
  await page.route('**/api/issues/dismiss', async (route) => {
    const { url } = route.request().postDataJSON();
    dismissed.push(url);
    issues = issues.filter((item) => item.url !== url);
    await route.fulfill({ json: { ok: true } });
  });
  await page.getByRole('navigation', { name: 'Projects' }).getByRole('button', { name: 'Crew', exact: true }).click();
  const section = page.getByRole('region', { name: 'Start from an issue' });
  await expect(section.getByRole('listitem')).toHaveCount(3);
  // Labels read as the app shows them, first letter capitalized.
  await expect(section.getByText('#12 · Bug · P1')).toBeVisible();
  await page.screenshot({ path: process.env.CREW_E2E_SHOT ?? test.info().outputPath('issues.png') });
  await section.getByRole('button', { name: 'Dismiss #12' }).click();
  expect(dismissed).toEqual(['https://github.com/octo/crew/issues/12']);
  await expect(section.getByText('Fourth issue waits its turn')).toBeVisible();
  // Start Work fills in New Job; sending stays the user's.
  await section.getByRole('button', { name: 'Start work on #13' }).click();
  await expect(page.getByRole('textbox', { name: 'New job instructions' })).toHaveValue('Work on issue #13: Add a dark mode toggle\n\nhttps://github.com/octo/crew/issues/13');
  const calls = await (await request.get('/__requests')).json();
  expect(calls.some((call: { route: string }) => call.route === '/api/jobs')).toBe(false);
});
