import { HOME } from './config.ts';
import { projectRoot } from './git.ts';
import { leadContext, loadFailure } from './instructions.ts';

/**
 * SessionStart and SubagentStart hook: gives a Claude session the same shared instructions the
 * workers get with each job. It runs again after compaction, which may have dropped the earlier copy.
 * It reads the files itself, so it works before the daemon is up.
 */

let event = 'SessionStart';
let additionalContext: string;
try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  event = input.hook_event_name ?? event;
  const cwd: string = input.cwd ?? process.cwd();
  // Same lookup as a worker job, so the lead and the workers are given the same files.
  additionalContext = leadContext(HOME, (await projectRoot(cwd)) ?? process.env.CLAUDE_PROJECT_DIR ?? cwd);
} catch (err) {
  additionalContext = loadFailure(err);
}
if (additionalContext) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
