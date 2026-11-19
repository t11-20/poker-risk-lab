/**
 * An acknowledged sitting reminder stays acknowledged across a reload of the same tab (REGRESSION: the
 * acknowledgement lived only in React state, so every full page load brought the reminder straight back).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ACKNOWLEDGED_KEY, readAcknowledgedAt, writeAcknowledgedAt } from '../src/lib/session-sitting.ts';

function withSessionStorage<T>(stored: Map<string, string>, run: () => T, refuse = false): T {
  const storage = {
    getItem: (key: string) => {
      if (refuse) throw new Error('SecurityError');
      return stored.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (refuse) throw new Error('QuotaExceededError');
      stored.set(key, value);
    },
  };
  const globals = globalThis as { window?: unknown };
  const before = globals.window;
  globals.window = { sessionStorage: storage, localStorage: storage };
  try {
    return run();
  } finally {
    globals.window = before;
  }
}

describe('the acknowledged reminder survives a reload', () => {
  const startedAt = 1_000_000;
  const acknowledged = startedAt + 20 * 60_000;
  const reloaded = acknowledged + 60_000;

  it('reads back the acknowledgement this tab wrote', () => {
    const stored = new Map<string, string>();
    withSessionStorage(stored, () => writeAcknowledgedAt(acknowledged));
    assert.equal(stored.get(ACKNOWLEDGED_KEY), String(acknowledged));
    assert.equal(
      withSessionStorage(stored, () => readAcknowledgedAt(startedAt, reloaded)),
      acknowledged,
    );
  });

  it('ignores an acknowledgement it cannot place inside this sitting', () => {
    for (const value of [String(startedAt - 1), String(reloaded + 1), 'soon', 'NaN', '']) {
      const stored = new Map([[ACKNOWLEDGED_KEY, value]]);
      assert.equal(
        withSessionStorage(stored, () => readAcknowledgedAt(startedAt, reloaded)),
        null,
        `${JSON.stringify(value)} must count from the start again`,
      );
    }
  });

  it('reads nothing, and throws nothing, where storage is refused', () => {
    const stored = new Map<string, string>();
    withSessionStorage(stored, () => writeAcknowledgedAt(acknowledged), true);
    assert.equal(stored.size, 0);
    assert.equal(
      withSessionStorage(stored, () => readAcknowledgedAt(startedAt, reloaded), true),
      null,
    );
  });

  it('is read on mount and written on every acknowledgement', () => {
    const component = readFileSync(new URL('../src/components/SessionDuration.tsx', import.meta.url), 'utf8');
    assert.match(component, /setAcknowledgedAt\(readAcknowledgedAt\(started, loadedAt\)\)/u);
    assert.match(component, /setAcknowledgedAt\(at\);\s*writeAcknowledgedAt\(at\);/u);
    const calls = [...component.matchAll(/\backnowledge\(\);/gu)].length;
    assert.equal(calls, 2, 'both choosing an interval and "Remind me again" acknowledge');
    assert.doesNotMatch(component, /setAcknowledgedAt\(Date\.now\(\)\)/u, 'no acknowledgement skips storage');
  });
});
