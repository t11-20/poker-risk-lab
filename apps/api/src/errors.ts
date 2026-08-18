/**
 * One error shape out, whatever went wrong inside.
 *
 * Every failure this server produces — a thrown `AppError`, an Ajv validation
 * failure, a CSRF rejection, a rate-limit trip, a 404, or a genuine bug — leaves
 * through the single handler in this file and reaches the client as the `ApiError`
 * shape from `@prl/contracts`, with the status from `ERROR_STATUS` and the wording
 * from `ERROR_MESSAGES`.
 *
 * ## The rule that matters: the client is told a code, never a cause
 *
 * An unexpected error is logged in full server-side and answered with
 * `internal_error`, the generic message, and the request id. No stack trace, no SQL
 * fragment, no `error.message`. Those are how a 500 turns into a map of the server's
 * internals: a Postgres error names tables and columns, a `TypeError` names internal
 * properties, and a driver will happily quote the failing query. The request id is the
 * bridge — the user can quote it, and the log line has everything.
 *
 * The one deliberate exception is `invalid_request`, where per-field messages are
 * derived from the Ajv errors. Those describe the *client's own* payload against a
 * schema the client can already read, so they leak nothing about the server. The field
 * paths are still sanitised and capped, because an `additionalProperties` error echoes
 * a key name the caller chose, and echoing caller-chosen text unfiltered is how an
 * error body ends up carrying a payload into someone's log viewer.
 *
 * ## Statuses are normalised to the contract
 *
 * Fastify's framework errors carry their own statuses (415 for a bad media type, for
 * instance). We map the code first and then take the status from `ERROR_STATUS`, so a
 * client only ever has to know the contract's table. The original status and code go
 * to the log.
 */

import { type ApiError, ERROR_MESSAGES, ERROR_STATUS, type ErrorCode } from '@prl/contracts';
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
  RouteHandlerMethod,
} from 'fastify';
import { withoutControlCharacters } from './logging.ts';

/** Extra detail an `AppError` may carry. Everything is optional. */
export interface AppErrorDetail {
  /** Field-level messages. Only meaningful for `invalid_request`. */
  readonly fields?: Readonly<Record<string, string>>;
  /** Seconds until a retry may succeed. Only meaningful for `rate_limited`. */
  readonly retryAfterSeconds?: number;
  /**
   * Server-side only: what actually happened, for the log line. Never sent to a
   * client. Use it for the detail you would have put in `message` if `message` were
   * private — "room 7 is closed", "range parser rejected the token at offset 4".
   */
  readonly logDetail?: string;
  /** Underlying error, preserved for the log line. */
  readonly cause?: unknown;
}

