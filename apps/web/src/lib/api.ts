/**
 * The typed fetch wrapper. Every request the web client makes goes through here.
 *
 * ## Why a wrapper at all
 *
 * Four things have to be true of every call, and each of them is a security or correctness
 * property rather than a convenience:
 *
 *  1. **`credentials: 'include'`.** The session is a `__Host-`-prefixed, `SameSite=Strict` cookie,
 *     and the browser reaches the API through its own origin (see `API_ORIGIN`), so it is sent
 *     without asking. The flag stays anyway: it costs nothing on a same-origin request, and the
 *     day somebody points this client at a second origin its absence would look exactly like
 *     "logged out" — and the tempting fix for that is a token in `localStorage`, which is the
 *     thing the cookie design exists to avoid.
 *  2. **`x-csrf-token` on every mutation, and never on a read.** The token comes from
 *     `SessionResponse.csrfToken`. Sending it on a GET would leak it into anything that logs
 *     request headers for no benefit.
 *  3. **A failure carries the contract's `ErrorCode`, not a string.** Codes are the contract
 *     (`@prl/contracts/errors`); messages are for humans and may change. A screen that branches
 *     on a message will break silently the first time the copy is edited.
 *  4. **A timeout.** These calls run inside a server render. Without a deadline, an API that
 *     accepts a connection and never answers holds a page open until the platform kills it,
 *     and the reader sees nothing at all rather than a screen rendered from a fixture.
 *
 * ## What this deliberately does not do
 *
 *  - **No retries.** A retry on a mutation is a duplicate action; a retry on a read hides the
 *    outage the caller needs to know about so it can fall back to its fixture.
 *  - **No response validation.** `@prl/contracts` ships JSON Schemas and the API validates
 *    against them on the way out. Re-validating here would be a second definition of the same
 *    contract, and the two would drift.
 *  - **No protocol-version header.** `PROTOCOL_VERSION` is exchanged in
 *    `SessionResponse.protocolVersion`; the header name for sending it is the API's to define,
 *    and inventing one here would produce a header nothing reads.
 */

import type { ApiError, DeleteAccountResponse, ErrorCode, SessionResponse } from '@prl/contracts';
import { ACCOUNT_DELETE_CONFIRMATION, API_PATHS } from '@prl/contracts';

/**
 * Every path this client can emit, re-exported from the wire contract.
 *
 * Re-exported rather than re-declared: the paths are half of the contract and they belong in
 * `@prl/contracts` next to the response types, where `apps/api` compiles against them too. A
 * second copy here is exactly the arrangement that let the client address `/api/…` for the whole
 * build-out while the API served `/api/v1/…`.
 *
 * There is no supported way to build a request path outside this table. See
 * `packages/contracts/src/api-paths.ts`.
 */
export { API_PATHS, API_PREFIX } from '@prl/contracts';

/**
 * What to put in front of a path, which is not the same answer in a browser as on the server.
 *
 * **In the browser: nothing.** The request goes to the page's own origin as `/api/v1/…`, and
 * something in front of the app routes it — the `/api/:path*` rewrite in `next.config.ts` for the
 * dev loop, the reverse proxy for the container stack. One published origin is not a tidiness
 * preference: the session cookie is `__Host-` prefixed with no `Domain` (`plugins/security.ts` in
 * the API), and a `__Host-` cookie is only ever sent back to the exact host that set it.
 *
 * **On the server: an absolute origin**, because Node's `fetch` cannot resolve a relative URL — there
 * is no document to resolve it against. A server render is already inside the deployment, so it
 * addresses the API directly rather than looping back through the proxy.
 *
 * `PRL_API_ORIGIN` has no `NEXT_PUBLIC_` prefix, and that is the whole point of this arrangement:
 * `next build` inlines every `NEXT_PUBLIC_*` value into the client JavaScript, so a built image
 * ships whichever origin the build machine happened to see and no deployment can retarget it. This
 * variable is read only where `window` is undefined, so it is never in a client bundle and `next
 * start` picks it up from the process environment at boot. See the "deliberately absent" entry for
 * `NEXT_PUBLIC_API_ORIGIN` in `.env.example`.
 */
