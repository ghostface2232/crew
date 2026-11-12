import { test, expect } from '@playwright/test';
import { fixture, NOW } from './fixtures.ts';

test.beforeEach(async ({ page, request }) => {
  await request.post('/__reset');
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto('/');
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
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
