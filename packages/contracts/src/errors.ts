/**
 * Error codes shared by the API and the web client. Codes are the contract and messages may change.
 * A client is told less than the server knows. Auth and room-join failures never reveal whether the
 * account or room exists, so they cannot be enumerated.
 */

export const ERROR_CODES = [
  'invalid_request',
  'unsupported_protocol_version',
  'payload_too_large',

  'not_authenticated',
  'session_expired',
  'csrf_failed',
  'oidc_state_mismatch',
  'oidc_exchange_failed',
  'oidc_not_configured',
  /**
   * A foreign key to `prl.users` without a deletion rule still blocks the erasure (the state before
   * migration 0004). 409, not `internal_error`, because the transaction left the account untouched
   * and the learner is owed a truthful answer.
   */
  'account_deletion_blocked',

  'forbidden',
  'not_room_member',
  'not_your_turn',
  'not_seated',
  /**
   * The caller may see this table but no cohort entitles them to a seat. Its own code so a student
   * gets a sentence they can act on. 403 because 4xx closes the socket permanently, and no retry
   * creates an enrolment. Not 404, because the caller already knows the room exists.
   */
  'enrolment_required',

  'room_not_found_or_not_permitted',
  'room_full',
  'room_closed',
  'seat_taken',
  'invite_code_invalid',
  'already_seated',
  'insufficient_units',
  /**
   * Another API process holds the `prl.room_ownership` lease for this room. A live room exists in one
   * process's memory, so two processes would deal two different hands. 503 so `wsCloseForError` maps
   * it to the retry-with-backoff path.
   */
  'room_owned_elsewhere',

  'illegal_action',
  'stale_action_sequence',
  'hand_not_active',
  'hand_not_found',
  /**
   * The hand is the caller's but cannot be compared. It is still in progress, has no modelled
   * opponent this build can name, or cannot be replayed. `fields.hand` says which. 409, not 404.
   */
  'hand_not_comparable',
  /** Live Coach was requested at a difficulty that offers it only in review. */
  'coach_not_available',

  'content_not_found',

  'computation_rejected',
  'computation_timeout',

  'rate_limited',
  'service_unavailable',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The single error shape every failing endpoint and socket message returns. */
export interface ApiError {
  readonly error: {
    readonly code: ErrorCode;
    /** Human-readable, safe to display. Never contains internal detail. */
    readonly message: string;
    /** Field-level detail for `invalid_request` only. Keys are dotted paths into the body. */
    readonly fields?: Readonly<Record<string, string>>;
    /** Correlates a client-visible failure with a server log line, revealing nothing else. */
    readonly requestId: string;
    /** Present on `rate_limited`: seconds until the caller may retry. */
    readonly retryAfterSeconds?: number;
  };
}

/** Default HTTP status for each code, so routes cannot drift from one another. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_request: 400,
  unsupported_protocol_version: 400,
  payload_too_large: 413,

  not_authenticated: 401,
  session_expired: 401,
  csrf_failed: 403,
  oidc_state_mismatch: 400,
  oidc_exchange_failed: 502,
  oidc_not_configured: 501,
  account_deletion_blocked: 409,

  forbidden: 403,
  not_room_member: 403,
  not_your_turn: 409,
  not_seated: 409,
  // 403 so the socket close is permanent. An absent enrolment does not lift by retrying.
  enrolment_required: 403,

  // 404 even when the room exists, so private rooms cannot be enumerated.
  room_not_found_or_not_permitted: 404,
  room_full: 409,
  room_closed: 409,
  seat_taken: 409,
  invite_code_invalid: 404,
  already_seated: 409,
  insufficient_units: 409,
  // 503 so the socket close is retryable. Another process is serving this room.
  room_owned_elsewhere: 503,

  illegal_action: 422,
  stale_action_sequence: 409,
  hand_not_active: 409,
  hand_not_found: 404,
  hand_not_comparable: 409,
  coach_not_available: 409,

  content_not_found: 404,

  computation_rejected: 422,
  computation_timeout: 504,

  rate_limited: 429,
  service_unavailable: 503,
  internal_error: 500,
};

/** Messages safe to show a user. Kept here so wording is consistent everywhere. */
export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  invalid_request: 'That request was not in a shape we understand.',
  unsupported_protocol_version: 'This client is too old for the server. Reload the page.',
  payload_too_large: 'That request was too large.',

  not_authenticated: 'You need to be signed in — even as a guest — to do that.',
  session_expired: 'Your session has expired. Start a new one to continue.',
  csrf_failed: 'That request could not be verified. Reload the page and try again.',
  oidc_state_mismatch: 'The sign-in attempt could not be verified. Please start again.',
  oidc_exchange_failed: 'The identity provider could not complete sign-in. Please try again.',
  oidc_not_configured: 'Sign-in with an external account is not enabled on this server.',
  account_deletion_blocked:
    'Your account could not be deleted, and nothing was removed. This is a fault on our side, not ' +
    'something you did — please try again shortly.',

  forbidden: 'You do not have access to that.',
  not_room_member: 'You are not a member of that table.',
  not_your_turn: 'It is not your turn to act.',
  not_seated: 'You need to take a seat first.',
  enrolment_required:
    'Taking a seat at a table is part of a course, and this account is not enrolled in one that is ' +
    'running right now. The lessons, the Lab and the glossary stay open to everybody. If you think ' +
    'you should be enrolled, ask whoever enrols your class — nobody here can add you from this page.',

  room_not_found_or_not_permitted: 'No table was found for that link.',
  room_full: 'That table has no free seats.',
  room_closed: 'That table has closed.',
  seat_taken: 'Someone just took that seat.',
  invite_code_invalid: 'That invite code is not valid.',
  already_seated: 'You are already seated at that table.',
  insufficient_units: 'You do not have enough units for that table. Reset your units and try again.',
  room_owned_elsewhere:
    'That table is being looked after by another server right now. Give it a moment and try again.',

  illegal_action: 'That is not a legal action in this spot.',
  stale_action_sequence: 'The hand moved on while you were deciding. Have another look.',
  hand_not_active: 'That hand is no longer in progress.',
  hand_not_found: 'That hand could not be found.',
  hand_not_comparable: 'That hand cannot be compared against a modelled style.',
  coach_not_available:
    'The Coach is available in review after the hand, not while it is being played at this difficulty.',

  content_not_found: 'That lesson, quiz or scenario does not exist.',

  computation_rejected: 'That calculation was outside the limits we can run.',
  computation_timeout: 'That calculation took too long and was stopped.',

  rate_limited: 'You are doing that too quickly. Give it a moment.',
  service_unavailable: 'The service is temporarily unavailable. Try again shortly.',
  internal_error: 'Something went wrong on our side.',
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}
