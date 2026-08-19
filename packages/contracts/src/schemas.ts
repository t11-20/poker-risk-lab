/**
 * JSON Schemas for every request body, query string and WebSocket message.
 *
 * ## Why plain JSON Schema and not a validation library
 *
 * Fastify already carries Ajv and compiles route schemas at startup, so these
 * schemas cost nothing extra and validate at the framework boundary rather than
 * inside a handler that might forget to call a parser. Adding zod (or similar) would
 * mean a second validator, a second set of rules to keep in step with these, and one
 * more dependency in a repo whose policy is to minimise them.
 *
 * ## Every schema is closed
 *
 * `additionalProperties: false` everywhere. An open schema silently accepts unknown
 * fields, which is how mass-assignment bugs happen: a client sends `{"units": 999999}`
 * to an endpoint that spreads the body into a record, and the field it was never
 * meant to control gets written.
 *
 * ## Bounds are real limits, not documentation
 *
 * Every string has a `maxLength` and every number a `minimum`/`maximum`. Unbounded
 * inputs are how a request turns into a denial of service — a 50 MB display name, a
 * Monte Carlo request for 10^12 samples, a board with a thousand cards.
 */

const CARD_PATTERN = '^(?:10|[2-9TJQKAtjqka])[cdhsCDHS]$';
const CARDS_PATTERN = '^\\s*(?:(?:10|[2-9TJQKAtjqka])[cdhsCDHS]\\s*,?\\s*)+$';
/** Range notation, exact cards, or "top:NN". Parsed strictly downstream. */
const RANGE_PATTERN = '^(?:top:(?:100|[1-9][0-9]?)|[0-9TJQKAtjqka2-9scdhoSCDHO ,+%\\-]{2,120})$';
const ID_PATTERN = '^[a-z0-9][a-z0-9_-]{0,63}$';
const CONTENT_ID_PATTERN = '^[a-z0-9][a-z0-9-]{0,79}$';
/** A UUID or an opaque client-generated token of bounded length. */
const REQUEST_ID_PATTERN = '^[A-Za-z0-9_-]{8,64}$';

/** Display names: printable, no control characters, no leading/trailing space. */
const DISPLAY_NAME_SCHEMA = {
  type: 'string',
  minLength: 2,
  maxLength: 24,
  // Letters, digits, space, and a small punctuation set. Excludes control
  // characters, bidi overrides and zero-width characters, which are how a name is
  // used to impersonate another player or to break a log line.
  pattern: "^[A-Za-z0-9][A-Za-z0-9 '._-]{0,22}[A-Za-z0-9]$",
} as const;

const CARDS_SCHEMA = { type: 'string', minLength: 2, maxLength: 24, pattern: CARDS_PATTERN } as const;
const OPTIONAL_BOARD_SCHEMA = { type: 'string', maxLength: 24, pattern: `${CARDS_PATTERN}|^$` } as const;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const createGuestBodySchema = {
  $id: 'prl:createGuestBody',
  type: 'object',
  additionalProperties: false,
  properties: { displayName: DISPLAY_NAME_SCHEMA },
} as const;

export const oidcStartQuerySchema = {
  $id: 'prl:oidcStartQuery',
  type: 'object',
  additionalProperties: false,
  properties: {
    // Only a path is accepted, never a full URL: an absolute redirect target is an
    // open-redirect vulnerability, and the sign-in flow is exactly where it gets
    // used to phish.
    redirectAfter: { type: 'string', maxLength: 256, pattern: '^/(?![/\\\\])[A-Za-z0-9/_\\-?=&.]*$' },
  },
} as const;

export const oidcCallbackQuerySchema = {
  $id: 'prl:oidcCallbackQuery',
  type: 'object',
  additionalProperties: false,
  required: ['state'],
  properties: {
    code: { type: 'string', minLength: 1, maxLength: 2048 },
    state: { type: 'string', minLength: 8, maxLength: 256 },
    error: { type: 'string', maxLength: 256 },
    error_description: { type: 'string', maxLength: 512 },
  },
} as const;

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export const contentIdParamsSchema = {
  $id: 'prl:contentIdParams',
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', pattern: CONTENT_ID_PATTERN } },
} as const;

export const quizAttemptBodySchema = {
  $id: 'prl:quizAttemptBody',
  type: 'object',
  additionalProperties: false,
  required: ['questionId', 'answer'],
  properties: {
    questionId: { type: 'string', pattern: CONTENT_ID_PATTERN },
    answer: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['choice', 'number', 'action'] },
        index: { type: 'integer', minimum: 0, maximum: 9 },
        value: { type: 'number', minimum: -1e9, maximum: 1e9 },
        action: { type: 'string', enum: ['fold', 'check', 'call', 'bet', 'raise'] },
      },
    },
  },
} as const;

/**
 * The body of `POST /content/lessons/:id/read`.
 *
 * `additionalProperties: false` and a single required boolean: there is nothing else a client may
 * say about a read, and in particular no timestamp — the server stamps `now()` so a fleet with
 * drifting clocks cannot record a lesson as read before it existed.
 */