export const API_ORIGIN =
  typeof window === 'undefined' ? (process.env['PRL_API_ORIGIN'] ?? 'http://localhost:3001') : '';

/**
 * How long an ORDINARY call may take. Short, because the only caller that matters is a server
 * render with a reader waiting on it, and every screen in this app can render from a fixture.
 *
 * "Ordinary" means a read the API answers out of the database or the content bundle. It is the
 * wrong deadline for an endpoint that computes its answer, and `EXPENSIVE_READ_TIMEOUT_MS` below
 * is why that distinction had to be made explicit rather than left to each call site.
 */
export const REQUEST_TIMEOUT_MS = 4_000;

/**
 * How long a call to an endpoint that COMPUTES its answer may take.
 *
 * ## The defect this closes
 *
 * `GET /api/v1/hands/:handId` does not fetch a hand review; it builds one. Nothing derived is
 * stored (decision 7 in `db/migrations/0001_initial.sql`), so every read re-runs the Coach over
 * every hero decision in the hand — a bounded Monte Carlo each, up to `MAX_ANALYSED_DECISIONS`.
 * The route states in writing how long it may spend on that: `budgetMs:
 * Math.floor(app.appConfig.requestTimeoutMs / 2)` in `apps/api/src/routes/hands.ts`, which is
 * **ten seconds** at the shipped `REQUEST_TIMEOUT_MS` of 20 s.
 *
 * The deadline above was four seconds — well under half the budget the endpoint declares for
 * itself, before a byte of the 45 KB payload is serialised. So the client aborted healthy work on
 * exactly the hands worth reviewing: a four-seat showdown with fifteen actions was measured at
 * 6.3–7.0 s against the same session where a two-decision hand answered in 1.4 s. The learner did
 * not see a slow page. They saw a 404, because the abort surfaced as "there is no API" and
 * `/review/[handId]` fell through to a fixture that carries only the sample hands — which is to
 * say the deck-commitment proof, this product's headline verifiable claim, was unreachable for
 * every hand with enough decisions in it to be worth checking.
 *
 * ## Why fifteen seconds, and not "however long it takes"
 *
 * The value is bounded on both sides by numbers the API already publishes, which is what makes it
 * a derived figure rather than a guess:
 *
 *  - **Above the review's own analysis budget (10 s)**, with room for the query, the JSON and the
 *    wire. A deadline below it cannot be reached by a healthy server doing its declared maximum of
 *    work, which is the property that was missing.
 *  - **Below the API's own `REQUEST_TIMEOUT_MS`** (20 s; the fallback is in `apps/api/src/config.ts`).
 *    When the server is the one that gives up, it answers with a code and a request id that
 *    correlates to a log line. Aborting first throws that away and leaves us guessing. Losing the
 *    race to the server is the better failure.
 *
 * It is deliberately NOT the default. A fifteen-second deadline on the session read in the app
 * shell would hold every page in the product open for fifteen seconds against a hung API, to
 * settle one number in the header.
 *
 * `apps/web/test/y1-review-deadline.test.ts` re-derives both bounds from the API's own source and
 * fails if this window ever closes again — including if somebody lowers `REQUEST_TIMEOUT_MS`, which
 * moves the analysis budget with it.
 */
export const EXPENSIVE_READ_TIMEOUT_MS = 15_000;

/** Methods that carry the CSRF header. Anything not listed here is treated as a read. */
const MUTATING_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * A failed call, with the contract's code attached.
 *
 * `'transport'` is this class's own addition rather than an `ErrorCode`: the request never
 * reached a handler, so the API never chose a code. Callers that fall back to a fixture check
 * for it, because it is the difference between "the API said no" and "there was no API".
 */
