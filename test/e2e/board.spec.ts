import { test, expect } from '@playwright/test';
import { fixture, NOW, TEST_TOKEN } from './fixtures.ts';

test.beforeEach(async ({ page, request }) => {
  await request.post('/__reset');
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto('/');
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
});

test('short mission plans render in order with matching tracks and progress', async ({ page, request }) => {
  const data = fixture();
  data.missions[0].stages = ['cross-review', 'fix', 'final'];
  data.missions[0].stage = 'cross-review';
  await request.post('/__push', { data: { type: 'state', data } });
  const card = page.locator('[data-key="mission-1"]');
  await expect(card.locator('.stop-name span')).toHaveText(['Review', 'Fix', 'Final']);
  await expect(card.locator('.stop[data-pos="past"]')).toHaveCount(0);
  await expect(card.locator('.stop').first().locator('button[data-job]')).toHaveCount(2);
  await expect(card.getByRole('progressbar', { name: 'Mission progress' })).toHaveAttribute('value', String(0.5 / 3));
  await expect(card.locator('.steps circle')).toHaveCount(3);
  await card.locator('.cmd-toggle').click();
  await expect(card.locator('.mini i')).toHaveCount(3);

  data.missions[0].stage = 'final';
  await request.post('/__push', { data: { type: 'state', data } });
  await expect(card.getByRole('progressbar')).toHaveAttribute('value', String(2.5 / 3));
  data.missions[0].stages = ['final'];
  await request.post('/__push', { data: { type: 'state', data } });
  await card.locator('.cmd-toggle').click();
  await expect(card.locator('.stop-name span')).toHaveText(['Final']);
  await expect(card.getByRole('progressbar')).toHaveAttribute('value', '0.5');
  await expect(card.locator('.stop').first().locator('button[data-job]')).toHaveCount(2);
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
  await card.getByRole('button', { name: 'Mark done', exact: true }).click();
  await expect(card.locator('.chip')).toHaveText('Done');
  await expect(card.getByRole('progressbar')).toHaveAttribute('value', '1');
  await expect(card.getByText('Looks finished', { exact: true })).toHaveCount(0);
  await expect(card.locator('.stop[data-pos="past"]')).toHaveCount(2);
  await expect(card.locator('.mini i[data-state="done"]')).toHaveCount(2);
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
  await expect(card.locator('.stop-name span')).toHaveText(['Build', 'Review', 'Fix', 'Review 2', 'Fix 2', 'Polish', 'Final']);
  await expect(card.locator('.stop').nth(1).locator('button[data-job="cx-build"]')).toHaveCount(1);
  await expect(card.locator('.stop').nth(3).locator('button[data-job="cx-question"]')).toHaveCount(1);
  await expect(card.locator('.stop[data-pos="now"] .stop-name span')).toHaveText('Fix 2');
  await expect(card.getByRole('progressbar')).toHaveAttribute('value', String(4.5 / 7));
  data.missions[0].stages = [...data.missions[0].stages.slice(0, 5), 'final', 'cross-review'];
  await request.post('/__push', { data: { type: 'state', data } });
  await expect(card.locator('.stop-name span')).toHaveText(['Build', 'Review', 'Fix', 'Review 2', 'Fix 2', 'Final', 'Review 3']);
  await expect(card.locator('.stop').nth(3).locator('button[data-job="cx-question"]')).toHaveCount(1);
  await card.locator('.cmd-toggle').click();
  await expect(card.locator('.mini i')).toHaveCount(7);
});

