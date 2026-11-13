/**
 * Every failure leaves through the handler here as the contract `ApiError`, with the status from
 * `ERROR_STATUS` and the wording from `ERROR_MESSAGES`. The client gets a code and a request id,
 * never a stack, SQL or `error.message`. The one exception is `invalid_request` field messages,
 * derived from the client's own payload, with paths sanitised and capped. Framework statuses
 * are normalised to the contract, and the original goes to the log.
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
import { recordApiError } from './observability/metrics.ts';

export interface AppErrorDetail {
  /** Only meaningful for `invalid_request`. */
  readonly fields?: Readonly<Record<string, string>>;
  /** For `rate_limited`, and `service_unavailable` from the feature gate in `app.ts`. */
  readonly retryAfterSeconds?: number;
  /** Server-side only. Never sent to a client. */
  readonly logDetail?: string;
  readonly cause?: unknown;
}

/** Throw this for a deliberate failure. Anything else becomes `internal_error`, logged loudly. */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ErrorCode;
  readonly fields?: Readonly<Record<string, string>>;
  readonly retryAfterSeconds?: number;
  readonly logDetail?: string;

  constructor(code: ErrorCode, detail: AppErrorDetail = {}) {
    // For logs only. The client sees ERROR_MESSAGES[code].
    super(detail.logDetail ?? code, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.code = code;
    if (detail.fields !== undefined) this.fields = detail.fields;
    if (detail.retryAfterSeconds !== undefined) this.retryAfterSeconds = detail.retryAfterSeconds;
    if (detail.logDetail !== undefined) this.logDetail = detail.logDetail;
  }

  get statusCode(): number {
    return ERROR_STATUS[this.code];
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

interface ApiErrorExtras {
  readonly fields?: Readonly<Record<string, string>>;
  readonly retryAfterSeconds?: number;
}

/** Field by field, because under `exactOptionalPropertyTypes` an optional member must be absent. */
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

const MAX_REPORTED_FIELDS = 12;
const MAX_FIELD_PATH_LENGTH = 64;
const MAX_FIELD_MESSAGE_LENGTH = 120;

const UNSAFE_PATH_CHARACTERS = /[^A-Za-z0-9_.]/g;

/** Structural, so nothing here depends on Ajv's types. */
interface AjvLikeError {
  readonly instancePath?: unknown;
  readonly keyword?: unknown;
  readonly message?: unknown;
  readonly params?: { readonly additionalProperty?: unknown; readonly missingProperty?: unknown };
}

function sanitiseSegment(raw: string): string {
  return raw.replace(UNSAFE_PATH_CHARACTERS, '').slice(0, MAX_FIELD_PATH_LENGTH);
}

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
  // Generated from the schema, not the value. Still capped and stripped against future schemas.
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

/** Non-body paths are prefixed with their request part, so `limit` is not mistaken for a body field. */
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
    // `_` is not a legal field name in any schema, so it cannot be mistaken for one.
    const key = `${prefix}${joined === '' ? '_' : joined}`;
    if (fields[key] === undefined) fields[key] = fieldMessage(error);
  }

  return fields;
}

/** Unlisted codes are bugs, except a framework 4xx, which maps by status (`codeForStatus`). */
const FRAMEWORK_CODE_MAP: Readonly<Record<string, ErrorCode>> = {
  FST_ERR_VALIDATION: 'invalid_request',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'invalid_request',
  FST_ERR_CTP_INVALID_JSON_BODY: 'invalid_request',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'invalid_request',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'invalid_request',
  FST_ERR_CTP_BODY_TOO_LARGE: 'payload_too_large',
  FST_ERR_BAD_URL: 'invalid_request',
  FST_ERR_ASYNC_CONSTRAINT: 'invalid_request',
  // Not distinguished, because which CSRF check failed only helps a prober.
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
    // Validation rejections are ordinary traffic and would drown out everything else.
    logLevel: ERROR_STATUS[error.code] >= 500 ? 'error' : error.code === 'invalid_request' ? 'info' : 'warn',
  };
  if (error.fields !== undefined) result.fields = error.fields;
  if (error.retryAfterSeconds !== undefined) result.retryAfterSeconds = error.retryAfterSeconds;
  return result;
}

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

  return { code: 'internal_error', logLevel: 'error' };
}

/** `no-store`, so a shared cache never replays one caller's error body to another. */
function sendApiError(reply: FastifyReply, code: ErrorCode, requestId: string, extras: ApiErrorExtras): void {
  // Counted here, the one exit every contract error takes, because the status alone cannot
  // separate `not_room_member` from `room_full`.
  recordApiError(code);
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
    // The pattern, so it cannot contain a real id or a query string.
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
 * No path lets `error.message` reach the response. Also the 429 handler, since
 * `plugins/security.ts` makes the rate limiter throw an `AppError` that lands here.
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

/** `content_not_found`, the same answer as an unknown id, so the API surface cannot be mapped. */
export const notFoundHandler: RouteHandlerMethod = (request, reply) => {
  sendApiError(reply, 'content_not_found', request.id, {});
};

export interface ErrorHandlerOptions {
  /**
   * `setNotFoundHandler` bypasses `route()`, so the global rate limit never applies to unknown
   * paths. A CSRF failure is refused before this runs and is counted in `plugins/security.ts`.
   */
  readonly notFoundPreHandler?: preHandlerAsyncHookHandler;
}

export function registerErrorHandlers(app: FastifyInstance, options: ErrorHandlerOptions = {}): void {
  app.setErrorHandler(apiErrorHandler);
  if (options.notFoundPreHandler === undefined) {
    app.setNotFoundHandler(notFoundHandler);
    return;
  }
  app.setNotFoundHandler({ preHandler: options.notFoundPreHandler }, notFoundHandler);
}

/** Here so the body's `retryAfterSeconds` and the `Retry-After` header come from one number. */
export function rateLimitError(retryAfterSeconds: number): AppError {
  return new AppError('rate_limited', {
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
    logDetail: 'rate limit exceeded',
  });
}
