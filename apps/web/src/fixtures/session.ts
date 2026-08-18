/**
 * The session fixture: what the app shell renders when there is no API to ask.
 *
 * ## Why a fixture exists for something as small as a units balance
 *
 * The API is being built in parallel with this client, so `GET /api/session` may not answer yet.
 * The header's units badge is on every page, and there are only two honest ways to handle a shell
 * that cannot reach its server: show nothing, or show the value a new player would have. Showing
 * nothing puts an empty hole in the header of every screen and makes the whole app look broken over
 * one absent endpoint; showing the starting balance is *true for a new player*, which is who is
 * looking at a freshly-started app.
 *
 * This is not mock-driven development for its own sake. It is what lets every screen be built,
 * reviewed and render-checked in CI with no database, and it is typed against `@prl/contracts` so
 * that "the fixture compiles" means "the fixture is the shape the API promises". A fixture typed
 * loosely is a fixture that will disagree with the wire the day it matters.
 *
 * ## Nothing in here is a secret, and nothing pretends to be
 *
 * `csrfToken` is a visibly fake string. A fixture with a plausible-looking token invites somebody to
 * wonder whether it is real, and a real token in a source file is the kind of thing that survives
 * into a commit. The name says what it is.
 *
 * `units` is `1000` because that is what the header must read (`1,000 units`) and because the
 * product guardrails make it meaningful: free, resettable, valueless, and never shown with a
 * currency symbol.
 */

import type { SessionResponse, SessionUser } from '@prl/contracts';
import { PROTOCOL_VERSION } from '@prl/contracts';

/** The starting balance. The one number the header falls back to. */
export const STARTING_UNITS = 1000;

/**
 * A guest, because a guest is the state a first-time reader arrives in: no account, no email, no
 * OIDC round trip, and a display name they did not have to invent.
 */
export const FIXTURE_USER: SessionUser = {
  id: 'fixture-user',
  kind: 'guest',
  displayName: 'Guest',
  units: STARTING_UNITS,
  createdAt: '2026-08-17T00:00:00.000Z',
};

/**
 * A signed-in guest session.
 *
 * `oidcEnabled: false` matches a local development stack with no identity provider configured, which
 * is the environment this fixture is standing in for.
 */
export const FIXTURE_SESSION: SessionResponse = {
  user: FIXTURE_USER,
  csrfToken: 'fixture-csrf-token-not-a-real-secret',
  protocolVersion: PROTOCOL_VERSION,
  oidcEnabled: false,
};

/**
 * The other honest shape: reachable API, nobody signed in.
 *
 * Kept beside the populated one so a screen that has to handle "no user" can be built against a
 * real value rather than by deleting a property from the fixture above and hoping the types agree.
 * `csrfToken` is null here for the same reason it is in the contract — there is no session to
 * protect, so there is no token to echo.
 */
export const ANONYMOUS_SESSION: SessionResponse = {
  user: null,
  csrfToken: null,
  protocolVersion: PROTOCOL_VERSION,
  oidcEnabled: false,
};
