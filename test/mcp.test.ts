import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { STAGES, normalizeTitle } from '../plugin/bridge/missions.ts';
import type { Mission } from '../plugin/bridge/missions.ts';

test('mission forwards plans on start, revision, repeated titles and reattachment', async () => {
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('function describeMission('), source.indexOf('async function describeDelivered'));
  let current: Mission | null = null;
  let saved: Mission[] = [];
  const calls: { method: string; route: string; body: any }[] = [];
  const run = vm.runInNewContext(`${stripTypeScriptTypes(handler)}; reportMission`, {
    STAGES, normalizeTitle, SESSION: 'lead', PROJECT: '/project', missionId: null, closedElsewhere: null,
    ownMission: async () => current,
    api: async (method: string, route: string, body: any) => {
      calls.push({ method, route, body });
      if (method === 'GET') return { missions: saved };
      return { id: 'm', stage: 'cross-review', stages: body.stages, state: 'active', title: 'Review' };
    },
  });
  const stages = ['cross-review', 'fix', 'final'];
  const report = await run({ title: 'Review', stages });
  assert.match(report, /step 1 of 3/);
  assert.deepEqual(calls.at(-1)?.body.stages, stages);
  current = { id: 'm', title: 'Review' } as Mission;
  for (const args of [{ stages }, { title: 'Review', stages }, { stage: 'fix', stages }]) {
    const update = await run(args);
    assert.match(update, /Plan: cross-review \(current\) → fix → final/);
    assert.equal(calls.at(-1)?.route, '/api/missions/m');
    assert.deepEqual(calls.at(-1)?.body.stages, stages);
  }
  current = null;
  saved = [{ id: 'lost', title: 'Review', owner: 'lead', project: '/project', state: 'active' } as Mission];
  await run({ title: 'Review', stages });
  assert.equal(calls.at(-1)?.route, '/api/missions/lost');
  assert.deepEqual(calls.at(-1)?.body.stages, stages);
  const describe = vm.runInNewContext(`${stripTypeScriptTypes(handler.slice(0, handler.indexOf('async function reportMission')))}; describeMission`, { STAGES });
  assert.match(describe({ id: 'm', title: 'Review', state: 'active', stage: 'self-review', stageIndex: 2,
    stages: ['self-review', 'fix', 'self-review'] }), /Plan: self-review → fix → self-review \(current\)/);
});

test('polish advertises the shared model option and forwards it to the job', async () => {
  // Evaluate just the schema and handler case, without starting the stdio server or a daemon.
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8');
  const modelProps = vm.runInNewContext(`(${source.match(/const modelProps = (\{[^]*?\n\});/)![1]})`);
  const schema = source.slice(source.indexOf("    name: 'polish',"), source.indexOf("    name: 'mission',"));
  const tool = vm.runInNewContext(`({${schema.slice(0, schema.lastIndexOf('\n  },'))}})`, {
    holder: () => 'Antigravity', worktreeProps: {}, skillsProp: {}, common: {}, modelProps,
  });
  assert.deepEqual(tool.inputSchema.properties.model, modelProps.model);
  const body = source.split("    case 'polish':")[1].split("    case 'mission':")[0];
  const run = vm.runInNewContext(`(async (args) => { const cwd = '/project', ctx = {}; ${body} })`, { runJob: (spec: unknown) => spec });
  assert.equal((await run({ targets: ['README.md'], model: 'selected-model' })).model, 'selected-model');
  assert.equal((await run({ targets: ['README.md'] })).model, undefined);
});
