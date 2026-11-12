import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

/** Runs the board's handlers with deferred HTTP responses and only the DOM needed for settings. */
function harness() {
  const elements = new Map<string, any>();
  const handlers = new Map<string, (event: any) => Promise<void>>();
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, {
      id, value: '', disabled: false, dataset: {}, textContent: '',
      addEventListener: () => {}, toggleAttribute: () => {}, setAttribute: () => {}, removeAttribute: () => {},
    });
    return elements.get(id);
  };
  const button = element('save');
  const status = element('status');
  const form = { id: 'instructions-form', querySelector: (selector: string) => selector.startsWith('button') ? button : status };
  const requests: { body: any; resolve: (data: unknown) => void; reject: (error: Error) => void }[] = [];
  const context = vm.createContext({
    document: {
      getElementById: element,
      addEventListener: (name: string, handler: (event: any) => Promise<void>) => handlers.set(name, handler),
      querySelector: () => button,
      querySelectorAll: () => [],
    },
    window: { addEventListener: () => {} },
    localStorage: { getItem: () => null },
    setInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    EventSource: class { addEventListener() {} },
    fetch: (_route: string, options?: { body: string }) => new Promise((resolve, reject) => {
      requests.push({ body: options && JSON.parse(options.body), resolve: (data) => resolve({ ok: true, json: async () => data }), reject });
    }),
  });
  vm.runInContext(fs.readFileSync(new URL('../plugin/board/board.js', import.meta.url), 'utf8'), context);
  vm.runInContext('savedRoles = JSON.stringify(rolesTable())', context);
  return {
    instructions: element('instructions-text'), scope: element('instructions-scope'), button, status, requests,
    submit: () => handlers.get('submit')!({ preventDefault() {}, target: form }),
    load: () => vm.runInContext('loadInstructions()', context) as Promise<void>,
    dirty: () => vm.runInContext('settingsDirty()', context) as boolean,
    run: (code: string) => vm.runInContext(code, context),
  };
}

test('saving instructions preserves later edits and keeps them unsaved until the next save', async () => {
  const h = harness();
  h.instructions.value = 'First draft';
  const first = h.submit();
  assert.equal(h.requests[0].body.text, 'First draft');
  h.instructions.value = 'First draft with a new requirement';
  h.requests[0].resolve({ file: '/project/.crew/instructions.md', text: 'First draft\n' });
  await first;
  assert.equal(h.instructions.value, 'First draft with a new requirement');
  assert.equal(h.dirty(), true);
  assert.equal(h.button.disabled, false);

  const second = h.submit();
  assert.equal(h.requests[1].body.text, 'First draft with a new requirement');
  h.requests[1].resolve({ file: '/project/.crew/instructions.md', text: 'First draft with a new requirement\n' });
  await second;
  assert.equal(h.instructions.value, 'First draft with a new requirement\n');
  assert.equal(h.dirty(), false);
});

test('one request shares a lock across decisions and text answers, including after acceptance', async () => {
  const h = harness();
  const first = h.run(`runAction(answerKey('cx-1', 'request-1'), 'approve', () => call('/reply', { decision: 'approve' }))`);
  assert.equal(await h.run(`runAction(answerKey('cx-1', 'request-1'), 'deny', () => call('/reply', { decision: 'deny' }))`), false);
  assert.equal(await h.run(`runAction(answerKey('cx-1', 'request-1'), 'send', () => call('/reply', { message: 'answer' }))`), false);
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({});
  assert.equal(await first, true);
  // A slow SSE update must not reopen the already-answered request.
  assert.equal(await h.run(`runAction(answerKey('cx-1', 'request-1'), 'deny', () => call('/reply', {}))`), false);
  const next = h.run(`runAction(answerKey('cx-1', 'request-2'), 'send', () => call('/reply', { message: 'next answer' }))`);
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve({});
  assert.equal(await next, true);
});

