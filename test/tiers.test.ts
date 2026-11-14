import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { codexModel, defaultTier, pickModel, tierEffort, tierModel, tierOf } from '../plugin/bridge/tiers.ts';

function cache(t: { after: (fn: () => void) => void }, models: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-tiers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'models_cache.json');
  fs.writeFileSync(file, JSON.stringify(models));
  return file;
}

test('a Codex tier picks the newest listed model of its family, skipping hidden ones', (t) => {
  const file = cache(t, { models: [
    { slug: 'gpt-5.6-sol' }, { slug: 'gpt-6-sol' }, { slug: 'gpt-6.1-sol' }, { slug: 'gpt-6-astra' },
    { slug: 'gpt-6.1-terra' }, { slug: 'gpt-6-luna' }, { slug: 'gpt-7-sol', visibility: 'hide' }, { slug: 'gpt-6-solar' },
  ] });
  assert.equal(codexModel('sol', file), 'gpt-6.1-sol');
  assert.equal(tierModel('codex', 'frontier', file), 'gpt-6-astra');
  assert.equal(tierModel('codex', 'light', file), 'gpt-6.1-terra');
  assert.equal(tierModel('codex', 'fast', file), 'gpt-6-luna');
  // A newer Sol is picked up without any change to Crew.
  const later = cache(t, [{ slug: 'gpt-6.1-sol' }, { slug: 'gpt-6.3-sol' }]);
  assert.equal(codexModel('sol', later), 'gpt-6.3-sol');
  assert.equal(codexModel('sol', path.join(os.tmpdir(), 'no-such-cache.json')), undefined);
});

test('Antigravity tiers name a family that the session list resolves', () => {
  assert.equal(tierModel('antigravity', 'standard'), 'hydrogen');
  assert.equal(tierModel('antigravity', 'light'), 'hydrogen');
  assert.equal(tierModel('antigravity', 'frontier'), 'argon');
  const options = [{ value: 'gemini-pro-orchestrator-g1-pro', name: 'Orchestrator (Argon)' }, { value: 'gemini-4-argon' }, { value: 'gemini-4-hydrogen' }];
  assert.equal(pickModel(options, 'argon'), 'gemini-4-argon');
  assert.equal(pickModel(options, 'hydrogen'), 'gemini-4-hydrogen');
  assert.equal(pickModel(options, 'gemini-4-argon'), 'gemini-4-argon');
  assert.equal(pickModel(options, 'helium'), undefined);
  assert.equal(pickModel(undefined, 'hydrogen'), undefined);
});

test('a named model is placed in the tier of its family', () => {
  assert.equal(tierOf('codex', 'gpt-6-astra'), 'frontier');
  assert.equal(tierOf('codex', 'gpt-6.1-sol'), 'standard');
  assert.equal(tierOf('codex', 'gpt-6-luna'), 'fast');
  assert.equal(tierOf('antigravity', 'gemini-4-argon'), 'frontier');
  assert.equal(tierOf('antigravity', 'Gemini 4 Hydrogen'), 'standard');
  assert.equal(tierOf('codex', 'custom'), undefined);
});

test('effort is medium by default and high at the frontier; a question defaults to the light tier', () => {
  assert.deepEqual(['fast', 'light', 'standard', 'frontier'].map((tier) => tierEffort(tier as never)), ['medium', 'medium', 'medium', 'high']);
  assert.equal(defaultTier({}), 'standard');
  assert.equal(defaultTier({ ask: true }), 'light');
});
