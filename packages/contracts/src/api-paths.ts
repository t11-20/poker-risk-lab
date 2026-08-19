/**
 * The REST surface, as paths, shared by `apps/api` and `apps/web`.
 *
 * ## Why this is here rather than in the client
 *
 * It used to be in the client — three separate "provisional endpoint paths" constants, one per
 * feature, each written before the routes were named and none of them reconciled afterwards. Every
 * one of them omitted the `/api/v1` version segment, two of them had the wrong path *shape*, and
 * one named a route that was never built. The whole web application therefore ran on bundled
 * fixtures in every environment, and nothing failed: the client counted a 404 as "the API is not
 * deployed yet" and fell back silently.
 *
 * A path is half of a contract. Written on one side only, it drifts the moment the other side is
 * named; written here, in the package both sides already compile against, a rename is one edit and
 * `apps/api/test/web-api-paths.test.ts` proves the two still agree.
 *
 * ## The table is the whole surface, deliberately
 *
 * `API_PATHS` is the only place a request path may be constructed. A path built inline at a call
 * site — `` apiGet(`/api/hands/${id}`) `` — is invisible to any test that enumerates constants,
 * which is precisely how the version segment went missing on seven call sites at once. So the
 * builders live here, `API_PATH_PROBES` republishes every one of them in a form a test can drive,
 * and the `Readonly<Record<ApiPathName, …>>` annotation on that table means adding a path without
 * adding its probe does not compile.
 *
 * Nothing here performs I/O or depends on a runtime: it is string building, so both a server render
 * and a browser can use it.
 *
 * ## The WebSocket upgrade is in the table too
 *
 * It is a path on the same server, registered by the same `registerRoutes` under the same prefix,
 * and it drifts the same way if it is written on one side only — which it was: `apps/web` carried
 * `/ws` as a private constant with a comment saying it belonged here, and `/auth/guest` and
 * `/rooms` were gathered in a second table in the live-table client for the same reason. A surface
 * that publishes "every path except the four a live table needs" is not the guarantee this file
 * claims to give. An upgrade is not a request/response, so `ApiPathProbe` says so with `UPGRADE`
 * and the contract test asserts it as a registered route rather than by reading a status code.
 */

/**
 * Every route module is mounted under this prefix.
 *
 * Kept in step with `API_PREFIX` in `apps/api/src/app.ts` by
 * `apps/api/test/web-api-paths.test.ts`, which asserts the two are equal. The API owns the mount;
 * this constant exists so a client can address it without hard-coding a string the API can change.
 */
export const API_PREFIX = '/api/v1';

/**
 * Every path the web client can emit.
 *
 * Collection paths take no argument; a path that names one resource takes its identifier and
 * encodes it. Identifiers are encoded here rather than at the call site for the usual reason —
 * a content id with a slash in it would otherwise silently address a different route.
 */
