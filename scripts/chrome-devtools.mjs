/**
 * Finds, launches and waits for the Chrome every browser gate drives over DevTools.
 *
 * The startup budget is 30s because the old 9s budget (60 polls 150ms apart) failed both PASS 3 tests
 * in check-contrast.test.mjs on a busy CI runner. The wait ends early, with the exit code, when Chrome
 * exits first, so a crash is not reported as a timeout.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const DEVTOOLS_STARTUP_TIMEOUT_MS = 30_000;
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

/** Without a fixed `profile` each run gets a fresh one, removed after, so no seeded cookie carries over. */
export async function withChrome({ headful, port, profile, freshProfile, flags, dim }, run) {
  const binary = chromePath();
  const userDataDir = profile ?? mkdtempSync(join(tmpdir(), freshProfile));
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
    const version = await waitForDevtools(child, port);
    const openTab = async () => {
      const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(
        (r) => r.json(),
      );
      return target.webSocketDebuggerUrl;
    };
    return await run({ version, openTab });
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