test('question drafts and focus survive stream updates and a reconnect', async ({ page, request }) => {
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

test('answering in the drawer locks the same request on the board', async ({ page, request }) => {
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
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Shared instructions' });
  await expect(field).toBeEnabled();
  await field.fill('First draft');
  await page.getByRole('button', { name: 'Save instructions' }).click();
  await field.fill('First draft with a new requirement');
  release();
  await expect(page.getByRole('button', { name: 'Save instructions' })).toBeEnabled();
  await expect(field).toHaveValue('First draft with a new requirement');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
});

test('an old save cannot replace another scope and failed loads cannot be saved', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Shared instructions' });
  await expect(field).toBeEnabled();
  await field.fill('Old text');
  await page.getByRole('button', { name: 'Save instructions' }).click();
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByLabel('Applies to').selectOption('/workspace/Other');
  release();
  await expect(field).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save instructions' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry loading' })).toBeVisible();
});

test('settings can retry failed saves and confirm unsaved close', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Shared instructions' });
  await expect(field).toBeEnabled();
  await field.fill('Draft');
  await page.route('**/api/instructions', (route) => route.fulfill({ status: 500, json: { error: 'Save failed' } }));
  await page.getByRole('button', { name: 'Save instructions' }).click();
  await expect(page.getByText('Save failed', { exact: true })).toBeVisible();
  await expect(field).toHaveValue('Draft');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.unroute('**/api/instructions');
  await page.getByRole('button', { name: 'Save instructions' }).click();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
});

test('drawer cancels, follows up, and escapes task text', async ({ page, request }) => {
  await page.locator('button[data-job="cx-build"]').click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Inspect the existing implementation first. <task>')).toBeHidden();
  await drawer.getByText('Task given to Codex', { exact: true }).click();
  await expect(drawer.getByText('Inspect the existing implementation first. <task>')).toBeVisible();
  await drawer.getByRole('textbox', { name: 'Message to Codex' }).fill('Check the narrow layout');
  await drawer.getByRole('button', { name: 'Send message to codex' }).click();
  await expect(drawer.getByRole('textbox', { name: 'Message to Codex' })).toHaveValue('');
  await drawer.getByRole('button', { name: 'Cancel job' }).click();
  await expect(drawer.getByText('Cancelled', { exact: true }).first()).toBeVisible();
  const calls = await (await request.get('/__requests')).json();
  expect(calls.some((call: { route: string }) => call.route.endsWith('/cancel'))).toBe(true);
});

