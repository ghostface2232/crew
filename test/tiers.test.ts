import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ANTIGRAVITY_MODELS, codexModel, codexModels, defaultTier, familyTier, modelId, pickModel, tierEffort, tierModel, tierOf } from '../plugin/bridge/tiers.ts';

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
  assert.equal(tierModel('antigravity', 'frontier'), 'neon');
  // The list agy 1.5.12 gives a Pro account.
  const options = [{ value: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' }, { value: 'gemini-4-neon' }, { value: 'gemini-4-argon' }, { value: 'gemini-4-hydrogen' }];
  assert.equal(pickModel(options, 'neon'), 'gemini-4-neon');
  assert.equal(pickModel(options, 'argon'), 'gemini-4-argon');
  assert.equal(pickModel(options, 'hydrogen'), 'gemini-4-hydrogen');
  assert.equal(pickModel(options, 'gemini-4-argon'), 'gemini-4-argon');
  assert.equal(pickModel(options, 'helium'), undefined);
  assert.equal(pickModel(undefined, 'hydrogen'), undefined);
});

test('a family name the lead passes as a model stands for its tier, and a display name for its ID', (t) => {
  assert.equal(familyTier('codex', 'Astra'), 'frontier');
  assert.equal(familyTier('codex', 'astra (frontier)'), 'frontier');
  assert.equal(familyTier('codex', 'Luna (isolated)'), 'fast');
  assert.equal(familyTier('antigravity', 'Hydrogen'), 'standard');
  assert.equal(familyTier('antigravity', 'Neon (frontier)'), 'frontier');
  // A former family is a model named outright, not the tier it held.
  assert.equal(familyTier('antigravity', 'Argon'), undefined);
  // IDs, other names, and labels naming two families are not family names.
  assert.equal(familyTier('codex', 'gpt-6-astra'), undefined);
  assert.equal(familyTier('codex', 'console'), undefined);
  assert.equal(familyTier('codex', 'Sol or Astra'), undefined);
  const file = cache(t, [{ slug: 'gpt-6-astra', display_name: 'GPT-6-Astra' }, { slug: 'gpt-6.1-terra', display_name: 'GPT-6.1 Terra' }]);
  assert.equal(modelId('codex', 'GPT-6-Astra', file), 'gpt-6-astra');
  assert.equal(modelId('codex', 'gpt-6.1 terra', file), 'gpt-6.1-terra');
  assert.equal(modelId('codex', 'gpt-5.6-sol', file), 'gpt-5.6-sol');
});

test('a named model is placed in the tier of its family', () => {
  assert.equal(tierOf('codex', 'gpt-6-astra'), 'frontier');
  assert.equal(tierOf('codex', 'gpt-6.1-sol'), 'standard');
  assert.equal(tierOf('codex', 'gpt-6-luna'), 'fast');
  assert.equal(tierOf('antigravity', 'gemini-4-neon'), 'frontier');
  assert.equal(tierOf('antigravity', 'gemini-4-argon'), 'frontier');
  assert.equal(tierOf('antigravity', 'Gemini 4 Hydrogen'), 'standard');
  assert.equal(tierOf('codex', 'custom'), undefined);
});

test('effort is medium by default and high at the frontier; a question defaults to the light tier', () => {
  assert.deepEqual(['fast', 'light', 'standard', 'frontier'].map((tier) => tierEffort(tier as never)), ['medium', 'medium', 'medium', 'high']);
  assert.equal(defaultTier({}), 'standard');
  assert.equal(defaultTier({ ask: true }), 'light');
});

test('the settings offer the models Codex lists, with the efforts each accepts, and Antigravity\'s families', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-models-')), 'models_cache.json');
  fs.writeFileSync(file, JSON.stringify({ models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
    { slug: 'gpt-6-luna', visibility: 'list' },
  ] }));
  assert.deepEqual(codexModels(file), [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'high'] },
    { id: 'gpt-6-luna', name: 'gpt-6-luna', efforts: [] },
  ]);
  assert.deepEqual(codexModels(path.join(os.tmpdir(), 'no-such-cache.json')), []);
  assert.deepEqual(ANTIGRAVITY_MODELS, [{ id: 'hydrogen', name: 'Hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'] }, { id: 'neon', name: 'Neon', efforts: ['low', 'medium', 'high', 'xhigh'] }]);
});
