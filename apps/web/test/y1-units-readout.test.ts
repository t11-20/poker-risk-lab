/**
 * The one figure the app shows about the reader on every screen must never be invented.
 *
 * ## Two defects, one badge
 *
 * **It stated a figure it could not check.** The header's session effect read
 * `if (!result.ok) return;`, so when the API could not be reached the bundled starting balance
 * simply stayed on screen. With the API stopped the bar said `1,000 UNITS`, unqualified, on every
 * page, to a reader whose real figure was 2,000 — and on `/record` it sat directly above that
 * page's own "your record could not be fetched" notice. The scenario count three fields down in the
 * same component already did the right thing: "not answering is a fine answer".
 *
 * **It went stale after the reader changed it.** Pressing reset produced "Done. Your units are back
 * to 2000" while the badge went on reading `3,308 UNITS` until a reload. The header read the
 * session once, on mount, and nothing told it the number had moved.
 *
 * ## What is asserted
 *
 * The signal that fixes the second defect is a real, importable function, so it is tested for real:
 * `subscribeToAcceptedMutations` must fire after a mutation the API accepted, and must NOT fire for
 * a read or for a mutation that failed — a header that re-read the session on a failed reset would
 * be busywork, and one that fired on every GET would re-read the session on every page.
 *
 * The badge itself lives in a React component with no renderer in this package, so its half is
 * checked at source level: the branch that let the fallback stand is gone, and there is a rendering
 * path for "no figure" that does not print one.
 *
 * `window` is defined before the module is imported because both halves of the signal are
 * browser-only by construction — a server render must not broadcast, since this module's state is
 * per process and one request's listeners would otherwise be invoked by another's.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

// Before the import, not after: `API_ORIGIN` is resolved at module evaluation from the same test.
Object.defineProperty(globalThis, 'window', {
  value: { location: { origin: 'http://localhost' } },
  configurable: true,
  writable: true,
});

const { apiGet, apiSend, subscribeToAcceptedMutations } = await import('../src/lib/api.ts');

/** Replaces `fetch` for one call and puts the real one back afterwards. */
async function withFetch<T>(reply: () => Response, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(reply())) as typeof globalThis.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the shell is told when the reader changes something', () => {
  it('fires after a mutation the API accepted', async () => {
    let fired = 0;
    const unsubscribe = subscribeToAcceptedMutations(() => {
      fired += 1;
    });
    try {
      await withFetch(
        () => json({ units: 2000 }),
        () => apiSend('POST', '/api/v1/me/units/reset', {}, { csrfToken: 'token' }),
      );
    } finally {
      unsubscribe();
    }
    // This is the whole of P2-C: without it the header keeps the figure it read on mount, and the
    // page beside it prints a different one.
    assert.equal(fired, 1, 'A reset the API accepted must reach the header.');
  });

  it('fires for a 204, which is a mutation that returns nothing rather than one that did nothing', async () => {
    let fired = 0;
    const unsubscribe = subscribeToAcceptedMutations(() => {
      fired += 1;
    });
    try {
      await withFetch(
        () => new Response(null, { status: 204 }),
        () => apiSend('DELETE', '/api/v1/rooms/room_x/members/me', undefined, { csrfToken: 'token' }),
      );
    } finally {
      unsubscribe();
    }
    assert.equal(fired, 1);
  });

  it('does not fire for a read', async () => {
    let fired = 0;
    const unsubscribe = subscribeToAcceptedMutations(() => {
      fired += 1;
    });
    try {
      await withFetch(
        () => json({ user: null, csrfToken: 't', protocolVersion: 1, oidcEnabled: false }),
        () => apiGet('/api/v1/auth/session'),
      );
    } finally {
      unsubscribe();
    }
    // The subscriber's response is to re-read the session. Firing on reads would make that a loop,
    // and would put a second session request behind every page the reader opens.
    assert.equal(fired, 0, 'A GET changes nothing, so there is nothing to re-read.');
  });

  it('does not fire for a mutation the API refused', async () => {
    let fired = 0;
    const unsubscribe = subscribeToAcceptedMutations(() => {
      fired += 1;
    });
    try {
      await withFetch(
        () => json({ error: { code: 'csrf_failed', message: 'no', requestId: 'req_1' } }, 403),
        () => apiSend('POST', '/api/v1/me/units/reset', {}).then(null, () => undefined),
      );
    } finally {
      unsubscribe();
    }
    assert.equal(fired, 0, 'Nothing happened, so nothing should be announced as having happened.');
  });

  it('stops firing once the subscriber has gone', async () => {
    let fired = 0;
    subscribeToAcceptedMutations(() => {
      fired += 1;
    })();
    await withFetch(
      () => json({ units: 2000 }),
      () => apiSend('POST', '/api/v1/me/units/reset', {}, { csrfToken: 'token' }),
    );
    // The header unsubscribes on unmount, before it aborts its controller. A listener left behind
    // would re-read the session into a component that is gone.
    assert.equal(fired, 0);
  });
});