test('project filtering keeps global requests visible and direct dispatch follows roles', async ({ page, request }) => {
  await page.getByRole('combobox', { name: 'Filter project' }).selectOption('/workspace/Other');
  await expect(page.getByRole('heading', { name: 'Other', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Your answer' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption('review');
  await page.getByRole('textbox', { name: 'New job' }).fill('Review the accessibility changes');
  await page.getByRole('button', { name: 'Send new job' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const calls = await (await request.get('/__requests')).json();
  const created = calls.find((call: { route: string }) => call.route === '/api/jobs');
  expect(created.body).toMatchObject({
    kind: 'review',
    cwd: '/workspace/Other',
    review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' },
  });
});

test('a single project filter can be cleared after reload to dispatch elsewhere', async ({ page, request }) => {
  const data = fixture();
  data.claude = data.claude.filter((session) => session.cwd === '/workspace/Crew');
  await request.post('/__push', { data: { type: 'state', data } });
  const directory = page.getByRole('textbox', { name: 'Project directory' });
  await expect(directory).toBeEditable();
  await page.getByRole('heading', { name: 'Crew', exact: true }).getByRole('button').click();
  await expect(directory).not.toBeEditable();
  await page.reload();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(directory).toHaveValue('/workspace/Crew');
  await page.getByRole('combobox', { name: 'Filter project' }).selectOption('');
  await expect(directory).toBeEditable();
  await directory.fill('/workspace/New');
  await page.getByRole('textbox', { name: 'New job' }).fill('Implement the new project');
  await page.getByRole('button', { name: 'Send new job' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const calls = await (await request.get('/__requests')).json();
  expect(calls.find((call: { route: string }) => call.route === '/api/jobs').body).toMatchObject({
    cwd: '/workspace/New', project: '/workspace/New',
  });
  expect(await page.evaluate(() => localStorage.getItem('crew.project'))).toBe('');
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
  test(`layout at ${width}px has no overflow, consistent SVGs, and readable multiple requests`, async ({
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
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Your answer' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(
      await page
        .locator('.mark')
        .first()
        .evaluate((element) => element.tagName),
    ).toBe('svg');
    expect(
      await page
        .locator('.mark')
        .first()
        .evaluate((element) => getComputedStyle(element).maskImage),
    ).toBe('none');
    expect(errors).toEqual([]);
    await expect(page).toHaveScreenshot(`board-${width}.png`, { fullPage: true, animations: 'disabled' });
    await page.screenshot({ path: testInfo.outputPath(`board-${width}.png`), fullPage: true });
  });

test('IME Enter does not submit and the next question gets a fresh draft', async ({ page, request }) => {
  const field = page.getByRole('textbox', { name: 'Your answer' });
  await field.fill('조합 중');
  await field.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
  expect(await (await request.get('/__requests')).json()).toHaveLength(0);
  await request.post('/__push', { data: { type: 'job', data: { id: 'cx-question', waiting: { id: 'request-2', type: 'question', reason: 'A new question', since: NOW } } } });
  await expect(field).toHaveValue('');
  await field.fill('새 답변'); await field.press('Enter');
  const calls = await (await request.get('/__requests')).json();
  expect(calls[0].body).toMatchObject({ message: '새 답변', request_id: 'request-2' });
});

test('320px dialogs keep controls within the viewport and support reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(page.getByRole('textbox', { name: 'Shared instructions' })).toBeEnabled();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await dialog.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  await page.getByRole('button', { name: 'Save instructions' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Save instructions' })).toBeInViewport();
});

test('usage windows show every status, reset, projection, and scoped disclosure', async ({ page, request }) => {
  const gauges = page.locator('.usage-windows');
  await expect(gauges).toHaveCount(3);
  for (const status of ['ok', 'tight', 'exhausted', 'unknown'])
    await expect(page.locator(`.usage-window[data-status="${status}"]`)).toBeVisible();
  await expect(page.getByText('5-hour · 25% used', { exact: true })).toBeVisible();
  await expect(page.getByText('Resets in 1d · runs out in about 2h')).toBeVisible();
  await expect(page.getByText('Billing cycle · 0% used · unknown')).toBeVisible();
  await expect(page.locator('.usage-window[data-status="tight"]')).toHaveAttribute('title', 'Little room remains.');
  await expect(page.locator('.usage-window[data-status="stale"]')).toBeHidden();
  await page.getByText('Model limits (1)').click();
  await expect(page.getByText('Fable · Weekly · 30% used · stale')).toBeVisible();
  const usage = fixture().usage!;
  usage.providers[0].windows[0].usedRatio = 0.5;
  await request.post('/__push', { data: { type: 'usage', data: usage } });
  await expect(page.getByText('5-hour · 50% used', { exact: true })).toBeVisible();
  await expect(page.getByText('Fable · Weekly · 30% used · stale')).toBeVisible();
});

for (const source of ['absent', 'none'])
  test(`legacy limit line is unchanged when usage is ${source}`, async ({ page, request }) => {
    const data = fixture();
    if (source === 'absent') delete data.usage;
    else data.usage!.source = 'none';
    delete data.preset;
    delete data.presets;
    await request.post('/__push', { data: { type: 'state', data } });
    await expect(page.locator('.usage-windows')).toHaveCount(0);
    await expect(page.locator('.usage')).toHaveText('42% of limit used');
    await expect(page.locator('.usage')).toHaveAttribute('title', '42% of the 5-hour limit');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('Model preset')).toHaveCount(0);
  });

test('preset saves its selection, displays models, and permits none', async ({ page, request }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const select = page.getByLabel('Model preset');
  await expect(select).toHaveValue('balanced');
  await select.selectOption('economy');
  await expect(page.getByText('small · low effort')).toBeVisible();
  await expect(page.getByText('haiku', { exact: true })).toBeVisible();
  await expect(page.getByText('A model or effort set on a role overrides the preset.')).toBeVisible();
  await page.getByRole('button', { name: 'Save preset' }).click();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  let calls = await (await request.get('/__requests')).json();
  expect(calls.find((call: { route: string }) => call.route === '/api/preset').body).toEqual({ preset: 'economy' });
  await select.selectOption('');
  await page.getByRole('button', { name: 'Save preset' }).click();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  calls = await (await request.get('/__requests')).json();
  expect(calls.at(-1)).toEqual({ route: '/api/preset', body: { preset: null } });
});

test('preset failures keep the draft and saving preserves newer edits', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const select = page.getByLabel('Model preset');
  await select.selectOption('best');
  await page.route('**/api/preset', (route) => route.fulfill({ status: 500, json: { error: 'Cannot save preset' } }));
  await page.getByRole('button', { name: 'Save preset' }).click();
  await expect(page.getByText('Cannot save preset')).toBeVisible();
  await expect(select).toHaveValue('best');
  await page.unroute('**/api/preset');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/preset', async (route) => { await gate; await route.continue(); });
  await page.getByRole('button', { name: 'Save preset' }).click();
  await select.selectOption('economy');
  release();
  await expect(page.getByRole('button', { name: 'Save preset' })).toBeEnabled();
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
  await expect(rounds.getByText('Turn 1 · 1 file · Undone')).toBeVisible();
  await rounds.getByRole('button', { name: 'Keep' }).click();
  await expect(rounds.getByText('Turn 1 · 1 file · Kept')).toBeVisible();
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
  await page.getByLabel('Project directory').fill('/workspace/Crew');
  await expect(page.getByRole('combobox', { name: 'Intent', exact: true })).toHaveValue('command');
  await page.getByRole('textbox', { name: 'New job' }).fill('Implement the feature');
  await page.getByRole('button', { name: 'Send new job' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const calls = await (await request.get('/__requests')).json();
  expect(calls.find((call: { route: string }) => call.route === '/api/jobs').body).toEqual({
    kind: 'delegate', cwd: '/workspace/Crew', project: '/workspace/Crew', task: 'Implement the feature', isolation: 'worktree',
  });
});

test('question intent hides command options, respects IME, and labels the read-only job', async ({ page, request }) => {
  await page.getByLabel('Project directory').fill('/workspace/Crew');
  await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption('polish');
  await page.getByRole('combobox', { name: 'Intent', exact: true }).selectOption('question');
  await expect(page.getByRole('combobox', { name: 'Role', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Allowed files or directories (one per line)')).toHaveCount(0);
  const field = page.getByRole('textbox', { name: 'Question', exact: true });
  await field.fill('이 코드는 어떻게 동작하나요?');
  await field.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
  expect(await (await request.get('/__requests')).json()).toHaveLength(0);
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.kind')).toHaveText('Question');
  await page.getByRole('button', { name: 'Close details' }).click();
  await expect(page.locator('button[data-job="cx-direct"] .at')).toHaveText('Question');
  const calls = await (await request.get('/__requests')).json();
  expect(calls.find((call: { route: string }) => call.route === '/api/jobs').body).toEqual({
    kind: 'delegate', ask: true, task: '이 코드는 어떻게 동작하나요?', cwd: '/workspace/Crew',
  });
});

for (const target of ['mission:mission-1', 'project', 'global'])
  test(`information intent saves to ${target} without starting a job`, async ({ page, request }) => {
    await page.getByLabel('Project directory').fill('/workspace/Crew');
    await page.getByRole('combobox', { name: 'Intent', exact: true }).selectOption('information');
    await page.getByLabel('Save information to').selectOption(target);
    await expect(page.getByText('Save information for future work. This starts no job.')).toBeVisible();
    await page.getByRole('textbox', { name: 'Information', exact: true }).fill('Keep this requirement');
    await page.getByRole('button', { name: 'Send information' }).click();
    await expect(page.getByRole('textbox', { name: 'Information', exact: true })).toHaveValue('');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const calls = await (await request.get('/__requests')).json();
    expect(calls).toEqual(target.startsWith('mission:')
      ? [{ route: '/api/missions/mission-1', body: { note: 'Keep this requirement' } }]
      : [{ route: '/api/instructions', body: { append: 'Keep this requirement', project: target === 'global' ? null : '/workspace/Crew' } }]);
    if (target.startsWith('mission:')) await expect(page.getByLabel('Pinned notes').getByText('Keep this requirement')).toBeVisible();
  });

test('mission notes and progress remain visible when collapsed', async ({ page }) => {
  const card = page.locator('[data-key="mission-1"]');
  await expect(card.getByRole('progressbar', { name: 'Mission progress' })).toHaveAttribute('value', String(1.5 / 7));
  await card.getByRole('button', { name: /Make the agent board a desktop app/ }).click();
  await expect(card.getByText('21%', { exact: true })).toBeVisible();
  await expect(card.getByText('Keep keyboard navigation available.')).toBeVisible();
});

test('rounds render oldest first and waiting jobs cannot change them', async ({ page, request }) => {
  const round = fixture().jobs[0].rounds![0];
  await request.post('/__push', { data: { type: 'job', data: {
    id: 'cx-build', state: 'waiting', rounds: [{ ...round, turn: 2, state: 'undone' }, round],
  } } });
  await page.locator('button[data-job="cx-build"]').click();
  const rounds = page.getByRole('region', { name: 'Rounds' });
  await expect(rounds.locator('li').first()).toContainText('Turn 1');
  await expect(rounds.locator('li').last()).toContainText('Turn 2');
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
  await page.getByLabel('Project directory').fill('/workspace/Crew');
  await page.getByRole('combobox', { name: 'Intent', exact: true }).selectOption('information');
  const destination = page.getByRole('combobox', { name: 'Save information to' });
  await expect(destination.locator('option')).toHaveCount(3);
  await destination.selectOption('mission:mission-1');
  const field = page.getByRole('textbox', { name: 'Information', exact: true });
  await field.fill('정보를 유지해요');
  await field.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
  expect(await (await request.get('/__requests')).json()).toHaveLength(0);
  await page.route('**/api/missions/mission-1', (route) => route.fulfill({ status: 409, json: { error: 'Mission is no longer active' } }));
  await page.getByRole('button', { name: 'Send information' }).click();
  await expect(page.getByText('Mission is no longer active')).toBeVisible();
  await expect(field).toHaveValue('정보를 유지해요');
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

  test('a launch token signs in before other requests, clears the fragment, and uses only the cookie', async ({ page, context, request }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/?view=board#token=${TEST_TOKEN}`);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/\?view=board$/);
    await expect(page.getByRole('textbox', { name: 'Your answer' })).toBeVisible();
    const traffic = await (await request.get('/__traffic')).json();
    expect(traffic[0]).toEqual({ route: '/api/session', method: 'POST' });
    expect(traffic.filter((call: { route: string }) => call.route === '/api/session')).toHaveLength(1);
    expect(traffic.some((call: { route: string }) => call.route === '/api/stream')).toBe(true);
    expect(traffic.every((call: { route: string }) => !call.route.includes(TEST_TOKEN))).toBe(true);
    expect((await context.cookies()).find((cookie) => cookie.name === 'crew_session')).toMatchObject({
      httpOnly: true, sameSite: 'Strict',
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
    await expect(page.getByText('Disconnected — reconnecting…')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Your answer' })).toHaveCount(0);
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
    await expect(page.getByRole('textbox', { name: 'Your answer' })).toBeVisible();
  });

  test('an action returning 401 replaces the board and closes its stream', async ({ page, context, request }) => {
    await page.goto(`/#token=${TEST_TOKEN}`);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
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
  await expect(page.getByText('Disconnected — reconnecting…')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The board is not signed in' })).toHaveCount(0);
  await page.unroute('**/api/state');
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
});
