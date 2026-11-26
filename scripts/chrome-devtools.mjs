/**
 * Finds, launches and waits for the Chrome every browser gate drives over DevTools.
 *
 * The startup budget is 30s because the old 9s budget (60 polls 150ms apart) failed both PASS 3 tests
 * in check-contrast.test.mjs on a busy CI runner. The wait ends early, with the exit code, when Chrome
 * exits first, so a crash is not reported as a timeout.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { refuseOccupiedPort } from './gate-servers.mjs';

export const DEVTOOLS_STARTUP_TIMEOUT_MS = 30_000;
/**
 * No DevTools call a gate makes takes minutes. Without a bound, a headless Chrome that stopped answering
 * on 2026-11-22 held `test:age-gate`, and `verify` behind it, for three hours.
 */
export const CDP_CALL_TIMEOUT_MS = 300_000;
const POLL_MS = 150;
const POLL_TIMEOUT_MS = 1_000;

const INSTALLED_CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function chromePath(env = process.env, exists = existsSync) {
  const candidates = [env.CHROME_PATH, ...INSTALLED_CHROMES].filter(
    (path) => typeof path === 'string' && path !== '',
  );
  const found = candidates.find((path) => exists(path));
  if (found === undefined) {
    throw new Error(
      `no Chrome found. Set CHROME_PATH, or install one of:\n${candidates.map((p) => `  ${p}`).join('\n')}`,
    );
  }
  return found;
}

export async function waitForDevtools(child, port, timeoutMs = DEVTOOLS_STARTUP_TIMEOUT_MS) {
  let exited = null;
  const onExit = (code, signal) => {
    exited = { code, signal };
  };
  child.once('exit', onExit);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exited !== null || child.exitCode !== null) {
        const how = exited ?? { code: child.exitCode, signal: child.signalCode };
        throw new Error(
          `Chrome exited (code ${String(how.code)}, signal ${String(how.signal)}) before it opened a ` +
            `debugging port on ${port}`,
        );
      }
      // Each poll is capped at a second and at the remaining budget, so a listener that never answers
      // cannot hold `fetch` open past the deadline.
      const signal = AbortSignal.timeout(Math.max(1, Math.min(POLL_TIMEOUT_MS, deadline - Date.now())));
      const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal })
        .then((response) => response.json())
        .catch(() => null);
      if (version !== null) return version;
      await delay(POLL_MS);
    }
    throw new Error(`Chrome did not open a debugging port on ${port} within ${timeoutMs / 1000}s`);
  } finally {
    child.off('exit', onExit);
  }
}

/**
 * For port 0, which Chrome answers by picking a free port and writing it to `DevToolsActivePort` in the
 * profile, so a gate drives only the Chrome it launched. The port must serve the browser the file names.
 */
export async function waitForDevtoolsFile(child, profile, timeoutMs = DEVTOOLS_STARTUP_TIMEOUT_MS) {
  const file = join(profile, 'DevToolsActivePort');
  let exited = null;
  const onExit = (code, signal) => {
    exited = { code, signal };
  };
  child.once('exit', onExit);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exited !== null || child.exitCode !== null) {
        const how = exited ?? { code: child.exitCode, signal: child.signalCode };
        throw new Error(
          `Chrome exited (code ${String(how.code)}, signal ${String(how.signal)}) before it wrote ${file}`,
        );
      }
      const [port, path] = readDevtoolsFile(file);
      if (port !== undefined) {
        const signal = AbortSignal.timeout(Math.max(1, Math.min(POLL_TIMEOUT_MS, deadline - Date.now())));
        const version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal })
          .then((response) => response.json())
          .catch(() => null);
        if (version !== null) {
          if (version.webSocketDebuggerUrl !== `ws://127.0.0.1:${port}${path}`) {
            throw new Error(
              `port ${port} answered as ${String(version.webSocketDebuggerUrl)}, not as the Chrome that ` +
                `wrote ${path} to ${file}`,
            );
          }
          return { port: Number(port), version };
        }
      }
      await delay(POLL_MS);
    }
    throw new Error(`Chrome did not write a debugging port to ${file} within ${timeoutMs / 1000}s`);
  } finally {
    child.off('exit', onExit);
  }
}

/** A missing or half-written file reads as not written yet. */
function readDevtoolsFile(file) {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const [port, path] = text.split('\n');
  if (!/^\d+$/u.test(port ?? '') || !(path ?? '').startsWith('/devtools/browser/')) return [];
  return [port, path];
}

/**
 * Without a fixed `profile` each run gets a fresh one, removed after, so no seeded cookie carries over.
 * A non-zero `port` is refused when something already answers on it, since Chrome writes no
 * `DevToolsActivePort` for one and the poll could not tell a stranger from its own child.
 */
export async function withChrome({ headful, port, profile, freshProfile, flags, dim }, run) {
  const binary = chromePath();
  if (port !== 0) {
    await refuseOccupiedPort(
      `http://127.0.0.1:${port}`,
      'A Chrome launched there could not be told from it. Stop it, or pick another port.',
    );
  }
  const userDataDir = profile ?? mkdtempSync(join(tmpdir(), freshProfile));
  // A fixed profile keeps the last run's file, which names a port that Chrome may no longer hold.
  if (profile !== undefined) rmSync(join(profile, 'DevToolsActivePort'), { force: true });
  const child = spawn(
    binary,
    [
      headful ? '--no-first-run' : '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      ...flags,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    const opened =
      port === 0
        ? await waitForDevtoolsFile(child, userDataDir)
        : { port, version: await waitForDevtools(child, port) };
    const openTab = async () => {
      const target = await fetch(`http://127.0.0.1:${opened.port}/json/new?about:blank`, {
        method: 'PUT',
      }).then((r) => r.json());
      return target.webSocketDebuggerUrl;
    };
    return await run({ version: opened.version, openTab });
  } finally {
    child.kill('SIGTERM');
    if (profile === undefined) {
      // Chrome writes its profile as it exits, so removal retries and tolerates failure.
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (error) {
        console.log(
          dim(
            `  left the browser profile at ${userDataDir} (${error instanceof Error ? error.message : error})`,
          ),
        );
      }
    }
  }
}

/**
 * The DevTools calls one page is waiting on. Once a call goes unanswered for the bound, or the socket
 * closes, every waiting and later call rejects at once, because the gates retry failed calls and a
 * per-call bound alone multiplied into hours on a frozen Chrome.
 */
export class DevtoolsReplies {
  #pending = new Map();
  #broken = null;
  #timeoutMs;

  constructor(timeoutMs = CDP_CALL_TIMEOUT_MS) {
    this.#timeoutMs = timeoutMs;
  }

  expect(id, method) {
    if (this.#broken !== null) return Promise.reject(this.#broken);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error(`Chrome did not answer ${method} within ${this.#timeoutMs / 1000}s`)),
        this.#timeoutMs,
      );
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  /** A reply to a call that already failed is dropped; ids are never reused. */
  settle(message) {
    const waiter = this.#pending.get(message.id);
    if (waiter === undefined) return;
    this.#pending.delete(message.id);
    if (message.error !== undefined) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }

  fail(error) {
    this.#broken ??= error;
    const waiting = [...this.#pending.values()];
    this.#pending.clear();
    for (const waiter of waiting) waiter.reject(this.#broken);
  }
}
