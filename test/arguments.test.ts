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

test('undeclared names every argument a schema does not declare, nested ones by path', () => {
  assert.deepEqual(undeclared(mission.inputSchema, { id: 'm-1', ack: ['a', 'b'], tasks: [{ id: 't1', after: ['t0'] }] }), []);
  assert.deepEqual(undeclared(mission.inputSchema, { mission_id: 'm-1', tasks: [{ id: 't1' }, { id: 't2', owner: 'x' }] }), ['mission_id', 'tasks[1].owner']);
  // Inherited names are not declarations.
  assert.deepEqual(undeclared(mission.inputSchema, { toString: 'x', constructor: 1 }), ['toString', 'constructor']);
  // Values are the handlers' to judge: a wrong type is not an unknown name.
  assert.deepEqual(undeclared(mission.inputSchema, { tasks: 'not a list', id: 3 }), []);
});

test('checkArguments refuses a call with an unknown argument, listing what the tool takes, and leaves an unknown tool alone', () => {
  const hint = (tool: string, key: string) => (key === 'mission_id' ? `${tool} names the mission with \`id\`.` : undefined);
  assert.throws(() => checkArguments([mission], 'mission', { mission_id: 'm-1', stage: 'final' }, hint),
    { message: 'mission does not take `mission_id`, `stage`, so nothing was done. mission names the mission with `id`. Its arguments: id, tasks, ack. Call it again with these names.' });
  checkArguments([mission], 'mission', { id: 'm-1' }, hint);
  checkArguments([mission], 'no_such_tool', { anything: true });
});