export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';
  /** 0 when the request never completed. */
  readonly status: number;
  readonly code: ErrorCode | 'transport';
  /** Correlates with a server log line. Null when the failure never reached the server. */
  readonly requestId: string | null;
  /** Field-level detail, present only for `invalid_request`. */
  readonly fields: Readonly<Record<string, string>> | null;

  constructor(input: {
    readonly message: string;
    readonly status: number;
    readonly code: ErrorCode | 'transport';
    readonly requestId?: string | null;
    readonly fields?: Readonly<Record<string, string>> | null;
  }) {
    super(input.message);
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId ?? null;
    this.fields = input.fields ?? null;
  }
}

/**
 * True when the API could not be reached or is not answering usefully.
 *
 * This is the question every screen asks before rendering from its fixture, and the line it draws
 * is: **did anything route our request?**
 *
 *  - `'transport'` — no HTTP response at all: refused connection, DNS failure, timeout. There is no
 *    API here. This is what a genuinely undeployed API looks like, and it is the case the fixture
 *    fallback exists for.
 *  - `503` / `service_unavailable`, `501`, `5xx` — an API answered and said it cannot serve this.
 *    It named the condition itself, so taking it at its word is not a guess.
 *
 * **A 404 is deliberately NOT on that list**, and the omission is the fix for a release blocker.
 * A 404 means an HTTP server accepted the request and routed it to nothing, so it is one of exactly
 * two things: a path this client built wrong, or an identifier that does not exist. Neither is "the
 * API is not deployed". Counting it as one is what let every path in this client omit the `/api/v1`
 * segment through an entire build-out — every screen fell back to a fixture, no error surfaced, no
 * test failed, and the product shipped six fixture scenarios against the API's thirty-six.
 *
 * The consequence for callers is intended: a 404 on a collection path now reaches the error
 * boundary. A caller that asked for one identified resource, and for which "no such thing" is a
 * real product state, uses `isMissingResource` to render its own 404 instead — see the note there
 * for why that split is safe.
 */
export function isApiUnavailable(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  if (error.code === 'transport') return true;
  if (error.code === 'service_unavailable') return true;
  return error.status === 501 || error.status >= 502;
}

/**
 * True when a request for ONE identified resource came back 404.
 *
 * Only call this where the path carried an identifier the reader supplied — a lesson id from the
 * URL, a hand id, a profile id. There, a 404 is the ordinary answer to "does this exist?" and the
 * page turns it into its own not-found screen.
 *
 * Never call it for a collection path. A collection has no identifier that can be missing, so a
 * 404 there can only be a routing failure, and mapping it to "nothing here" would reinstate exactly
 * the silence this module was just fixed to remove. `apps/api/test/web-api-paths.test.ts` asserts
 * every path in `API_PATHS` resolves to a registered route, which is what makes the *other* reading
 * of a parameterised 404 — a mistyped path — a caught defect rather than an assumption.
 */
export function isMissingResource(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404;
}

