/**
 * Waiting for a freshly spawned Chrome to open its DevTools port, for every gate that drives one.
 *
 * Six gates (check-contrast, ax-tree-audit, text-layout-audit, keyboard-audit, age-gate-audit,
 * csp-negative-control) each carried the same loop: sixty polls 150ms apart, so a Chrome that took
 * longer than nine seconds to start was reported as "did not open a debugging port". On CI's
 * runners `test:scripts` runs every test file at once, and the two PASS 3 tests in
 * `check-contrast.test.mjs` had been passing at 16s and 7.5s end to end. On the merge of PR #7 into
 * main both stopped at 9.2s with that message, on a commit whose tree had passed an hour earlier:
 * nine seconds was the budget, not a measurement of anything.
 *
 * So the budget is thirty seconds, and the wait ends early, with the exit code, when Chrome exits
 * instead: a Chrome that crashed or handed off to another instance never opens the port, and
 * waiting thirty seconds to say so would hide the real failure behind a timeout.
 */

import { setTimeout as delay } from 'node:timers/promises';

export const DEVTOOLS_STARTUP_TIMEOUT_MS = 30_000;
const POLL_MS = 150;
const POLL_TIMEOUT_MS = 1_000;

/**
 * Resolves with Chrome's `/json/version` once `port` answers, or throws when `child` exits first or
 * the budget runs out.
 */
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
      // Each poll gets at most a second, and never more than the budget has left: something that
      // accepts the connection and never answers would otherwise hold `fetch` open past the
      // deadline and past a Chrome exit, neither of which is checked until it returns.
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
