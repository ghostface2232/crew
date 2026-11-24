import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ko } from '../plugin/board/src/ko.ts';
import { followSetting, language, onLanguageChange, pickLanguage, setLanguage, t, translated } from '../plugin/board/src/i18n.ts';

const root = path.resolve(import.meta.dirname, '..');
const sources = [
  ...fs.readdirSync(path.join(root, 'plugin/board/src')).map((name) => path.join('plugin/board/src', name)),
  ...fs.readdirSync(path.join(root, 'desktop')).map((name) => path.join('desktop', name)),
].filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith('ko.ts'));

/** Every key passed to t() or tNodes() as a literal, with the files that pass it. */
function literalKeys() {
  const keys = new Map<string, string[]>();
  const call = /(?<![\w$.])(?:t|tNodes)\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\$])*)`)\s*[,)]/g;
  for (const file of sources) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of text.matchAll(call)) {
      const key = (match[1] ?? match[2] ?? match[3]).replace(/\\(.)/g, (_, char: string) => (char === 'n' ? '\n' : char));
      keys.set(key, [...(keys.get(key) ?? []), file]);
    }
  }
  return keys;
}
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test('every literal interface string has Korean text with the same placeholders', () => {
  const keys = literalKeys();
  assert.ok(keys.size > 0);
  const missing = [...keys].filter(([key]) => !(key in ko)).map(([key, files]) => `${key} (${[...new Set(files)].join(', ')})`);
  assert.deepEqual(missing, [], 'Add these to plugin/board/src/ko.ts');
  const mismatched = Object.entries(ko).filter(([key, value]) => placeholders(key).join() !== placeholders(value).join()).map(([key]) => key);
  assert.deepEqual(mismatched, []);
  assert.deepEqual(Object.entries(ko).filter(([, value]) => !value.trim()).map(([key]) => key), []);
});

test('the first spoken language in the preference list wins', () => {
  assert.equal(pickLanguage(['ko-KR', 'en-US']), 'ko');
  assert.equal(pickLanguage(['ja-JP', 'ko']), 'ko');
  assert.equal(pickLanguage(['en-GB', 'ko-KR']), 'en');
  assert.equal(pickLanguage(['ja-JP']), 'en');
  assert.equal(pickLanguage([]), 'en');
});

/** Runs `run` with the browser globals the board reads, as a page would have them. */
function inPage(globals: Record<string, unknown>, run: () => void) {
  const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try {
    run();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

test('the language setting switches the page in place and is remembered for the next page', () => {
  const stored = new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) };
  const heard: string[] = [];
  const stop = onLanguageChange(() => heard.push(language));
  try {
    // No location here: a reload would sign a browser tab out, so reaching for one fails the test.
    inPage({ localStorage: storage, navigator: { languages: ['en-US'] } }, () => {
      assert.equal(language, 'en');
      // An older daemon sends no setting, and nothing changes.
      followSetting(undefined);
      assert.deepEqual([[...stored], heard], [[], []]);
      followSetting('en');
      assert.deepEqual([[...stored], heard], [[['crew.language', 'en']], []]);
      followSetting('ko');
      assert.deepEqual([[...stored], heard, t('Language')], [[['crew.language', 'ko']], ['ko'], '언어']);
      // Following the system again forgets the setting and reads the browser's language.
      followSetting(null);
      assert.deepEqual([[...stored], heard], [[], ['ko', 'en']]);
    });
    // Where storage is out of reach the setting still applies; only the next page cannot start in it.
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} };
    inPage({ localStorage: blocked, navigator: { languages: ['en-US'] } }, () => followSetting('ko'));
    assert.deepEqual(heard, ['ko', 'en', 'ko']);
  } finally {
    stop();
    setLanguage('en');
  }
});

test('text a module keeps is built again only when the language changes', () => {
  let builds = 0;
  const labels = translated(() => {
    builds++;
    return { title: t('Language') };
  });
  try {
    const english = labels();
    assert.equal(labels(), english);
    setLanguage('ko');
    assert.deepEqual([labels().title, builds], ['언어', 2]);
    assert.equal(labels(), labels());
  } finally {
    setLanguage('en');
  }
  assert.deepEqual([labels().title, builds], ['Language', 3]);
});

test('text without an entry stays English, and placeholders fill in either language', () => {
  try {
    setLanguage('ko');
    assert.equal(t('A string no catalog has {n}', { n: 3 }), 'A string no catalog has 3');
    const [key] = Object.keys(ko).filter((entry) => placeholders(entry).length);
    if (key) assert.doesNotMatch(t(key, Object.fromEntries(placeholders(key).map((name) => [name, 'X']))), /\{\w+\}/);
  } finally {
    setLanguage('en');
  }
  assert.equal(t('{a} of {b}', { a: 1, b: 2 }), '1 of 2');
});
