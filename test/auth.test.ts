import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { boardCredential, boardExpiry, ensureToken, evidenceSeal } from '../plugin/bridge/auth.ts';

const secret = 'a1'.repeat(32);
const WEEK = 7 * 24 * 60 * 60 * 1000;

test('a board credential holds for a week under the secret that sealed it, and for nothing else', () => {
  const { credential, expires } = boardCredential(secret, 1000);
  assert.equal(expires, 1000 + WEEK);
  assert.equal(boardExpiry(credential, secret, 1000), expires);
  assert.equal(boardExpiry(credential, secret, expires - 1), expires);
  // Lapsed at the moment it names, and under another secret.
  assert.equal(boardExpiry(credential, secret, expires), null);
  assert.equal(boardExpiry(credential, 'b2'.repeat(32), 1000), null);
  const [, , seal] = credential.split('.');
  for (const forged of [secret, '', undefined, 42, `board.${expires + 1}.${seal}`, `board.0${expires}.${seal}`, `board.${expires}.${seal}.x`,
    `board.${expires}.${seal.toUpperCase()}`, `board.${expires}`, `evidence.${expires}.${seal}`]) {
    assert.equal(boardExpiry(forged, secret, 1000), null, String(forged));
  }
  assert.equal(credential.includes(secret), false);
});

test('an evidence seal opens one recorded file of one job', () => {
  const seal = evidenceSeal(secret, 'cx-1', 'shot.png', 5);
  assert.match(seal, /^[0-9a-f]{64}$/);
  assert.equal(evidenceSeal(secret, 'cx-1', 'shot.png', 5), seal);
  // Another job, another name, the same name recorded again, another secret.
  for (const other of [evidenceSeal(secret, 'cx-2', 'shot.png', 5), evidenceSeal(secret, 'cx-1', 'other.png', 5),
    evidenceSeal(secret, 'cx-1', 'shot.png', 6), evidenceSeal('b2'.repeat(32), 'cx-1', 'shot.png', 5)]) assert.notEqual(other, seal);
  // A seal is not a credential, and the parts cannot be shifted between job and file.
  assert.equal(boardExpiry(`board.5.${seal}`, secret, 0), null);
  assert.notEqual(evidenceSeal(secret, 'cx-1\0shot.png', '', 5), evidenceSeal(secret, 'cx-1', 'shot.png\0', 5));
});

test('a secret is kept once it is marked as made after tickets, and replaced once when it is not', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-auth-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const first = ensureToken(home);
  assert.equal(ensureToken(home), first);
  for (const earlier of [null, '1\n', 'x']) {
    const before = ensureToken(home);
    if (earlier === null) fs.rmSync(path.join(home, 'token.version'));
    else fs.writeFileSync(path.join(home, 'token.version'), earlier);
    const replaced = ensureToken(home);
    assert.notEqual(replaced, before, String(earlier));
    assert.equal(ensureToken(home), replaced);
    assert.equal(fs.readFileSync(path.join(home, 'token'), 'utf8'), `${replaced}\n`);
  }
  // A newer mark than this code knows keeps the secret.
  fs.writeFileSync(path.join(home, 'token.version'), '3\n');
  assert.equal(ensureToken(home), fs.readFileSync(path.join(home, 'token'), 'utf8').trim());
});
