/**
 * Error codes shared by the API and the web client.
 *
 * Codes are stable strings, not HTTP statuses and not free-text messages, so the
 * client can branch on them and the UI can say something useful. Messages are for
 * humans and may change; codes are the contract.
 *
 * What a client is told is deliberately narrower than what the server knows. An
 * authentication failure never says whether the account existed; a room join
 * failure never says whether the room exists. Anything more would let an
 * unauthenticated caller enumerate accounts or private rooms one request at a time.
 */

export const ERROR_CODES = [
  // --- request shape ---
  'invalid_request',
  'unsupported_protocol_version',
  'payload_too_large',

  // --- authentication and session ---
  'not_authenticated',
  'session_expired',
  'csrf_failed',
  'oidc_state_mismatch',
  'oidc_exchange_failed',
  'oidc_not_configured',
  /**
   * The account exists, the caller is who they say they are, and the database still refuses to
   * let the account go.
   *
   * Only one thing produces it: a foreign key referencing `prl.users` that is `ON DELETE
   * RESTRICT` or `NO ACTION`, which is the state every database was in before migration 0004 —
   * a learner who had ever created or joined a table could not be deleted at all. It is a real,
   * reachable answer rather than a defensive one: an API rolled ahead of its migration, a
   * restore of an older dump, or a later migration that adds a ninth reference without deciding
   * what an erasure does to it.
   *
   * 409 rather than 500, because nothing went wrong and nothing was half-done — the deletion
   * runs in one transaction, so the account is exactly as it was. It is deliberately NOT
   * `internal_error`: a learner asking to leave is owed a truthful answer about whether they
   * have, and "something went wrong on our side" would leave them unable to tell whether their
   * data is gone.
   */
  'account_deletion_blocked',

  // --- authorisation ---
  'forbidden',
  'not_room_member',
  'not_your_turn',
  'not_seated',
  /**
   * The caller may see this table and may not take a seat at it, because this deployment serves a
   * taught course and no cohort entitles them right now.
   *
   * ## Why it is not `forbidden`
   *
   * `forbidden` is the answer to "you do not have access to that", and a learner who reads it has
   * nowhere to go: it does not say what would change the answer, and the thing that changes this
   * answer is an operator writing a row somebody else has to ask for. So this carries its own code
   * and its own sentence — one a student can act on — and the client can branch on it to say more
   * than a generic refusal panel would. It is also not `not_room_member` (they may well be one)
   * and not `insufficient_units` (their units are irrelevant and resetting them changes nothing).
   *
   * ## Why it is 403 and NOT 5xx, unlike `room_owned_elsewhere`
   *
   * `wsCloseForError` derives the socket close code from the status, and 4xx is the branch
   * `describeClose` treats as PERMANENT while 5xx is the retry-with-backoff branch. A room held by
   * another process is genuinely a "wait and try again"; this is not. Nothing the client can do —
   * no backoff, no reconnect, no second tap on the seat — turns an absent enrolment into a present
   * one, and a client looping against that would be a defect with a metric behind it. So: 4xx,
   * hence 4403, hence `retryable: false`.
   *
   * 403 rather than 404 for the same reason `room_not_found_or_not_permitted` is a 404: the two
   * codes exist to hide different things, and there is nothing to hide here. The caller has
   * already been told the room exists (they are a member of it), so answering "no such thing"
   * would be a lie that costs the reader the explanation and buys nothing.
   *
   * Deliberately says nothing about money, and there is nothing it could say: a scholarship
   * enrolment and any other kind are identical rows (`db/migrations/0006_cohort_enrolments.sql`),
   * this schema holds no amount and no currency, and this software cannot take money. The honest
   * instruction is "ask whoever enrolled your class", which is what the message gives.
   */
  'enrolment_required',

  // --- rooms ---
  'room_not_found_or_not_permitted',
  'room_full',
  'room_closed',
  'seat_taken',
  'invite_code_invalid',
  'already_seated',
  'insufficient_units',
  /**
   * Another API process is authoritative for this room, and this one refused to serve it.
   *
   * A room being played lives in ONE process's memory — the deck, the salts and the pot have no
   * column and never will — so two processes serving one room deal two different hands and the
   * second settlement to land destroys the chips the first paid out. `prl.room_ownership` makes
   * that an enforced lease rather than a comment beside `deploy.replicas: 1`, and this is what a
   * process answers when it is refused the lease.
   *
   * Its own code rather than `seat_taken` (which is an ordinary race between two learners and must
   * never page anybody) and rather than `internal_error` (nothing broke — the guard worked, and a
   * 500 would send the reader a bug report form for a configuration mistake).
   *
   * 503 rather than 409, and the reason is what the client then does: `wsCloseForError` maps 5xx to
   * `serverShuttingDown`, which is the retry-with-backoff path, while 4xx maps to a permanent
   * refusal that tells the reader the table is not theirs. It is not theirs to give up on — it is
   * being served, somewhere — so the honest instruction to the client is "wait and try again",
   * which is also what resolves it when a deploy's containers stop overlapping.
   */
  'room_owned_elsewhere',

  // --- gameplay ---
  'illegal_action',
  'stale_action_sequence',
  'hand_not_active',
  'hand_not_found',
  /**
   * The hand exists and is the caller's, and a comparison of it cannot be built.
   *
   * Distinct from `hand_not_found` because it is a different answer to a different question, and
   * collapsing the two would make the Legends hand-review screen say "no such hand" about a hand
   * the reader can see in their own history. The three cases are: the hand is still in progress
   * (a comparison discloses what each seat could see, so it is post-hand only), no seat in it was
   * a modelled opponent this build can name, and the stored rows cannot be replayed into the
   * views the seats acted on. `fields.hand` carries which.
   *
   * 409 rather than 404: the resource is there, its state is wrong for this representation.
   */
  'hand_not_comparable',
  /**
   * Live Coach was asked for at a table whose difficulty turns it off during the hand.
   *
   * Expert Legends advertises "Coach in review only". The socket used to ignore that flag and
   * answer anyway. 409: the table is there, this representation of it is not offered while the
   * hand is in progress.
   */
  'coach_not_available',

  // --- content ---
  'content_not_found',

  // --- computation ---
  'computation_rejected',
  'computation_timeout',

  // --- infrastructure ---
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
    /**
     * Field-level detail for `invalid_request` only. Keys are dotted paths into
     * the request body.
     */
    readonly fields?: Readonly<Record<string, string>>;
    /**
     * Correlates a client-visible failure with a server log line, without
     * exposing anything about the failure itself.
     */
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
  // 403, and the choice is load-bearing rather than a default. See the code's own note: 4xx is the
  // PERMANENT branch of `wsCloseForError`, and an absent enrolment is permanent until an operator
  // acts. A 5xx here would map to 4503 and put an honest client into a reconnect loop against a
  // refusal that will never lift on its own — the opposite of `room_owned_elsewhere`, which is
  // 503 precisely because waiting IS the fix there.
  enrolment_required: 403,

  // 404 on purpose, even when the room exists: a distinguishable "exists but you
  // may not see it" response would let anyone enumerate private rooms.
  room_not_found_or_not_permitted: 404,
  room_full: 409,
  room_closed: 409,
  seat_taken: 409,
  invite_code_invalid: 404,
  already_seated: 409,
  insufficient_units: 409,
  // 503, not 409. See the code's own note: 5xx is the retryable branch of `wsCloseForError`, and
  // a room held by another process is a "try again", not a "this is not yours".
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
