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
