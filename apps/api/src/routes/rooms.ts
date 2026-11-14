/**
 * Rooms and the "Play a Legend" endpoints. A thin layer over `src/rooms/registry.ts`, so REST and
 * the socket `sit` frame run the same method.
 *
 * `POST /rooms` returns the invite code once. Only `sha256(code)` is stored, and `logging.ts`
 * censors `inviteCode`. "No such room" and "not your room" share one answer so a room id cannot
 * be confirmed. Every Legends response goes through `profileDisclosure()`, defaulting to the
 * `archetype` naming mode. `deterministicSeed` seeds bot decisions only. Cards always come from
 * `createSecureRandom()`.
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
  botDisplayNames,
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

/**
 * Schemas for Legends bodies that `@prl/contracts` types but does not schema. Passed inline with
 * no `$id`, so the contract has no second addressable definition.
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

const BOARD_LENGTH: Readonly<Record<'preflop' | 'flop' | 'turn' | 'river', number>> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

const DEFAULT_COMPARE_TRIALS = 12;

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

export function createRoomRoutes(options: RoomRoutesOptions = {}): FastifyPluginAsync {
  return async (app) => {
    const registry = options.registry ?? roomRegistry();
    const ownsRegistry = options.registry === undefined;
    const store =
      options.sessionStore ??
      (app.hasRequestDecorator('session') ? null : createAuthStore(getSql()).sessions);
    if (store !== null) await app.register(sessionPlugin, { store });

    app.addHook('onClose', async () => {
      // Only a registry this module created. `shutdown()` waits for room leases to be released,
      // otherwise the replacement process cannot open those rooms until `LEASE_TTL_MS` passes.
      // It never rejects, so shutdown cannot hang.
      if (ownsRegistry) await registry.shutdown();
    });

    const principalOf = (request: Parameters<typeof requireSession>[0]): RoomPrincipal => {
      const session = requireSession(request);
      return { userId: session.user.id, displayName: session.user.displayName };
    };

    /**
     * `POST /rooms`. Requested bots take seats from 1 upwards, leaving seat 0 for the owner. Each
     * bot gets a real user row, so no query needs a special case.
     */
    app.post<{ Body: CreateRoomRequest }>(
      '/rooms',
      { schema: { body: { $ref: 'prl:createRoomBody#' } } },
      async (request, reply): Promise<CreateRoomResponse> => {
        const principal = principalOf(request);
        const body = request.body;
        const build = async (): Promise<{ readonly room: LiveRoom; readonly inviteCode: string }> => {
          const made = await registry.createRoom(principal, {
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
          await seatRequestedBots(registry, made.room, body.bots ?? []);
          return made;
        };
        // Bots in every chair but the owner's make a practice table, and a learner holds one at a
        // time (`RoomRegistry.retirePracticeTables`). A table with a free chair is never retired here.
        const bots = (body.bots ?? []).reduce((total, entry) => total + entry.count, 0);
        const created =
          bots > 0 && bots + 1 === body.maxSeats
            ? await registry.replacePracticeTable(principal.userId, build)
            : await build();
        reply.status(201);
        return { room: toRoomSummary(created.room), inviteCode: created.inviteCode };
      },
    );

    /** Joining a room you are already in is not an error. */
    app.post<{ Body: JoinRoomRequest }>(
      '/rooms/join',
      { schema: { body: { $ref: 'prl:joinRoomBody#' } } },
      async (request): Promise<JoinRoomResponse> => {
        const principal = principalOf(request);
        const room = await registry.joinByInviteCode(principal, request.body.inviteCode);
        return { room: toRoomSummary(room) };
      },
    );

    app.get('/rooms', async (request): Promise<RoomListResponse> => {
      const principal = principalOf(request);
      const rows = await registry.store.listForUser(principal.userId);
      const members = await registry.store.membersOfRooms(rows.map((row) => row.id));
      const rooms: RoomSummary[] = rows.map((row) => {
        // A live table in this process is fresher than the durable record.
        const live = registry.get(row.id);
        if (live !== null) return toRoomSummary(live);
        return summaryFromRows(
          row,
          members.filter((member) => member.room_id === row.id),
        );
      });
      return { rooms };
    });

    app.get<{ Params: { roomId: string } }>(
      '/rooms/:roomId',
      { schema: { params: { $ref: 'prl:roomIdParams#' } } },
      async (request): Promise<JoinRoomResponse> => {
        const principal = principalOf(request);
        const room = await openRoomFor(registry, request.params.roomId, principal.userId);
        return { room: toRoomSummary(room) };
      },
    );

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
     * Leaving mid-hand folds the seat at its turn and releases it when the hand completes, so the
     * returned summary can still show the seat holding folded cards.
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

    /**
     * No session required. The universal disclaimer is returned separately so the UI can show it
     * once above the list as well as on each card.
     */
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
     * Built by `learnFromSummary`, because two of the sixteen axes are conditional quantities an
     * observer cannot measure and an inline copy would drift. `observed` is null, and the blockers are
     * listed on the field in `@prl/contracts`. Simulated figures are served by the `/stats` route.
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
          // Re-derived through `profileDisclosure` so contrasts use this deployment's naming mode.
          contrasts: PROFILES.filter((other) => other.naming.id !== profile.naming.id).map((other) => ({
            otherProfileId: other.naming.id,
            otherDisplayName: profileDisclosure(other.naming, mode).displayName,
            differences: biggestTraitDifferences(profile.traits, other.traits),
          })),
        };
      },
    );

    // Owned by `routes/legends.ts`.
    registerLegendStatsRoute(app, PROFILE_ID_PARAMS);

    /** An ordinary invite-only room, so the table UI, history and review are unchanged. */
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

        // Retire the previous practice table first, as one turn per learner, so two tabs cannot each
        // keep one (`RoomRegistry.retirePracticeTables`).
        const created = await registry.replacePracticeTable(principal.userId, async () => {
          const made = await registry.createRoom(principal, {
            name: 'Legends practice',
            maxSeats,
            smallBlind: body.smallBlind,
            bigBlind: body.bigBlind,
            ...(body.ante === undefined ? {} : { ante: body.ante }),
            startingStack: body.startingStack,
          });
          const roomId = made.room.record.id;
          for (const seat of plan) {
            const user = await registry.store.createBotUser(seat.displayName);
            const durable = {
              profileId: durableProfile(seat.profileId),
              difficulty: body.difficulty,
              // Store the resolved seed so a rehydrated seat replays the same decision stream.
              seed: seedFor(roomId, seat.seat, body.deterministicSeed),
            };
            // The full profile id, so a restart remembers which Legend was chosen (migration 0003).
            await registry.store.addMember({
              roomId,
              userId: user.id,
              isBot: true,
              bot: durable,
            });
            const memberId = await registry.store.seatMember(roomId, user.id, seat.seat);
            await registry.seatBot(
              roomId,
              { userId: user.id, displayName: seat.displayName, seat: seat.seat, ...durable },
              memberId,
            );
          }
          return made;
        });

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

    /** Each trial runs a policy and may sample equity, so it takes the expensive rate limit. */
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