/**
 * True when the API refused because there is no session.
 *
 * Distinct from "unavailable" because the API is working perfectly: it is telling us the caller is
 * anonymous. A screen that treated that as an outage would be lying about the cause, and one that
 * threw would replace a signed-out state with an error page.
 *
 * This used to be the answer a server render ALWAYS got, because a server-side `fetch` carries no
 * cookie jar and `credentials: 'include'` does nothing without a browser. It no longer is: a
 * per-reader server render forwards the reader's session cookie explicitly (`ApiCallOptions.cookie`
 * and `src/lib/server-session.ts`), so `not_authenticated` on the server now means what it says —
 * this reader is not signed in.
 *
 * ## Both 401 codes, and why missing one of them was a 500
 *
 * The API splits the refusal in two on purpose (`requireSession` in `apps/api/src/auth/session.ts`):
 * `not_authenticated` when no session cookie was presented or it was not ours, `session_expired`
 * when a cookie *this deployment signed* no longer resolves to a live session. Its own comment says
 * what the split is for — "a client that knows to open a fresh guest session rather than showing a
 * dead end".
 *
 * This predicate matched only the first, so the dead end is exactly what the client showed. A
 * reader whose guest session had been swept, or who was holding a cookie from a redeployed
 * database, got an unhandled `ApiRequestError` out of `loadRecord`, `/review` and
 * `/review/[handId]` — the error boundary, an incident-reference number, and a screen saying
 * something went wrong — for the entirely ordinary condition of an old cookie. Both codes are 401,
 * both mean "there is no usable session here", and every caller of this function does the same
 * thing with the answer: render the signed-out state and offer the way to get a session.
 *
 * Widening it is not a loosening: nothing here decides whether to trust a caller. The API alone
 * settles that, and this only chooses which of two truthful screens to draw.
 */
export function isSignedOut(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  return error.code === 'not_authenticated' || error.code === 'session_expired';
}

/** Narrows an unknown parsed body to the contract's error envelope. */
function readApiError(body: unknown): ApiError['error'] | null {
  if (typeof body !== 'object' || body === null) return null;
  const envelope = (body as { readonly error?: unknown }).error;
  if (typeof envelope !== 'object' || envelope === null) return null;
  const { code, message, requestId, fields } = envelope as {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly requestId?: unknown;
    readonly fields?: unknown;
  };
  if (typeof code !== 'string' || typeof message !== 'string' || typeof requestId !== 'string') {
    return null;
  }
  const parsed: ApiError['error'] = {
    code: code as ErrorCode,
    message,
    requestId,
  };
  if (typeof fields === 'object' && fields !== null) {
    return { ...parsed, fields: fields as Readonly<Record<string, string>> };
  }
  return parsed;
}

export interface ApiCallOptions {
  /** Required by the API on every mutation. Omitted on reads, deliberately. */
  readonly csrfToken?: string;
  /**
   * The reader's session cookie, as one `name=value` pair, for a SERVER render only.
   *
   * ## Why this exists
   *
   * `credentials: 'include'` above is a browser instruction and does nothing in Node: a
   * server-side `fetch` has no cookie jar, so a server render was anonymous by construction and
   * every per-reader endpoint answered `not_authenticated`. `/review` therefore could not show a
   * signed-in reader their own hand history at all — it rendered a "your history is private and
   * this page has no session to read it with" notice over a fixture, for everybody, forever.
   *
   * ## The boundary, which is the whole point of the shape
   *
   * This is deliberately NOT a general credential-forwarding facility, and three things keep it
   * that way:
   *
   *  1. **It cannot be pointed at another host.** `call()` builds every URL as
   *     `${API_ORIGIN}${path}` from a path in `API_PATHS`. There is no caller-supplied origin, so
   *     a value passed here can only ever be sent to this deployment's own API.
   *  2. **It is ignored in a browser.** The check below is on `window`, not on a flag: in a
   *     browser the cookie is attached by the browser under its own rules, and an app-supplied
   *     `cookie` header would be both useless (forbidden header name) and a way to smuggle a
   *     credential into a request the browser did not authorise.
   *  3. **Only one cookie is ever put in it.** The single supported producer is
   *     `readerCallOptions` in `src/lib/server-session.ts`, which reads the session cookie by
   *     name and nothing else — not the CSRF secret, not a third-party cookie, not the whole
   *     `Cookie` header. See that module for why.
   */
  readonly cookie?: string;
  /** Forwarded to `fetch`. Defaults to `no-store`: none of this data is cacheable. */
  readonly cache?: RequestCache;
  /** Caller's own deadline, for anything that legitimately takes longer than the default. */
  readonly timeoutMs?: number;
  /**
   * The caller's own cancellation, composed WITH the timeout rather than replacing it.
   *
   * A client component that fetches in an effect has to abort on unmount, or a navigation leaves a
   * response resolving into a component that no longer exists. Passing it as its own option rather
   * than as a `signal` that overrides the deadline is what stops "I want to cancel this myself"
   * from silently meaning "and I no longer want a timeout".
   */
  readonly signal?: AbortSignal;
}

