#!/usr/bin/env node
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, ensureDaemon, health, stopDaemon } from './client.ts';
import { boardUrl, readToken } from './auth.ts';
import { agentCommand, agentEnv, BASE_URL, HOME, installed, loadConfig, PLUGIN_ROOT, VERSION } from './config.ts';
import { describe, summarize } from './render.ts';
import type { JobView } from './render.ts';

const USAGE = `crew ${VERSION} — lead a Claude + Codex + Antigravity crew

Usage:
  crew status            What each agent is doing, and recent jobs
  crew show <job>        Full result of one job
  crew cancel <job>      Stop a running job
  crew export <mission>  Print a mission as a Markdown runbook: decisions, dead ends, jobs and their checks
  crew gc [--apply] [--branches]  Preview leftovers; --apply cleans directories and metadata, --branches also deletes branches merged into HEAD
  crew board             Open the status board in the browser, signed in (--url prints the address instead)
  crew doctor            Check that everything Crew needs is in place
  crew install           Register the plugin with Claude Code and put crew on PATH
  crew daemon <start|stop|restart|logs>
`;

function run(bin: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const env = agentEnv();
  const command = agentCommand(bin, args, env);
  return new Promise((resolve) => {
    execFile(command.bin, command.args, { env, shell: command.shell, timeout: 20_000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || stderr || err?.message || '').trim() });
    });
  });
}

async function status(): Promise<void> {
  await ensureDaemon();
  const state = await api('GET', '/api/state');
  const jobs: JobView[] = state.jobs;
  console.log('Claude');
  if (state.claude.length === 0) console.log('  no session reporting (sessions appear once the plugin is loaded)');
  for (const s of state.claude) console.log(`  ${s.state.padEnd(8)} ${s.title} — ${s.waitingFor ?? s.phase}`);
  for (const [agent, name] of [['codex', 'Codex'], ['antigravity', 'Antigravity']] as const) {
    console.log(`\n${name}`);
    const mine = jobs.filter((j) => j.agent === agent);
    const shown = [...mine.filter((j) => !j.endedAt), ...mine.filter((j) => j.endedAt).slice(0, 3)];
    if (shown.length === 0) console.log('  idle');
    for (const job of shown) console.log(`  ${summarize(job)}`);
  }
  console.log(`\nBoard: ${BASE_URL}`);
}

async function doctor(): Promise<void> {
  const config = loadConfig();
  const checks: [label: string, ok: boolean, detail: string][] = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  checks.push(['Node.js 22.18+ (runs the bridge\'s TypeScript directly)', major > 22 || (major === 22 && minor >= 18), process.versions.node]);

  const git = await run('git', ['--version']);
  checks.push(['git', git.ok, git.out]);
  const codex = await run(config.codex.bin, ['--version']);
  checks.push(['Codex CLI', codex.ok, codex.ok ? codex.out : 'not found — install Codex and run `codex login`']);
  if (codex.ok) {
    const login = await run(config.codex.bin, ['login', 'status']);
    checks.push(['Codex login', login.ok, login.out.split('\n')[0]]);
  }
  const agy = await run(config.antigravity.bin, ['--version']);
  checks.push(['Antigravity CLI', agy.ok, agy.ok ? agy.out : 'not found — install it, then run `agy` once to log in']);
  const claude = await run('claude', ['plugin', 'list']);
  checks.push(['Claude Code plugin', claude.ok && /crew@/.test(claude.out), claude.ok ? (/crew@/.test(claude.out) ? 'installed' : 'not installed — run `crew install`') : 'claude CLI not found']);

  try {
    await ensureDaemon();
    const running = await health();
    const stale = running?.build !== installed().build;
    // Not a failure: the daemon switches to the installed code once its running jobs are done.
    const detail = `${BASE_URL} (v${running?.version}${stale ? `, older code than installed; it restarts once ${running?.active} running job(s) finish, or run \`crew daemon restart\`` : ''})`;
    checks.push(['Crew daemon', true, detail]);
  } catch (err) {
    checks.push(['Crew daemon', false, String((err as Error).message)]);
  }
  for (const [label, ok, detail] of checks) console.log(`${ok ? '✓' : '✗'} ${label}: ${detail}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

async function install(): Promise<void> {
  const marketplace = path.resolve(PLUGIN_ROOT, '..');
  const steps: [string, string[]][] = [
    ['marketplace', ['plugin', 'marketplace', 'add', marketplace]],
    ['plugin', ['plugin', 'install', 'crew@crew']],
  ];
  for (const [label, args] of steps) {
    const res = await run('claude', args);
    console.log(`${res.ok || /already/i.test(res.out) ? '✓' : '✗'} ${label}: ${res.out.split('\n').pop()}`);
  }
  const link = path.join(os.homedir(), '.local', 'bin', 'crew');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.rmSync(link, { force: true });
  fs.symlinkSync(path.join(PLUGIN_ROOT, 'bridge', 'cli.ts'), link);
  console.log(`✓ crew command: ${link}`);
  console.log('\nRestart Claude Code sessions (or run /reload-plugins) to load the plugin, then try /crew:run.');
}

const [command, arg] = process.argv.slice(2);
try {
  switch (command) {
    case undefined:
    case 'status':
      await status();
      break;
    case 'show':
      await ensureDaemon();
      console.log(describe(await api('GET', `/api/jobs/${arg}`)));
      break;
    case 'export':
      if (!arg) throw new Error('Usage: crew export <mission id> (the board and status show mission ids)');
      await ensureDaemon();
      process.stdout.write((await api('GET', `/api/missions/${arg}/runbook`)).text);
      break;
    case 'cancel':
      await ensureDaemon();
      console.log(describe(await api('POST', `/api/jobs/${arg}/cancel`, {})));
      break;
    case 'gc': {
      if (process.argv.slice(3).some((flag) => !['--apply', '--branches'].includes(flag))) throw new Error('Usage: crew gc [--apply] [--branches]');
      await ensureDaemon();
      const result = await api('POST', '/api/gc', { apply: process.argv.includes('--apply'), branches: process.argv.includes('--branches') });
      console.log(result.text);
      break;
    }
    case 'board':
      await ensureDaemon();
      // The address carries the secret in its fragment so the page can sign in. It is printed only when asked for,
      // for a caller that opens the page itself.
      if (process.argv.includes('--url')) {
        console.log(boardUrl(BASE_URL, readToken(HOME)));
        break;
      }
      spawn('open', [boardUrl(BASE_URL, readToken(HOME))], { stdio: 'ignore', detached: true }).unref();
      console.log(BASE_URL);
      break;
    case 'doctor':
      await doctor();
      break;
    case 'install':
      await install();
      break;
    case 'daemon':
      if (arg === 'start') await ensureDaemon();
      else if (arg === 'stop') await stopDaemon();
      else if (arg === 'restart') {
        await stopDaemon();
        await ensureDaemon();
      } else if (arg === 'logs') {
        execFileSync('tail', ['-n', '60', path.join(HOME, 'daemon.log')], { stdio: 'inherit' });
        break;
      } else throw new Error('Usage: crew daemon <start|stop|restart|logs>');
      if (!(await health())) console.log('stopped');
      else {
        // Verify that the daemon accepts the token on disk before reporting it as running.
        await api('GET', '/api/usage');
        console.log(`running at ${BASE_URL}`);
      }
      break;
    default:
      console.log(USAGE);
      if (command !== 'help' && command !== '--help' && command !== '-h') process.exitCode = 1;
  }
} catch (err) {
  console.error(`crew: ${(err as Error).message}`);
  process.exitCode = 1;
}
