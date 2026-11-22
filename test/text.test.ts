import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clip, clipEnd } from '../plugin/bridge/text.ts';

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
