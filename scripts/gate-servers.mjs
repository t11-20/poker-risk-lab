/**
 * The servers a browser gate starts for itself, and the refusal to measure one it did not start.
 * Kept apart from chrome-devtools.mjs because a11y-audit.mjs starts servers and drives no Chrome.
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const dim = (s) => (NO_COLOR ? s : `\u001b[2m${s}\u001b[0m`);

/**
 * Refuse to start when something already answers on a port this run will poll, because
 * `waitUntilReady` accepts any 200 and cannot tell its own child's answer from a stranger's.
 * It connects rather than binds, because on macOS a bind of 127.0.0.1 succeeds beside a wildcard
 * listener such as `next start` (Node 24.18). Only ECONNREFUSED counts as free.
 */
export async function refuseOccupiedPort(url, advice) {
  const { hostname, port, protocol } = new URL(url);
  const host = hostname.replace(/^\[(.*)\]$/, '$1');
  const target = { host, port: Number(port || (protocol === 'https:' ? 443 : 80)) };
  const outcome = await new Promise((done) => {
    const socket = connect(target);
    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.destroy();
      done('accepted');
    });
    socket.once('timeout', () => {
      socket.destroy();
      done('was neither accepted nor refused within 2s');
    });
    socket.once('error', (error) =>
      done(error.code === 'ECONNREFUSED' ? 'refused' : `failed (${error.code})`),
    );
  });
  if (outcome === 'refused') return;
  const seen = outcome === 'accepted' ? 'something is already listening' : `a probe connection ${outcome}`;
  throw new Error(`${seen} on ${host}:${String(target.port)}. ${advice}`);
}

/**
 * `pnpm --filter ... start` is a wrapper, so the server is detached and signalled by process group.
 * `options.dim` styles the one line it prints, for a gate that colours unconditionally.
 */
export class ManagedServer {
  constructor(label, args, readyUrl, env, options = {}) {
    this.label = label;
    this.args = args;
    this.readyUrl = readyUrl;
    this.env = env;
    this.dim = options.dim ?? dim;
    this.child = null;
    // Kept for the failure message only.
    this.output = [];
    this.exited = null;
  }

  start() {
    this.child = spawn('pnpm', this.args, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, ...this.env },
    });
    const keep = (chunk) => {
      this.output.push(chunk.toString());
      if (this.output.length > 200) this.output.shift();
    };
    this.child.stdout.on('data', keep);
    this.child.stderr.on('data', keep);
    this.child.on('exit', (code, signal) => {
      this.exited = signal ?? code;
    });
  }

  async waitUntilReady(timeoutSeconds) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      if (this.exited !== null) {
        throw new Error(
          `${this.label} exited (${this.exited}) before it was ready:\n${this.output.join('')}`,
        );
      }
      const answered = await fetch(this.readyUrl, { signal: AbortSignal.timeout(2000) })
        .then((response) => response.status > 0)
        .catch(() => false);
      if (answered) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `${this.label} was not ready at ${this.readyUrl} within ${timeoutSeconds}s:\n${this.output.join('')}`,
        );
      }
      await delay(300);
    }
  }

  stop() {
    if (this.child === null || this.child.pid === undefined) return;
    try {
      process.kill(-this.child.pid, 'SIGTERM');
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ESRCH')) {
        console.log(this.dim(`  could not stop ${this.label}: ${err.message}`));
      }
    }
  }
}
