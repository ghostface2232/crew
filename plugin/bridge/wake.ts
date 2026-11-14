import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './client.ts';
import { HOOK_SECONDS } from './delivery.ts';

interface HookInput { session_id?: string; agent_id?: string; hook_event_name?: string; stop_hook_active?: boolean }
interface HookOutput { code: number; stderr?: string; stdout?: string }

/** The transport is injectable so crash/retry paths can be checked without a live Claude session. */
export async function leadHook(input: HookInput, mode: string, request: typeof api = api, deadline = Date.now() + (HOOK_SECONDS - 10) * 1000): Promise<HookOutput> {
  const session = input.session_id;
  if (!session || input.agent_id) return { code: 0 };
  const send = (action: string, body: object = {}) => request('POST', `/api/lead/${action}`, { session, ...body }, AbortSignal.timeout(Math.max(1, Math.min(25_000, deadline - Date.now()))));
  if (mode === 'context') {
    const { text } = await send('context');
    return { code: 0, ...(text ? { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: text } }) } : {}) };
  }
  if (mode === 'stop') {
    if (input.stop_hook_active) return { code: 0 };
    const { offer } = await send('offer', { automatic: true });
    return offer ? { code: 2, stderr: offer.text } : { code: 0 };
  }
  let generation: string | undefined;
  let backoff = 250;
  try {
    while (Date.now() < deadline) {
      try {
        if (!generation) {
          const { watch } = await send('watch', { deadline });
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? 'watch';
  // End before the host timeout, even if stdin or the transport gets stuck.
  const lifetime = mode === 'watch' ? (HOOK_SECONDS - 10) * 1000 : 4000;
  const deadline = Date.now() + lifetime;
  const timer = setTimeout(() => process.exit(0), lifetime);
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
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
