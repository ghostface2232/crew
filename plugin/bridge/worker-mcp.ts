import readline from 'node:readline';
import { api } from './client.ts';
import { VERSION } from './config.ts';
import type { LeadQuestion } from './jobs.ts';

const TOOLS = [
  {
    name: 'ask_lead',
    description: 'Ask the lead a question and keep working.',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string', maxLength: 4000 }, blocks: { type: 'string' } },
      required: ['question'],
    },
  },
  {
    name: 'lead_answers',
    description: 'Read lead answers; optionally wait for one.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { wait_seconds: { type: 'number', minimum: 0, maximum: 600 } } },
  },
  {
    name: 'siblings',
    description: 'List the other active jobs in this mission or project.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
  },
];
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

async function callTool(name: string, args: any): Promise<unknown> {
  const id = process.env.CREW_JOB_ID;
  const token = process.env.CREW_JOB_TOKEN;
  if (!id || !token || !process.env.CREW_PORT) throw new Error('CREW_JOB_ID, CREW_JOB_TOKEN and CREW_PORT are required.');
  const route = `/api/jobs/${encodeURIComponent(id)}`;
  const auth = `token=${encodeURIComponent(token)}`;
  switch (name) {
    case 'ask_lead': {
      const question = await api('POST', `${route}/questions`, { text: args.question, blocks: args.blocks, token });
      return { ...question, guidance: 'Carry on with whatever the answer does not affect; call lead_answers when you reach the part it blocks.' };
    }
    case 'lead_answers': {
      const seconds = args.wait_seconds ?? 0;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) throw new Error('wait_seconds must be a non-negative number.');
      const { questions }: { questions: LeadQuestion[] } = await api('GET', `${route}/questions?${auth}&wait=${Math.min(seconds, 600)}`);
      return { questions: questions.map((q) => ({ ...q, answer: q.answer ?? 'not answered yet' })) };
    }
    case 'siblings':
      return api('GET', `${route}/siblings?${auth}`);
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
