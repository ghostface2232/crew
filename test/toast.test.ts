import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toastCommand } from '../plugin/bridge/toast.ts';

test('a Windows toast carries its text in the environment, never in the script', () => {
  const text = `<b>"x"</b> $(whoami) '; rm -rf ~ ${'a'.repeat(300)}`;
  const toast = toastCommand('Codex finished', text, 'body', { SystemRoot: 'D:\\Win' });
  assert.equal(toast.bin, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const script = Buffer.from(toast.args.at(-1)!, 'base64').toString('utf16le');
  assert.equal(toast.args.at(-2), '-EncodedCommand');
  assert.doesNotMatch(script, /whoami|Codex finished/);
  assert.match(script, /SecurityElement\]::Escape/);
  assert.equal(toast.env.CREW_TOAST_TITLE, 'Codex finished');
  assert.equal(toast.env.CREW_TOAST_SUBTITLE, text.slice(0, 200));
  assert.equal(toast.env.CREW_TOAST_BODY, 'body');
});
