import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { resolveConfig } from '../plugin/bridge/config.ts';
import { imageContent, openEvidence } from '../plugin/bridge/evidence.ts';
import { Jobs } from '../plugin/bridge/jobs.ts';
import type { Adapter, CrewEvent, Job, JobCtl } from '../plugin/bridge/jobs.ts';
import { describe } from '../plugin/bridge/render.ts';

function harness(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-evidence-'));
  const workers = new Map<string, JobCtl>();
  const sent: string[] = [];
  const refuse = { reply: false };
  const adapter: Adapter = {
    start: async (ctl) => { workers.set(ctl.job.id, ctl); ctl.session(ctl.job.id); },
    reply: async (ctl, message) => {
      if (refuse.reply) throw new Error('Codex has not confirmed the turn status.');
      sent.push(message);
      workers.set(ctl.job.id, ctl);
    },
    answer: async () => {}, cancel: async () => {}, shutdown: () => {},
  };
  const config = resolveConfig({ notify: false });
  const hooks = { onEvent: (_: CrewEvent) => {}, onJob: () => {}, onAttention: () => {} };
  const jobs = new Jobs(home, () => config, { codex: adapter, antigravity: adapter }, hooks);
  // Retried: the bridge may still be appending to its event log or clearing a turn's scratch.
  t.after(() => { jobs.flush(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });
  const create = (spec = {}) => jobs.create({ kind: 'delegate', cwd: home, isolation: 'in_place', task: 'test', ...spec });
  const image = (name: string) => {
    const file = path.join(home, name);
    fs.writeFileSync(file, 'png bytes');
    return file;
  };
  const settle = async (job: Job) => {
    while (job.state === 'running') await jobs.wait(job.id, job.seq, 2000);
  };
  return { home, jobs, workers, sent, refuse, create, image, settle, restore: () => new Jobs(home, () => config, { codex: adapter, antigravity: adapter }, hooks) };
}

test('the lead attaches images to a task, and the worker is told where they are and where to save its own', async (t) => {
  const h = harness(t);
  const design = h.image('design.png');
  const job = await h.create({ attachments: [design] });
  assert.equal(job.evidenceDir, path.join(h.home, 'evidence', job.id));
  assert.deepEqual(job.evidence?.map(({ file, turn, from }) => ({ file, turn, from })), [{ file: 'lead-1-design.png', turn: 1, from: 'lead' }]);
  assert.equal(fs.readFileSync(path.join(job.evidenceDir!, 'lead-1-design.png'), 'utf8'), 'png bytes');
  assert.match(job.prompt, new RegExp(`# Attached by the lead\\n.*\\n- ${path.join(job.evidenceDir!, 'lead-1-design.png').replace(/[\\.]/g, '\\$&')}`));
  assert.match(job.instructions, /# Evidence\nSave screenshots and recordings/);
  assert.ok(job.instructions.includes(job.evidenceDir!));
});

test('attachments that are not images or do not exist are refused before anything is created', async (t) => {
  const h = harness(t);
  const notes = path.join(h.home, 'notes.txt');
  fs.writeFileSync(notes, 'text');
  await assert.rejects(h.create({ attachments: [notes] }), /not an image or video/);
  await assert.rejects(h.create({ attachments: [path.join(h.home, 'missing.png')] }), /Attachment not found/);
  assert.equal(h.jobs.list().length, 0);
  assert.equal(fs.existsSync(path.join(h.home, 'evidence')), false);
});

test('screenshots the worker saves are recorded with the turn they came from, and the text result lists the latest', async (t) => {
  const h = harness(t);
  const job = await h.create();
  fs.writeFileSync(path.join(job.evidenceDir!, 'narrow.png'), 'one');
  fs.writeFileSync(path.join(job.evidenceDir!, 'notes.txt'), 'ignored');
  fs.symlinkSync('/etc/hosts', path.join(job.evidenceDir!, 'linked.png'));
  h.workers.get(job.id)!.done('first');
  await h.settle(job);
  assert.deepEqual(job.evidence?.map(({ file, turn, from }) => ({ file, turn, from })), [{ file: 'narrow.png', turn: 1, from: 'worker' }]);

  await h.jobs.reply(job.id, { message: 'Check dark mode too', attachments: [h.image('bug.png')] });
  assert.match(h.sent.at(-1)!, /^Check dark mode too\n\n# Attached by the lead\n.*\n- .*lead-2-bug\.png$/);
  fs.writeFileSync(path.join(job.evidenceDir!, 'dark.png'), 'two');
  h.workers.get(job.id)!.done('second');
  await h.settle(job);
  assert.deepEqual(job.evidence?.map(({ file, turn, from }) => `${from}:${turn}:${file}`).sort(), ['lead:2:lead-2-bug.png', 'worker:1:narrow.png', 'worker:2:dark.png']);
  const text = describe(job);
  assert.match(text, /evidence: 1 file\(s\) from turn 2, 1 earlier\n {2}.*dark\.png\n/);
  assert.doesNotMatch(text, /narrow\.png/);
});

test('a worker shows evidence with a question, and the lead answers with an attachment', async (t) => {
  const h = harness(t);
  const job = await h.create();
  fs.writeFileSync(path.join(job.evidenceDir!, 'overflow.png'), 'shot');
  assert.throws(() => h.jobs.ask(job.id, 'Is this right?', undefined, ['../design.png']), /not in your evidence directory/);
  assert.throws(() => h.jobs.ask(job.id, 'Is this right?', undefined, ['missing.png']), /not in your evidence directory/);
  const question = h.jobs.ask(job.id, 'Is this overflow expected?', undefined, ['overflow.png']);
  assert.deepEqual(question.attachments, ['overflow.png']);
  assert.ok(describe(job).includes(`Attached: ${path.join(job.evidenceDir!, 'overflow.png')}`));

  h.jobs.answer(job.id, question.id, 'No, match this', [h.image('expected.png')]);
  assert.match(job.questions![0].answer!, /^No, match this\n\n# Attached by the lead\n.*\n- .*lead-1-expected\.png$/);
});

test('evidence of a job that is no longer kept is removed at the next start', async (t) => {
  const h = harness(t);
  const job = await h.create();
  h.workers.get(job.id)!.done('done');
  await h.settle(job);
  const orphan = path.join(h.home, 'evidence', 'cx-gone00');
  fs.mkdirSync(orphan, { recursive: true });
  h.jobs.flush();
  h.restore();
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(job.evidenceDir!), true);
});

/** A PNG header that says `width` by `height`; enough for the size check. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32BE(0x89504e47, 0);
  header.writeUInt32BE(0x0d0a1a0a, 4);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

test('a screenshot rewritten under the same name in a later turn counts as that turn\'s', async (t) => {
  const h = harness(t);
  const job = await h.create();
  const shot = path.join(job.evidenceDir!, 'shot.png');
  fs.writeFileSync(shot, 'before');
  h.workers.get(job.id)!.done('first');
  await h.settle(job);
  await h.jobs.reply(job.id, { message: 'fix it' });
  fs.writeFileSync(shot, 'after the fix');
  fs.utimesSync(shot, new Date(), new Date(Date.now() + 5000));
  h.workers.get(job.id)!.done('second');
  await h.settle(job);
  assert.deepEqual(job.evidence?.map(({ file, turn, bytes }) => ({ file, turn, bytes })), [{ file: 'shot.png', turn: 2, bytes: 13 }]);
});

test('an attachment never writes through a link the worker planted in its evidence directory', async (t) => {
  const h = harness(t);
  const job = await h.create();
  h.workers.get(job.id)!.done('done');
  await h.settle(job);
  const outside = path.join(h.home, 'outside.png');
  fs.symlinkSync(outside, path.join(job.evidenceDir!, 'lead-2-design.png'));
  await h.jobs.reply(job.id, { message: 'match this', attachments: [h.image('design.png')] });
  assert.equal(fs.existsSync(outside), false);
  assert.ok(job.evidence?.some((item) => item.file === 'lead-2-design-2.png' && item.from === 'lead'));
});

test('a recorded file swapped for a link is neither served nor shown to the lead', async (t) => {
  const h = harness(t);
  const job = await h.create();
  const shot = path.join(job.evidenceDir!, 'shot.png');
  fs.writeFileSync(shot, png(10, 10));
  h.workers.get(job.id)!.done('done');
  await h.settle(job);
  const item = job.evidence![0];
  assert.equal(imageContent([item]).length, 1);
  const secret = path.join(h.home, 'secret.png');
  fs.writeFileSync(secret, png(10, 10));
  fs.rmSync(shot);
  fs.symlinkSync(secret, shot);
  assert.equal(openEvidence(item), null);
  assert.deepEqual(imageContent([item]), []);
});

test('the lead is shown only images Claude accepts, and at most four', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-images-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const item = (file: string, data: Buffer | string) => {
    fs.writeFileSync(path.join(dir, file), data);
    return { file, path: path.join(dir, file), turn: 1, from: 'worker' as const, bytes: 0, modified: 0 };
  };
  const empty = item('empty.png', '');
  const fake = item('fake.png', 'not a png');
  const tall = item('tall.png', png(1, 9001));
  assert.deepEqual(imageContent([empty, fake, tall]), []);
  const good = Array.from({ length: 6 }, (_, n) => item(`good-${n}.png`, png(800, 600)));
  const shown = imageContent([...good, good[0]]);
  assert.equal(shown.length, 4);
  assert.deepEqual(shown[0], { type: 'image', data: png(800, 600).toString('base64'), mimeType: 'image/png' });
});

test('screenshots of a turn cut off by a restart are collected when the job is restored', async (t) => {
  const h = harness(t);
  const job = await h.create();
  fs.writeFileSync(path.join(job.evidenceDir!, 'halfway.png'), 'shot');
  h.jobs.flush();
  const restored = h.restore().get(job.id);
  assert.equal(restored.state, 'failed');
  assert.deepEqual(restored.evidence?.map(({ file, turn }) => ({ file, turn })), [{ file: 'halfway.png', turn: 1 }]);
});

test('attachments to a message the worker refuses are taken back', async (t) => {
  const h = harness(t);
  const job = await h.create();
  h.refuse.reply = true;
  await assert.rejects(h.jobs.reply(job.id, { message: 'look', attachments: [h.image('design.png')] }), /not confirmed/);
  assert.deepEqual(job.evidence ?? [], []);
  assert.deepEqual(fs.readdirSync(job.evidenceDir!), []);
});

test('relative attachments and attachments to a native review are refused', async (t) => {
  const h = harness(t);
  await assert.rejects(h.create({ attachments: ['design.png'] }), /absolute paths/);
  await assert.rejects(h.jobs.create({ kind: 'review', cwd: h.home, review: { target: { type: 'uncommittedChanges' }, mode: 'standard' }, attachments: [h.image('design.png')] }), /standard review/);
});
