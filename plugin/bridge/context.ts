import { HOME } from './config.ts';
import { projectRoot } from './git.ts';
import { leadContext, loadFailure } from './instructions.ts';

/**
 * SessionStart and SubagentStart hook: gives a Claude session the same shared instructions the
 * workers get with each job. It runs again after compaction, which may have dropped the earlier copy.
 * It reads the files itself, so it works before the daemon is up.
 */

/**
 * Subagents that only search and read. The shared instructions are notes for building, running and checking, so these
 * would carry them unused into every context. The self-reviewer runs checks and the app, so it keeps them.
 */
const READERS = new Set(['Explore', 'Plan', 'claude-code-guide', 'web-fetch']);

let event = 'SessionStart';
let additionalContext: string;
try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  event = input.hook_event_name ?? event;
  if (event === 'SubagentStart' && READERS.has(input.agent_type)) process.exit(0);
  const cwd: string = input.cwd ?? process.cwd();
  // Same lookup as a worker job, so the lead and the workers are given the same files.
  additionalContext = leadContext(HOME, (await projectRoot(cwd)) ?? process.env.CLAUDE_PROJECT_DIR ?? cwd);
} catch (err) {
  additionalContext = loadFailure(err);
}
if (additionalContext) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
