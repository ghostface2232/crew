import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, codexJob, ensureDaemon } from './client.ts';
import { JOB_ID as ANY_JOB } from './config.ts';
import { HOOK_SECONDS } from './delivery.ts';

interface HookInput {
  session_id?: string; agent_id?: string; hook_event_name?: string; stop_hook_active?: boolean;
  tool_name?: string; tool_input?: { job_id?: unknown; job_ids?: unknown }; tool_response?: unknown;
}

const JOB_ID = new RegExp(`\\[(${ANY_JOB})\\]`);
const STARTS_JOB = /__(?:delegate|review|polish|debate)$/;

/**
 * The jobs a Crew call acted on: those it named, or the one it started. Ids merely shown, in a status list or
 * quoted in a report, are not taken over: another lead session may own them.
 */
function actedOn(input: HookInput): string[] {
  const named = [input.tool_input?.job_id, ...(Array.isArray(input.tool_input?.job_ids) ? input.tool_input.job_ids : [])];
  const started = STARTS_JOB.test(input.tool_name ?? '') ? JSON.stringify(input.tool_response ?? '').match(JOB_ID)?.[1] : undefined;
  return [...new Set([...named, started].filter((id): id is string => typeof id === 'string' && new RegExp(`^${ANY_JOB}$`).test(id)))].slice(0, 50);
}
interface HookOutput { code: number; stderr?: string; stdout?: string }

/** The transport is injectable so crash/retry paths can be checked without a live Claude session. */
export async function leadHook(input: HookInput, mode: string, request: typeof api = api, deadline = Date.now() + (HOOK_SECONDS - 10) * 1000): Promise<HookOutput> {
  const session = input.session_id;
  if (!session || input.agent_id) return { code: 0 };
  const send = (action: string, body: object = {}) => request('POST', `/api/lead/${action}`, { session, ...body }, AbortSignal.timeout(Math.max(1, Math.min(25_000, deadline - Date.now()))));
  if (mode === 'context') {
    const { text } = await send('context', { event: input.hook_event_name });
    return { code: 0, ...(text ? { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: text } }) } : {}) };
  }
  if (mode === 'stop' || mode === 'stop-json') {
    if (input.stop_hook_active) return { code: 0 };
    const { offer } = await send('offer', { automatic: true });
    if (!offer) return { code: 0 };
    // Codex runs a hook under pwsh on Windows, which turns node's exit code 2 into 1, so its hooks ask to continue
    // through the JSON decision instead (docs/mcp-compatibility.md#5-codex-as-a-lead-host).
    return mode === 'stop-json' ? { code: 0, stdout: JSON.stringify({ decision: 'block', reason: offer.text }) } : { code: 2, stderr: offer.text };
  }
  // The hook knows the session for certain; the lead's MCP server may not (an older server, /clear, no session
  // variable). So the session whose Crew call just acted on these jobs takes them over, before it watches for news.
  const shown = actedOn(input);
  if (shown.length) await send('adopt', { job_ids: shown }).catch(() => {});
  let generation: string | undefined;
  let backoff = 250;
  try {
    while (Date.now() < deadline) {
      try {
        if (!generation) {
          let watch;
          try {
            ({ watch } = await send('watch', { deadline }));
          } catch (error) {
            // No daemon, or one without delivery: nothing to watch, and the next Stop or Crew call arms again.
            // Retrying here would leave one process per hook alive for a day.
            if (!/Watcher lease/.test(String(error))) return { code: 0 };
            throw error;
          }
          if (!watch) return { code: 0 };
          generation = watch.generation;
        }
        await send('heartbeat', { generation });
        const { offer } = await send('offer', { automatic: true, generation, wait: true });
        if (offer) return { code: 2, stderr: offer.text };
        backoff = 250;
      } catch (error) {
        // A restart forgets watching leases. A replaced watcher cannot reacquire while its successor is live.
        if (/Watcher lease/.test(String(error))) generation = undefined;
        await new Promise((resolve) => setTimeout(resolve, Math.min(backoff, Math.max(0, deadline - Date.now()))));
        backoff = Math.min(backoff * 2, 5000);
      }
    }
    return { code: 0 };
  } finally {
    if (generation) await send('release', { generation }).catch(() => {});
  }
}

// Node resolves links in a module's URL but not in argv, and the plugin folder may be reached through one.
const real = (file: string) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const mode = process.argv[2] ?? 'watch';
  // `start`: a Codex SessionStart hook brings the daemon up first. A hook has the user's whole environment, while
  // Codex starts the lead's MCP server with a filtered one that a daemon it started would keep (CODEX_HOME, proxies).
  const starts = process.argv[3] === 'start';
  // End before the host timeout, even if stdin or the transport gets stuck.
  const lifetime = mode === 'watch' ? (HOOK_SECONDS - 10) * 1000 : starts ? 25_000 : 4000;
  const deadline = Date.now() + lifetime;
  const timer = setTimeout(() => process.exit(0), lifetime);
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    // A daemon that cannot start leaves the context empty, as a missing daemon always has.
    if (starts) {
      codexJob();
      await ensureDaemon().catch(() => {});
    }
    const result = await leadHook(JSON.parse(raw), mode, api, deadline);
    if (result.stdout) await new Promise<void>((resolve) => process.stdout.write(result.stdout + '\n', () => resolve()));
    if (result.stderr) await new Promise<void>((resolve) => process.stderr.write(result.stderr + '\n', () => resolve()));
    process.exitCode = result.code;
  } catch {
    // The ledger retains news through failures; a later hook or explicit status can recover it.
    process.exitCode = 0;
  } finally {
    clearTimeout(timer);
  }
}