/**
 * The deadline, and the caller's cancellation, as one signal.
 *
 * `AbortSignal.any` aborts as soon as either does, which is exactly the semantics wanted: whichever
 * reason arrives first wins, and neither can disable the other. Written as a function so the
 * timeout is applied in one place — a `signal` option that quietly replaced the deadline would be
 * a request with no deadline, and it would look correct at the call site.
 */
function abortSignalFor(options: ApiCallOptions): AbortSignal {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  if (options.signal === undefined) return deadline;
  return AbortSignal.any([deadline, options.signal]);
}

/**
 * Says out loud that a path this client built was routed to nothing.
 *
 * The API's not-found handler returns the same `content_not_found` envelope for an unregistered
 * route as for a real id that does not exist, so the response cannot tell the two apart. What can
 * is the developer reading this line: the path is printed next to the reminder that this client is
 * only allowed to build paths from `API_PATHS`, so "the route is not registered" and "that lesson
 * was deleted" are one grep apart rather than indistinguishable.
 *
 * Development only. In production this would be noise on every mistyped URL a reader visits, and
 * the loud signal there is the one the caller now gets anyway: `isApiUnavailable` no longer swallows
 * a 404 into a fixture.
 */
function warnOnNotFound(method: string, path: string): void {
  if (process.env.NODE_ENV === 'production') return;
  console.error(
    `[api] ${method} ${path} → 404. Nothing is registered at that path, or the id in it does not exist. ` +
      'Every path this client emits must come from API_PATHS in @prl/contracts, and ' +
      'apps/api/test/web-api-paths.test.ts asserts each one resolves — so a 404 here is a client bug ' +
      'until that test says otherwise.',
  );
}

/**
 * One call.
 *
 * The `init` object is assembled conditionally rather than spread with possibly-absent values:
 * `exactOptionalPropertyTypes` rejects `{ body: undefined }`, and the compiler catching that is
 * the point of the setting.
 */
async function call<T>(method: string, path: string, body: unknown, options: ApiCallOptions): Promise<T> {
  return (await callWithHeaders<T>(method, path, body, options)).data;
}

