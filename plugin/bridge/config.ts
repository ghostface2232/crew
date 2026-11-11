import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');

export const VERSION: string = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
).version;

export const HOME = process.env.CREW_HOME ?? path.join(os.homedir(), '.crew');
export const PORT = Number(process.env.CREW_PORT ?? 47615);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

export interface Config {
  /** Seconds of silence from a running worker before it is flagged as possibly stalled. */
  stallSeconds: number;
  /** macOS notifications for waiting, error, limit, and stall events. */
  notify: boolean;
  /** Also notify when a job finishes normally. */
  notifyOnDone: boolean;
  codex: {
    bin: string;
    /** Approval policy for delegated implementation work. Reviews always run with "never". */
    approvalPolicy: 'never' | 'on-request' | 'untrusted';
    model?: string;
    effort?: string;
  };
  antigravity: {
    bin: string;
    enabled: boolean;
    /** Value for the ACP "model" config option, e.g. "gemini-3.8-flash". */
    model?: string;
  };
}

const defaults: Config = {
  stallSeconds: 300,
  notify: true,
  notifyOnDone: false,
  codex: { bin: 'codex', approvalPolicy: 'on-request' },
  antigravity: { bin: 'agy', enabled: true },
};

export function loadConfig(): Config {
  let user: Partial<Config> = {};
  try {
    user = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Invalid ${HOME}/config.json: ${(err as Error).message}`);
  }
  return {
    ...defaults,
    ...user,
    codex: { ...defaults.codex, ...user.codex },
    antigravity: { ...defaults.antigravity, ...user.antigravity },
  };
}

/**
 * GUI-launched processes (Claude Desktop) get a minimal PATH, so the agent
 * CLIs installed under the user's home would not resolve without these.
 */
export function agentEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extra = [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', path.dirname(process.execPath)];
  const current = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const merged = [...current, ...extra.filter((p) => !current.includes(p))];
  return { ...process.env, PATH: merged.join(path.delimiter) };
}
