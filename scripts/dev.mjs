#!/usr/bin/env node
/**
 * Runs the API and web dev servers side by side with interleaved, labelled output.
 *
 * This is what `pnpm run dev` does. It exists instead of a concurrently/npm-run-all
 * dependency because adding a package to run two `spawn` calls is not a trade worth
 * making in a repo whose dependency policy is this strict — and because the three
 * things such a package is actually useful for are the three things below, all of
 * which are easier to get right when you can read them.
 *
 * ## 1. Each child runs in its own process group
 *
 * `pnpm --filter @prl/api dev` is not the dev server; it is a process that starts
 * the dev server. Killing the pnpm process leaves `node --watch src/server.ts`
 * running, holding port 3001, and the next `pnpm run dev` fails with EADDRINUSE
 * for reasons that look nothing like the cause. So each child is spawned
 * `detached: true`, which gives it a new process group, and shutdown signals the
 * whole group with `process.kill(-pid, signal)` — the negative pid is the group.
 *
 * A side effect of `detached: true` that we want: Ctrl-C in the terminal is
 * delivered to the foreground process group, which now contains only this
 * script. The children hear about it exactly once, from us, in an order we
 * control — rather than each receiving its own SIGINT while we are also trying to
 * shut them down.
 *
 * ## 2. Output is prefixed per line, not per chunk
 *
 * A pipe hands over arbitrary byte ranges. A naive `data => log(prefix + data)`
 * puts the label in the middle of lines whenever a write is split across chunks,
 * and produces one prefix for a chunk that contains twenty lines. Each stream
 * therefore keeps a remainder buffer and only emits complete lines, flushing
 * whatever is left when the stream ends.
 *
 * ## 3. First non-zero exit wins, and an early death is not silent
 *
 * If either server exits non-zero — a syntax error at startup, a port already
 * bound, a missing DATABASE_URL — this script stops the other one and exits with
 * that code. Leaving half a stack running after the other half failed is how you
 * end up debugging the API against a web app that was never built.
 *
 * To run just one, the root package.json already has `dev:api` and `dev:web`.
 */

import { spawn } from 'node:child_process';

// --- colour ---------------------------------------------------------------
// Deliberately not imported from scripts/supply-chain/lib.mjs: a dev-server
// runner should not depend on the supply-chain gates, and this is four lines.
// NO_COLOR is honoured (https://no-color.org) and colour is dropped when stdout
// is not a TTY, so piping this into a file or a CI log gives clean text.
const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);

/**
 * The two dev servers.
 *
 * Labels are the same width so the output columns line up, which matters more
 * than it sounds when two servers are logging at once. Colours are chosen to
 * survive both light and dark terminals: cyan and magenta rather than blue
 * (unreadable on dark) or yellow (unreadable on light).
 */
const TARGETS = [
  { label: 'api', colour: '36', args: ['--filter', '@prl/api', 'dev'] },
  { label: 'web', colour: '35', args: ['--filter', '@prl/web', 'dev'] },
];

const children = new Map();
/** The exit code this script will use: the first non-zero one it sees. */
let firstFailure = null;
let shuttingDown = false;

function label(target, stream) {
  const name = NO_COLOR ? target.label : paint(target.colour, target.label);
  return stream === 'stderr' ? `${name} ${dim('!')}` : `${name} ${dim('|')}`;
}

/** Emits only complete lines, so a prefix never lands mid-line. */
function pipeLines(readable, prefix, write) {
  let remainder = '';
  readable.setEncoding('utf8');
  readable.on('data', (chunk) => {
    const text = remainder + chunk;
    const lines = text.split('\n');
    // The final element is either an empty string (the chunk ended on a newline)
    // or a partial line. Either way it is not ready to print.
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
    // The repo root: this script lives in scripts/, and pnpm's --filter is
    // resolved against the workspace root.
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
    // See the module comment: own process group, so shutdown reaches the real
    // dev server and not just the pnpm wrapper.
    detached: true,
    env: process.env,
  });

  children.set(target.label, child);

  pipeLines(child.stdout, label(target, 'stdout'), (s) => process.stdout.write(s));
  pipeLines(child.stderr, label(target, 'stderr'), (s) => process.stderr.write(s));

  child.on('error', (err) => {
    // Almost always ENOENT for pnpm itself. Say so, rather than letting the
    // process disappear with no output.
    process.stderr.write(`${label(target, 'stderr')} failed to start: ${err.message}\n`);
    if (firstFailure === null) firstFailure = 1;
    children.delete(target.label);
    stopAll('SIGTERM');
  });

  child.on('exit', (code, signal) => {
    children.delete(target.label);
    const how = signal ? `signal ${signal}` : `code ${code}`;
    // A child we killed on purpose during shutdown is not a failure.
    if (shuttingDown) {
      process.stdout.write(dim(`${label(target, 'stdout')} stopped (${how})\n`));
    } else {
      process.stderr.write(`${label(target, 'stderr')} exited early with ${how}\n`);
      if (firstFailure === null) firstFailure = typeof code === 'number' && code !== 0 ? code : 1;
      // One server down means the stack is broken. Take the other one with it so
      // the developer sees a stopped stack rather than a subtly broken one.
      stopAll('SIGTERM');
    }
    if (children.size === 0) finish();
  });

  return child;
}

/** Signals each child's whole process group. */
function stopAll(signal) {
  shuttingDown = true;
  for (const [name, child] of children) {
    if (child.pid === undefined) continue;
    try {
      // Negative pid = "the process group with this id". Requires the child to
      // have been spawned detached, which it was.
      process.kill(-child.pid, signal);
    } catch (err) {
      // ESRCH means it is already gone, which is the outcome we wanted.
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

// --- signals --------------------------------------------------------------
// Without these handlers Node's defaults would terminate this process on Ctrl-C
// and the detached children — in their own process groups, so not signalled by
// the terminal — would survive as orphans holding ports 3000 and 3001.
//
// A second Ctrl-C escalates to SIGKILL, because a dev server that has wedged
// itself should not be able to trap someone in their own terminal.
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
process.stdout.write(dim('  api  http://127.0.0.1:3001   web  http://127.0.0.1:3000\n'));
process.stdout.write(dim('  needs a database: run `pnpm run db:setup` first if you have not already\n\n'));

for (const target of TARGETS) start(target);