/** `call`, plus the response headers, for the one caller that needs a `set-cookie`. */
async function callWithHeaders<T>(
  method: string,
  path: string,
  body: unknown,
  options: ApiCallOptions,
): Promise<{ readonly data: T; readonly headers: Headers }> {
  const url = `${API_ORIGIN}${path}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  const mutating = MUTATING_METHODS.includes(method);
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (mutating && options.csrfToken !== undefined) headers['x-csrf-token'] = options.csrfToken;
  // Server renders only, and only to `API_ORIGIN` — see `ApiCallOptions.cookie`. `window` is the
  // test rather than an option, so no call site can opt a browser request into it.
  if (options.cookie !== undefined && typeof window === 'undefined') headers['cookie'] = options.cookie;

  const init: RequestInit = {
    method,
    headers,
    credentials: 'include',
    cache: options.cache ?? 'no-store',
    signal: abortSignalFor(options),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    // A DNS failure, a refused connection, a timeout: the request never reached a handler, so
    // there is no code and no request id to report. The message names what was actually addressed —
    // the absolute origin on the server, and "this origin" in a browser, where the request went to
    // the page's own host and whatever routes `/api/*` there did not answer.
    const target = API_ORIGIN === '' ? 'this origin' : API_ORIGIN;
    throw new ApiRequestError({
      message: `could not reach the API at ${target}: ${cause instanceof Error ? cause.message : 'unknown transport failure'}`,
      status: 0,
      code: 'transport',
    });
  }

  if (response.status === 204) {
    notifyMutationAccepted(mutating);
    return { data: undefined as T, headers: response.headers };
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (response.status === 404) warnOnNotFound(method, path);

  if (!response.ok) {
    const envelope = readApiError(parsed);
    if (envelope === null) {
      throw new ApiRequestError({
        message: `${method} ${path} failed with status ${response.status}`,
        status: response.status,
        code: 'internal_error',
      });
    }
    throw new ApiRequestError({
      message: envelope.message,
      status: response.status,
      code: envelope.code,
      requestId: envelope.requestId,
      fields: envelope.fields ?? null,
    });
  }

  if (parsed === null) {
    throw new ApiRequestError({
      message: `${method} ${path} returned a body that is not JSON`,
      status: response.status,
      code: 'internal_error',
    });
  }
  // After the last throw, so nothing that failed is announced as having happened. See
  // `notifyMutationAccepted` for why the shell needs to hear about this at all.
  notifyMutationAccepted(mutating);
  return { data: parsed as T, headers: response.headers };
}

/** A read. Never sends the CSRF token. */
export function apiGet<T>(path: string, options: ApiCallOptions = {}): Promise<T> {
  return call<T>('GET', path, undefined, options);
}

/**
 * A mutation.
 *
 * The CSRF token is not defaulted or invented: a caller without one gets a request without the
 * header and a `csrf_failed` from the server, which is the correct and visible outcome.
 */
export function apiSend<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  options: ApiCallOptions = {},
): Promise<T> {
  return call<T>(method, path, body, options);
}

// ---------------------------------------------------------------------------
// The non-throwing form
// ---------------------------------------------------------------------------

/**
 * A call that has already been handled, as a value.
 *
 * ## Why this exists alongside the throwing form
 *
 * Every screen in this app has to render when the API is absent, because the API is being built in
 * parallel with the client and because a learner mid-lesson should not lose the lesson to a network
 * blip. "Render an error state instead" is therefore the *normal* path, not the exceptional one,
 * and a thrown exception is the wrong tool for a normal path: in a server component it escapes to
 * `error.tsx` and takes the whole route with it, and in a client component it becomes an unhandled
 * rejection unless every call site remembers a `catch`.
 *
 * A discriminated result makes the failure case impossible to forget. `if (!result.ok)` is checked
 * by the compiler — `result.data` does not exist until the check has narrowed it — so a screen
 * cannot read data it has not established it has.
 *
 * The throwing form stays for the cases that genuinely are exceptional: a mutation the reader just
 * asked for, where "it silently did not happen" is the worst possible outcome.
 */
export type SafeResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiRequestError };

/**
 * Runs a call and returns its outcome instead of throwing.
 *
 * Only an `ApiRequestError` is caught. Anything else — a `TypeError` from a bug in this module, a
 * `RangeError` from somewhere unexpected — is a defect in the client rather than a fact about the
 * network, and swallowing it into a tidy `{ ok: false }` would turn a crash that should be fixed
 * into an error state that gets shrugged at.
 */
export async function safeFetch<T>(run: () => Promise<T>): Promise<SafeResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (cause) {
    if (cause instanceof ApiRequestError) return { ok: false, error: cause };
    throw cause;
  }
}

/**
 * The session, as a result.
 *
 * `GET /api/v1/auth/session` is the one call the app shell makes on every page: it carries the
 * reader's units for the header badge and the CSRF token every later mutation needs. It is a GET
 * with no query string — the session is identified by the cookie, and putting any part of an
 * identity in a URL puts it in every log, proxy and `Referer` header between here and the server.
 */
export function fetchSession(options: ApiCallOptions = {}): Promise<SafeResult<SessionResponse>> {
  return safeFetch<SessionResponse>(() => apiGet<SessionResponse>(API_PATHS.session(), options));
}

