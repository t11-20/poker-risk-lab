/**
 * The typed fetch wrapper. Every request the web client makes goes through here.
 * Always `credentials: 'include'`, so a second origin never tempts anyone into a token in storage.
 * `x-csrf-token` on mutations only, never on a read. Failures carry the contract's `ErrorCode`, so
 * screens never branch on message text. Every call has a deadline, because these run in server renders.
 * No retries (a retried mutation is a duplicate) and no response re-validation (the API validates).
 */

import type { ApiError, DeleteAccountResponse, ErrorCode, SessionResponse } from '@prl/contracts';
import { ACCOUNT_DELETE_CONFIRMATION, API_PATHS } from '@prl/contracts';

/** Re-exported, never re-declared. A second copy once sent the client to `/api/…` instead of `/api/v1/…`. */
export { API_PATHS, API_PREFIX } from '@prl/contracts';

/**
 * Empty in the browser, so requests go same-origin. The session cookie is `__Host-` with no `Domain`
 * and is only sent back to the host that set it. Absolute on the server, where `fetch` cannot resolve a
 * relative URL. `PRL_API_ORIGIN` has no `NEXT_PUBLIC_` prefix so it is read at boot, not inlined at build.
 */
export const API_ORIGIN =
  typeof window === 'undefined' ? (process.env['PRL_API_ORIGIN'] ?? 'http://localhost:3001') : '';

/** For reads answered from the database or content. Short, because every screen can render a fixture. */
export const REQUEST_TIMEOUT_MS = 4_000;

/**
 * For endpoints that compute their answer. A hand review re-runs the Coach with a 10s budget (half the
 * API's 20s `REQUEST_TIMEOUT_MS`), and a four-seat showdown measured 6.3 to 7.0s, so 4s aborted it.
 * 15s sits above that budget and below the API's own timeout, so the server gives up first with a code.
 * Not the default, or a hung API would hold every page for 15s. `y1-review-deadline.test.ts` pins both.
 */
export const EXPENSIVE_READ_TIMEOUT_MS = 15_000;

const MUTATING_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** `'transport'` is not an `ErrorCode`. It means no handler was reached, so callers can fall back. */
export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';
  readonly status: number;
  readonly code: ErrorCode | 'transport';
  readonly requestId: string | null;
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
 * True when nothing routed the request (`'transport'`) or the API said it cannot serve (503, 501, 5xx).
 * A 404 is deliberately excluded. Counting it hid a missing `/api/v1` segment behind fixtures for the
 * whole build-out. Single-resource callers use `isMissingResource`.
 */
export function isApiUnavailable(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  if (error.code === 'transport') return true;
  if (error.code === 'service_unavailable') return true;
  return error.status === 501 || error.status >= 502;
}

/**
 * Only for a path carrying a reader-supplied id. Never for a collection, where a 404 can only mean a
 * routing failure (`apps/api/test/web-api-paths.test.ts` checks every path resolves).
 */
export function isMissingResource(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404;
}

/**
 * Both 401 codes. `not_authenticated` is no usable cookie, `session_expired` is a cookie this deployment
 * signed whose session is gone. Matching only the first sent old cookies to the error boundary. This
 * picks which screen to draw and decides no trust.
 */
export function isSignedOut(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  return error.code === 'not_authenticated' || error.code === 'session_expired';
}

/**
 * A 400 `invalid_request` naming only the cursor. `/review?cursor=zzz` was a 500 (audit at 308fadf).
 * Kept this narrow so a 400 on any other field still reaches the boundary.
 */
export function isRejectedCursor(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  if (error.status !== 400 || error.code !== 'invalid_request') return false;
  const fields = error.fields;
  return fields !== null && CURSOR_FIELDS.some((field) => Object.hasOwn(fields, field));
}

/**
 * `query.cursor` is the route's refusal of a cursor it did not mint. `querystring.cursor` is the schema's,
 * from `fieldsFromValidation` prefixing Fastify's `validationContext`.
 */
const CURSOR_FIELDS: readonly string[] = ['query.cursor', 'querystring.cursor'];

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
  /** Mutations only. */
  readonly csrfToken?: string;
  /**
   * The reader's session cookie as one `name=value` pair, for a server render only.
   * It cannot reach another host (every URL is `API_ORIGIN` plus an `API_PATHS` path), it is ignored
   * where `window` exists, and its only producer `readerCallOptions` puts in the session cookie alone.
   */
  readonly cookie?: string;
  /** Defaults to `no-store`. */
  readonly cache?: RequestCache;
  readonly timeoutMs?: number;
  /** Composed with the timeout, never replacing it, so cancelling does not also drop the deadline. */
  readonly signal?: AbortSignal;
}