export const lessonReadBodySchema = {
  $id: 'prl:lessonReadBody',
  type: 'object',
  additionalProperties: false,
  required: ['completed'],
  properties: { completed: { type: 'boolean' } },
} as const;

export const scenarioAttemptBodySchema = {
  $id: 'prl:scenarioAttemptBody',
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['fold', 'check', 'call', 'bet', 'raise'] },
    to: { type: 'integer', minimum: 0, maximum: 1_000_000 },
  },
} as const;

// ---------------------------------------------------------------------------
// Calculation
// ---------------------------------------------------------------------------

/**
 * Opponent count and sample count are both capped. Monte Carlo is the one endpoint
 * where a single small request can consume unbounded CPU, so the ceiling is part of
 * the schema rather than a check somewhere in the handler.
 */
export const equityBodySchema = {
  $id: 'prl:equityBody',
  type: 'object',
  additionalProperties: false,
  required: ['heroCards', 'opponents'],
  properties: {
    heroCards: CARDS_SCHEMA,
    board: OPTIONAL_BOARD_SCHEMA,
    opponents: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: { type: 'string', minLength: 2, maxLength: 120, pattern: RANGE_PATTERN },
    },
    samples: { type: 'integer', minimum: 1_000, maximum: 500_000 },
  },
} as const;

export const coachBodySchema = {
  $id: 'prl:coachBody',
  type: 'object',
  additionalProperties: false,
  required: ['heroCards', 'opponents', 'pot', 'toCall', 'heroStack', 'bigBlind', 'street'],
  properties: {
    heroCards: CARDS_SCHEMA,
    board: OPTIONAL_BOARD_SCHEMA,
    opponents: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: { type: 'string', minLength: 2, maxLength: 120, pattern: RANGE_PATTERN },
    },
    pot: { type: 'integer', minimum: 0, maximum: 10_000_000 },
    toCall: { type: 'integer', minimum: 0, maximum: 10_000_000 },
    heroStack: { type: 'integer', minimum: 0, maximum: 10_000_000 },
    opponentStacks: {
      type: 'array',
      maxItems: 5,
      items: { type: 'integer', minimum: 0, maximum: 10_000_000 },
    },
    bigBlind: { type: 'integer', minimum: 1, maximum: 100_000 },
    street: { type: 'string', enum: ['preflop', 'flop', 'turn', 'river'] },
  },
} as const;

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export const createRoomBodySchema = {
  $id: 'prl:createRoomBody',
  type: 'object',
  additionalProperties: false,
  required: ['name', 'maxSeats', 'smallBlind', 'bigBlind', 'startingStack'],
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 40,
      pattern: "^[A-Za-z0-9][A-Za-z0-9 '._-]{0,38}[A-Za-z0-9]$|^[A-Za-z0-9]$",
    },
    maxSeats: { type: 'integer', minimum: 2, maximum: 6 },
    smallBlind: { type: 'integer', minimum: 1, maximum: 10_000 },
    bigBlind: { type: 'integer', minimum: 1, maximum: 20_000 },
    ante: { type: 'integer', minimum: 0, maximum: 10_000 },
    startingStack: { type: 'integer', minimum: 2, maximum: 1_000_000 },
    actionTimeoutSeconds: { type: 'integer', minimum: 5, maximum: 120 },
    bots: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['profile', 'count'],
        properties: {
          profile: {
            type: 'string',
            enum: ['nit', 'tight-aggressive', 'loose-aggressive', 'calling-station', 'maniac'],
          },
          count: { type: 'integer', minimum: 1, maximum: 5 },
        },
      },
    },
  },
} as const;

export const joinRoomBodySchema = {
  $id: 'prl:joinRoomBody',
  type: 'object',
  additionalProperties: false,
  required: ['inviteCode'],
  properties: {
    // Base32-ish, generated server-side. Bounded so a brute-force attempt is a
    // rate-limit problem rather than a parsing problem.
    inviteCode: { type: 'string', minLength: 8, maxLength: 32, pattern: '^[A-Za-z0-9-]{8,32}$' },
  },
} as const;

export const roomIdParamsSchema = {
  $id: 'prl:roomIdParams',
  type: 'object',
  additionalProperties: false,
  required: ['roomId'],
  properties: { roomId: { type: 'string', pattern: ID_PATTERN } },
} as const;

export const sitBodySchema = {
  $id: 'prl:sitBody',
  type: 'object',
  additionalProperties: false,
  required: ['seat'],
  properties: { seat: { type: 'integer', minimum: 0, maximum: 5 } },
} as const;

// ---------------------------------------------------------------------------
// Hands
// ---------------------------------------------------------------------------

export const handIdParamsSchema = {
  $id: 'prl:handIdParams',
  type: 'object',
  additionalProperties: false,
  required: ['handId'],
  properties: { handId: { type: 'string', pattern: ID_PATTERN } },
} as const;