/**
 * The error type route handlers, repositories and the WebSocket hub should throw.
 *
 * Throwing this rather than a bare `Error` is what makes a deliberate failure
 * distinguishable from a bug: an `AppError` becomes its own code and status, while
 * anything else becomes `internal_error` and is logged loudly.
 */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ErrorCode;
  readonly fields?: Readonly<Record<string, string>>;
  readonly retryAfterSeconds?: number;
  readonly logDetail?: string;

  constructor(code: ErrorCode, detail: AppErrorDetail = {}) {
    // The Error message is for logs only. The client sees ERROR_MESSAGES[code].
    super(detail.logDetail ?? code, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.code = code;
    if (detail.fields !== undefined) this.fields = detail.fields;
    if (detail.retryAfterSeconds !== undefined) this.retryAfterSeconds = detail.retryAfterSeconds;
    if (detail.logDetail !== undefined) this.logDetail = detail.logDetail;
  }

  /** The contract status for this code, so Fastify's own paths agree with ours. */
  get statusCode(): number {
    return ERROR_STATUS[this.code];
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

// ---------------------------------------------------------------------------
// Body construction
// ---------------------------------------------------------------------------

interface ApiErrorExtras {
  readonly fields?: Readonly<Record<string, string>>;
  readonly retryAfterSeconds?: number;
}

/**
 * Builds the wire body.
 *
 * Assembled field by field rather than by spreading, because
 * `exactOptionalPropertyTypes` means `fields: undefined` is not the same as an absent
 * `fields`, and the contract's optional members must genuinely be absent — a client
 * doing `'fields' in error` should not see one that is only there to hold `undefined`.
 */
export function apiErrorBody(code: ErrorCode, requestId: string, extras: ApiErrorExtras = {}): ApiError {
  const error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    fields?: Readonly<Record<string, string>>;
    retryAfterSeconds?: number;
  } = { code, message: ERROR_MESSAGES[code], requestId };
  if (extras.fields !== undefined && Object.keys(extras.fields).length > 0) error.fields = extras.fields;
  if (extras.retryAfterSeconds !== undefined) error.retryAfterSeconds = extras.retryAfterSeconds;
  return { error };
}

// ---------------------------------------------------------------------------
// Ajv validation failures
// ---------------------------------------------------------------------------

/** Cap on how many field messages are returned. One schema can produce dozens. */
const MAX_REPORTED_FIELDS = 12;
const MAX_FIELD_PATH_LENGTH = 64;
const MAX_FIELD_MESSAGE_LENGTH = 120;

/** Everything outside this set is dropped from a field path before it is echoed. */
const UNSAFE_PATH_CHARACTERS = /[^A-Za-z0-9_.]/g;

/**
 * The subset of an Ajv error this module reads, declared structurally so that nothing
 * here depends on Ajv's own types (Fastify owns that dependency, not us).
 */
interface AjvLikeError {
  readonly instancePath?: unknown;
  readonly keyword?: unknown;
  readonly message?: unknown;
  readonly params?: { readonly additionalProperty?: unknown; readonly missingProperty?: unknown };
}

function sanitiseSegment(raw: string): string {
  return raw.replace(UNSAFE_PATH_CHARACTERS, '').slice(0, MAX_FIELD_PATH_LENGTH);
}

/** `/opponents/0` becomes `opponents.0`; anything unexpected becomes an empty string. */
function dottedPath(instancePath: unknown): string {
  if (typeof instancePath !== 'string' || instancePath === '') return '';
  return instancePath
    .split('/')
    .map((segment) => sanitiseSegment(segment))
    .filter((segment) => segment !== '')
    .join('.')
    .slice(0, MAX_FIELD_PATH_LENGTH);
}

function fieldMessage(error: AjvLikeError): string {
  if (error.keyword === 'additionalProperties') return 'is not a field this endpoint accepts';
  if (error.keyword === 'required') return 'is required';
  const message = typeof error.message === 'string' ? error.message : 'is not valid';
  // Ajv's messages are generated from the schema, never from the submitted value, so
  // they are safe to echo. Still capped and stripped, because "safe today" is not a
  // property anyone can check on every future schema change.
  return withoutControlCharacters(message).slice(0, MAX_FIELD_MESSAGE_LENGTH);
}

function extraKeyFor(error: AjvLikeError): string {
  const candidate =
    error.keyword === 'additionalProperties'
      ? error.params?.additionalProperty
      : error.keyword === 'required'
        ? error.params?.missingProperty
        : undefined;
  return typeof candidate === 'string' ? sanitiseSegment(candidate) : '';
}

/**
 * Turns Ajv errors into `{ path: message }`.
 *
 * Paths for anything other than the body are prefixed with the request part, since
 * the contract describes the keys as paths into the body and a bare `limit` would
 * otherwise be ambiguous between a body field and a query parameter.
 */
export function fieldsFromValidation(
  validation: readonly AjvLikeError[],
  context: string | undefined,
): Readonly<Record<string, string>> {
  const prefix = context === undefined || context === 'body' ? '' : `${sanitiseSegment(context)}.`;
  const fields: Record<string, string> = {};

  for (const error of validation) {
    if (Object.keys(fields).length >= MAX_REPORTED_FIELDS) break;
    const joined = [dottedPath(error.instancePath), extraKeyFor(error)]
      .filter((part) => part !== '')
      .join('.');
    // An error with no usable path at all (a failed root-level `oneOf`, say) is
    // reported against `_`, which is not a legal field name in any of our schemas and
    // so cannot be mistaken for a real one.
    const key = `${prefix}${joined === '' ? '_' : joined}`;
    if (fields[key] === undefined) fields[key] = fieldMessage(error);
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Classifying whatever was thrown
// ---------------------------------------------------------------------------

/**
 * Fastify and plugin error codes we recognise. Anything absent is treated as a bug and
 * becomes `internal_error`, except that a 4xx status is trusted enough to map by status
 * (see `codeForStatus`) — a framework 4xx is a statement about the request, and
 * answering it with a 500 would be a lie.
 */
const FRAMEWORK_CODE_MAP: Readonly<Record<string, ErrorCode>> = {
  FST_ERR_VALIDATION: 'invalid_request',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'invalid_request',
  FST_ERR_CTP_INVALID_JSON_BODY: 'invalid_request',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'invalid_request',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'invalid_request',
  FST_ERR_CTP_BODY_TOO_LARGE: 'payload_too_large',
  FST_ERR_BAD_URL: 'invalid_request',
  FST_ERR_ASYNC_CONSTRAINT: 'invalid_request',
  // @fastify/csrf-protection. Both of its failures mean the same thing to a user: the
  // request could not be proven to come from our own page. Which of the two it was is
  // deliberately not distinguished, because that only helps someone probing the check.
  FST_CSRF_MISSING_SECRET: 'csrf_failed',
  FST_CSRF_INVALID_TOKEN: 'csrf_failed',
};

function codeForStatus(status: number): ErrorCode {
  if (status === 401) return 'not_authenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'content_not_found';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status <= 499) return 'invalid_request';
  return 'internal_error';
}

type LogLevelName = 'info' | 'warn' | 'error';

interface Classification {
  readonly code: ErrorCode;
  readonly fields?: Readonly<Record<string, string>>;
  readonly retryAfterSeconds?: number;
  readonly logLevel: LogLevelName;
}

function readValidation(
  error: unknown,
): { readonly list: readonly AjvLikeError[]; readonly context: string | undefined } | null {
  if (typeof error !== 'object' || error === null || !('validation' in error)) return null;
  const candidate: { readonly validation?: unknown; readonly validationContext?: unknown } = error;
  if (!Array.isArray(candidate.validation)) return null;
  const list = candidate.validation.filter(
    (entry: unknown): entry is AjvLikeError => typeof entry === 'object' && entry !== null,
  );
  const context = typeof candidate.validationContext === 'string' ? candidate.validationContext : undefined;
  return { list, context };
}

function numericStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return null;
  const candidate: { readonly statusCode?: unknown } = error;
  return typeof candidate.statusCode === 'number' ? candidate.statusCode : null;
}

function frameworkCode(error: unknown): ErrorCode | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const candidate: { readonly code?: unknown } = error;
  return typeof candidate.code === 'string' ? FRAMEWORK_CODE_MAP[candidate.code] : undefined;
}

function classifyAppError(error: AppError): Classification {
  const result: {
    code: ErrorCode;
    logLevel: LogLevelName;
    fields?: Readonly<Record<string, string>>;
    retryAfterSeconds?: number;
  } = {
    code: error.code,
    // A deliberate 5xx (service_unavailable, say) still deserves the loud level; a
    // validation rejection is ordinary traffic and would drown out everything else.
    logLevel: ERROR_STATUS[error.code] >= 500 ? 'error' : error.code === 'invalid_request' ? 'info' : 'warn',
  };
  if (error.fields !== undefined) result.fields = error.fields;
  if (error.retryAfterSeconds !== undefined) result.retryAfterSeconds = error.retryAfterSeconds;
  return result;
}

/** Decides what a thrown value becomes on the wire, and how loudly it is logged. */
export function classifyThrown(error: unknown): Classification {
  if (isAppError(error)) return classifyAppError(error);

  const validation = readValidation(error);
  if (validation !== null) {
    return {
      code: 'invalid_request',
      fields: fieldsFromValidation(validation.list, validation.context),
      logLevel: 'info',
    };
  }

  const mapped = frameworkCode(error);
  if (mapped !== undefined) {
    return { code: mapped, logLevel: mapped === 'invalid_request' ? 'info' : 'warn' };
  }

  const status = numericStatus(error);
  if (status !== null && status >= 400 && status <= 499) {
    return { code: codeForStatus(status), logLevel: 'warn' };
  }

  // Anything left is a bug or an unknown dependency failure: `internal_error` on the
  // wire, the whole object in the log.
  return { code: 'internal_error', logLevel: 'error' };
}

// ---------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------

/**
 * Everything leaving through an error path is `no-store`. An error body carries a
 * request id and sometimes field detail about one caller's payload; a shared cache
 * holding on to that and replaying it to somebody else is a small leak with no upside.
 */
function sendApiError(reply: FastifyReply, code: ErrorCode, requestId: string, extras: ApiErrorExtras): void {
  reply.header('cache-control', 'no-store');
  if (extras.retryAfterSeconds !== undefined) {
    reply.header('retry-after', String(extras.retryAfterSeconds));
  }
  void reply.status(ERROR_STATUS[code]).send(apiErrorBody(code, requestId, extras));
}

function logFailure(
  request: FastifyRequest,
  error: unknown,
  classification: Classification,
  frameworkStatus: number | null,
): void {
  const detail = {
    err: error,
    apiErrorCode: classification.code,
    frameworkStatus,
    method: request.method,
    // The route *pattern*, not the URL: `/api/v1/rooms/:roomId` groups cleanly in a
    // log search and cannot contain a real id or a query string.
    routePattern: request.routeOptions.url ?? null,
  };
  if (classification.logLevel === 'error') {
    request.log.error(detail, 'request failed with an unexpected error');
    return;
  }
  if (classification.logLevel === 'warn') {
    request.log.warn(detail, 'request rejected');
    return;
  }
  request.log.info(detail, 'request failed validation');
}

/**
 * The single error handler.
 *
 * Note what is absent: any path by which `error.message` reaches the response. The only
 * strings that go out are `ERROR_MESSAGES` entries and Ajv-derived field messages.
 *
 * This is also the 429 handler. `@fastify/rate-limit` is configured (in
 * `plugins/security.ts`) to build an `AppError` with `retryAfterSeconds`, throw it, and
 * let it arrive here, so the 429 body is produced by exactly the same code as every
 * other error and cannot drift from it.
 */
export function apiErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  const classification = classifyThrown(error);
  logFailure(request, error, classification, numericStatus(error));

  const extras: { fields?: Readonly<Record<string, string>>; retryAfterSeconds?: number } = {};
  if (classification.fields !== undefined) extras.fields = classification.fields;
  if (classification.retryAfterSeconds !== undefined) {
    extras.retryAfterSeconds = classification.retryAfterSeconds;
  }
  sendApiError(reply, classification.code, request.id, extras);
}