/** `AbortSignal.any` so neither the deadline nor the caller's signal can disable the other. */
function abortSignalFor(options: ApiCallOptions): AbortSignal {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  if (options.signal === undefined) return deadline;
  return AbortSignal.any([deadline, options.signal]);
}

/**
 * The API answers an unregistered route and a missing id with the same envelope, so this prints the
 * path for the developer. Development only.
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

/** `init` is built conditionally because `exactOptionalPropertyTypes` rejects `{ body: undefined }`. */
async function call<T>(method: string, path: string, body: unknown, options: ApiCallOptions): Promise<T> {
  return (await callWithHeaders<T>(method, path, body, options)).data;
}

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
  // Server renders only. Gated on `window`, not an option, so no call site can opt a browser into it.
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
    // No handler was reached, so there is no code or request id. In a browser the target is the page's
    // own origin and whatever routes the API prefix there.
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
  // After the last throw, so nothing that failed is announced as having happened.
  notifyMutationAccepted(mutating);
  return { data: parsed as T, headers: response.headers };
}

export function apiGet<T>(path: string, options: ApiCallOptions = {}): Promise<T> {
  return call<T>('GET', path, undefined, options);
}

/** The CSRF token is never defaulted. Without one the server answers `csrf_failed`, visibly. */
export function apiSend<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  options: ApiCallOptions = {},
): Promise<T> {
  return call<T>(method, path, body, options);
}

/**
 * A handled call as a value. Rendering a fallback is the normal path here, and a throw in a server
 * component takes the whole route to `error.tsx`. Mutations the reader asked for keep the throwing form.
 */
export type SafeResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiRequestError };

/** Catches only `ApiRequestError`. Any other error is a client bug and must stay loud. */
export async function safeFetch<T>(run: () => Promise<T>): Promise<SafeResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (cause) {
    if (cause instanceof ApiRequestError) return { ok: false, error: cause };
    throw cause;
  }
}

/** No query string. The cookie identifies the session, and identity in a URL ends up in logs. */
export function fetchSession(options: ApiCallOptions = {}): Promise<SafeResult<SessionResponse>> {
  return safeFetch<SessionResponse>(() => apiGet<SessionResponse>(API_PATHS.session(), options));
}

/**
 * The confirmation phrase is supplied here so the body cannot drift from the contract. The reader's
 * own consent is checked first in `DeleteAccount.tsx`. Non-throwing, since 401, 409 and transport
 * failure are all screens.
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

/**
 * A module-level set, not a `CustomEvent`, so page scripts cannot dispatch it and no event name can be
 * mistyped. Browser only.
 */
const mutationListeners = new Set<() => void>();

/**
 * Fires after any accepted mutation so the shell re-reads `GET /auth/session`. It carries no figure,
 * so the session endpoint stays the one authority for units. Reads do not fire it, so there is no loop.
 */
function notifyMutationAccepted(mutating: boolean): void {
  if (!mutating) return;
  // Module state is per process, so on the server one request's listeners could fire for another's.
  if (typeof window === 'undefined') return;
  for (const listener of [...mutationListeners]) listener();
}

/**
 * A settled hand moves units over the socket, which HTTP never sees (audit at 6b3886e). The caller
 * says only that the session may have moved.
 */
export function notifySessionChanged(): void {
  notifyMutationAccepted(true);
}

/** A no-op unsubscribe on the server, so callers need no `typeof window` guard. */
export function subscribeToAcceptedMutations(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  mutationListeners.add(listener);
  return () => {
    mutationListeners.delete(listener);
  };
}

/** `__Host-` prefixed in production, plain outside. */
const CSRF_COOKIE_NAMES: readonly string[] = ['__Host-prl_csrf', 'prl_csrf'];

/**
 * A CSRF pair this process mints for itself, for endpoints that are reads wearing a POST
 * (`POST /api/v1/legends/compare`). The handshake is not a user credential.
 * Never combine it with the reader's cookies. Forwarding the reader's CSRF secret would let a render
 * act as them, which is the forgery the check exists to prevent.
 */
export interface ServerCsrfHandshake {
  readonly csrfToken: string;
  /** The secret cookie the token was derived from, as one `name=value` pair. */
  readonly cookie: string;
}

/** Null when no usable pair was issued. Only the API's own CSRF cookie names are accepted. */
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
