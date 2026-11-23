import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientJson, clip, clipEnd } from '../plugin/bridge/text.ts';

test('a cut never leaves half of a surrogate pair', () => {
  assert.equal(clip('ab😀cd', 3), 'ab');
  assert.equal(clip('ab😀cd', 4), 'ab😀');
  assert.equal(clip('abc', 10), 'abc');
  assert.equal(clip('', 3), '');
  assert.equal(clipEnd('ab😀cd', 3), 'cd');
  assert.equal(clipEnd('ab😀cd', 4), '😀cd');
  assert.equal(clipEnd('abc', 10), 'abc');
  for (let length = 1; length <= 8; length++) {
    assert.ok(clip('😀한😀a😀', length).isWellFormed(), `clip at ${length}`);
    assert.ok(clipEnd('😀한😀a😀', length).isWellFormed(), `clipEnd at ${length}`);
  }
});

test('JSON for a client carries no lone surrogate, and nothing else is changed', () => {
  const texts = ['plain', 'ab😀cd', 'ab\ud83d cd', '\ude00 first', 'last \ud83d', '\ude00\ud83d reversed', 'literal \\ud83d text',
    'slash \\\ud83d lone', 'two \\\\ud83d slashes', 'quote "\ud83d"', '한글 \ud83d\ud83d 둘', '\\', '\\\\u', 'u d 8 3 d'];
  for (const text of texts) {
    for (const value of [text, { nested: [text, { deeper: text }] }]) {
      const json = clientJson(value);
      assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(value), (_key, item) => typeof item === 'string' ? item.toWellFormed() : item), text);
      assert.doesNotMatch(json.replace(/\\\\/g, ''), /\\ud[89a-f][0-9a-f]{2}/, text);
    }
  }
  // Well-formed input comes back byte for byte.
  const state = { jobs: [{ title: 'a "quoted" \\ path 😀', n: 1, none: null }] };
  assert.equal(clientJson(state), JSON.stringify(state));
});
