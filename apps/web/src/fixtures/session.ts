/**
 * The session the app shell renders when `GET /api/session` cannot be reached. The units badge is on
 * every page, and the starting balance is true for the new player looking at a fresh app, where an
 * empty badge would make every screen look broken. Typed against `@prl/contracts`.
 *
 * `csrfToken` is a visibly fake string, so nobody mistakes it for a real token in a source file.
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

/** A signed-in guest session. `oidcEnabled: false` matches a local stack with no identity provider. */
export const FIXTURE_SESSION: SessionResponse = {
  user: FIXTURE_USER,
  csrfToken: 'fixture-csrf-token-not-a-real-secret',
  protocolVersion: PROTOCOL_VERSION,
  oidcEnabled: false,
};

/**
 * The other honest shape: reachable API, nobody signed in. `csrfToken` is null, as in the contract,
 * because there is no session to protect.
 */
export const ANONYMOUS_SESSION: SessionResponse = {
  user: null,
  csrfToken: null,
  protocolVersion: PROTOCOL_VERSION,
  oidcEnabled: false,
};
