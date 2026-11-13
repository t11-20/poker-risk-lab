/**
 * The units figure in the header must never be invented, after a failed session read or an accepted
 * reset. The badge has no renderer here, so its half is checked at source level.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

// Defined before the import, because the signal is browser-only and `API_ORIGIN` resolves at evaluation.
Object.defineProperty(globalThis, 'window', {
  value: { location: { origin: 'http://localhost' } },
  configurable: true,
  writable: true,
});

const { apiGet, apiSend, subscribeToAcceptedMutations } = await import('../src/lib/api.ts');

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
    // The subscriber re-reads the session, so firing on reads would loop.
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
    // A listener left behind would re-read the session into a component that is gone.
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
    // Scoped to the session read. The same early return is correct in the scenario-count effect.
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
    assert.match(header, /units offline/u);
    // The word "units" is always present and a currency symbol never is, so the pill must stay.
    assert.match(header, /prl-units__word prl-label">units/u);
  });

  it('distinguishes a confirmed figure from the one it was seeded with', () => {
    // `assumed` and `known` render the same pill, but the type forces a reader to know the figure's origin.
    assert.match(code, /state: 'known'; readonly units: number/u);
    assert.match(code, /state: 'assumed'; readonly units: number/u);
    assert.match(code, /state: 'unknown'/u);
  });

  it('leaves the sibling that was already honest alone', () => {
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
    // One authority for the figure, so two places on one screen cannot disagree.
    assert.doesNotMatch(code, /ResetUnitsResponse/u);
  });
});
