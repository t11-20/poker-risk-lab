#!/usr/bin/env node
/**
 * Runs the API and web dev servers side by side with labelled, line-buffered output.
 *
 * Each child gets its own process group (`detached: true`) and shutdown signals the group, because
 * killing only the pnpm wrapper leaves `node --watch` holding port 3001. The first non-zero exit,
 * including a failed spawn, stops the other server and becomes this script's exit code.
 */

import { spawn } from 'node:child_process';

// NO_COLOR is honoured and colour is dropped when stdout is not a TTY.
const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);

// Cyan and magenta stay readable on both light and dark terminals.
const TARGETS = [
  { label: 'api', colour: '36', args: ['--filter', '@prl/api', 'dev'] },
  { label: 'web', colour: '35', args: ['--filter', '@prl/web', 'dev'] },
];

const children = new Map();
let firstFailure = null;
let shuttingDown = false;

function label(target, stream) {
  const name = NO_COLOR ? target.label : paint(target.colour, target.label);
  return stream === 'stderr' ? `${name} ${dim('!')}` : `${name} ${dim('|')}`;
}

function pipeLines(readable, prefix, write) {
  let remainder = '';
  readable.setEncoding('utf8');
  readable.on('data', (chunk) => {
    const text = remainder + chunk;
    const lines = text.split('\n');
    remainder = lines.pop() ?? '';
    for (const line of lines) write(`${prefix} ${line}\n`);
  });
  readable.on('end', () => {
    if (remainder.length > 0) {
      write(`${prefix} ${remainder}\n`);
      remainder = '';
    }
  });
}

function start(target) {
  const child = spawn('pnpm', target.args, {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: process.env,
  });

  children.set(target.label, child);

  pipeLines(child.stdout, label(target, 'stdout'), (s) => process.stdout.write(s));
  pipeLines(child.stderr, label(target, 'stderr'), (s) => process.stderr.write(s));

  child.on('error', (err) => {
    process.stderr.write(`${label(target, 'stderr')} failed to start: ${err.message}\n`);
    if (firstFailure === null) firstFailure = 1;
    children.delete(target.label);
    stopAll('SIGTERM');
    // Node emits no 'exit' after a spawn 'error', so this is the only path to `finish()` for this child.
    // Without it, a PATH with no pnpm made both spawns fail and the script exit 0.
    if (children.size === 0) finish();
  });

  child.on('exit', (code, signal) => {
    children.delete(target.label);
    const how = signal ? `signal ${signal}` : `code ${code}`;
    if (shuttingDown) {
      process.stdout.write(dim(`${label(target, 'stdout')} stopped (${how})\n`));
    } else {
      process.stderr.write(`${label(target, 'stderr')} exited early with ${how}\n`);
      if (firstFailure === null) firstFailure = typeof code === 'number' && code !== 0 ? code : 1;
      stopAll('SIGTERM');
    }
    if (children.size === 0) finish();
  });

  return child;
}

function stopAll(signal) {
  shuttingDown = true;
  for (const [name, child] of children) {
    if (child.pid === undefined) continue;
    try {
      // A negative pid signals the whole process group.
      process.kill(-child.pid, signal);
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code !== 'ESRCH') {
        process.stderr.write(dim(`could not signal ${name}: ${err.message}\n`));
      }
    }
  }
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  process.exitCode = firstFailure ?? 0;
}

// The detached children are not signalled by the terminal, so without these handlers they survive
// Ctrl-C holding ports 3000 and 3001. A second Ctrl-C escalates to SIGKILL.
let stopRequests = 0;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopRequests += 1;
    if (stopRequests === 1) {
      process.stdout.write(dim(`\nstopping (${signal})...\n`));
      stopAll(signal);
      return;
    }
    process.stdout.write(dim('\nsecond signal — killing\n'));
    stopAll('SIGKILL');
  });
}

process.stdout.write(dim('Poker Risk Lab dev servers\n'));
// `localhost` for the web because the session cookie is host-scoped and every doc says localhost
// (docs/RUNBOOK.md §2).
process.stdout.write(dim('  api  http://127.0.0.1:3001   web  http://localhost:3000\n'));
process.stdout.write(dim('  needs a database: run `pnpm run db:setup` first if you have not already\n\n'));

for (const target of TARGETS) start(target);