/** An unknown profile id is a bad link, so `content_not_found`. */
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
 * One answer, `room_not_found_or_not_permitted`, for a missing room and a stranger.
 * Membership is checked against durable rows first, so a guessed room id never makes this process
 * build a live table. `ensureOpen` rebuilds the table from the roster after a restart.
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

async function seatRequestedBots(
  registry: RoomRegistry,
  room: LiveRoom,
  requested: readonly { readonly profile: string; readonly count: number }[],
): Promise<void> {
  const profiles = requested.flatMap((entry) =>
    Array.from({ length: entry.count }, () => resolveProfile(entry.profile)),
  );
  const names = botDisplayNames(profiles.map((profile) => profile.naming.id));
  for (const [index, profile] of profiles.entries()) {
    const seat = index + 1;
    if (seat >= room.record.config.maxSeats) {
      throw new AppError('room_full', {
        logDetail: `more bots requested than seats at ${room.record.id}`,
      });
    }
    const displayName = names[index] ?? botDisplayName(profile.naming.id);
    const user = await registry.store.createBotUser(displayName);
    // `POST /rooms` has no difficulty field, so these bots play the middle setting.
    const durable = {
      profileId: durableProfile(profile.naming.id),
      difficulty: 'realistic' as const,
      seed: seedFor(room.record.id, seat, undefined),
    };
    // Persisted in full before the runner is told, since the row is what a restart reads.
    await registry.store.addMember({
      roomId: room.record.id,
      userId: user.id,
      isBot: true,
      bot: durable,
    });
    const memberId = await registry.store.seatMember(room.record.id, user.id, seat);
    await registry.seatBot(room.record.id, { userId: user.id, displayName, seat, ...durable }, memberId);
  }
}

/** A Scenario Lab situation or an ad-hoc one. */
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
