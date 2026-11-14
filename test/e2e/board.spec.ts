import { test, expect, type Locator, type Page } from '@playwright/test';
import { fixture, NOW, TEST_TOKEN } from './fixtures.ts';

test.beforeEach(async ({ page, request }) => {
  await request.post('/__reset');
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto('/');
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
});
const needsYou = (page: Page) => page.getByRole('tab', { name: 'Needs You' }).click();
const openSettings = async (page: Page, tab?: string) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  if (tab) await page.getByRole('radio', { name: tab }).click();
};
const newJob = (page: Page) => page.getByRole('button', { name: 'New Job', exact: true }).click();
const stage = (card: Locator, name: string) =>
  card.locator('.stage-groups > .rows').filter({ has: card.page().getByRole('heading', { name, exact: true }) });

test('short mission plans render in order with matching tracks and progress', async ({ page, request }) => {
  const data = fixture();
  data.missions[0].stages = ['cross-review', 'fix', 'final'];
  data.missions[0].stage = 'cross-review';
  await request.post('/__push', { data: { type: 'state', data } });
  const card = page.locator('[data-key="mission-1"]');
  await expect(card.locator('.track-name')).toHaveText(['Review', 'Fix', 'Final']);
  await expect(card.locator('.track > li[data-pos="past"]')).toHaveCount(0);
  await expect(stage(card, 'Review').locator('button[data-job]')).toHaveCount(2);
  await expect(card.locator('.mission-progress')).toHaveText(`${Math.round((0.5 / 3) * 100)}%`);

  data.missions[0].stage = 'final';
  await request.post('/__push', { data: { type: 'state', data } });
  await expect(card.locator('.mission-progress')).toHaveText(`${Math.round((2.5 / 3) * 100)}%`);
  data.missions[0].stages = ['final'];
  await request.post('/__push', { data: { type: 'state', data } });
  await expect(card.locator('.track-name')).toHaveText(['Final']);
  await expect(card.locator('.mission-progress')).toHaveText('50%');
  await expect(stage(card, 'Final').locator('button[data-job]')).toHaveCount(2);
});

test('a quiet ended workload looks finished and the authenticated user can mark the mission done', async ({ page, request }) => {
  // From `/`, a fragment-only goto would not reload the page, so the launch token would never sign in.
  await page.goto('about:blank');
  await request.post('/__reset', { data: { auth: true } });
  await page.goto(`/#token=${TEST_TOKEN}`);
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
  await page.getByRole('menuitem', { name: 'Mark done' }).click();
  await expect(card.locator('.mission-head .chip')).toHaveText('Done');
  await expect(card.locator('.mission-progress')).toHaveText('100%');
  await expect(card.getByText('Looks finished', { exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Mission options' })).toHaveCount(0);
  // An ended mission starts collapsed, as in the app.
  await card.getByRole('button', { name: 'Expand mission' }).click();
  await expect(card.locator('.track > li[data-pos="past"]')).toHaveCount(2);
  const calls = await (await request.get('/__requests')).json();
  expect(calls).toEqual([{ route: '/api/missions/mission-1', body: { done: true, outcome: 'Marked done on the board.' } }]);
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
  await expect(card.locator('.mission-progress')).toHaveText(`${Math.round((4.5 / 7) * 100)}%`);
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
  await page.getByRole('button', { name: 'Save Instructions' }).click();
  await field.fill('First draft with a new requirement');
  release();
  await expect(page.getByRole('button', { name: 'Save Instructions' })).toBeEnabled();
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
  await page.getByRole('button', { name: 'Save Instructions' }).click();
  // As in the app, the scope is locked while its save is in flight.
  await expect(page.getByLabel('Applies to')).toBeDisabled();
  release();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  await page.getByLabel('Applies to').selectOption('/workspace/Other');
  await expect(field).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save Instructions' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry Loading' })).toBeVisible();
});