export const API_PATHS = {
  /** The session the app shell reads on every page: units for the badge, CSRF for later mutations. */
  session: (): string => `${API_PREFIX}/auth/session`,
  /**
   * `POST`. A guest account in one request — no email, no password, no confirmation.
   *
   * Published here rather than built by the live-table client, which is where it used to live. A
   * path written on one side of the wire is half a contract, and this one was outside the
   * guarantee `apps/api/test/web-api-paths.test.ts` exists to give.
   */
  guest: (): string => `${API_PREFIX}/auth/guest`,

  lessons: (): string => `${API_PREFIX}/content/lessons`,
  lesson: (lessonId: string): string => `${API_PREFIX}/content/lessons/${encodeURIComponent(lessonId)}`,

  /**
   * Records that a learner has read a lesson to the end.
   *
   * A `POST` rather than a field on the `GET`, because reading is a thing the learner did and the
   * server must not infer it from a fetch: a prefetch, a crawler or a back-button would all look
   * identical to a read, and progress that fills itself in is worth nothing to the person it
   * claims to describe. Completion is sticky server-side, so re-reading never un-finishes a lesson.
   */
  lessonRead: (lessonId: string): string =>
    `${API_PREFIX}/content/lessons/${encodeURIComponent(lessonId)}/read`,
  glossary: (): string => `${API_PREFIX}/content/glossary`,
  scenarios: (): string => `${API_PREFIX}/content/scenarios`,
  scenario: (scenarioId: string): string =>
    `${API_PREFIX}/content/scenarios/${encodeURIComponent(scenarioId)}`,
  /** `POST`. The learner's committed action, graded server-side against the live analysis. */
  scenarioAttempt: (scenarioId: string): string =>
    `${API_PREFIX}/content/scenarios/${encodeURIComponent(scenarioId)}/attempt`,
  /** `POST`. One quiz answer. */
  quizAttempt: (quizId: string): string =>
    `${API_PREFIX}/content/quizzes/${encodeURIComponent(quizId)}/attempt`,

  /**
   * The hand history page. `query` is an already-serialised query string without its `?`, because
   * the caller owns which of `sort`, `limit` and `cursor` it sends and in what order.
   */
  hands: (query = ''): string => (query === '' ? `${API_PREFIX}/hands` : `${API_PREFIX}/hands?${query}`),
  hand: (handId: string): string => `${API_PREFIX}/hands/${encodeURIComponent(handId)}`,

  legendProfiles: (): string => `${API_PREFIX}/legends/profiles`,
  /** "What can I learn from this style" — the profile detail, not a nested `/learn` route. */
  legendProfile: (profileId: string): string =>
    `${API_PREFIX}/legends/profiles/${encodeURIComponent(profileId)}`,
  /**
   * What a large deterministic simulation of this profile actually did, against what its card
   * declares. A separate path from `legendProfile` because it is a separate cost: the answer is
   * produced by running thousands of hands rather than by reading a constant.
   */
  legendProfileStats: (profileId: string): string =>
    `${API_PREFIX}/legends/profiles/${encodeURIComponent(profileId)}/stats`,
  /** `POST`: the request carries a whole situation, which does not belong in a URL. */
  legendCompare: (): string => `${API_PREFIX}/legends/compare`,

  /**
   * The live table's rooms: `GET` lists the ones this session can see, `POST` creates one.
   *
   * One path, two methods, which is why `ApiPathProbe` carries a list of them rather than one.
   * Sitting and leaving are deliberately NOT here: they happen over the socket, where they are
   * ordered against the hand the seat is in, and a second REST path to the same mutation would
   * give two routes with no ordering between them.
   */
  rooms: (): string => `${API_PREFIX}/rooms`,

  /**
   * Join a private room with the invite code its owner was shown once.
   *
   * Separate from `rooms` because it is a different authorisation question: `POST /rooms` asks
   * "may this session create a table", and this asks "does this session hold the code for that
   * one". The server answers a wrong or unknown code with 404 rather than 403, so the reply
   * cannot be used to discover which rooms exist.
   */
  roomJoin: (): string => `${API_PREFIX}/rooms/join`,

  /**
   * The reader's own progress counts.
   *
   * Counts only — no score, rank, streak or percentage. `docs/PRODUCT-GUARDRAILS.md` §2 forbids
   * those, and `apps/api/test/…` asserts the payload carries none of them, so this path cannot
   * quietly grow into a leaderboard.
   */
  progress: (): string => `${API_PREFIX}/me/progress`,

  /**
   * Reset the reader's units to the starting figure.
   *
   * Every page states the units are free and resettable at any time; this is the path that makes
   * that statement true rather than aspirational. It resets units only: progress is not touched,
   * because a learner clearing a play-money stack has not asked to forget what they have read.
   */
  unitsReset: (): string => `${API_PREFIX}/me/units/reset`,

  /**
   * The WebSocket upgrade path — the *path only*, because the scheme and host are the page's own.
   *
   * A client composes `ws(s)://<its own host>` in front of this: the session cookie is
   * `__Host-` prefixed with no `Domain`, so a socket opened against any other origin arrives
   * unauthenticated and is closed 4401, and page script cannot set a header on `new WebSocket()`
   * to compensate. See `tableSocketUrl` in `apps/web/src/lib/table-socket.ts`.
   *
   * It is in this table for the same reason every REST path is: `WS_PATH` in
   * `apps/api/src/ws/hub.ts` is `/ws` and the hub is mounted under `API_PREFIX` like every other
   * route module, so the concrete path is a fact about two files that must not drift. It was
   * written out in the client as a private constant, which is precisely the shape this table
   * exists to remove.
   */
  ws: (): string => `${API_PREFIX}/ws`,
} as const;

/** The name of one entry in `API_PATHS`. */
export type ApiPathName = keyof typeof API_PATHS;

