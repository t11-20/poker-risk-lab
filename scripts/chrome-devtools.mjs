/**
 * Waits for a freshly spawned Chrome to open its DevTools port, for every gate that drives one.
 *
 * The budget is 30s because the old 9s budget (60 polls 150ms apart) failed both PASS 3 tests in
 * check-contrast.test.mjs on a busy CI runner. The wait ends early, with the exit code, when Chrome
 * exits first, so a crash is not reported as a timeout.
 */

import { setTimeout as delay } from 'node:timers/promises';

export const DEVTOOLS_STARTUP_TIMEOUT_MS = 30_000;
const POLL_MS = 150;
const POLL_TIMEOUT_MS = 1_000;

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
