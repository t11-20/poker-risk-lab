/**
 * Where `@prl/poker-ai` meets the engine.
 *
 * ###########################################################################
 * ##  A BOT RECEIVES ONLY `table.viewFor(botUserId)`.                      ##
 * ##                                                                       ##
 * ##  `buildPolicyInput` is the ONE place a `PolicyInput` is constructed,   ##
 * ##  and it takes a redacted `PlayerView` and nothing else. The seat's own ##
 * ##  two cards are read out of that view's own seat — the one place        ##
 * ##  `redactFor` puts them — so this file never touches a `HandState`,     ##
 * ##  never sees a deck, a cursor, a salt or another seat's cards, and has  ##
 * ##  no import through which it could. That is an architectural boundary,  ##
 * ##  not a convention: `test/bots.test.ts` asserts it by scanning a real   ##
 * ##  captured `PolicyInput` for the other seat's cards and for every       ##
 * ##  secret field name.                                                   ##
 * ###########################################################################
 *
 * ## The policy proposes; the engine decides
 *
 * `decide()` returns an action drawn from a distribution over `view.legalActions`. It is then
 * submitted through `LiveTable.submitAction`, exactly as a human's action is, so `validateAction`
 * re-derives the legal set and a bug in a policy produces a rejected action rather than an
 * illegal game. There is no privileged path for a bot.
 *
 * ## Seeded randomness, and why it is not the dealing source
 *
 * Each bot gets its own `RandomSource` derived from a seed, so a match replays identically: the
 * postflop equity estimate, the bet-size jitter and the sampling draw all come off that stream in
 * a fixed order (see `policy.ts`). It is a SplitMix32 written out here rather than imported,
 * because the engine's `createDeterministicRandomForTests` must never appear in server source —
 * it is for tests and fixed-deck teaching hands, and a server file importing it is the first step
 * towards a hand being dealt from it. **Cards are never dealt from this stream.** The table's
 * dealing source is `createSecureRandom()`, and every hand records `randomSourceKind: 'csprng'`
 * to prove it.
 *
 * `RandomSource.kind` offers only two values, so this one is labelled
 * `deterministic-test-only`: it is honest (this is not a CSPRNG) and it is inert, because the
 * label is only ever recorded by `startHand`, which this stream is never passed to.
 *
 * ## The thinking delay is for legibility, not deliberation
 *
 * A bot could answer inside a millisecond. It waits `thinkingDelayMs` first, so that a learner
 * can see whose turn it was and read what happened — the same reason a dealer pauses. It is
 * **not** a simulation of thought, it does not vary with how hard the decision is, and nothing in
 * the UI should present it as thinking. It runs on the injected clock, so a test advances it
 * rather than sleeping.
 *
 * ## What the opponent model is fed
 *
 * Public actions only, from `TableNotice.publicActions` — a type with no field for a card — and,
 * at the end of a hand, the bot's own redacted view, whose `result.showdowns` contains exactly
 * the hands that were actually turned over. A hand that ends in a fold therefore teaches the
 * model nothing about anybody's cards, which is correct.
 */

import { randomBytes } from 'node:crypto';
import type {
  CoachReport,
  CompareProfilesResponse,
  LegendDifficulty,
  ProfileComparisonEntry,
  ProfileDisclosureDto,
} from '@prl/contracts';
import {
  DIFFICULTY_SETTINGS,
  type Difficulty,
  type DifficultySettings,
  decide,
  expressTraits,
  type NamingMode,
  OpponentModel,
  type PolicyDecision,
  type PolicyInput,
  PROFILES,
  profileDisclosure,
  requireProfile,
  type StrategyProfile,
  type Traits,
} from '@prl/poker-ai';
import type {
  Card,
  HandState,
  LoggedAction,
  PlayerView,
  RandomSource,
  SeatIndex,
  SeatState,
} from '@prl/poker-engine';
import { commitToKnownDeck, createSecureRandom, orderedDeck, redactFor } from '@prl/poker-engine';
import {
  buildCoachReport,
  deriveLegalActions,
  type ParsedRange,
  parseRange,
  topPercentRange,
} from '@prl/poker-math';
import { AppError } from '../errors.ts';
import type { ProblemHook } from '../observability/telemetry.ts';
import type { LiveTable, TableNotice } from './table.ts';
import type { Clock, ScheduledTask } from './timers.ts';

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/**
 * A seeded, non-cryptographic source for *decisions*, never for cards.
 *
 * SplitMix32: counter-based, small, well distributed, and not claimed to be secure. The whole
 * reason it exists is reproducibility — a Legends match run twice from the same seed produces the
 * same opponent decisions, which is what makes a teaching replay worth anything.
 */
