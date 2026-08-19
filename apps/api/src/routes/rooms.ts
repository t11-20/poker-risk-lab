/**
 * Rooms and the "Play a Legend" endpoints.
 *
 * A thin HTTP layer. Every decision that matters — who may see a room, who may sit, what a table
 * does next — belongs to `src/rooms/registry.ts` and the engine, so that the socket transport and
 * this one cannot drift: `POST /rooms/:roomId/sit` and a `sit` frame run the same method.
 *
 * ## The invite code is returned exactly once
 *
 * `POST /rooms` is the only response in this API that carries one. Only `sha256(code)` is stored
 * (`rooms.invite_code_hash`), so it cannot be recovered later — the owner shares it now or creates
 * another room. `logging.ts` censors `inviteCode` and anything matching `/invite/i`, which is why
 * it may pass through this file at all.
 *
 * ## One answer for "no such room" and "not your room"
 *
 * Every room endpoint answers `room_not_found_or_not_permitted` for both. A distinguishable "it
 * exists but you may not see it" is a free way to confirm a room id, and room ids appear in links
 * people share.
 *
 * ## The Legends endpoints always return the full disclosure
 *
 * `ProfileDisclosureDto.disclaimers` is a required, non-empty array, and every response here goes
 * through `profileDisclosure()` — the one function that produces a display name — so there is no
 * path that returns a profile's name without the framing that says it is an educational simulation
 * and not a real person. `resolveNamingMode()` decides which name is shown, and its default is
 * `archetype`: the safe mode is the one a deployer gets by not thinking about it.
 *
 * ## `deterministicSeed` seeds the opponents, not the deal
 *
 * `CreateLegendMatchRequest.deterministicSeed` asks for a reproducible session. It is honoured for
 * the part that can be: each bot's decision stream. It is deliberately NOT used for dealing — cards
 * come from `createSecureRandom()` on every table, every hand records `randomSourceKind: 'csprng'`,
 * and the deterministic generator is a test-and-teaching tool the server must not be able to reach
 * (see the note in `@prl/poker-engine`'s `rng.ts`). So the same seed reproduces how the profiles
 * play, not which cards arrive.
 */

import { scenarioById } from '@prl/content';
import type {
  CompareProfilesResponse,
  CreateLegendMatchResponse,
  CreateRoomRequest,
  CreateRoomResponse,
  JoinRoomRequest,
  JoinRoomResponse,
  LearnFromProfileResponse,
  LegendDifficulty,
  LegendDifficultyDto,
  LegendProfileCardDto,
  LegendProfilesResponse,
  RoomListResponse,
  RoomSummary,
  SitRequest,
} from '@prl/contracts';
import { PATTERNS } from '@prl/contracts';
import {
  biggestTraitDifferences,
  DIFFICULTIES,
  DIFFICULTY_SETTINGS,
  learnFromSummary,
  PROFILES,
  profileCard,
  profileDisclosure,
  radarAxes,
  requireProfile,
  resolveNamingMode,
  UNIVERSAL_DISCLAIMER,
} from '@prl/poker-ai';
import { parseCards } from '@prl/poker-engine';
import type { FastifyPluginAsync } from 'fastify';
import { requireSession, type SessionStore, sessionPlugin } from '../auth/session.ts';
import { getSql } from '../db.ts';
import { AppError } from '../errors.ts';
import { durableProfile } from '../rooms/bot-profile.ts';
import {
  botDisplayName,
  compareProfilesOnSpot,
  type HypotheticalSpot,
  MAX_COMPARE_TRIALS,
  planLegendSeats,
  resolveProfile,
  seedFor,
} from '../rooms/bots.ts';
import {
  type LiveRoom,
  type RoomPrincipal,
  type RoomRegistry,
  roomRegistry,
  summaryFromRows,
  toRoomSummary,
} from '../rooms/registry.ts';
import { createAuthStore } from './auth.ts';
import { registerLegendStatsRoute } from './legends.ts';

// ---------------------------------------------------------------------------
// Local schemas
// ---------------------------------------------------------------------------

/**
 * Schemas for the endpoints `@prl/contracts` does not carry one for.
 *
 * The Legends request bodies have wire *types* in `legends.ts` but no JSON Schema, so these are
 * written here, closed and bounded like every schema in the contract package. They are passed as
 * objects rather than registered with an `$id`, because a schema that only one route uses does not
 * need to be addressable — and adding an `$id` here would put a second definition of the contract
 * in a place nobody looking for the contract would find.
 */