test('a failed answer unlocks for retry and cannot put its error onto the next request', async () => {
  const h = harness();
  const first = h.run(`runAction(answerKey('cx-1', 'old'), 'approve', () => call('/reply', {}))`);
  const next = h.run(`runAction(answerKey('cx-1', 'new'), 'send', () => call('/reply', {}))`);
  h.requests[0].reject(new Error('Connection lost. Try again.'));
  assert.equal(await first, false);
  assert.equal(h.run(`actionStates.get(answerKey('cx-1', 'new')).pending`), true);
  assert.equal(h.run(`actionStates.get(answerKey('cx-1', 'old')).tone`), 'failed');
  const retry = h.run(`runAction(answerKey('cx-1', 'old'), 'approve', () => call('/reply', {}))`);
  assert.equal(h.requests.length, 3);
  h.requests[2].resolve({});
  assert.equal(await retry, true);
  h.requests[1].resolve({});
  assert.equal(await next, true);
});

test('a failed instructions save preserves the draft and allows a retry', async () => {
  const h = harness();
  h.instructions.value = 'Draft';
  const pending = h.submit();
  h.requests[0].reject(new Error('Save failed'));
  await pending;
  assert.equal(h.instructions.value, 'Draft');
  assert.equal(h.dirty(), true);
  assert.equal(h.button.disabled, false);
  assert.equal(h.status.textContent, 'Save failed');
});

test('a save response cannot overwrite or unlock an instructions editor being reloaded', async () => {
  const h = harness();
  h.instructions.value = 'Old draft';
  const saving = h.submit();
  // Reloading the same scope also happens when settings are closed and reopened.
  const loading = h.load();
  h.requests[0].resolve({ file: '/project/.crew/instructions.md', text: 'Old draft\n' });
  await saving;
  assert.equal(h.button.disabled, true);
  assert.equal(h.instructions.value, 'Old draft');
  h.requests[1].resolve({ file: '/project/.crew/instructions.md', text: 'Freshly loaded text\n' });
  await loading;
  assert.equal(h.instructions.value, 'Freshly loaded text\n');
  assert.equal(h.button.disabled, false);
  assert.equal(h.dirty(), false);
});

test('states combine by urgency and times read as coarse labels', () => {
  const context = vm.createContext({
    document: { getElementById: () => ({ addEventListener() {}, dataset: {} }), addEventListener() {}, querySelectorAll: () => [] },
    window: { addEventListener() {} }, localStorage: { getItem: () => null }, setInterval() {}, EventSource: class { addEventListener() {} },
  });
  vm.runInContext(fs.readFileSync(new URL('../plugin/board/board.js', import.meta.url), 'utf8'), context);
  const run = (code: string) => vm.runInContext(code, context);
  // Folded, a stop shows the state that most needs the user.
  assert.equal(run(`together(['done', 'working', 'waiting'])`), 'waiting');
  assert.equal(run(`together(['done', 'stalled', 'working'])`), 'stalled');
  assert.equal(run(`together(['done', 'idle'])`), 'done');
  assert.equal(run(`together([])`), '');
  assert.equal(run(`jobMark({ state: 'running', stalled: true })`), 'stalled');
  assert.equal(run(`jobMark({ state: 'waiting', stalled: true })`), 'waiting');
  assert.equal(run(`jobMark({ state: 'cancelled' })`), 'idle');
  assert.equal(run(`[brief(42_000), brief(7 * 60_000 + 59_000), brief(3_780_000)].join(', ')`), '42s, 7m, 1h 3m');
  assert.equal(run(`timeLabel({ state: 'failed', createdAt: 0, endedAt: 660_000 })`), 'stopped after 11m');
  // The two reviews share one stop, and a job sits at the stop of its kind.
  assert.equal(run(`STOP_OF_STAGE['self-review']`), run(`STOP_OF_STAGE['cross-review']`));
  assert.match(run(`trackOf([{ id: 'cx-1', kind: 'review', state: 'done', agent: 'codex', title: 'R', createdAt: 0, endedAt: 1000 }], 2, true, false).html`), /data-pos="now"><p class="stop-name"><i class="node"><\/i><span title="Review">Review<\/span><\/p><ul class="items">/);
});