export function createSeededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  const nextUint32 = (): number => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
  const draw = (boundExclusive: number): number => {
    if (!Number.isInteger(boundExclusive) || boundExclusive <= 0) {
      throw new AppError('internal_error', { logDetail: `invalid random bound ${boundExclusive}` });
    }
    if (boundExclusive === 1) return 0;
    // Rejection sampling, for the same reason the engine does it: `x % n` favours low indices
    // unless n divides 2^32, and a biased policy draw is a biased style.
    const limit = Math.floor(2 ** 32 / boundExclusive) * boundExclusive;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const value = nextUint32();
      if (value < limit) return value % boundExclusive;
    }
    throw new AppError('internal_error', { logDetail: 'seeded random source is not uniform' });
  };
  return {
    kind: 'deterministic-test-only',
    nextInt: (boundExclusive) => draw(boundExclusive),
    bytes: (count) => {
      const out = new Uint8Array(count);
      for (let index = 0; index < count; index += 1) out[index] = nextUint32() & 0xff;
      return out;
    },
  };
}

/** A seed from a room, a seat and an optional caller-supplied seed. Stable across restarts. */
export function seedFor(roomId: string, seat: SeatIndex, base: number | undefined): number {
  let hash = base === undefined ? 0x811c9dc5 : base >>> 0;
  for (const char of `${roomId}:${seat}`) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Profiles: names, difficulty, disclosure
// ---------------------------------------------------------------------------

/**
 * The contract's five legacy bot names, mapped onto strategy profiles.
 *
 * `createRoomBodySchema` accepts `nit | tight-aggressive | loose-aggressive | calling-station |
 * maniac`. The Legends profile set is richer, so the two vocabularies have to meet somewhere, and
 * a table is the honest place: each legacy name picks the profile whose traits most nearly
 * describe it, and the mapping is visible rather than buried in a conditional.
 *
 * This is now a ONE-WAY table, used only to read a request. It used to have a reverse direction
 * as well — `persistableProfile`, which answered `unknown` for the seven profiles no legacy name
 * could express, because `room_members.bot_profile` was CHECK-constrained to those five. That is
 * the defect migration `0003` removes: the column holds the strategy profile's own id now, so
 * nothing has to be squeezed back through this vocabulary to be written down. See
 * `rooms/bot-profile.ts` for what replaced it and why an inexpressible id is now a refusal rather
 * than a fallback.
 */
export const LEGACY_PROFILE_IDS: Readonly<Record<string, string>> = {
  nit: 'disciplined-specialist',
  'tight-aggressive': 'patient-technician',
  'loose-aggressive': 'reading-pressure-specialist',
  'calling-station': 'calling-station',
  maniac: 'volume-grinder',
};

/** Resolves a legacy name or a strategy profile id to a profile. Throws `invalid_request`. */
export function resolveProfile(name: string): StrategyProfile {
  const mapped = LEGACY_PROFILE_IDS[name] ?? name;
  const profile = PROFILES.find((candidate) => candidate.naming.id === mapped);
  if (profile === undefined) {
    throw new AppError('invalid_request', {
      fields: { profile: 'is not a strategy profile this server knows' },
      logDetail: `unknown bot profile "${name}"`,
    });
  }
  return profile;
}

/** The full disclosure for a profile, disclaimers included. Never a name on its own. */
export function disclosureFor(profileId: string, mode: NamingMode): ProfileDisclosureDto {
  return profileDisclosure(requireProfile(profileId).naming, mode);
}

/** Longest a bot's display name may be: `users_display_name_shape` allows 2..24 characters. */
const MAX_BOT_NAME = 24;

/**
 * A seat plate for a bot, inside the database's own length rule.
 *
 * Built from the profile id by whole words rather than by truncating a long archetype name mid
 * word, because "Reading Pressure Special" reads like a mistake and "Reading Pressure" does not.
 * The full display name, with its disclaimers, travels in `ProfileDisclosureDto` — this is only
 * the plate.
 */
export function botDisplayName(profileId: string): string {
  const words = profileId.split('-').map((word) => (word[0] ?? '').toUpperCase() + word.slice(1));
  let name = '';
  for (const word of words) {
    const candidate = name === '' ? word : `${name} ${word}`;
    if (candidate.length > MAX_BOT_NAME) break;
    name = candidate;
  }
  if (name.length < 2) name = (words[0] ?? 'Bot').slice(0, MAX_BOT_NAME);
  return name.length < 2 ? 'Bot' : name;
}

// ---------------------------------------------------------------------------
// The one place a PolicyInput is built
// ---------------------------------------------------------------------------

export interface PolicyInputRequest {
  /** Already redacted for this seat. The ONLY state a policy is given. */
  readonly view: PlayerView;
  readonly seat: SeatIndex;
  readonly traits: Traits;
  readonly difficulty: DifficultySettings;
  readonly observations: OpponentModel;
  readonly random: RandomSource;
}

/**
 * Assembles a `PolicyInput` from a redacted view and nothing else.
 *
 * The seat's own cards come out of `view.seats[...].holeCards` for the seat the view was built
 * for — the one place `redactFor` puts them. Reading them from anywhere else (a `HandState`, a
 * side table of "who holds what") is what this function exists to make unnecessary, and the fact
 * that it takes no other source is the boundary.
 */
export function buildPolicyInput(request: PolicyInputRequest): PolicyInput {
  const { view, seat } = request;
  if (view.viewerSeat !== seat) {
    throw new AppError('internal_error', {
      logDetail: `a policy input for seat ${seat} was given a view redacted for ${String(view.viewerSeat)}`,
    });
  }
  const own = view.seats.find((entry) => entry.seat === seat);
  const holeCards = own?.holeCards ?? null;
  if (holeCards === null) {
    throw new AppError('internal_error', {
      logDetail: `seat ${seat} has no hole cards in its own view, so it cannot decide`,
    });
  }
  return {
    view,
    holeCards,
    seat,
    traits: request.traits,
    difficulty: request.difficulty,
    observations: request.observations,
    random: request.random,
  };
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** One bot seat at a live table. */
export interface BotSeatSpec {
  readonly userId: string;
  readonly seat: SeatIndex;
  /** A strategy profile id from `@prl/poker-ai`. */
  readonly profileId: string;
  readonly difficulty: Difficulty;
  /** Fixes this seat's decision stream. Derive it with `seedFor`. */
  readonly seed: number;
}

interface BotSeatState {
  readonly spec: BotSeatSpec;
  readonly traits: Traits;
  readonly settings: DifficultySettings;
  readonly random: RandomSource;
  readonly model: OpponentModel;
  /** Hands already folded into the model, so a hand cannot be counted twice. */
  readonly observedHands: Set<string>;
  pending: ScheduledTask | null;
  /** The `(handId, sequence)` a decision is already scheduled for. */
  pendingAt: string | null;
}

export interface BotRunnerOptions {
  readonly table: LiveTable;
  readonly clock: Clock;
  /** Legibility only. See the file comment. */
  readonly thinkingDelayMs?: number;
  /**
   * Non-fatal problems. Typed `event` on the detail, so "a bot could not decide" and "the engine
   * refused a bot's action" are two counters rather than two sentences — see
   * `observability/telemetry.ts`.
   */
  readonly onProblem?: ProblemHook;
  /** Test seam: lets a test capture the exact `PolicyInput` a bot was given. */
  readonly onDecision?: (input: PolicyInput, decision: PolicyDecision) => void;
}

/** Long enough to be readable, short enough not to be a wait. */
const DEFAULT_THINKING_DELAY_MS = 700;

/**
 * Drives every bot seat at one table.
 *
 * One runner per table, subscribed to that table's notices. It holds no state the table does not
 * already have except each bot's own opponent model and random stream.
 */
export class BotRunner {
  private readonly table: LiveTable;
  private readonly clock: Clock;
  private readonly thinkingDelayMs: number;
  private readonly onProblem: ProblemHook;
  private readonly onDecision: ((input: PolicyInput, decision: PolicyDecision) => void) | null;
  private readonly bots = new Map<string, BotSeatState>();
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(options: BotRunnerOptions) {
    this.table = options.table;
    this.clock = options.clock;
    this.thinkingDelayMs = options.thinkingDelayMs ?? DEFAULT_THINKING_DELAY_MS;
    this.onProblem = options.onProblem ?? ((): void => undefined);
    this.onDecision = options.onDecision ?? null;
    this.unsubscribe = this.table.subscribe((notice) => this.onNotice(notice));
  }

  /** Registers a seat as a bot. The seat itself is taken through `LiveTable.sit`. */
  add(spec: BotSeatSpec): void {
    const profile = requireProfile(spec.profileId);
    this.bots.set(spec.userId, {
      spec,
      traits: expressTraits(profile, spec.difficulty),
      settings: DIFFICULTY_SETTINGS[spec.difficulty],
      random: createSeededRandom(spec.seed),
      model: new OpponentModel(spec.seat),
      observedHands: new Set(),
      pending: null,
      pendingAt: null,
    });
  }

  remove(userId: string): void {
    const bot = this.bots.get(userId);
    bot?.pending?.cancel();
    this.bots.delete(userId);
  }

  get seatCount(): number {
    return this.bots.size;
  }

  profileOf(userId: string): string | null {
    return this.bots.get(userId)?.spec.profileId ?? null;
  }

  /**
   * The whole registered spec for a seat, or null when the seat is not a bot here.
   *
   * `profileOf` answers a third of the question. A seat is `(profile, difficulty, seed)` and all
   * three change how it plays, so a restart that restored only the profile would look correct and
   * play differently — which is exactly the class of bug this accessor exists to let a test catch.
   */
  specOf(userId: string): BotSeatSpec | null {
    return this.bots.get(userId)?.spec ?? null;
  }

  /** Every registered spec. Used to decide whether live Coach is offered at this table. */
  specs(): readonly BotSeatSpec[] {
    return [...this.bots.values()].map((bot) => bot.spec);
  }

  /**
   * Whether the Coach panel may run *during* a hand at this table.
   *
   * Expert Legends advertises Coach in review only (`DIFFICULTY_SETTINGS.expert.coachAvailable`).
   * The match writes that difficulty onto each bot seat, so the registered specs are the fact.
   * A table with no bots, or only educational/realistic bots, keeps live Coach. One expert seat
   * turns it off. Unrehydrated seats are not registered and do not flip this.
   */
  coachDuringHand(): boolean {
    return this.specs().every((spec) => DIFFICULTY_SETTINGS[spec.difficulty].coachAvailable);
  }

  /** Cancels every scheduled decision and stops listening. Called when the room closes. */
  stop(): void {
    this.stopped = true;
    for (const bot of this.bots.values()) bot.pending?.cancel();
    this.bots.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // -----------------------------------------------------------------------
  // Reacting to the table
  // -----------------------------------------------------------------------

  private onNotice(notice: TableNotice): void {
    if (this.stopped) return;
    for (const bot of this.bots.values()) {
      this.observe(bot, notice);
      this.scheduleIfItsTurn(bot);
    }
  }

  /**
   * Feeds one bot's model from public information only.
   *
   * Actions first, completion second, which is the order the observer requires: folding a hand in
   * and then observing another of its actions is rejected outright, and rightly — double counting
   * corrupts every rate at once while looking completely normal.
   */
  private observe(bot: BotSeatState, notice: TableNotice): void {
    for (const event of notice.publicActions) {
      try {
        bot.model.observeAction(event);
      } catch (error) {
        this.onProblem('an opponent model refused a public action', {
          event: 'opponent-model',
          seat: bot.spec.seat,
          error: String(error),
        });
      }
    }
    if (!notice.handCompleted) return;
    const view = this.table.viewFor(bot.spec.userId);
    if (view === null || view.street !== 'complete') return;
    if (bot.observedHands.has(view.handId)) return;
    bot.observedHands.add(view.handId);
    try {
      // The bot's OWN redacted view: `result.showdowns` holds exactly the hands that were turned
      // over, so a hand that ended in a fold teaches it nothing about anybody's cards.
      bot.model.observe(view);
    } catch (error) {
      this.onProblem('an opponent model refused a completed hand', {
        event: 'opponent-model',
        seat: bot.spec.seat,
        error: String(error),
      });
    }
  }

  private scheduleIfItsTurn(bot: BotSeatState): void {
    const view = this.table.viewFor(bot.spec.userId);
    if (view === null || view.street === 'complete') return;
    if (view.toAct !== bot.spec.seat) return;

    const at = `${view.handId}:${view.actionSequence}`;
    if (bot.pendingAt === at) return;
    bot.pending?.cancel();
    bot.pendingAt = at;
    // The delay is for legibility, not deliberation: it is a constant, it does not depend on how
    // hard the decision is, and nothing in the UI may present it as thinking.
    bot.pending = this.clock.schedule(this.thinkingDelayMs, () => {
      bot.pending = null;
      bot.pendingAt = null;
      void this.act(bot, at);
    });
  }

  /**
   * Decides and submits, through exactly the same entry point a human uses.
   *
   * The view is re-read after the delay rather than captured before it: in between, the seat may
   * have been folded by a timeout, the hand may have completed, or somebody may have acted. If
   * the spot has moved, the decision is abandoned rather than submitted against a stale sequence.
   */
  private async act(bot: BotSeatState, at: string): Promise<void> {
    if (this.stopped) return;
    const view = this.table.viewFor(bot.spec.userId);
    if (view === null || view.street === 'complete') return;
    if (view.toAct !== bot.spec.seat) return;
    if (`${view.handId}:${view.actionSequence}` !== at) return;

    let decision: PolicyDecision;
    let input: PolicyInput;
    try {
      input = buildPolicyInput({
        view,
        seat: bot.spec.seat,
        traits: bot.traits,
        difficulty: bot.settings,
        observations: bot.model,
        random: bot.random,
      });
      decision = decide(input);
    } catch (error) {
      this.onProblem('a bot policy failed to decide', {
        event: 'bot-policy',
        seat: bot.spec.seat,
        error: String(error),
      });
      return;
    }
    this.onDecision?.(input, decision);

    try {
      // Same path, same validation, same idempotency as a person's action. A policy that proposed
      // something illegal is rejected by the engine here rather than trusted.
      await this.table.submitAction(bot.spec.userId, {
        action: decision.action,
        actionId: newBotActionId(),
        expectedSequence: view.actionSequence,
      });
    } catch (error) {
      this.onProblem('a bot action was rejected', {
        event: 'bot-action-rejected',
        seat: bot.spec.seat,
        error: String(error),
      });
    }
  }
}

/** An `actionId` for a bot, in the same alphabet the wire schema allows. */
function newBotActionId(): string {
  return `bot-${randomBytes(9).toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// Legends: seating a table of profiles
// ---------------------------------------------------------------------------

export interface LegendSeatPlan {
  readonly seat: SeatIndex;
  readonly profileId: string;
  readonly displayName: string;
  readonly disclosure: ProfileDisclosureDto;
}

/**
 * Plans the bot seats for a Legends match: the learner takes seat 0, profiles fill upwards.
 *
 * Every seat carries its full disclosure, because `ProfileDisclosureDto.disclaimers` is a
 * required non-empty array and there is deliberately no way to name a profile without it.
 */
export function planLegendSeats(
  profileIds: readonly string[],
  mode: NamingMode,
  maxSeats: number,
): readonly LegendSeatPlan[] {
  if (profileIds.length === 0) {
    throw new AppError('invalid_request', {
      fields: { profileIds: 'name at least one profile to play against' },
      logDetail: 'legend match requested with no profiles',
    });
  }
  if (profileIds.length + 1 > maxSeats) {
    throw new AppError('invalid_request', {
      fields: { profileIds: `at most ${maxSeats - 1} opponents fit at this table` },
      logDetail: `${profileIds.length} profiles exceed ${maxSeats} seats`,
    });
  }
  return profileIds.map((profileId, index) => {
    const profile = resolveProfile(profileId);
    return {
      seat: index + 1,
      profileId: profile.naming.id,
      displayName: botDisplayName(profile.naming.id),
      disclosure: profileDisclosure(profile.naming, mode),
    };
  });
}

// ---------------------------------------------------------------------------
// Comparing profiles on one hypothetical spot
// ---------------------------------------------------------------------------

/** The situation `POST /legends/compare` asks about. Every figure is the caller's. */
export interface HypotheticalSpot {
  readonly heroCards: readonly Card[];
  readonly board: readonly Card[];
  readonly street: 'preflop' | 'flop' | 'turn' | 'river';
  /** Chips already in the middle, INCLUDING the bet hero is facing. */
  readonly pot: number;
  readonly toCall: number;
  readonly heroStack: number;
  readonly opponentStack: number;
  readonly bigBlind: number;
}

const HERO_SEAT = 0;
const OPPONENT_SEAT = 1;

/**
 * Builds a `HandState` for a hypothetical spot, so that the engine — not this file — decides what
 * is legal in it.
 *
 * This is the one place in the server that constructs a state rather than dealing one, and it is
 * worth being explicit about why that is not a back door. The state never becomes a hand: it is
 * not registered, not persisted, has no room, and exists only long enough for `redactFor` to
 * produce a view whose `legalActions` came from `legalActions(state, seat)`. Synthesising a
 * `PlayerView` directly instead would mean writing out a legal-action set by hand, which is
 * exactly the duplication ADR 0002 forbids.
 *
 * The reconstruction makes three assumptions the caller cannot express, and the response says so
 * in its `takeaway`: it is heads-up, hero holds the button, and the money already in the middle
 * from earlier streets is split evenly between the two seats.
 */
export function buildHypotheticalState(spot: HypotheticalSpot): HandState {
  const dead = [...spot.heroCards, ...spot.board];
  if (new Set(dead).size !== dead.length) {
    throw new AppError('invalid_request', {
      fields: { heroCards: 'duplicates a board card' },
      logDetail: 'hypothetical spot had duplicate cards',
    });
  }
  const priorStreets = spot.pot - spot.toCall;
  if (priorStreets < 0) {
    throw new AppError('invalid_request', {
      fields: { pot: 'must include the bet hero is facing, so it cannot be smaller than toCall' },
      logDetail: `pot ${spot.pot} is smaller than toCall ${spot.toCall}`,
    });
  }

  // Two cards for the opponent, taken from what is left. They are never shown: `redactFor` nulls
  // them for hero's view, and the state is discarded immediately afterwards. They exist because
  // the engine's showdown and commitment machinery expects a full, distinct deck.
  const rest = orderedDeck().filter((card) => !dead.includes(card));
  const opponentCards = rest.slice(0, 2);
  const [opponentFirst, opponentSecond] = opponentCards;
  if (opponentFirst === undefined || opponentSecond === undefined) {
    throw new AppError('internal_error', { logDetail: 'not enough cards left for a hypothetical spot' });
  }
  const heroPair = twoCards(spot.heroCards, 'heroCards');

  const deck: Card[] = [
    heroPair[0],
    heroPair[1],
    opponentFirst,
    opponentSecond,
    ...spot.board,
    ...rest.slice(2),
  ];
  const commitment = commitToKnownDeck(
    `hypothetical:${spot.street}:${spot.pot}:${spot.toCall}`,
    deck,
    // Salts only. Nothing is dealt here, and the state is thrown away.
    createSecureRandom(),
  );

  const heroPrior = Math.floor(priorStreets / 2);
  const seats: SeatState[] = [
    {
      seat: HERO_SEAT,
      playerId: 'hero',
      stack: spot.heroStack,
      committedThisStreet: 0,
      committedTotal: heroPrior,
      holeCards: heroPair,
      status: 'active',
      lastActedAtBetLevel: null,
      isAllInThisHand: false,
    },
    {
      seat: OPPONENT_SEAT,
      playerId: 'opponent',
      stack: spot.opponentStack,
      committedThisStreet: spot.toCall,
      committedTotal: priorStreets - heroPrior + spot.toCall,
      holeCards: [opponentFirst, opponentSecond],
      status: 'active',
      lastActedAtBetLevel: spot.toCall,
      isAllInThisHand: false,
    },
  ];

  // A synthesised log entry for the bet hero is facing, so the policy answers "a bet" rather than
  // "no action" — `facingAction` is read off the action log, as it is in a real hand.
  const actions: LoggedAction[] =
    spot.toCall > 0
      ? [
          {
            sequence: 1,
            street: spot.street,
            seat: OPPONENT_SEAT,
            playerId: 'opponent',
            action: { type: 'bet', to: spot.toCall },
            amountPaid: spot.toCall,
            betLevelAfter: spot.toCall,
            potAfter: spot.pot,
            wasAutomatic: false,
            actionId: null,
          },
        ]
      : [];

  return {
    handId: 'hand_hypothetical',
    roomId: 'room_hypothetical',
    handNumber: 1,
    config: {
      smallBlind: Math.max(1, Math.floor(spot.bigBlind / 2)),
      bigBlind: spot.bigBlind,
      ante: 0,
      maxSeats: 2,
      actionTimeoutSeconds: 30,
    },
    buttonSeat: HERO_SEAT,
    // Heads-up the button posts the small blind, so hero holds both — which is what the response's
    // `takeaway` already tells the caller it assumed. Recorded rather than derived because a hand
    // dealt under the dead-button rule can have a dead button or a dead small blind, and a
    // reconstruction has no way to know which; this one is neither.
    smallBlindSeat: HERO_SEAT,
    bigBlindSeat: OPPONENT_SEAT,
    seats,
    board: [...spot.board],
    street: spot.street,
    deck,
    deckCursor: 4 + spot.board.length,
    deckSalts: commitment.secret.salts,
    commitment: commitment.commitment,
    toAct: HERO_SEAT,
    betLevel: spot.toCall,
    lastFullRaiseBetLevel: spot.toCall,
    lastFullRaiseIncrement: Math.max(spot.toCall, spot.bigBlind),
    potFromPreviousStreets: priorStreets,
    forcedBets: [],
    actions,
    actionSequence: actions.length,
    result: null,
    // Labelled for what it is. A hypothetical is not a fairly dealt hand and must never be
    // mistaken for one.
    randomSourceKind: 'fixed-deck-scenario',
    holeCardPositions: { [HERO_SEAT]: [0, 1], [OPPONENT_SEAT]: [2, 3] },
    boardPositions: spot.board.map((_card, index) => 4 + index),
  };
}

function twoCards(cards: readonly Card[], field: string): readonly [Card, Card] {
  const [first, second] = cards;
  if (first === undefined || second === undefined || cards.length !== 2) {
    throw new AppError('invalid_request', {
      fields: { [field]: 'must be exactly two cards' },
      logDetail: `${field} had ${cards.length} cards`,
    });
  }
  return [first, second];
}

export interface CompareRequest {
  readonly spot: HypotheticalSpot;
  readonly profileIds: readonly string[];
  readonly difficulty: LegendDifficulty;
  readonly trials: number;
  readonly namingMode: NamingMode;
  /** Assumed opponent range for the maths. Stated in the report, never implied. */
  readonly opponentRange?: string;
}

/** Trials per profile. Bounded because each trial runs a policy, and a policy samples equity. */
export const MAX_COMPARE_TRIALS = 40;

/**
 * Runs every profile through the same spot, `trials` times each, and reports the distribution.
 *
 * The distribution is the point: these styles are probabilistic, not scripted, so a single sample
 * would be a misleading answer to "what would this profile do here?". Each trial draws from the
 * same seeded stream per profile, so the answer is reproducible.
 */
export function compareProfilesOnSpot(request: CompareRequest): CompareProfilesResponse {
  const state = buildHypotheticalState(request.spot);
  const view = redactFor(state, { viewerSeat: HERO_SEAT });
  const settings = DIFFICULTY_SETTINGS[difficultyOf(request.difficulty)];
  const trials = Math.max(1, Math.min(MAX_COMPARE_TRIALS, request.trials));

  const entries: ProfileComparisonEntry[] = request.profileIds.map((profileId, index) => {
    const profile = resolveProfile(profileId);
    const traits = expressTraits(profile, difficultyOf(request.difficulty));
    const random = createSeededRandom(seedFor('compare', index, request.spot.pot));
    const model = new OpponentModel(HERO_SEAT);

    const counts = new Map<string, { count: number; readonly fractions: number[] }>();
    let last: PolicyDecision | null = null;
    for (let trial = 0; trial < trials; trial += 1) {
      const decision = decide(
        buildPolicyInput({
          view,
          seat: HERO_SEAT,
          traits,
          difficulty: settings,
          observations: model,
          random,
        }),
      );
      last = decision;
      const action = decision.action;
      const bucket = counts.get(action.type) ?? { count: 0, fractions: [] };
      bucket.count += 1;
      if (action.type === 'bet' || action.type === 'raise') {
        bucket.fractions.push(action.to / Math.max(1, request.spot.pot));
      }
      counts.set(action.type, bucket);
    }
    if (last === null) {
      throw new AppError('internal_error', { logDetail: 'a comparison produced no decision' });
    }

    const distribution = [...counts.entries()]
      .map(([action, bucket]) => ({
        action,
        probability: bucket.count / trials,
        medianSizeToPotFraction: median(bucket.fractions),
      }))
      .sort((left, right) => right.probability - left.probability);
    const modal = distribution[0];

    return {
      profileId: profile.naming.id,
      disclosure: profileDisclosure(profile.naming, request.namingMode),
      actionDistribution: distribution,
      modalAction: modal?.action ?? last.action.type,
      reasoning: {
        modelPreference: last.modelPreference,
        drivingTraits: last.drivingTraits.map((trait) => ({
          key: traitKeyOf(trait.key),
          label: trait.label,
          value: trait.value,
        })),
        whatChangedIt: last.whatChangedIt,
        actionProbabilities: last.distribution.map((weighted) => ({
          action: weighted.action.type,
          probability: weighted.probability,
        })),
      },
    };
  });

  return {
    analysis: coachReportFor(request),
    entries,
    trials,
    takeaway:
      'Each profile answered the same spot, reconstructed heads-up with hero on the button and any ' +
      'earlier-street money split evenly between the two seats. Where two of these styles disagree, ' +
      'that disagreement is the lesson: the maths above is identical for all of them, so the spread ' +
      'comes from what each style is willing to do with the same price.',
  };
}

/** The maths for the spot, identical for every profile. */
function coachReportFor(request: CompareRequest): CoachReport {
  const spot = request.spot;
  const range = opponentRangeFor(request);
  return buildCoachReport({
    heroCards: spot.heroCards,
    board: spot.board,
    street: spot.street,
    opponents: [{ label: 'the profile', range }],
    pot: spot.pot,
    toCall: spot.toCall,
    // A comparison spot is reconstructed rather than played: earlier-street money is
    // split evenly between the two seats and lands in `pot`, so hero has nothing out
    // on the current street. Stating it keeps the raise totals the Coach publishes
    // legal for the spot as reconstructed.
    heroCommittedThisStreet: 0,
    heroStack: spot.heroStack,
    opponentStacks: [spot.opponentStack],
    bigBlind: spot.bigBlind,
    // A comparison spot has no `HandState`, so there is no `legalActions(state, seat)` to
    // ask. Derive the set instead of omitting it: an omitted set used to mean "everything
    // is permitted", which is how the Coach came to price a raise against an opponent with
    // nothing behind. Passing it explicitly is also what lets the field stay required, so
    // a future caller cannot reopen the hole by simply not thinking about it.
    legalActions: deriveLegalActions({
      toCall: spot.toCall,
      heroCommittedThisStreet: 0,
      heroStack: spot.heroStack,
      opponentStacks: [spot.opponentStack],
    }),
  });
}

/**
 * The default assumption when nobody names a range: the top 40% of hands.
 *
 * Stated as a number here and reported in words by the Coach, because an assumed range is an
 * input and not a measurement — the whole product turns on the difference.
 */
export const DEFAULT_ASSUMED_RANGE_PERCENT = 40;

/**
 * Parses a range in either of the two forms the contract's `RANGE_PATTERN` accepts.
 *
 * `top:NN` is not range notation and `parseRange` rightly refuses it: it is a *percentage of the
 * computed strength ordering*, so it has to go through `topPercentRange` first, which builds the
 * notation from that ordering and hands it to the same parser. One path, one parser, and the
 * percentage form cannot silently mean something different from the notation form.
 */
export function assumedRange(notation: string, dead: readonly Card[]): ParsedRange {
  const percent = /^top:(\d{1,3})$/.exec(notation.trim());
  if (percent !== null) {
    const value = Number(percent[1]);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new AppError('invalid_request', {
        fields: { opponentRange: 'a top percentage must be between 1 and 100' },
        logDetail: `rejected range "${notation}"`,
      });
    }
    return parseRange(topPercentRange(value).notation, dead);
  }
  try {
    return parseRange(notation, dead);
  } catch (error) {
    throw new AppError('invalid_request', {
      fields: { opponentRange: 'is not a range this server can read' },
      logDetail: 'range parser refused an assumed range',
      cause: error,
    });
  }
}

function opponentRangeFor(request: CompareRequest): ParsedRange {
  const dead = [...request.spot.heroCards, ...request.spot.board];
  return assumedRange(request.opponentRange ?? `top:${DEFAULT_ASSUMED_RANGE_PERCENT}`, dead);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const at = sorted[middle];
  if (at === undefined) return null;
  if (sorted.length % 2 === 1) return at;
  const before = sorted[middle - 1];
  return before === undefined ? at : (before + at) / 2;
}

/** The wire difficulty and the package's own are the same three names; this proves it. */
export function difficultyOf(difficulty: LegendDifficulty): Difficulty {
  return difficulty;
}

/** Narrows a policy trait key to the wire's key union, which is the same list. */
function traitKeyOf(key: PolicyDecision['drivingTraits'][number]['key']): LegendTraitKeyOnWire {
  return key;
}

type LegendTraitKeyOnWire = ProfileComparisonEntry['reasoning']['drivingTraits'][number]['key'];
