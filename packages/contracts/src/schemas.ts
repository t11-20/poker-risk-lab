/**
 * JSON Schemas for every request body, query string and WebSocket message, compiled by Fastify's Ajv
 * at startup. Every schema sets `additionalProperties: false` to stop mass assignment. Every string has
 * a `maxLength` and every number a range, so no input is unbounded.
 */

import { ACCOUNT_DELETE_CONFIRMATION } from './api-types.ts';

const CARD_PATTERN = '^(?:10|[2-9TJQKAtjqka])[cdhsCDHS]$';
const CARDS_PATTERN = '^\\s*(?:(?:10|[2-9TJQKAtjqka])[cdhsCDHS]\\s*,?\\s*)+$';
/** Range notation, exact cards, or "top:NN". Parsed strictly downstream. */
const RANGE_PATTERN = '^(?:top:(?:100|[1-9][0-9]?)|[0-9TJQKAtjqka2-9scdhoSCDHO ,+%\\-]{2,120})$';
const ID_PATTERN = '^[a-z0-9][a-z0-9_-]{0,63}$';
const CONTENT_ID_PATTERN = '^[a-z0-9][a-z0-9-]{0,79}$';
/** A UUID or an opaque client-generated token of bounded length. */
const REQUEST_ID_PATTERN = '^[A-Za-z0-9_-]{8,64}$';

const DISPLAY_NAME_SCHEMA = {
  type: 'string',
  minLength: 2,
  maxLength: 24,
  // Excludes control, bidi-override and zero-width characters, which impersonate players or break logs.
  pattern: "^[A-Za-z0-9][A-Za-z0-9 '._-]{0,22}[A-Za-z0-9]$",
} as const;

const CARDS_SCHEMA = { type: 'string', minLength: 2, maxLength: 24, pattern: CARDS_PATTERN } as const;
const OPTIONAL_BOARD_SCHEMA = { type: 'string', maxLength: 24, pattern: `${CARDS_PATTERN}|^$` } as const;

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
    // A path only, never a full URL, so the sign-in flow cannot be an open redirect.
    redirectAfter: { type: 'string', maxLength: 256, pattern: '^/(?![/\\\\])[A-Za-z0-9/_\\-?=&.]*$' },
  },
} as const;

/**
 * The body of `POST /me/delete`. `const` rather than a boolean, so a mis-wired client, replay or double
 * submit cannot erase an account. `maxLength` refuses a huge body before the comparison. CSRF and the
 * session cookie are the other defences.
 */
export const deleteAccountBodySchema = {
  $id: 'prl:deleteAccountBody',
  type: 'object',
  additionalProperties: false,
  required: ['confirm'],
  properties: {
    confirm: { type: 'string', minLength: 1, maxLength: 64, const: ACCOUNT_DELETE_CONFIRMATION },
  },
} as const;

/**
 * The authorization-code callback's query string. Unknown parameters are a 400, so the extra parameters
 * that real providers send are listed here (Google `scope`/`authuser`/`prompt`/`hd`, Keycloak
 * `session_state`, Microsoft `client_info`, RFC 9207 `iss`). Add a new one deliberately.
 * `routes/auth.ts` checks `iss` against the configured issuer to stop code mix-up between providers.
 */
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
    /** RFC 9207. Checked against the configured issuer. */
    iss: { type: 'string', maxLength: 512 },
    /** Informational. Read by nothing here. */
    scope: { type: 'string', maxLength: 512 },
    session_state: { type: 'string', maxLength: 256 },
    authuser: { type: 'string', maxLength: 32 },
    prompt: { type: 'string', maxLength: 64 },
    hd: { type: 'string', maxLength: 256 },
    client_info: { type: 'string', maxLength: 2048 },
  },
} as const;

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

/** The body of `POST /content/lessons/:id/read`. No timestamp, because the server stamps `now()`. */
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

/** Opponent and sample counts are capped, because Monte Carlo can otherwise consume unbounded CPU. */
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
    // Generated server-side. Bounded so brute force is a rate-limit problem, not a parsing one.
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

export const handIdParamsSchema = {
  $id: 'prl:handIdParams',
  type: 'object',
  additionalProperties: false,
  required: ['handId'],
  properties: { handId: { type: 'string', pattern: ID_PATTERN } },
} as const;

/**
 * The orderings `GET /hands` applies. `apps/api/src/routes/hands.ts` maps each name to a fixed
 * `order by` clause, so nothing is interpolated into SQL. Each is a total order over the whole history,
 * not one page. An unsettled hand has no net or pot and sorts last, not as zero.
 */
export const HAND_SORTS = ['recent', 'oldest', 'net-high', 'net-low', 'pot-high'] as const;

export type HandSort = (typeof HAND_SORTS)[number];

/** The default when the caller does not ask. */
export const DEFAULT_HAND_SORT: HandSort = 'recent';

export const handListQuerySchema = {
  $id: 'prl:handListQuery',
  type: 'object',
  additionalProperties: false,
  properties: {
    roomId: { type: 'string', pattern: ID_PATTERN },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    // A cursor carries its ordering and key value, so it cannot be replayed against another `sort`.
    cursor: { type: 'string', maxLength: 160, pattern: '^[A-Za-z0-9_:.-]{1,160}$' },
    sort: { type: 'string', enum: [...HAND_SORTS] },
  },
} as const;

const REQUEST_ID_SCHEMA = { type: 'string', pattern: REQUEST_ID_PATTERN } as const;

/** One discriminated schema for every inbound socket frame, checked before the router sees it. */
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

export const ALL_SCHEMAS = [
  createGuestBodySchema,
  oidcStartQuerySchema,
  deleteAccountBodySchema,
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

export const PATTERNS = {
  CARD: CARD_PATTERN,
  CARDS: CARDS_PATTERN,
  RANGE: RANGE_PATTERN,
  ID: ID_PATTERN,
  CONTENT_ID: CONTENT_ID_PATTERN,
  REQUEST_ID: REQUEST_ID_PATTERN,
  DISPLAY_NAME: DISPLAY_NAME_SCHEMA.pattern,
} as const;