/**
 * The 404 handler.
 *
 * `content_not_found` rather than a bespoke "no such route": an unknown path and a
 * known path with an unknown id are the same answer as far as a client is concerned,
 * and a distinguishable "this route exists, that id does not" is a free map of the API
 * surface. Fastify already logs the request and its 404 response, so nothing extra is
 * logged here.
 */
export const notFoundHandler: RouteHandlerMethod = (request, reply) => {
  sendApiError(reply, 'content_not_found', request.id, {});
};

export interface ErrorHandlerOptions {
  /**
   * A rate-limit `preHandler` for the not-found route.
   *
   * `setNotFoundHandler` does not go through Fastify's `route()`, so
   * `@fastify/rate-limit`'s `onRoute` hook never sees it and the global limit does NOT
   * apply. Without this, a caller can hammer nonexistent paths for free — which is
   * exactly what a path scanner does.
   */
  readonly notFoundPreHandler?: preHandlerAsyncHookHandler;
}

/** Installs the error, 404 and (by way of the error handler) 429 responses. */
export function registerErrorHandlers(app: FastifyInstance, options: ErrorHandlerOptions = {}): void {
  app.setErrorHandler(apiErrorHandler);
  if (options.notFoundPreHandler === undefined) {
    app.setNotFoundHandler(notFoundHandler);
    return;
  }
  app.setNotFoundHandler({ preHandler: options.notFoundPreHandler }, notFoundHandler);
}

/**
 * Builds the `rate_limited` error the rate limiter throws.
 *
 * Lives here rather than inline in the security plugin so that `retryAfterSeconds` in
 * the body and the `Retry-After` header are produced from one number, in one place.
 */
export function rateLimitError(retryAfterSeconds: number): AppError {
  return new AppError('rate_limited', {
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
    logDetail: 'rate limit exceeded',
  });
}