/** The identifiers `API_PATHS` interpolates. Named so a probe can say which one it needs. */
export interface ApiPathExamples {
  readonly lessonId: string;
  readonly quizId: string;
  readonly scenarioId: string;
  readonly handId: string;
  readonly profileId: string;
  /** Serialised without its `?`, as `API_PATHS.hands` expects. */
  readonly handsQuery: string;
}

/**
 * How the client reaches a path.
 *
 * `UPGRADE` is not an HTTP method and is not pretending to be one: it says that this path is
 * reached by a WebSocket handshake rather than by a request/response, so a test must assert it
 * as a registered upgrade route rather than by injecting a request and reading a status. Naming
 * it in the table is what stops the WebSocket path from being left out of the guarantee on the
 * grounds that it does not fit — which is how it came to be written out in the client instead.
 */
export type ApiPathMethod = 'GET' | 'POST' | 'UPGRADE';

/**
 * One entry of `API_PATHS`, in a shape a test can drive without knowing which arguments it takes.
 *
 * `build` is handed a whole set of example identifiers rather than a positional argument list, so
 * every probe has the same signature and a caller can iterate them. The test supplies identifiers
 * it has read back from the API's own list endpoints, which is what keeps the probes from failing
 * for the unrelated reason that a hand-picked content id was retired.
 *
 * `methods` is a list because a path is not a route: `/rooms` is a list on `GET` and a creation on
 * `POST`, and a table that could only name one of them would either under-test the path or force a
 * second entry building the same string.
 */
export interface ApiPathProbe {
  readonly methods: readonly ApiPathMethod[];
  readonly build: (examples: ApiPathExamples) => string;
}

/**
 * Every entry of `API_PATHS`, enumerable.
 *
 * The `Readonly<Record<ApiPathName, ApiPathProbe>>` annotation is the point of this table: a new
 * path in `API_PATHS` without an entry here is a compile error, and an entry here for a path that
 * no longer exists is too. That is what stops the contract test from drifting away from the call
 * sites while still passing.
 */
export const API_PATH_PROBES: Readonly<Record<ApiPathName, ApiPathProbe>> = {
  session: { methods: ['GET'], build: () => API_PATHS.session() },
  guest: { methods: ['POST'], build: () => API_PATHS.guest() },
  lessons: { methods: ['GET'], build: () => API_PATHS.lessons() },
  lesson: { methods: ['GET'], build: (ex) => API_PATHS.lesson(ex.lessonId) },
  lessonRead: { methods: ['POST'], build: (ex) => API_PATHS.lessonRead(ex.lessonId) },
  glossary: { methods: ['GET'], build: () => API_PATHS.glossary() },
  scenarios: { methods: ['GET'], build: () => API_PATHS.scenarios() },
  scenario: { methods: ['GET'], build: (ex) => API_PATHS.scenario(ex.scenarioId) },
  scenarioAttempt: { methods: ['POST'], build: (ex) => API_PATHS.scenarioAttempt(ex.scenarioId) },
  quizAttempt: { methods: ['POST'], build: (ex) => API_PATHS.quizAttempt(ex.quizId) },
  hands: { methods: ['GET'], build: (ex) => API_PATHS.hands(ex.handsQuery) },
  hand: { methods: ['GET'], build: (ex) => API_PATHS.hand(ex.handId) },
  legendProfiles: { methods: ['GET'], build: () => API_PATHS.legendProfiles() },
  legendProfile: { methods: ['GET'], build: (ex) => API_PATHS.legendProfile(ex.profileId) },
  legendProfileStats: { methods: ['GET'], build: (ex) => API_PATHS.legendProfileStats(ex.profileId) },
  legendCompare: { methods: ['POST'], build: () => API_PATHS.legendCompare() },
  // Both methods, because the live-table client sends both: the list on load, the creation when
  // there is no room to reuse.
  rooms: { methods: ['GET', 'POST'], build: () => API_PATHS.rooms() },
  roomJoin: { methods: ['POST'], build: () => API_PATHS.roomJoin() },
  progress: { methods: ['GET'], build: () => API_PATHS.progress() },
  unitsReset: { methods: ['POST'], build: () => API_PATHS.unitsReset() },
  ws: { methods: ['UPGRADE'], build: () => API_PATHS.ws() },
};