/**
 * The orderings `GET /hands` will apply, as an enum rather than a free string.
 *
 * This list is the whitelist. `apps/api/src/routes/hands.ts` maps each name to a fixed
 * `order by` clause written out in full — no column name and no direction is ever
 * interpolated into SQL — and the `Readonly<Record<HandSort, …>>` annotation on that table
 * means a name added here without a clause does not compile.
 *
 * Every entry is a total order over the whole history, not a re-sort of one page: `net-high`
 * means "the biggest gain in everything you have played", which is a different row from "the
 * biggest gain on this page". That distinction is why the ordering has to be a server
 * parameter at all — a client that sorted the six rows it was handed would print a heading it
 * could not honour.
 *
 * An unsettled hand has no net and no pot, and sorts last in every ordering that names one
 * rather than being treated as zero. Zero is a result; null is the absence of one.
 */
export const HAND_SORTS = ['recent', 'oldest', 'net-high', 'net-low', 'pot-high'] as const;

export type HandSort = (typeof HAND_SORTS)[number];

/** The default when the caller does not ask. Matches the pre-`sort` behaviour of the route. */
export const DEFAULT_HAND_SORT: HandSort = 'recent';

export const handListQuerySchema = {
  $id: 'prl:handListQuery',
  type: 'object',
  additionalProperties: false,
  properties: {
    roomId: { type: 'string', pattern: ID_PATTERN },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    // Longer than the 128 it was: a cursor now carries the ordering it was issued for and
    // that ordering's key value, so a stale cursor cannot be replayed against a different
    // `sort`. It is still opaque to a client, which hands it back unchanged.
    cursor: { type: 'string', maxLength: 160, pattern: '^[A-Za-z0-9_:.-]{1,160}$' },
    sort: { type: 'string', enum: [...HAND_SORTS] },
  },
} as const;

// ---------------------------------------------------------------------------
// WebSocket messages
// ---------------------------------------------------------------------------

const REQUEST_ID_SCHEMA = { type: 'string', pattern: REQUEST_ID_PATTERN } as const;

/**
 * One discriminated schema for every inbound socket frame. Validated before the
 * router looks at the message, so a handler never sees a malformed frame.
 */
export const wsClientMessageSchema = {
  $id: 'prl:wsClientMessage',
  type: 'object',
  required: ['type'],
  discriminator: { propertyName: 'type' },
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'protocolVersion', 'roomId', 'clientNonce'],
      properties: {
        type: { const: 'hello' },
        protocolVersion: { type: 'integer', minimum: 1, maximum: 1000 },
        roomId: { type: 'string', pattern: ID_PATTERN },
        clientNonce: REQUEST_ID_SCHEMA,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'seat', 'requestId'],
      properties: {
        type: { const: 'sit' },
        seat: { type: 'integer', minimum: 0, maximum: 5 },
        requestId: REQUEST_ID_SCHEMA,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'requestId'],
      properties: { type: { const: 'stand' }, requestId: REQUEST_ID_SCHEMA },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'actionId', 'expectedSequence', 'action', 'requestId'],
      properties: {
        type: { const: 'action' },
        actionId: REQUEST_ID_SCHEMA,
        expectedSequence: { type: 'integer', minimum: 0, maximum: 100_000 },
        requestId: REQUEST_ID_SCHEMA,
        action: {
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: {
            type: { type: 'string', enum: ['fold', 'check', 'call', 'bet', 'raise'] },
            to: { type: 'integer', minimum: 0, maximum: 10_000_000 },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'requestId'],
      properties: {
        type: { const: 'requestCoach' },
        requestId: REQUEST_ID_SCHEMA,
        opponentRange: { type: 'string', minLength: 2, maxLength: 120, pattern: RANGE_PATTERN },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'requestId'],
      properties: { type: { const: 'startHand' }, requestId: REQUEST_ID_SCHEMA },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'nonce'],
      properties: { type: { const: 'ping' }, nonce: REQUEST_ID_SCHEMA },
    },
  ],
} as const;

/** Every schema, for one-shot registration with Ajv/Fastify at startup. */
export const ALL_SCHEMAS = [
  createGuestBodySchema,
  oidcStartQuerySchema,
  oidcCallbackQuerySchema,
  contentIdParamsSchema,
  quizAttemptBodySchema,
  lessonReadBodySchema,
  scenarioAttemptBodySchema,
  equityBodySchema,
  coachBodySchema,
  createRoomBodySchema,
  joinRoomBodySchema,
  roomIdParamsSchema,
  sitBodySchema,
  handIdParamsSchema,
  handListQuerySchema,
  wsClientMessageSchema,
] as const;

/** Exported so tests can assert the patterns behave as intended. */
export const PATTERNS = {
  CARD: CARD_PATTERN,
  CARDS: CARDS_PATTERN,
  RANGE: RANGE_PATTERN,
  ID: ID_PATTERN,
  CONTENT_ID: CONTENT_ID_PATTERN,
  REQUEST_ID: REQUEST_ID_PATTERN,
  DISPLAY_NAME: DISPLAY_NAME_SCHEMA.pattern,
} as const;
