import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkArguments, undeclared } from '../plugin/bridge/arguments.ts';

const mission = {
  name: 'mission',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      tasks: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, after: { type: 'array', items: { type: 'string' } } } } },
      ack: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    },
  },
};
const browser = { name: 'browser', inputSchema: { type: 'object', properties: {} } };
const paths = (value: unknown) => undeclared(mission.inputSchema, value).map(({ path }) => path);

test('undeclared names every argument a schema does not declare, nested ones by path', () => {
  assert.deepEqual(paths({ id: 'm-1', ack: ['a', 'b'], tasks: [{ id: 't1', after: ['t0'] }] }), []);
  assert.deepEqual(undeclared(mission.inputSchema, { mission_id: 'm-1', tasks: [{ id: 't1' }, { id: 't2', owner: 'x' }] }), [
    { path: 'mission_id', parent: '', allowed: ['id', 'tasks', 'ack'] },
    { path: 'tasks[1].owner', parent: 'tasks[1]', allowed: ['id', 'after'] },
  ]);
  // Inherited names are not declarations.
  assert.deepEqual(paths({ toString: 'x', constructor: 1 }), ['toString', 'constructor']);
  // Values are the handlers' to judge: a wrong type is not an unknown name.
  assert.deepEqual(paths({ tasks: 'not a list', id: 3 }), []);
  // agy adds toolSummary to every call an Antigravity worker makes; only at the top, where it puts it.
  assert.deepEqual(paths({ id: 'm-1', toolSummary: 'Check the mission' }), []);
  assert.deepEqual(paths({ tasks: [{ id: 't1', toolSummary: 'x' }] }), ['tasks[0].toolSummary']);
});

test('checkArguments refuses a call with an unknown argument, naming what is taken where it was found, and leaves an unknown tool alone', () => {
  const hint = (tool: string, key: string) => (key === 'mission_id' ? `${tool} names the mission with \`id\`.` : undefined);
  assert.throws(() => checkArguments([mission], 'mission', { mission_id: 'm-1', stage: 'final' }, hint),
    { message: 'mission does not take `mission_id`, `stage`, so nothing was done. mission names the mission with `id`. Its arguments: id, tasks, ack.' });
  // A nested name is answered with the names at its own level.
  assert.throws(() => checkArguments([mission], 'mission', { tasks: [{ id: 't1', owner: 'me' }] }),
    { message: 'mission does not take `tasks[0].owner`, so nothing was done. `tasks[0]` takes id, after.' });
  assert.throws(() => checkArguments([browser], 'browser', { engine: 'chromium' }), { message: 'browser does not take `engine`, so nothing was done. It takes no arguments.' });
  checkArguments([browser], 'browser', { toolSummary: 'Start a browser' });
  checkArguments([mission], 'mission', { id: 'm-1' }, hint);
  checkArguments([mission], 'no_such_tool', { anything: true });
});