test('settings can retry failed saves and confirm unsaved close', async ({ page }) => {
  // Open from the keyboard: Safari does not focus a clicked button, so there would be no focus to return to.
  await page.getByRole('button', { name: 'Settings', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('radio', { name: 'Instructions' }).click();
  const field = page.getByRole('textbox', { name: 'Shared instructions' });
  await expect(field).toBeEnabled();
  await field.fill('Draft');
  await page.route('**/api/instructions', (route) => route.fulfill({ status: 500, json: { error: 'Save failed' } }));
  await page.getByRole('button', { name: 'Save Instructions' }).click();
  await expect(page.getByText('Save failed', { exact: true })).toBeVisible();
  await expect(field).toHaveValue('Draft');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.unroute('**/api/instructions');
  await page.getByRole('button', { name: 'Save Instructions' }).click();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
});

test('detail panel cancels, follows up, and escapes task text', async ({ page, request }) => {
  await page.locator('button[data-job="cx-build"]').click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Inspect the existing implementation first. <task>')).toBeHidden();
  await drawer.getByText('Original task', { exact: true }).click();
  await expect(drawer.getByText('Inspect the existing implementation first. <task>')).toBeVisible();
  const message = drawer.getByRole('textbox', { name: 'Message to Codex' });
  await message.fill('Check the narrow layout');
  // Return adds a newline; only the button sends.
  await message.press('Enter');
  expect((await (await request.get('/__requests')).json()).some((call: { route: string }) => call.route.endsWith('/reply'))).toBe(false);
  await drawer.getByRole('button', { name: 'Send message' }).click();
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
    { file: 'narrow.png', path: '/x/narrow.png', turn: 1, from: 'worker', bytes: 10, modified: 1 },
    { file: 'lead-1-design.png', path: '/x/lead-1-design.png', turn: 1, from: 'lead', bytes: 10, modified: 1 },
  ];
  await request.post('/__push', { data: { type: 'state', data } });
  await page.locator(`button[data-job="${data.jobs[0].id}"]`).click();
  const section = page.getByRole('dialog').getByRole('region', { name: 'Evidence' });
  const shot = section.getByRole('img', { name: 'narrow.png' });
  await expect(shot).toBeVisible();
  expect(await shot.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(section.getByText('Turn 1 · narrow.png')).toBeVisible();
  await expect(section.getByText('Attached by the lead · lead-1-design.png')).toBeVisible();
});

test('project filtering keeps global requests visible and New Job follows roles', async ({ page, request }) => {
  await page.getByRole('navigation').getByRole('button', { name: 'Other', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Other', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: /1 request needs your attention/ })).toBeVisible();
  await newJob(page);
  await expect(page.getByRole('textbox', { name: 'Project directory' })).toHaveValue('/workspace/Other');
  await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption('review');
  await page.getByRole('textbox', { name: 'New job instructions' }).fill('Review the accessibility changes');
  await page.getByRole('button', { name: 'Send Job' }).click();
  await expect(page.getByRole('button', { name: 'Close details' })).toBeVisible();
  const calls = await (await request.get('/__requests')).json();
  const created = calls.find((call: { route: string }) => call.route === '/api/jobs');
  expect(created.body).toMatchObject({
    kind: 'review',
    cwd: '/workspace/Other',
    review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' },
  });
});

test('a chosen project survives reload and All projects lets New Job go elsewhere', async ({ page, request }) => {
  await page.getByRole('navigation').getByRole('button', { name: 'Crew', exact: true }).click();
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
  expect(await page.evaluate(() => localStorage.getItem('crew.selection'))).toBe('overview');
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
    expect(await page.locator('.chip svg').first().evaluate((element) => element.tagName)).toBe('svg');
    expect(await page.locator('.agent-mark').first().evaluate((element) => getComputedStyle(element).maskImage)).not.toBe('none');
    // One baseline, Chromium's on macOS: text renders differently in other engines and systems, where the checks above still run.
    if (testInfo.project.name === 'chromium' && process.platform === 'darwin') await expect(page).toHaveScreenshot(`board-${width}.png`, { fullPage: true, animations: 'disabled' });
    await page.screenshot({ path: testInfo.outputPath(`board-${width}.png`), fullPage: true });
    await needsYou(page);
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Your answer' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
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

test('320px sheets keep controls within the viewport and support reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('combobox', { name: 'Project' }).selectOption('/workspace/Crew');
  await expect(page.getByRole('heading', { name: 'Crew', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: 'Project' }).selectOption('');
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
  await expect(page.getByRole('button', { name: 'Save Instructions' })).toBeInViewport();
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

test('preset saves its selection, describes its models, and permits none', async ({ page, request }) => {
  await openSettings(page, 'Presets');
  const select = page.getByLabel('Model preset');
  await expect(select).toHaveValue('balanced');
  await select.selectOption('economy');
  await expect(page.getByText('Codex: small · low effort; Antigravity: flash; Subagents: haiku', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save Preset' }).click();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  let calls = await (await request.get('/__requests')).json();
  expect(calls.find((call: { route: string }) => call.route === '/api/preset').body).toEqual({ preset: 'economy' });
  await select.selectOption('');
  await expect(page.getByText("Uses each agent's configured model and effort.")).toBeVisible();
  await page.getByRole('button', { name: 'Save Preset' }).click();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  calls = await (await request.get('/__requests')).json();
  expect(calls.at(-1)).toEqual({ route: '/api/preset', body: { preset: null } });
});

test('preset failures keep the draft and saving preserves newer edits', async ({ page }) => {
  await openSettings(page, 'Presets');
  const select = page.getByLabel('Model preset');
  await select.selectOption('best');
  await page.route('**/api/preset', (route) => route.fulfill({ status: 500, json: { error: 'Cannot save preset' } }));
  await page.getByRole('button', { name: 'Save Preset' }).click();
  await expect(page.getByText('Cannot save preset')).toBeVisible();
  await expect(select).toHaveValue('best');
  await page.unroute('**/api/preset');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/preset', async (route) => { await gate; await route.continue(); });
  await page.getByRole('button', { name: 'Save Preset' }).click();
  await select.selectOption('economy');
  release();
  await expect(page.getByRole('button', { name: 'Save Preset' })).toBeEnabled();
  await expect(select).toHaveValue('economy');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
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
    kind: 'delegate', cwd: '/workspace/Crew', project: '/workspace/Crew', task: 'Implement the feature', isolation: 'worktree',
  });
});

test('question intent hides command options, keeps Return as a newline, and labels the read-only job', async ({ page, request }) => {
  await newJob(page);
  await page.getByLabel('Project directory').fill('/workspace/Crew');
  await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption('polish');
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
    await page.getByLabel('Information destination').selectOption(target);
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

test('mission progress stays visible when collapsed and notes show when expanded', async ({ page }) => {
  const card = page.locator('[data-key="mission-1"]');
  await expect(card.locator('.mission-progress')).toHaveText(`${Math.round((1.5 / 7) * 100)}%`);
  await expect(card.getByText('Keep keyboard navigation available.')).toBeVisible();
  await card.getByRole('button', { name: 'Collapse mission' }).click();
  await expect(card.getByText('21%', { exact: true })).toBeVisible();
  await expect(card.getByText('Keep keyboard navigation available.')).toHaveCount(0);
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
  await expect(destination.locator('option')).toHaveCount(3);
  await destination.selectOption('mission:mission-1');
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

  test('a launch token signs in before other requests, clears the fragment, and uses only the cookie', async ({ page, context, request, browserName }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/?view=board#token=${TEST_TOKEN}`);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/\?view=board$/);
    await expect(page.locator('button[data-job="cx-build"]')).toBeVisible();
    const traffic = await (await request.get('/__traffic')).json();
    expect(traffic[0]).toEqual({ route: '/api/session', method: 'POST' });
    expect(traffic.filter((call: { route: string }) => call.route === '/api/session')).toHaveLength(1);
    expect(traffic.some((call: { route: string }) => call.route === '/api/stream')).toBe(true);
    expect(traffic.every((call: { route: string }) => !call.route.includes(TEST_TOKEN))).toBe(true);
    // WebKit on Windows reports every cookie's SameSite as None; the server still sends Strict.
    expect((await context.cookies()).find((cookie) => cookie.name === 'crew_session')).toMatchObject({
      httpOnly: true, ...(browserName === 'webkit' && process.platform === 'win32' ? {} : { sameSite: 'Strict' }),
    });
    expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })))
      .toEqual({ local: {}, session: {} });
    expect(await page.evaluate(() => Reflect.get(window, '__secretStorageWrite'))).toBe(false);
    expect(errors).toEqual([]);
    await page.reload();
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
  });

  test('without a token, explains sign-in and stops retrying until asked', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toBeVisible();
    await expect(page.getByText('crew board', { exact: true })).toBeVisible();
    await expect(page.getByText('Open Web Board', { exact: true })).toBeVisible();
    await expect(page.getByText('Reconnecting…')).toHaveCount(0);
    await expect(page.locator('button[data-job]')).toHaveCount(0);
    const before = await (await request.get('/__traffic')).json();
    expect(before.length).toBeGreaterThan(0);
    expect(before.length).toBeLessThanOrEqual(2);
    await page.waitForTimeout(2000);
    expect(await (await request.get('/__traffic')).json()).toEqual(before);
  });

  test('a wrong token shows the same screen and removes the fragment', async ({ page, request }) => {
    await page.goto(`/#token=${'f'.repeat(64)}`);
    await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    expect(await (await request.get('/__traffic')).json()).toEqual([{ route: '/api/session', method: 'POST' }]);
  });

  test('Retry loads the board after the cookie is set', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toBeVisible();
    expect((await context.request.post('/api/session', { data: { token: TEST_TOKEN } })).status()).toBe(200);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await expect(page.locator('button[data-job="cx-build"]')).toBeVisible();
  });

  test('an action returning 401 replaces the board and closes its stream', async ({ page, context, request }) => {
    await page.goto(`/#token=${TEST_TOKEN}`);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await needsYou(page);
    await context.clearCookies();
    await page.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toBeVisible();
    await request.post('/__push', { data: { type: 'state', data: fixture() } });
    await expect(page.getByRole('textbox', { name: 'Your answer' })).toHaveCount(0);
    const before = await (await request.get('/__traffic')).json();
    await page.waitForTimeout(2000);
    expect(await (await request.get('/__traffic')).json()).toEqual(before);
  });

  test('a failed stream probes state and stops on 401', async ({ page, context, request }) => {
    await page.goto(`/#token=${TEST_TOKEN}`);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await context.clearCookies();
    await request.post('/__push', { data: { type: 'disconnect' } });
    await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toBeVisible();
    const before = await (await request.get('/__traffic')).json();
    expect(before.at(-1)).toEqual({ route: '/api/state', method: 'GET' });
    await page.waitForTimeout(2000);
    expect(await (await request.get('/__traffic')).json()).toEqual(before);
  });

  test('a stream rejected with 401 is detected even after a successful state fetch', async ({ page, request }) => {
    let streamRequested = false;
    page.on('request', (call) => {
      if (new URL(call.url()).pathname === '/api/stream') streamRequested = true;
    });
    await page.route('**/api/state', (route) => route.fulfill({
      status: streamRequested ? 401 : 200,
      json: streamRequested ? { error: 'unauthorized' } : fixture(),
    }));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toBeVisible();
    expect(await (await request.get('/__traffic')).json()).toEqual([{ route: '/api/stream', method: 'GET' }]);
  });
});

test('an unreachable stream stays a connection failure and can recover', async ({ page, request }) => {
  await page.route('**/api/state', (route) => route.abort());
  await request.post('/__push', { data: { type: 'disconnect' } });
  await expect(page.getByText('Lost the connection to Crew. Reconnecting…')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toHaveCount(0);
  await page.unroute('**/api/state');
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
});