const PROFILE_ID_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['profileId'],
  properties: { profileId: { type: 'string', maxLength: 64, pattern: PATTERNS.ID } },
} as const;

const DIFFICULTY_SCHEMA = { type: 'string', enum: [...DIFFICULTIES] } as const;

const PROFILE_IDS_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: 5,
  items: { type: 'string', maxLength: 64, pattern: PATTERNS.ID },
} as const;

const LEGEND_MATCH_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['profileIds', 'difficulty', 'startingStack', 'smallBlind', 'bigBlind'],
  properties: {
    profileIds: PROFILE_IDS_SCHEMA,
    difficulty: DIFFICULTY_SCHEMA,
    startingStack: { type: 'integer', minimum: 2, maximum: 1_000_000 },
    smallBlind: { type: 'integer', minimum: 1, maximum: 10_000 },
    bigBlind: { type: 'integer', minimum: 2, maximum: 20_000 },
    ante: { type: 'integer', minimum: 0, maximum: 10_000 },
    deterministicSeed: { type: 'integer', minimum: 0, maximum: 2_147_483_647 },
  },
} as const;

const CARDS_PATTERN = PATTERNS.CARDS;

const COMPARE_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['profileIds', 'difficulty'],
  properties: {
    scenarioId: { type: 'string', maxLength: 80, pattern: PATTERNS.CONTENT_ID },
    situation: {
      type: 'object',
      additionalProperties: false,
      required: ['heroCards', 'pot', 'toCall', 'heroStack', 'opponentStack', 'bigBlind', 'street'],
      properties: {
        heroCards: { type: 'string', minLength: 2, maxLength: 24, pattern: CARDS_PATTERN },
        board: { type: 'string', maxLength: 24, pattern: `${CARDS_PATTERN}|^$` },
        pot: { type: 'integer', minimum: 0, maximum: 10_000_000 },
        toCall: { type: 'integer', minimum: 0, maximum: 10_000_000 },
        heroStack: { type: 'integer', minimum: 0, maximum: 10_000_000 },
        opponentStack: { type: 'integer', minimum: 0, maximum: 10_000_000 },
        bigBlind: { type: 'integer', minimum: 1, maximum: 100_000 },
        street: { type: 'string', enum: ['preflop', 'flop', 'turn', 'river'] },
      },
    },
    profileIds: PROFILE_IDS_SCHEMA,
    difficulty: DIFFICULTY_SCHEMA,
    trials: { type: 'integer', minimum: 1, maximum: MAX_COMPARE_TRIALS },
  },
} as const;

/** Board lengths a street must have. The engine would reject anything else anyway. */
const BOARD_LENGTH: Readonly<Record<'preflop' | 'flop' | 'turn' | 'river', number>> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

/** Trials per profile when the client does not ask. */
const DEFAULT_COMPARE_TRIALS = 12;

// ---------------------------------------------------------------------------
// Request body types, as the schemas above accept them
// ---------------------------------------------------------------------------

interface LegendMatchBody {
  readonly profileIds: readonly string[];
  readonly difficulty: LegendDifficulty;
  readonly startingStack: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante?: number;
  readonly deterministicSeed?: number;
}

interface CompareBody {
  readonly scenarioId?: string;
  readonly situation?: {
    readonly heroCards: string;
    readonly board?: string;
    readonly pot: number;
    readonly toCall: number;
    readonly heroStack: number;
    readonly opponentStack: number;
    readonly bigBlind: number;
    readonly street: 'preflop' | 'flop' | 'turn' | 'river';
  };
  readonly profileIds: readonly string[];
  readonly difficulty: LegendDifficulty;
  readonly trials?: number;
}