test('unfinished jobs outlive the recent-command limit without duplicate rows', () => {
  const h = harness();
  h.run(`
    for (const [id, endedAt] of [['old', 100], ['recent', 200], ['newest', 300]]) {
      missions.set(id, { id, title: id, state: 'abandoned', stage: 'implement', createdAt: 1, endedAt });
    }
    jobs.set('cx-old', { id: 'cx-old', mission: 'old', agent: 'codex', kind: 'delegate', title: 'Still running', state: 'running', createdAt: 2 });
    jobs.set('cx-recent', { id: 'cx-recent', mission: 'recent', agent: 'codex', kind: 'delegate', title: 'Waiting', state: 'waiting', waiting: { type: 'approval' }, createdAt: 3 });
  `);
  const cards = () => h.run(`cardsForProject({ missions: [...missions.values()], jobs: [...jobs.values()] }, '/project')`) as { key: string; closed: boolean; html: string }[];
  assert.deepEqual(Array.from(cards(), (card) => card.key), ['loose:/project', 'newest', 'recent']);
  assert.equal(cards()[0].closed, false);
  assert.match(cards()[0].html, /data-job="cx-old"/);
  assert.doesNotMatch(cards()[0].html, /data-job="cx-recent"/);
  assert.match(cards().find((card) => card.key === 'recent')!.html, /data-job="cx-recent"/);
  // The row remains reachable while waiting too, then leaves the active group when it finishes.
  h.run(`Object.assign(jobs.get('cx-old'), { state: 'waiting', waiting: { type: 'approval' } })`);
  assert.match(cards()[0].html, /data-job="cx-old"/);
  h.run(`Object.assign(jobs.get('cx-old'), { state: 'done', endedAt: 400 })`);
  assert.deepEqual(Array.from(cards(), (card) => card.key), ['newest', 'recent']);
});

test('mission leads disclose their full escaped question and retain a stable focus key across updates', () => {
  const h = harness();
  h.run(`
    sessions.set('lead-1', { id: 'lead-1', title: 'A long <session> title', cwd: '/project', state: 'waiting', waitingFor: 'First line\\nLast line <question>' });
    missions.set('active', { id: 'active', owner: 'lead-1', title: 'Task', state: 'active', stage: 'implement', createdAt: 1 });
  `);
  const html = () => h.run(`commandCard(missions.get('active')).html`) as string;
  assert.match(html(), /<details class="lead" data-details="session:lead-1"><summary class="item" data-session="lead-1"/);
  assert.match(html(), /<div class="session-detail"><p>A long &#60;session&#62; title<\/p><p>First line\nLast line &#60;question&#62;<\/p>/);
  h.run(`Object.assign(sessions.get('lead-1'), { state: 'working', phase: 'New phase details' })`);
  assert.match(html(), /data-session="lead-1"/);
  assert.match(html(), /<p>New phase details<\/p>/);
  assert.doesNotMatch(html(), /Last line/);
  assert.equal(h.run(`controlKey({ tagName: 'SUMMARY', matches: () => true, dataset: { session: 'lead-1', state: 'working' } })`),
    h.run(`controlKey({ tagName: 'SUMMARY', matches: () => true, dataset: { session: 'lead-1', state: 'waiting' } })`));
});

test('job focus identity survives presentation changes but distinguishes jobs and actions', () => {
  const h = harness();
  const key = (state: string, job = 'cx-1', act = 'open') => h.run(`controlKey({
    tagName: 'BUTTON', matches: () => true,
    dataset: ${JSON.stringify({ job, act, state })}, textContent: ${JSON.stringify(state)},
  })`);
  for (const state of ['waiting', 'stalled', 'done', 'failed', 'idle']) {
    assert.equal(key(state), key('working'));
  }
  assert.notEqual(key('working', 'cx-2'), key('working'));
  assert.notEqual(key('working', 'cx-1', 'cancel'), key('working'));
});

test('urgency reordering preserves the focused control after moving its row', () => {
  const h = harness();
  assert.equal(h.run(`(() => {
    let preventedScroll = false;
    const button = { focus(options) { document.activeElement = this; preventedScroll = options.preventScroll; } };
    const first = { dataset: { key: 'first' }, contains: () => false };
    const urgent = { dataset: { key: 'urgent' }, contains: node => node === button };
    const list = {
      children: [first, urgent],
      insertBefore(el, before) {
        if (el.contains(document.activeElement)) document.activeElement = null;
        this.children.splice(this.children.indexOf(el), 1);
        this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, el);
      },
    };
    document.activeElement = button;
    reconcile(list, ['urgent', 'first'].map(key => ({ key, update() {} })), () => { throw new Error('Should reuse rows'); });
    return list.children[0] === urgent && document.activeElement === button && preventedScroll;
  })()`), true);
});
