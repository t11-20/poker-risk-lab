/**
 * Three paths the API serves and `@prl/contracts` does not yet publish.
 *
 * ## Read this before adding a fourth
 *
 * `API_PATHS` in `packages/contracts/src/api-paths.ts` says, in its own header, that it "is the
 * only place a request path may be constructed", and it is right: a path written on one side of
 * the wire drifts the moment the other side is renamed, and that is precisely how every path in
 * this client once omitted the `/api/v1` segment while every screen quietly fell back to a
 * fixture. **This file is not a licence to go back to that.** It is a temporary holding pen with a
 * known end date, and everything about its shape is designed to make it easy to delete.
 *
 * ## Why it exists at all
 *
 * These three routes are registered, tested and working on the server today:
 *
 *   - `POST /api/v1/rooms/join`      `apps/api/src/routes/rooms.ts` — join a private room by code
 *   - `GET  /api/v1/me/progress`     `apps/api/src/routes/progress.ts` — the learner's own counts
 *   - `POST /api/v1/me/units/reset`  `apps/api/src/routes/auth.ts` — the reset every page promises
 *
 * None of them is in `API_PATHS`, so none of them had a client, so three shipped features were
 * unreachable: private multiplayer, any display of progress, and the "reset your units at any
 * time" the footer states on every page. The web client's own remediation could not add them to
 * the contract package, because `packages/contracts/**` is owned elsewhere and was being edited in
 * parallel — an edit there would have destroyed somebody else's work.
 *
 * ## How to delete this file (it should be a single, mechanical change)
 *
 *  1. In `packages/contracts/src/api-paths.ts`, add to `API_PATHS`:
 *
 *         roomJoin:   (): string => `${API_PREFIX}/rooms/join`,
 *         progress:   (): string => `${API_PREFIX}/me/progress`,
 *         unitsReset: (): string => `${API_PREFIX}/me/units/reset`,
 *
 *  2. Add the matching entries to `API_PATH_PROBES` — `{ methods: ['POST'], build: … }`,
 *     `['GET']`, `['POST']` — which the `Readonly<Record<ApiPathName, ApiPathProbe>>` annotation
 *     will demand anyway. `apps/api/test/web-api-paths.test.ts` then drives all three against a
 *     real `buildApp()`, which is the guarantee they are missing today.
 *  3. Replace every `UNPUBLISHED_API_PATHS.x()` in this app with `API_PATHS.x()` (three call
 *     sites, listed by `apps/web/test/api-paths.test.ts`) and delete this module.
 *
 * The routes above deliberately stop at three: `GET /rooms/:roomId` and `POST /rooms/:roomId/leave`
 * are also absent from `API_PATHS`, and this client does not need them — sitting and leaving happen
 * over the socket, where they are ordered against the hand the seat is in. Adding them here
 * "because they are missing too" would be building a second contract surface, which is the thing
 * this file is apologising for.
 */

import { API_PREFIX } from './api.ts';

/**
 * The paths, built the same way `API_PATHS` builds its own.
 *
 * No identifiers are interpolated into any of them, which is not an accident: an invite code goes
 * in a request BODY and must never appear in a URL. A URL is written to the access log of every
 * proxy between here and the server, and is sent onwards in `Referer`; the code is the only thing
 * standing between a private table and anybody who has it. `POST /rooms/join` takes it in the body
 * for exactly that reason, and this table has no builder that could be used to do otherwise.
 */
export const UNPUBLISHED_API_PATHS = {
  /** `POST`. Body: `{ inviteCode }`. Joining a room you are already in is not an error. */
  roomJoin: (): string => `${API_PREFIX}/rooms/join`,
  /** `GET`. The signed-in learner's own counts. Answers `not_authenticated` to anybody else. */
  progress: (): string => `${API_PREFIX}/me/progress`,
  /** `POST`. Empty body. Always available and never penalised — see `docs/PRODUCT-GUARDRAILS.md`. */
  unitsReset: (): string => `${API_PREFIX}/me/units/reset`,
} as const;
