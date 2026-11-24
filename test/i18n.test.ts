import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ko } from '../plugin/board/src/ko.ts';
import { pickLanguage, setLanguage, t } from '../plugin/board/src/i18n.ts';

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
