#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { api, ensureDaemon, health, stopDaemon } from './client.ts';
import { boardUrl } from './auth.ts';
import { baseUrl, HOME, installed, VERSION } from './config.ts';
import { checks as setupChecks, COMMAND, PACKAGED, register, run } from './setup.ts';
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
  console.log(`\nBoard: ${baseUrl()}`);
}

async function doctor(): Promise<void> {
  const checks: [label: string, ok: boolean, detail: string][] = [];
  if (!PACKAGED) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    checks.push(['Node.js 22.18+ (runs the bridge\'s TypeScript directly)', major > 22 || (major === 22 && minor >= 18), process.versions.node]);
    const git = await run('git', ['--version']);
    checks.push(['git', git.ok, git.out]);
  }
  for (const item of await setupChecks()) checks.push([item.label, item.ok, item.ok || !item.repairable ? item.detail : `${item.detail} Run \`crew install\`.`]);

  try {
    await ensureDaemon();
    const running = await health();
    const stale = running?.build !== installed().build;
    // Not a failure: the daemon switches to the installed code once its running jobs are done.
    const detail = `${baseUrl()} (v${running?.version}${stale ? `, older code than installed; it restarts once ${running?.active} running job(s) finish, or run \`crew daemon restart\`` : ''})`;
    checks.push(['Crew daemon', true, detail]);
  } catch (err) {
    checks.push(['Crew daemon', false, String((err as Error).message)]);
  }
  for (const [label, ok, detail] of checks) console.log(`${ok ? '✓' : '✗'} ${label}: ${detail}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

async function install(): Promise<void> {
  const result = await register();
  console.log(`${result.ok ? '✓' : '✗'} ${result.detail}`);
  if (!result.ok) process.exitCode = 1;
  else console.log(`✓ crew command: ${COMMAND}\n\nRestart Claude Code sessions (or run /reload-plugins) to load the plugin, then try /crew:run.`);
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
    case 'board': {
      await ensureDaemon();
      // The address carries a ticket in its fragment, which signs one page in once within a minute and is worth
      // nothing after. It is printed only when asked for, for a caller that opens the page itself.
      const { ticket } = await api<{ ticket: string }>('POST', '/api/session/ticket').catch((err) => {
        throw new Error(`The daemon gave no sign-in ticket (${err.message}). If it is older than this command, it is replaced once its running jobs end; \`crew daemon restart\` replaces it now and ends them.`);
      });
      const address = boardUrl(baseUrl(), ticket);
      if (process.argv.includes('--url')) {
        console.log(address);
        break;
      }
      if (process.platform === 'win32') {
        // start, not explorer, keeps the fragment that signs the page in. The address holds no cmd.exe syntax.
        spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${address}"`], { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: true }).unref();
      } else spawn('open', [address], { stdio: 'ignore', detached: true }).unref();
      console.log(baseUrl());
      break;
    }
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
        // Read here rather than with tail, which Windows has only inside Git Bash.
        const file = path.join(HOME, 'daemon.log');
        if (!fs.existsSync(file)) throw new Error(`No daemon log yet at ${file}: the daemon has not been started.`);
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        // The newline that ends the last line starts no further one.
        if (lines.at(-1) === '') lines.pop();
        process.stdout.write(lines.slice(-60).map((line) => `${line}\n`).join(''));
        break;
      } else throw new Error('Usage: crew daemon <start|stop|restart|logs>');
      if (!(await health())) console.log('stopped');
      else {
        // Verify that the daemon accepts the token on disk before reporting it as running.
        await api('GET', '/api/usage');
        console.log(`running at ${baseUrl()}`);
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