export interface RoomRoutesOptions {
  /** Defaults to the process-wide registry, which the WebSocket hub shares. */
  readonly registry?: RoomRegistry;
  /** Session persistence, so this module stands on its own. Tests pass a fake. */
  readonly sessionStore?: SessionStore;
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

export function createRoomRoutes(options: RoomRoutesOptions = {}): FastifyPluginAsync {
  return async (app) => {
    const registry = options.registry ?? roomRegistry();
    const ownsRegistry = options.registry === undefined;
    const store =
      options.sessionStore ??
      (app.hasRequestDecorator('session') ? null : createAuthStore(getSql()).sessions);
    if (store !== null) await app.register(sessionPlugin, { store });

    app.addHook('onClose', async () => {
      // Only the registry this module created. A registry passed in belongs to its owner, and
      // closing somebody else's tables on our way out would be a surprise.
      if (ownsRegistry) registry.closeAll();
      await Promise.resolve();
    });

    /** The caller, as every room operation wants them. */
    const principalOf = (request: Parameters<typeof requireSession>[0]): RoomPrincipal => {
      const session = requireSession(request);
      return { userId: session.user.id, displayName: session.user.displayName };
    };

    // -----------------------------------------------------------------------
    // Rooms
    // -----------------------------------------------------------------------

    /**
     * `POST /rooms` — a private table, and its invite code, once.
     *
     * Bots asked for in the body are seated immediately, from seat 1 upwards, leaving seat 0 for
     * the owner. Each gets a real user row, because a seat is a seat whoever occupies it: the same
     * membership, hand-seat and action shapes apply, and no query needs a special case.
     */
    app.post<{ Body: CreateRoomRequest }>(
      '/rooms',
      { schema: { body: { $ref: 'prl:createRoomBody#' } } },
      async (request, reply): Promise<CreateRoomResponse> => {
        const principal = principalOf(request);
        const body = request.body;
        const created = await registry.createRoom(principal, {
          name: body.name,
          maxSeats: body.maxSeats,
          smallBlind: body.smallBlind,
          bigBlind: body.bigBlind,
          ...(body.ante === undefined ? {} : { ante: body.ante }),
          startingStack: body.startingStack,
          ...(body.actionTimeoutSeconds === undefined
            ? {}
            : { actionTimeoutSeconds: body.actionTimeoutSeconds }),
        });

        await seatRequestedBots(registry, created.room, body.bots ?? []);
        reply.status(201);
        return { room: toRoomSummary(created.room), inviteCode: created.inviteCode };
      },
    );

    /** `POST /rooms/join` — by invite code. Joining a room you are already in is not an error. */
    app.post<{ Body: JoinRoomRequest }>(
      '/rooms/join',
      { schema: { body: { $ref: 'prl:joinRoomBody#' } } },
      async (request): Promise<JoinRoomResponse> => {
        const principal = principalOf(request);
        const room = await registry.joinByInviteCode(principal, request.body.inviteCode);
        return { room: toRoomSummary(room) };
      },
    );

    /** `GET /rooms` — the rooms this learner owns or is sitting at. */
    app.get('/rooms', async (request): Promise<RoomListResponse> => {
      const principal = principalOf(request);
      const rows = await registry.store.listForUser(principal.userId);
      const members = await registry.store.membersOfRooms(rows.map((row) => row.id));
      const rooms: RoomSummary[] = rows.map((row) => {
        // A room with a live table in this process reports what is actually happening at it; one
        // without reports the durable record. Both are honest; they differ in freshness, and the
        // live one is the fresher.
        const live = registry.get(row.id);
        if (live !== null) return toRoomSummary(live);
        return summaryFromRows(
          row,
          members.filter((member) => member.room_id === row.id),
        );
      });
      return { rooms };
    });

    /** `GET /rooms/:roomId` — one room, if the caller is a member or its owner. */
    app.get<{ Params: { roomId: string } }>(
      '/rooms/:roomId',
      { schema: { params: { $ref: 'prl:roomIdParams#' } } },
      async (request): Promise<JoinRoomResponse> => {
        const principal = principalOf(request);
        const room = await openRoomFor(registry, request.params.roomId, principal.userId);
        return { room: toRoomSummary(room) };
      },
    );

    /** `POST /rooms/:roomId/sit` — take a seat, if the units are there and it is free. */
    app.post<{ Params: { roomId: string }; Body: SitRequest }>(
      '/rooms/:roomId/sit',
      { schema: { params: { $ref: 'prl:roomIdParams#' }, body: { $ref: 'prl:sitBody#' } } },
      async (request): Promise<JoinRoomResponse> => {
        const principal = principalOf(request);
        const room = await openRoomFor(registry, request.params.roomId, principal.userId);
        await registry.sitAtTable(room.record.id, principal, request.body.seat);
        return { room: toRoomSummary(room) };
      },
    );

    /**
     * `POST /rooms/:roomId/leave` — stand up and leave the table.
     *
     * Leaving mid-hand is not a way to avoid a bet: the seat folds at its turn and is released when
     * the hand completes. The summary that comes back is the table as it now is, which for a
     * mid-hand departure still shows the seat holding its folded cards.
     */
    app.post<{ Params: { roomId: string } }>(
      '/rooms/:roomId/leave',
      { schema: { params: { $ref: 'prl:roomIdParams#' } } },
      async (request): Promise<JoinRoomResponse> => {
        const principal = principalOf(request);
        const room = await openRoomFor(registry, request.params.roomId, principal.userId);
        await registry.leaveRoom(room.record.id, principal.userId);
        return { room: toRoomSummary(room) };
      },
    );

    // -----------------------------------------------------------------------
    // Legends
    // -----------------------------------------------------------------------

    /**
     * `GET /legends/profiles` — the selector.
     *
     * No session required: this is teaching material, like a lesson. Every card carries its
     * disclosure, and the universal disclaimer is returned separately so the UI can show it once
     * above the whole list as well as with each profile.
     */
    // Not `async`: nothing here awaits, and Fastify sends a handler's return value whether or not
    // it is a promise.
    app.get('/legends/profiles', (): LegendProfilesResponse => {
      const mode = resolveNamingMode();
      const profiles: LegendProfileCardDto[] = PROFILES.map((profile) => {
        const card = profileCard(profile, mode);
        return {
          id: card.id,
          disclosure: card.disclosure,
          traits: card.traits,
          axes: radarAxes(card.traits),
          learnFrom: card.learnFrom,
          styleNotes: card.styleNotes,
          counterStrategy: card.counterStrategy,
          modelBasis: card.modelBasis,
          signatureTraits: card.signatureTraits,
          bestFor: card.bestFor,
        };
      });
      return {
        namingMode: mode,
        profiles,
        difficulties: DIFFICULTIES.map(difficultyDto),
        universalDisclaimer: UNIVERSAL_DISCLAIMER,
      };
    });

    /**
     * `GET /legends/profiles/:profileId` — "what can I learn from this player?"
     *
     * Built by `learnFromSummary` in `@prl/poker-ai` rather than assembled here. This handler used
     * to construct the response inline, and that is how it drifted: the generator knows which of
     * the sixteen axes a wire-shaped observation can honestly be compared against — two of them
     * declare a CONDITIONAL quantity that no observer on the other side of the table can measure —
     * and an inline copy silently did not.
     *
     * `observed` is null, and `observedBasis` with it. Measured frequencies here mean the reader's
     * OWN session against this profile, and three things block that today: the durable rows cannot
     * name seven of the twelve profiles, `bluffFrequency` asks what a bet was made with, and the
     * action log has no `raiseWasAvailable`. The field's comment in `@prl/contracts` carries the
     * list. What a simulation of the model actually did is measurable, and is served under a name
     * that says so by `GET /legends/profiles/:profileId/stats` — putting it here instead would make
     * `learnFromSummary` generate "across N hands you have seen" about hands nobody played.
     */
    app.get<{ Params: { profileId: string } }>(
      '/legends/profiles/:profileId',
      { schema: { params: PROFILE_ID_PARAMS } },
      (request): LearnFromProfileResponse => {
        const mode = resolveNamingMode();
        const profile = profileById(request.params.profileId);
        return {
          ...learnFromSummary({
            profile,
            disclosure: profileDisclosure(profile.naming, mode),
            observed: null,
            others: PROFILES,
          }),
          observedBasis: null,
          // `learnFromSummary` names other profiles by their archetype name, which is safe in both
          // modes but is not the name this deployment shows. Re-derived through `profileDisclosure`
          // so an attributed deployment's contrast section matches the rest of its own pages.
          contrasts: PROFILES.filter((other) => other.naming.id !== profile.naming.id).map((other) => ({
            otherProfileId: other.naming.id,
            otherDisplayName: profileDisclosure(other.naming, mode).displayName,
            differences: biggestTraitDifferences(profile.traits, other.traits),
          })),
        };
      },
    );

    // `GET /legends/profiles/:profileId/stats` — declared traits against a stored measurement of
    // what the model actually did. Registered from `routes/legends.ts`, which owns the runs.
    registerLegendStatsRoute(app, PROFILE_ID_PARAMS);

    /**
     * `POST /legends/matches` — a private room with profiles already seated.
     *
     * The match is an ordinary invite-only room, so the table UI, the hand history and the review
     * are unchanged. The learner takes seat 0 by sitting down as they would anywhere else.
     */
    app.post<{ Body: LegendMatchBody }>(
      '/legends/matches',
      { schema: { body: LEGEND_MATCH_BODY } },
      async (request, reply): Promise<CreateLegendMatchResponse> => {
        const principal = principalOf(request);
        const body = request.body;
        const mode = resolveNamingMode();
        const maxSeats = body.profileIds.length + 1;
        if (maxSeats > 6) {
          throw new AppError('invalid_request', {
            fields: { profileIds: 'at most five opponents fit at a table' },
            logDetail: `${body.profileIds.length} profiles requested`,
          });
        }
        const plan = planLegendSeats(body.profileIds, mode, maxSeats);

        const created = await registry.createRoom(principal, {
          name: 'Legends practice',
          maxSeats,
          smallBlind: body.smallBlind,
          bigBlind: body.bigBlind,
          ...(body.ante === undefined ? {} : { ante: body.ante }),
          startingStack: body.startingStack,
        });

        for (const seat of plan) {
          const user = await registry.store.createBotUser(seat.displayName);
          const durable = {
            profileId: durableProfile(seat.profileId),
            difficulty: body.difficulty,
            // Seeds the opponent's decisions, never the deal. See the file comment. The RESOLVED
            // seed is what is stored, not `body.deterministicSeed`: it is the value the runner is
            // given below, so a rehydrated seat reproduces this exact decision stream.
            seed: seedFor(created.room.record.id, seat.seat, body.deterministicSeed),
          };
          // The full seat, durably. This used to write `persistableProfile(...)`, which answered
          // `unknown` for seven of the twelve profiles — so a restart forgot which Legend the
          // learner had chosen to play. Migration 0003 widened the column; this writes to it.
          await registry.store.addMember({
            roomId: created.room.record.id,
            userId: user.id,
            isBot: true,
            bot: durable,
          });
          await registry.store.seatMember(created.room.record.id, user.id, seat.seat);
          await registry.seatBot(created.room.record.id, {
            userId: user.id,
            displayName: seat.displayName,
            seat: seat.seat,
            ...durable,
          });
        }

        reply.status(201);
        return {
          roomId: created.room.record.id,
          seats: plan.map((seat) => ({
            seat: seat.seat,
            profileId: seat.profileId,
            disclosure: seat.disclosure,
          })),
          difficulty: difficultyDto(body.difficulty),
        };
      },
    );

    /**
     * `POST /legends/compare` — the same spot, several styles.
     *
     * Expensive: each trial runs a policy, and a postflop policy samples equity. It takes the
     * expensive rate limit for the same reason the equity endpoints do.
     */
    app.post<{ Body: CompareBody }>(
      '/legends/compare',
      { config: app.expensiveRateLimit, schema: { body: COMPARE_BODY } },
      (request): CompareProfilesResponse => {
        const body = request.body;
        const spot = spotFor(body);
        return compareProfilesOnSpot({
          spot,
          profileIds: body.profileIds,
          difficulty: body.difficulty,
          trials: body.trials ?? DEFAULT_COMPARE_TRIALS,
          namingMode: resolveNamingMode(),
        });
      },
    );
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The profile, or `content_not_found`: an unknown profile id is a bad link, not a bad request. */
function profileById(profileId: string) {
  try {
    return requireProfile(profileId);
  } catch {
    throw new AppError('content_not_found', { logDetail: `unknown profile "${profileId}"` });
  }
}

function difficultyDto(difficulty: LegendDifficulty): LegendDifficultyDto {
  const settings = DIFFICULTY_SETTINGS[difficulty];
  return {
    id: settings.id,
    label: settings.label,
    description: settings.description,
    coachAvailable: settings.coachAvailable,
  };
}

/**
 * Checks the caller may see the room, then opens its live table.
 *
 * Both failures are one answer: `room_not_found_or_not_permitted`, whether the room does not exist
 * or the caller is nobody in it.
 *
 * The order is the part worth arguing about. Opening first and checking afterwards would be shorter
 * and would let a stranger who guessed a room id make this process build a live table — a
 * `HandState`, a timer, a bot runner — before being told no. So the membership check runs against
 * the durable rows first, and only a caller who belongs here gets a table built for them.
 *
 * `ensureOpen` is what makes a room usable after a restart: the row is durable, the table is not,
 * and the first request from a member rebuilds the table from the roster.
 */
async function openRoomFor(registry: RoomRegistry, roomId: string, userId: string): Promise<LiveRoom> {
  const refuse = (): never => {
    throw new AppError('room_not_found_or_not_permitted', {
      logDetail: `room ${roomId} is unknown, closed, or not this caller's`,
    });
  };

  const live = registry.get(roomId);
  if (live === null) {
    const row = await registry.store.byId(roomId);
    if (row === null || row.status === 'closed') refuse();
    const member = await registry.store.memberOf(roomId, userId);
    if (member === null && row?.owner_user_id !== userId) refuse();
  }

  const room = await registry.ensureOpen(roomId);
  if (room === null) refuse();
  return registry.require(roomId, userId);
}

/** Seats the bots a `POST /rooms` body asked for, from seat 1 upwards. */
async function seatRequestedBots(
  registry: RoomRegistry,
  room: LiveRoom,
  requested: readonly { readonly profile: string; readonly count: number }[],
): Promise<void> {
  let seat = 1;
  for (const entry of requested) {
    for (let index = 0; index < entry.count; index += 1) {
      if (seat >= room.record.config.maxSeats) {
        throw new AppError('room_full', {
          logDetail: `more bots requested than seats at ${room.record.id}`,
        });
      }
      const profile = resolveProfile(entry.profile);
      const displayName = botDisplayName(profile.naming.id);
      const user = await registry.store.createBotUser(displayName);
      // A table created through `POST /rooms` has no difficulty field, so its bots play the
      // middle setting: the style as designed, with the sizing variation a real opponent shows.
      const durable = {
        profileId: durableProfile(profile.naming.id),
        difficulty: 'realistic' as const,
        seed: seedFor(room.record.id, seat, undefined),
      };
      // Persisted before the runner is told, and persisted in FULL: the durable row is what a
      // restart reads, so a seat the row cannot describe is a seat the next process cannot put
      // back. See `rooms/bot-profile.ts`.
      await registry.store.addMember({
        roomId: room.record.id,
        userId: user.id,
        isBot: true,
        bot: durable,
      });
      await registry.store.seatMember(room.record.id, user.id, seat);
      await registry.seatBot(room.record.id, { userId: user.id, displayName, seat, ...durable });
      seat += 1;
    }
  }
}

/**
 * The spot to compare on: either a Scenario Lab situation or an ad-hoc one.
 *
 * A scenario is read through `@prl/content`'s own `readSituation`, so a comparison and the Scenario
 * Lab's own analysis are talking about exactly the same numbers rather than two readings of the
 * same JSON.
 */
function spotFor(body: CompareBody): HypotheticalSpot {
  if (body.scenarioId !== undefined) return spotFromScenario(body.scenarioId);
  const situation = body.situation;
  if (situation === undefined) {
    throw new AppError('invalid_request', {
      fields: { situation: 'give either a scenarioId or a situation' },
      logDetail: 'compare request had neither a scenario nor a situation',
    });
  }
  const board = parseCards(situation.board ?? '');
  if (board.length !== BOARD_LENGTH[situation.street]) {
    throw new AppError('invalid_request', {
      fields: { board: `must hold ${BOARD_LENGTH[situation.street]} cards on the ${situation.street}` },
      logDetail: `board of ${board.length} cards on the ${situation.street}`,
    });
  }
  return {
    heroCards: parseCards(situation.heroCards),
    board,
    street: situation.street,
    pot: situation.pot,
    toCall: situation.toCall,
    heroStack: situation.heroStack,
    opponentStack: situation.opponentStack,
    bigBlind: situation.bigBlind,
  };
}

function spotFromScenario(scenarioId: string): HypotheticalSpot {
  const scenario = scenarioById(scenarioId);
  if (scenario === null) {
    throw new AppError('content_not_found', { logDetail: `unknown scenario "${scenarioId}"` });
  }
  const hero = scenario.seats.find((seat) => seat.isHero === true);
  if (hero?.holeCards === undefined) {
    throw new AppError('content_not_found', { logDetail: `scenario "${scenarioId}" has no hero cards` });
  }
  const committed = scenario.committedThisStreet ?? {};
  const pot = scenario.potBeforeStreet + Object.values(committed).reduce((sum, value) => sum + value, 0);
  const opponent = scenario.seats.find((seat) => seat.isHero !== true);
  return {
    heroCards: parseCards(hero.holeCards),
    board: parseCards(scenario.board),
    street: scenario.street,
    pot,
    toCall: scenario.toCall,
    heroStack: hero.stack,
    opponentStack: opponent?.stack ?? hero.stack,
    bigBlind: scenario.bigBlind,
  };
}

const roomRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createRoomRoutes());
};

export default roomRoutes;
