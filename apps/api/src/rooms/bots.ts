/**
 * Where `@prl/poker-ai` meets the engine. A bot receives only `table.viewFor(botUserId)`.
 * `buildPolicyInput` is the one place a `PolicyInput` is built, from a redacted view alone, and
 * `test/bots.test.ts` scans a captured input for other seats' cards and every secret field name.
 * Actions go through `LiveTable.submitAction` like a human's, so the engine rejects an illegal one.
 * Decisions use a seeded stream so a match replays. Cards are never dealt from it.
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
  type AssumedRange,
  buildCoachReport,
  deriveContestablePot,
  deriveLegalActions,
  expandAssumedRange,
  LIVE_COACH_POLICY,
  type ParsedRange,
} from '@prl/poker-math';
import { AppError } from '../errors.ts';
import type { ProblemHook } from '../observability/telemetry.ts';
import type { LiveTable, TableNotice } from './table.ts';
import type { Clock, ScheduledTask } from './timers.ts';

/**
 * SplitMix32 for decisions, never for cards, so a Legends match replays from its seed. Written out
 * here because the engine's `createDeterministicRandomForTests` must never appear in server source.
 * It is labelled `deterministic-test-only`, which only `startHand` records, and it is never passed there.
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
    // Rejection sampling, because `x % n` favours low indices unless n divides 2^32.
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

/**
 * The five legacy names `createRoomBodySchema` accepts, mapped to the nearest strategy profile.
 * One-way, for reading a request. Since migration `0003` the column stores the profile id itself.
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

/** `users_display_name_shape` allows 2..24 characters. */
const MAX_BOT_NAME = 24;

/** Whole words only, because "Reading Pressure Special" reads like a mistake. */
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

/**
 * A profile seated twice is numbered, because the narration names a seat by display name alone and
 * `BOT_TABLE` seats two `tight-aggressive` bots. The number fits inside the 24 characters, so a long
 * name loses a word before it loses its number.
 */
export function botDisplayNames(profileIds: readonly string[]): readonly string[] {
  const total = new Map<string, number>();
  for (const id of profileIds) total.set(id, (total.get(id) ?? 0) + 1);
  const seen = new Map<string, number>();
  return profileIds.map((id) => {
    if ((total.get(id) ?? 0) < 2) return botDisplayName(id);
    const ordinal = (seen.get(id) ?? 0) + 1;
    seen.set(id, ordinal);
    const suffix = ` ${String(ordinal)}`;
    const words = botDisplayName(id).split(' ');
    while (words.length > 1 && `${words.join(' ')}${suffix}`.length > MAX_BOT_NAME) words.pop();
    return `${words.join(' ').slice(0, MAX_BOT_NAME - suffix.length)}${suffix}`;
  });
}

export interface PolicyInputRequest {
  /** Already redacted for this seat. The only state a policy is given. */
  readonly view: PlayerView;
  readonly seat: SeatIndex;
  readonly traits: Traits;
  readonly difficulty: DifficultySettings;
  readonly observations: OpponentModel;
  readonly random: RandomSource;
}

/** Hole cards come from the view's own seat, where `redactFor` puts them. No other source is taken. */
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

export interface BotSeatSpec {
  readonly userId: string;
  readonly seat: SeatIndex;
  readonly profileId: string;
  readonly difficulty: Difficulty;
  /** Derive it with `seedFor`. */
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
  /** Legibility only. Constant, and not to be presented as thinking. Runs on the injected clock. */
  readonly thinkingDelayMs?: number;
  /** Non-fatal problems, with a typed event on the detail so each is its own counter. */
  readonly onProblem?: ProblemHook;
  /** Test seam: lets a test capture the exact `PolicyInput` a bot was given. */
  readonly onDecision?: (input: PolicyInput, decision: PolicyDecision) => void;
}

/** Long enough to be readable, short enough not to be a wait. */
const DEFAULT_THINKING_DELAY_MS = 700;

/** One runner per table. Its only state beyond the table's is each bot's model and random stream. */
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

  /** The seat itself is taken through `LiveTable.sit`. */
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

  /** A seat plays by `(profile, difficulty, seed)`, so a test of a restart needs all three. */
  specOf(userId: string): BotSeatSpec | null {
    return this.bots.get(userId)?.spec ?? null;
  }

  specs(): readonly BotSeatSpec[] {
    return [...this.bots.values()].map((bot) => bot.spec);
  }

  /** One expert seat turns live Coach off (`DIFFICULTY_SETTINGS.expert.coachAvailable`). */
  coachDuringHand(): boolean {
    return this.specs().every((spec) => DIFFICULTY_SETTINGS[spec.difficulty].coachAvailable);
  }

  stop(): void {
    this.stopped = true;
    for (const bot of this.bots.values()) bot.pending?.cancel();
    this.bots.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private onNotice(notice: TableNotice): void {
    if (this.stopped) return;
    for (const bot of this.bots.values()) {
      this.observe(bot, notice);
      this.scheduleIfItsTurn(bot);
    }
  }

  /** Public information only. Actions before completion, because the model rejects double counting. */
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
    bot.pending = this.clock.schedule(this.thinkingDelayMs, () => {
      bot.pending = null;
      bot.pendingAt = null;
      void this.act(bot, at);
    });
  }

  /** Re-reads the view after the delay and abandons the decision if the spot has moved. */
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

/** In the alphabet the wire schema allows. */
function newBotActionId(): string {
  return `bot-${randomBytes(9).toString('base64url')}`;
}

export interface LegendSeatPlan {
  readonly seat: SeatIndex;
  readonly profileId: string;
  readonly displayName: string;
  readonly disclosure: ProfileDisclosureDto;
}

