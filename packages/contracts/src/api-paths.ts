/**
 * The REST surface, as paths, shared by `apps/api` and `apps/web`.
 * `API_PATHS` is the only place a request path may be built, and `API_PATH_PROBES` republishes each
 * entry so `apps/api/test/web-api-paths.test.ts` can prove both sides agree. The WebSocket upgrade
 * path is in the table too. String building only, so server and browser can both use it.
 */

/** Matches `API_PREFIX` in `apps/api/src/app.ts`, asserted by `web-api-paths.test.ts`. */
export const API_PREFIX = '/api/v1';

/** Every path the web client can emit. Ids are encoded here, so a slash in an id cannot change the route. */
export const API_PATHS = {
  /** The session the app shell reads on every page: units for the badge, CSRF for later mutations. */
  session: (): string => `${API_PREFIX}/auth/session`,
  /** `POST`. A guest account in one request, with no email or password. */
  guest: (): string => `${API_PREFIX}/auth/guest`,

  lessons: (): string => `${API_PREFIX}/content/lessons`,
  lesson: (lessonId: string): string => `${API_PREFIX}/content/lessons/${encodeURIComponent(lessonId)}`,

  /**
   * `POST`. Records that a learner read a lesson to the end. Not inferred from a `GET`, because a
   * prefetch or crawler looks like a read. Completion is sticky server-side.
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

  /** `query` is a serialised query string without its `?`. The caller chooses `sort`, `limit`, `cursor`. */
  hands: (query = ''): string => (query === '' ? `${API_PREFIX}/hands` : `${API_PREFIX}/hands?${query}`),
  hand: (handId: string): string => `${API_PREFIX}/hands/${encodeURIComponent(handId)}`,

  legendProfiles: (): string => `${API_PREFIX}/legends/profiles`,
  /** The profile detail, "What can I learn from this style". */
  legendProfile: (profileId: string): string =>
    `${API_PREFIX}/legends/profiles/${encodeURIComponent(profileId)}`,
  /** Simulated behaviour against the declared card. Separate because it runs thousands of hands. */
  legendProfileStats: (profileId: string): string =>
    `${API_PREFIX}/legends/profiles/${encodeURIComponent(profileId)}/stats`,
  /** `POST`: the request carries a whole situation, which does not belong in a URL. */
  legendCompare: (): string => `${API_PREFIX}/legends/compare`,
  /** `POST`. A private room with the named Legend profiles seated. Reached from `/play?profile=`. */
  legendMatches: (): string => `${API_PREFIX}/legends/matches`,

  /**
   * `GET`. One of the caller's own finished hands, compared decision by decision with the modelled
   * style. Scoped like `hand`, and answers `hand_not_found` either way so probing cannot confirm an id.
   */
  legendHandComparison: (handId: string): string =>
    `${API_PREFIX}/legends/hands/${encodeURIComponent(handId)}/comparison`,

  /**
   * `GET` lists the rooms this session can see, `POST` creates one. Sitting and leaving happen over
   * the socket, where they are ordered against the hand.
   */
  rooms: (): string => `${API_PREFIX}/rooms`,

  /** Join a private room by invite code. A wrong code is 404, not 403, so rooms cannot be discovered. */
  roomJoin: (): string => `${API_PREFIX}/rooms/join`,

  /** Progress counts only. No score, rank, streak or percentage (`docs/PRODUCT-GUARDRAILS.md` §2). */
  progress: (): string => `${API_PREFIX}/me/progress`,

  /** Reset units to the starting figure. Progress is not touched. */
  unitsReset: (): string => `${API_PREFIX}/me/units/reset`,

  /**
   * `POST`. Erase the reader's account. A `POST` because a `DELETE` with a required body is handled
   * inconsistently by proxies and clients. No user id in the path, so it never reaches access logs and
   * cannot address another account. Hands, audit events and created tables survive with the identity
   * detached (see `DeleteAccountResponse`).
   */
  accountDelete: (): string => `${API_PREFIX}/me/delete`,

  /**
   * The WebSocket upgrade path only. The client prepends `ws(s)://<its own host>`, because the
   * `__Host-` session cookie has no `Domain` and a socket to another origin is closed 4401.
   * Matches `WS_PATH` in `apps/api/src/ws/hub.ts` under `API_PREFIX`.
   */
  ws: (): string => `${API_PREFIX}/ws`,
} as const;

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

/** `UPGRADE` marks a WebSocket handshake path, which a test asserts as a registered upgrade route. */
export type ApiPathMethod = 'GET' | 'POST' | 'UPGRADE';

/**
 * One entry of `API_PATHS` in a shape a test can drive. `build` takes example identifiers that the
 * test reads back from the API's list endpoints. `methods` is a list because `/rooms` has two.
 */
export interface ApiPathProbe {
  readonly methods: readonly ApiPathMethod[];
  readonly build: (examples: ApiPathExamples) => string;
}

/** Every `API_PATHS` entry. The `Record<ApiPathName>` key type makes a missing or stale probe an error. */
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
  legendMatches: { methods: ['POST'], build: () => API_PATHS.legendMatches() },
  legendHandComparison: { methods: ['GET'], build: (ex) => API_PATHS.legendHandComparison(ex.handId) },
  rooms: { methods: ['GET', 'POST'], build: () => API_PATHS.rooms() },
  roomJoin: { methods: ['POST'], build: () => API_PATHS.roomJoin() },
  progress: { methods: ['GET'], build: () => API_PATHS.progress() },
  unitsReset: { methods: ['POST'], build: () => API_PATHS.unitsReset() },
  accountDelete: { methods: ['POST'], build: () => API_PATHS.accountDelete() },
  ws: { methods: ['UPGRADE'], build: () => API_PATHS.ws() },
};