describe('the units badge shows no figure when it has not been told one', () => {
  const header = read('components', 'SiteHeader.tsx');
  const code = header
    .split('\n')
    .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/u.test(line))
    .join('\n');

  it('no longer lets a failed session read leave the bundled figure standing', () => {
    // Scoped to the session read. The same early return is CORRECT in the scenario-count effect
    // below it — there, "not answering" leaves the badge absent rather than leaving a stale number
    // on screen — and that sibling is asserted separately, because the fix must not be applied by
    // deleting the thing that was already right.
    assert.doesNotMatch(
      code,
      /fetchSession\([\s\S]{0,400}?if \(!result\.ok\) return;/u,
      'A failed session read is the answer, not the absence of one: the badge must stop claiming a ' +
        'figure rather than keep the one it was seeded with.',
    );
    assert.match(code, /setUnits\(\{ state: 'unknown' \}\)/u);
  });

  it('renders a pill with no number in it, rather than a number nobody confirmed', () => {
    assert.match(code, /units\.state === 'unknown' \? \(\s*<UnitsUnknown \/>/u);
    assert.match(header, /units — not available/u);
    // The guardrail is that the word "units" is always present and a currency symbol never is.
    // Dropping the figure satisfies it; dropping the pill would not.
    assert.match(header, /prl-units__word prl-label">units/u);
  });

  it('distinguishes a confirmed figure from the one it was seeded with', () => {
    // `assumed` and `known` render the same pill today, and the distinction is still worth keeping:
    // it is what stops the next edit reading a number without first establishing where it came from.
    assert.match(code, /state: 'known'; readonly units: number/u);
    assert.match(code, /state: 'assumed'; readonly units: number/u);
    assert.match(code, /state: 'unknown'/u);
  });

  it('leaves the sibling that was already honest alone', () => {
    // The scenario count is the precedent this fix followed, and the audit named it as the thing
    // the units badge should imitate. A "cleanup" that gave it a fallback would undo the one part
    // of this component that never lied.
    assert.match(code, /if \(cachedScenarioCount !== null\) return;/u);
    assert.match(
      code,
      /apiGet<ScenarioListResponse>[\s\S]{0,300}?if \(!result\.ok\) return;/u,
      'The scenario count must still render nothing at all when the request fails.',
    );
    assert.match(header, /the badge stays absent rather than inventing a number/u);
  });

  it('re-reads the session when a mutation is accepted, instead of trusting the mutation', () => {
    assert.match(code, /subscribeToAcceptedMutations\(readSession\)/u);
    // Deliberately NOT reading `units` off the reset response. One authority for the figure is what
    // makes it impossible for two places on one screen to disagree.
    assert.doesNotMatch(code, /ResetUnitsResponse/u);
  });
});