/**
 * Erases the reader's account, and answers with what actually went and what was kept.
 *
 * ## Why the confirmation phrase is supplied HERE and not by the screen
 *
 * The API refuses this request unless the body carries `ACCOUNT_DELETE_CONFIRMATION` exactly, and
 * the point of that rule is that a mis-wired client cannot erase an account by accident. A screen
 * that assembled the body itself could send a phrase that had drifted from the contract — which
 * would not be a security hole (the API would refuse it) but WOULD be a delete button that
 * silently stopped working, which for this feature is the same defect wearing a different hat.
 *
 * The reader's own confirmation is a separate thing and stays where it belongs: the control in
 * `app/record/DeleteAccount.tsx` will not call this at all until the reader has reproduced the
 * phrase. This function is the wire format; that component is the consent.
 *
 * Non-throwing, like `fetchSession`, because every outcome here is a screen the reader has to be
 * shown rather than an exception: 401 means the session went while they were reading, 409 means
 * nothing was removed, and a transport failure means nobody knows yet.
 *
 * A `POST` and not a `DELETE`, which is the API's decision and is argued at `API_PATHS.accountDelete`.
 */
export function deleteAccount(csrfToken: string): Promise<SafeResult<DeleteAccountResponse>> {
  return safeFetch<DeleteAccountResponse>(() =>
    apiSend<DeleteAccountResponse>(
      'POST',
      API_PATHS.accountDelete(),
      { confirm: ACCOUNT_DELETE_CONFIRMATION },
      { csrfToken },
    ),
  );
}

// ---------------------------------------------------------------------------
// "Something the reader did changed the session"
// ---------------------------------------------------------------------------

/**
 * Anyone who wants to know that a mutation went through. Browser only — see
 * `subscribeToAcceptedMutations` below.
 *
 * A module-level set rather than a `CustomEvent` on `window`: the subscriber is a React effect
 * either way, and a set cannot be listened to by anything outside this bundle, cannot be
 * dispatched by a page script, and needs no name that a second module could typo.
 */
const mutationListeners = new Set<() => void>();

/**
 * Fires after any mutating request the API accepted.
 *
 * ## The defect this closes
 *
 * `POST /me/units/reset` succeeded, `/record` said "Done. Your units are back to 2000", and the
 * header badge two inches above it went on reading `3,308 UNITS` until the reader happened to
 * reload. One screen, two totals, both presented as fact. The header could not have known: it
 * reads the session once on mount and nothing tells it that anything moved.
 *
 * ## Why the signal carries no figure
 *
 * It would be easy to hand the new units along with it — the reset response contains them. That
 * would be wrong in a way this codebase keeps a rule about: the header would then be displaying a
 * number derived from a mutation's echo rather than from the endpoint whose job is to say what the
 * session holds. This signal says only "ask again". The subscriber re-reads
 * `GET /auth/session` and shows whatever the API says, including "I could not tell you" if that
 * read fails. One authority for the figure, which is what stops two screens disagreeing in the
 * first place.
 *
 * ## Why every mutation and not just the reset
 *
 * Because the reset is not the only thing that moves the number. A hand settles, a guest session
 * is opened, a room is joined — the units in the header are stale after all of them, and a rule
 * keyed on one path would have to be extended each time somebody adds an endpoint, silently
 * failing until they remembered. "The reader changed something; the shell's copy of the session is
 * now suspect" is the fact that is actually true, and it is true at exactly this line.
 *
 * The cost is one extra `GET /auth/session` — a cookie lookup and a row — per accepted mutation,
 * and mutations happen at human speed. Reads do not fire it, so there is no loop.
 */
function notifyMutationAccepted(mutating: boolean): void {
  // The "was this a mutation at all" test lives here rather than at the two call sites, so the one
  // transport function stays a single straight read of the response rather than growing a branch
  // per success path.
  if (!mutating) return;
  // A server render has no shell to update and no reader watching it; firing there would also mean
  // one request's listeners could be invoked by another's, since this module is per process.
  if (typeof window === 'undefined') return;
  for (const listener of [...mutationListeners]) listener();
}

