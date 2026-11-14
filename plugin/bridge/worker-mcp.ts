import { execFile } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { api } from './client.ts';
import { VERSION } from './config.ts';
import type { LeadQuestion } from './jobs.ts';

const TOOLS = [
  {
    name: 'ask_lead',
    description: 'Ask the lead a question and keep working. At most 20 questions per job.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', maxLength: 4000 },
        blocks: { type: 'string' },
        attachments: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Names of screenshots or recordings in your evidence directory to show the lead with the question.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'lead_answers',
    description: 'Answers that have arrived since you last asked, and the questions still open. With wait_seconds, returns as soon as one open question is answered or the time is up. If one stays unanswered, leave what it blocks and say so in your report.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { wait_seconds: { type: 'number', minimum: 0, maximum: 600 } } },
  },
  {
    name: 'siblings',
    description: 'The other unfinished jobs in this mission or project: who has which files, and whether one is waiting on the lead.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search',
    description: 'Search the files of your working tree for a pattern (extended regular expression), like git grep. For when you cannot run commands.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'File or directory to search in, relative to the working tree. Defaults to all of it.' }, ignore_case: { type: 'boolean' } },
      required: ['pattern'],
    },
  },
  {
    name: 'recent_changes',
    description: 'The last few commits that touched a path, and the latest one as a diff: what was just written, as opposed to what has been there. For when you cannot run commands.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File or directory, relative to the working tree. Defaults to all of it.' } } },
  },
];
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const run = promisify(execFile);
const MAX_OUTPUT = 12_000;
/** Answers this worker has already been shown; a later call returns only what is new, not the whole history again. */
const shown = new Set<string>();

/** The job's working tree, and `given` inside it. A path that leaves the tree is refused, not searched. */
function within(given: unknown): { cwd: string; target: string } {
  const cwd = process.env.CREW_JOB_CWD;
  if (!cwd) throw new Error('This job has no working tree to look in.');
  if (given !== undefined && typeof given !== 'string') throw new Error('path must be a string.');
  const target = path.resolve(cwd, given ?? '.');
  if (target !== cwd && !target.startsWith(cwd + path.sep)) throw new Error('path must be inside your working tree.');
  return { cwd, target: path.relative(cwd, target) || '.' };
}

const clip = (text: string) => (text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… cut at ${MAX_OUTPUT} characters; narrow the path or the pattern.` : text);

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    return (await run('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024, windowsHide: true })).stdout;
  } catch (err: any) {
    // git grep exits 1 when nothing matches; that is an answer, not a failure.
    if (err?.code === 1 && !err.stderr) return '';
    throw new Error(String(err?.stderr || err?.message || err).trim().split('\n')[0]);
  }
}

async function callTool(name: string, args: any): Promise<unknown> {
  const id = process.env.CREW_JOB_ID;
  const token = process.env.CREW_JOB_TOKEN;
  if (!id || !token || !process.env.CREW_PORT) throw new Error('CREW_JOB_ID, CREW_JOB_TOKEN and CREW_PORT are required.');
  const route = `/api/jobs/${encodeURIComponent(id)}`;
  const auth = `token=${encodeURIComponent(token)}`;
  switch (name) {
    case 'ask_lead': {
      const question = await api('POST', `${route}/questions`, { text: args.question, blocks: args.blocks, attachments: args.attachments, token });
      return { ...question, guidance: 'Carry on with whatever the answer does not affect; call lead_answers when you reach the part it blocks.' };
    }
    case 'lead_answers': {
      const seconds = args.wait_seconds ?? 0;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) throw new Error('wait_seconds must be a non-negative number.');
      const { questions }: { questions: LeadQuestion[] } = await api('GET', `${route}/questions?${auth}&wait=${Math.min(seconds, 600)}`);
      const fresh = questions.filter((q) => q.answer !== undefined && !shown.has(q.id));
      for (const q of fresh) shown.add(q.id);
      return {
        answered: fresh.map(({ id, text, answer }) => ({ id, question: text, answer })),
        open: questions.filter((q) => q.answer === undefined).map(({ id, text, blocks }) => ({ id, question: text, blocks })),
        answered_earlier: questions.filter((q) => q.answer !== undefined).length - fresh.length,
      };
    }
    case 'siblings':
      return api('GET', `${route}/siblings?${auth}`);
    case 'search': {
      if (typeof args.pattern !== 'string' || !args.pattern) throw new Error('pattern must be a non-empty string.');
      const { cwd, target } = within(args.path);
      // Tracked and untracked files, never ignored ones; the pattern goes after -e so it cannot be read as an option.
      const out = await git(cwd, ['grep', '-n', '-I', '-E', '--untracked', ...(args.ignore_case ? ['-i'] : []), '-e', args.pattern, '--', target]);
      const lines = out.split('\n').filter(Boolean);
      return { matches: lines.length, text: clip(lines.map((line) => (line.length > 300 ? `${line.slice(0, 300)}…` : line)).join('\n')) || 'No match.' };
    }
    case 'recent_changes': {
      const { cwd, target } = within(args.path);
      const log = await git(cwd, ['log', '-n', '5', '--date=short', '--format=%h %ad %s', '--stat', '--', target]);
      if (!log.trim()) return { commits: 'No commit touches that path.' };
      const latest = (await git(cwd, ['log', '-n', '1', '--format=%H', '--', target])).trim();
      return { commits: clip(log), latest_diff: clip(await git(cwd, ['show', '--format=', latest, '--', target])) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg;
  const reply = (result: unknown) => { send({ jsonrpc: '2.0', id, result }); };
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[1],
        capabilities: { tools: {} },
        serverInfo: { name: 'crew-worker', version: VERSION },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      try {
        const result = await callTool(params?.name, params?.arguments ?? {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: String((err as Error).message ?? err) }], isError: true });
      }
    default:
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg: any;
  try {
    msg = JSON.parse(line);
    if (!msg || typeof msg !== 'object') throw new Error('invalid message');
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (typeof msg.method === 'string') void handle(msg);
});
