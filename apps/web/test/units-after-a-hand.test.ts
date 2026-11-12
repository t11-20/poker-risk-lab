/**
 * The header's units re-read the session after a hand the reader played has settled.
 *
 * ## The defect (audit at 6b3886e, minor 3)
 *
 * The pill re-read `GET /auth/session` only after an HTTP mutation, and a hand settles over the
 * table's socket. At a bust it read 1,000 UNITS while the session said `"units":0` and the seat said
 * STACK 0; at 1440 it read 1,000 beside a stack of 334.
 *
 * ## And the trap in the obvious fix
 *
 * Re-reading the moment the hand-ending frame arrives reads the stack from BEFORE the hand: the API
 * writes it on its archive queue after the broadcast. Measured on the live table with the re-read
 * immediate, the pill trailed by exactly one hand on 4 of 4 hands; polled from the frame every
 * 10ms, the session had the new figure 12-34ms later on 8 of 8. So the re-read is scheduled, and
 * this file holds both halves: the signal is real and fires the header's own listener, and the hook
 * schedules it after the write rather than at the frame.
 *
 * `use-live-table.ts` is a hook with no renderer here (ADR 0008), so its half is read from source,
 * with each predicate also run against the old text, where it must fail.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Before the import: the signal is browser-only, and `API_ORIGIN` is resolved at module evaluation.
Object.defineProperty(globalThis, 'window', {
  value: { location: { origin: 'http://localhost' } },
  configurable: true,
  writable: true,
});

const api = await import('../src/lib/api.ts');

describe('a settled hand tells the header to ask again', () => {
  it('fires the same listener the header subscribes with', () => {
    assert.equal(typeof api.notifySessionChanged, 'function', 'lib/api.ts exports no notifySessionChanged');
    let fired = 0;
    const unsubscribe = api.subscribeToAcceptedMutations(() => {
      fired += 1;
    });
    try {
      api.notifySessionChanged();
    } finally {
      unsubscribe();
    }
    assert.equal(fired, 1);
  });

  it('carries no figure: the header asks the session, as for every other change', () => {
    assert.equal(api.notifySessionChanged.length, 0);
  });
});

describe('the hook asks after the archive write, not at the frame', () => {
  const scheduled = (source: string): boolean =>
    /settledHand =\s*view !== null && view\.street === 'complete' && view\.viewerSeat !== null \? view\.handId : null;/u.test(
      source,
    ) &&
    /for \(const ms of \[SETTLED_ASK_MS, SETTLED_RETRY_MS\]\) \{\s*settleTimers\.current\.push\(window\.setTimeout\(notifySessionChanged, ms\)\);/u.test(
      source,
    ) &&
    /\}, \[settledHand\]\);/u.test(source);

  it('schedules the re-read once per settled hand the reader was dealt into', () => {
    const hook = readFileSync(join(SRC, 'lib', 'use-live-table.ts'), 'utf8');
    assert.ok(scheduled(hook), 'use-live-table no longer schedules the re-read on a settled hand');
  });

  it('waits well past the measured write (12-34ms), and retries for a queue running behind', async () => {
    const { SETTLED_ASK_MS, SETTLED_RETRY_MS } = await import('../src/lib/use-live-table.ts');
    assert.ok(SETTLED_ASK_MS >= 340, `a first re-read at ${SETTLED_ASK_MS}ms is inside ten times the write`);
    assert.ok(SETTLED_RETRY_MS > SETTLED_ASK_MS, 'the retry is not later than the first ask');
    assert.ok(SETTLED_RETRY_MS <= 10_000, `a retry at ${SETTLED_RETRY_MS}ms leaves the pill stale too long`);
  });

  it('NEGATIVE CONTROLS: the predicate fails no re-read at all, and a re-read at the frame', () => {
    assert.equal(scheduled('const seatNames = useMemo(() => namesFor(table.room), [table.room]);'), false);
    const immediate = `const settledHand =
    view !== null && view.street === 'complete' && view.viewerSeat !== null ? view.handId : null;
  useEffect(() => {
    if (settledHand !== null) notifySessionChanged();
  }, [settledHand]);`;
    assert.equal(scheduled(immediate), false);
  });
});