/**
 * Registers a listener, and returns the function that removes it.
 *
 * Returns a no-op unsubscribe on the server rather than throwing: a client component's effect body
 * does not run during a server render, but the module is still evaluated there, and a subscriber
 * that has to guard `typeof window` at every call site is a subscriber somebody will forget to
 * guard.
 */
export function subscribeToAcceptedMutations(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  mutationListeners.add(listener);
  return () => {
    mutationListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Reaching a POST endpoint from a server render
// ---------------------------------------------------------------------------

/** The names the API gives its CSRF secret cookie: `__Host-` prefixed in production, plain outside. */
const CSRF_COOKIE_NAMES: readonly string[] = ['__Host-prl_csrf', 'prl_csrf'];

/**
 * A CSRF token this process minted for itself, with the secret cookie that matches it.
 *
 * ## What problem this solves, and what it deliberately does not do
 *
 * `POST /api/v1/legends/compare` is a pure computation: it takes a poker situation and returns
 * what each opponent model would do with it. It reads nothing about the caller and writes nothing.
 * It is a `POST` only because the request body is a whole situation rather than an identifier.
 *
 * The API applies its CSRF check to every state-changing method without exception, which is the
 * right rule and is not being relaxed here. The consequence was that a server render — which has
 * no browser and therefore no token — could not call it, and the compare screen treated
 * `csrf_failed` as an ordinary answer and rendered a bundled sample spot instead. A screen that
 * explains why it cannot show you the thing is not the thing.
 *
 * The resolution is that the double-submit handshake is not a user credential and does not need
 * one. `GET /auth/session` mints a token and sets the paired secret cookie for whoever asks,
 * including an anonymous caller — the first mutating request a brand-new visitor makes is
 * `POST /auth/guest`, so it has to. This function performs that handshake for the render itself
 * and returns both halves, and the pair is used once and discarded.
 *
 * **The reader's own cookies are not involved and must never be.** Nothing here reads
 * `next/headers`, and `ApiCallOptions.cookie` — which carries the reader's SESSION cookie for
 * per-reader reads — is not set by this function and must not be combined with it. The request
 * that follows is anonymous by construction, which is exactly why it is safe: causing this server
 * to make an unauthenticated, side-effect-free POST to its own API achieves nothing, whereas
 * forwarding the reader's CSRF secret so a render could act AS them would be the forgery the check
 * exists to prevent. Use this only for endpoints that are reads wearing a POST.
 */
export interface ServerCsrfHandshake {
  readonly csrfToken: string;
  /** The secret cookie the token was derived from, as one `name=value` pair. */
  readonly cookie: string;
}

/**
 * Performs the handshake, or returns null when the API did not issue a usable pair.
 *
 * Null rather than throwing: the caller's next step is to fall back to its fixture, and a missing
 * handshake is the same kind of "the API is not answering usefully" as any other. Only a cookie
 * whose name is one of the API's own CSRF cookie names is accepted, so a `set-cookie` for anything
 * else on that response is ignored rather than replayed.
 */
export async function serverCsrfHandshake(options: ApiCallOptions = {}): Promise<ServerCsrfHandshake | null> {
  if (typeof window !== 'undefined') return null;
  const result = await safeFetch(() =>
    callWithHeaders<SessionResponse>('GET', API_PATHS.session(), undefined, options),
  );
  if (!result.ok) return null;
  const token = result.data.data.csrfToken;
  if (token === null) return null;
  for (const raw of result.data.headers.getSetCookie()) {
    const pair = raw.split(';', 1)[0] ?? '';
    const name = pair.slice(0, pair.indexOf('='));
    if (CSRF_COOKIE_NAMES.includes(name)) return { csrfToken: token, cookie: pair };
  }
  return null;
}