/** The learner takes seat 0. Every seat carries its disclosure, which a profile is never named without. */
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
  const profiles = profileIds.map(resolveProfile);
  const names = botDisplayNames(profiles.map((profile) => profile.naming.id));
  return profiles.map((profile, index) => {
    return {
      seat: index + 1,
      profileId: profile.naming.id,
      displayName: names[index] ?? botDisplayName(profile.naming.id),
      disclosure: profileDisclosure(profile.naming, mode),
    };
  });
}

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
 * The one state the server builds rather than deals, so the engine decides what is legal (ADR 0002).
 * It is never registered or persisted. It assumes heads-up, hero on the button, and earlier streets
 * split evenly, and the response's `takeaway` says so.
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
      fields: { pot: 'must include the bet you are facing, so it cannot be smaller than toCall' },
      logDetail: `pot ${spot.pot} is smaller than toCall ${spot.toCall}`,
    });
  }

  // The engine needs a full distinct deck. `redactFor` hides these from hero's view.
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

  // `facingAction` is read off the action log, so the bet hero faces needs an entry.
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
    // Heads-up the button posts the small blind. Recorded, because a dead-button hand can differ.
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
    // A hypothetical is not a fairly dealt hand.
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

/** A distribution, because these styles are probabilistic. Seeded per profile, so reproducible. */
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
    const exemplars = new Map<string, PolicyDecision>();
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
      if (!exemplars.has(action.type)) exemplars.set(action.type, decision);
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

    // The explanation comes from a trial that chose the modal action. Taking the last trial put a
    // different action under the bar in 161 of 396 columns (12 profiles x 33 spots).
    const representative = (modal === undefined ? undefined : exemplars.get(modal.action)) ?? last;

    return {
      profileId: profile.naming.id,
      disclosure: profileDisclosure(profile.naming, request.namingMode),
      actionDistribution: distribution,
      modalAction: modal?.action ?? last.action.type,
      reasoning: {
        modelPreference: representative.modelPreference,
        drivingTraits: representative.drivingTraits.map((trait) => ({
          key: traitKeyOf(trait.key),
          label: trait.label,
          value: trait.value,
        })),
        whatChangedIt: representative.whatChangedIt,
        actionProbabilities: representative.distribution.map((weighted) => ({
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
      'Each profile answered the same spot, reconstructed heads-up with you on the button and any ' +
      'earlier-street money split evenly between the two seats. Where two of these styles disagree, ' +
      'that disagreement is the lesson: the maths above is identical for all of them, so the spread ' +
      'comes from what each style is willing to do with the same price.',
  };
}

function coachReportFor(request: CompareRequest): CoachReport {
  const spot = request.spot;
  const range = opponentRangeFor(request);
  return buildCoachReport({
    heroCards: spot.heroCards,
    board: spot.board,
    street: spot.street,
    opponents: [{ label: 'the profile', range }],
    pot: spot.pot,
    // Always heads-up, so `deriveContestablePot` is exact. Required, so no call site forgets it.
    contestablePot: deriveContestablePot({
      pot: spot.pot,
      toCall: spot.toCall,
      heroCommittedThisStreet: 0,
      heroStack: spot.heroStack,
      opponentStacks: [spot.opponentStack],
    }),
    toCall: spot.toCall,
    // Earlier streets land in `pot`, so hero has nothing out on this street.
    heroCommittedThisStreet: 0,
    heroStack: spot.heroStack,
    opponentStacks: [spot.opponentStack],
    bigBlind: spot.bigBlind,
    // No `HandState` to ask, so derived. An omitted set once meant everything was permitted.
    legalActions: deriveLegalActions({
      toCall: spot.toCall,
      heroCommittedThisStreet: 0,
      heroStack: spot.heroStack,
      opponentStacks: [spot.opponentStack],
    }),
  });
}

/** Only the bounds of `top:NN` are checked, because expanding it builds the preflop strength table. */
export function opponentRangeOption(text: string): AssumedRange {
  const percent = /^top:(\d{1,3})$/.exec(text.trim());
  if (percent === null) return { kind: 'notation', notation: text };
  const value = Number(percent[1]);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new AppError('invalid_request', {
      fields: { opponentRange: 'a top percentage must be between 1 and 100' },
      logDetail: `rejected range "${text}"`,
    });
  }
  return { kind: 'topPercent', percent: value };
}

export function assumedRange(range: AssumedRange, dead: readonly Card[]): ParsedRange {
  if (range.kind === 'topPercent') return expandAssumedRange(range, dead);
  try {
    return expandAssumedRange(range, dead);
  } catch (error) {
    throw new AppError('invalid_request', {
      fields: { opponentRange: 'is not a range this server can read' },
      logDetail: 'range parser refused an assumed range',
      cause: error,
    });
  }
}

/** The range a comparison assumes: the caller's, or the live Coach's top 40% when none is named. */
function opponentRangeFor(request: CompareRequest): ParsedRange {
  const dead = [...request.spot.heroCards, ...request.spot.board];
  const named = request.opponentRange;
  return assumedRange(named === undefined ? LIVE_COACH_POLICY.range : opponentRangeOption(named), dead);
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

/** The wire's three names and the package's are the same, which this assignment proves. */
export function difficultyOf(difficulty: LegendDifficulty): Difficulty {
  return difficulty;
}

function traitKeyOf(key: PolicyDecision['drivingTraits'][number]['key']): LegendTraitKeyOnWire {
  return key;
}

type LegendTraitKeyOnWire = ProfileComparisonEntry['reasoning']['drivingTraits'][number]['key'];
