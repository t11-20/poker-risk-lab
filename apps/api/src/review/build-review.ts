/**
 * Hand review, assembled at read time from `prl.hands`, `prl.hand_seats` and `prl.hand_actions`. No
 * database and no Fastify here, so `test/hands.test.ts` proves the visibility rules without Postgres.
 * No deck or salt is stored (migration 0001), and none is needed. The board is a prefix of
 * `prl.hands.board`, hole cards follow the viewer-or-showed-down rule, and chips are re-summed from
 * the action rows.
 * The blinds are RECOVERED from the rows, never derived from the button. Under the dead-button rule
 * the small blind may be dead and the button in an empty chair, and deriving them made the pot
 * cross-check refuse every decision in such hands.
 * Only the viewer's own decisions are analysed. Opponents are modelled by `REVIEW_OPPONENT_RANGE`,
 * which the report states as an assumption.
 * Work is bounded by `maxAnalysedDecisions`, a fixed sample count and a wall-clock backstop. Coach
 * reports are 99.9% of the cost (156 ms against 0.2 ms for one hand), so `planAnalysis` decides here
 * and the reports run on a worker thread. `buildHandReview` computes locally for fixtures and tests,
 * and `buildHandReviewOn` is what the API serves.
 */

import type {
  AutomaticReason,
  CoachReport,
  HandReviewDecision,
  HandReviewResponse,
  HandReviewSeat,
  HandSummary,
} from '@prl/contracts';
import type {
  Action,
  Card,
  DeckCommitment,
  DeckReveal,
  LegalAction,
  PlayerView,
  RevealedCard,
  SeatIndex,
  SeatStatus,
  SeatView,
  TableConfig,
} from '@prl/poker-engine';
import {
  COMMITMENT_VERSION,
  cardToString,
  contestablePotFor,
  DECK_SIZE,
  orderFrom,
  PROOF_LENGTH,
  parseCard,
  verifyDeckReveal,
} from '@prl/poker-engine';
import type { Street as BettingStreetName, CoachAction, ParsedRange } from '@prl/poker-math';
import { buildCoachReport, deriveLegalActions, parseRange } from '@prl/poker-math';
import type { CoachTask } from '../workers/equity-worker.ts';

/**
 * A function, not a `WorkerPool`, so this module touches no pool. The `import type` matters, because
 * `equity-worker.ts` throws if it is loaded on the main thread. Rejections are handled by `failed`.
 */
export type ReviewAnalyser = (task: CoachTask) => Promise<CoachReport>;

/**
 * The columns a `HandSummary` reads. `HandRow` extends it, so the list endpoint can pass a narrower
 * projection. `jsonb` columns are `unknown` and narrowed below, so a malformed row degrades to "no
 * analysis" instead of throwing. Timestamps may be `string` because that depends on the driver.
 */
export interface HandSummaryRow {
  readonly id: string;
  readonly room_id: string;
  readonly hand_number: number;
  readonly board: unknown;
  readonly result: unknown;
  readonly started_at: Date | string;
  readonly completed_at: Date | string | null;
}

/** `prl.hands`, as the driver hands it back. */
export interface HandRow extends HandSummaryRow {
  readonly button_seat: number;
  readonly config: unknown;
  readonly commitment_root: string;
  readonly commitment_context: string;
  readonly street: string;
  readonly reveal: unknown;
  /**
   * Read because `PlayerView` carries it. A review must never claim `csprng` for a fixed-deck hand.
   */
  readonly random_source_kind: 'csprng' | 'deterministic-test-only' | 'fixed-deck-scenario';
}

/**
 * `hole_cards` MUST already be filtered by `user_id = :viewer OR showed_down`. This module applies the
 * rule again, so an edited query still cannot leak.
 */
export interface HandSeatRow {
  readonly seat: number;
  readonly user_id: string | null;
  readonly display_name: string | null;
  readonly is_bot: boolean;
  readonly starting_stack: number;
  readonly hole_cards: unknown;
  readonly net_result: number | null;
  readonly status: string;
  readonly showed_down: boolean;
}

/** `prl.hand_actions`, in `sequence` order. */
export interface HandActionRow {
  readonly sequence: number;
  readonly street: string;
  readonly seat: number;
  readonly action_type: string;
  readonly action_to: number | null;
  readonly amount_paid: number;
  readonly bet_level_after: number;
  readonly pot_after: number;
  readonly was_automatic: boolean;
  /** Null on a person's decision, and on an automatic row archived before migration 0009. */
  readonly automatic_reason: AutomaticReason | null;
}

/**
 * Written out, not a top percentage, because it is instant (no strength table) and the learner sees
 * the exact string. A middling, unadjusted range of about a fifth of all hands.
 */
export const REVIEW_OPPONENT_RANGE = '22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo';

/**
 * At this sample count the printed interval is about one percentage point. More samples would only
 * change the third digit of a number whose second digit is an assumption.
 */
export const REVIEW_EQUITY_SAMPLES = 10_000;

/** Hero decisions analysed per review. Beyond this the later ones report `analysis: null`. */
export const MAX_ANALYSED_DECISIONS = 8;

/** Backstop wall-clock budget for the whole analysis pass. See the header note. */
export const DEFAULT_ANALYSIS_BUDGET_MS = 8_000;

/** Placeholder for a seat whose account was deleted (`hand_seats.user_id` is SET NULL). */
const DETACHED_SEAT_NAME = 'Seat';

/** Board cards in play on each betting street. Streets outside this map are not decision points. */
const BOARD_LENGTH_BY_STREET: Readonly<Record<string, number>> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

const BETTING_STREET_NAMES: readonly BettingStreetName[] = ['preflop', 'flop', 'turn', 'river'];

/**
 * Reads through `Reflect.get` into `unknown`, as `logging.ts` documents, so no `any` or cast escapes.
 */
function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const entry: unknown = Reflect.get(value, key);
    record[key] = entry;
  }
  return record;
}

function asInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function isoTimestamp(value: Date | string): string {
  if (typeof value === 'string') return value;
  return value.toISOString();
}

/** `null`, never a partial list. A half-read board would analyse a different spot. */
function cardsFromJson(value: unknown): { notation: readonly string[]; cards: readonly Card[] } | null {
  if (!Array.isArray(value)) return null;
  const notation: string[] = [];
  const cards: Card[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    try {
      const card = parseCard(entry);
      cards.push(card);
      notation.push(cardToString(card));
    } catch {
      return null;
    }
  }
  return { notation, cards };
}

/**
 * The first four are what the replay needs. `actionTimeoutSeconds` is nullable because only the
 * Legends comparison reads it, and an unreadable timeout must not cost a hand its whole review.
 */
interface TableConfigFields {
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante: number;
  readonly maxSeats: number;
  /** Null when the stored value is absent or unreadable. Only the comparison path cares. */
  readonly actionTimeoutSeconds: number | null;
}

function configFromJson(value: unknown): TableConfigFields | null {
  const record = asRecord(value);
  if (record === null) return null;
  const smallBlind = asInteger(record['smallBlind']);
  const bigBlind = asInteger(record['bigBlind']);
  const ante = asInteger(record['ante']);
  const maxSeats = asInteger(record['maxSeats']);
  const timeout = asInteger(record['actionTimeoutSeconds']);
  if (smallBlind === null || bigBlind === null || ante === null || maxSeats === null) return null;
  if (smallBlind <= 0 || bigBlind <= 0 || ante < 0 || maxSeats < 2 || maxSeats > 6) return null;
  return {
    smallBlind,
    bigBlind,
    ante,
    maxSeats,
    actionTimeoutSeconds: timeout !== null && timeout > 0 ? timeout : null,
  };
}

/** One seat, after the jsonb has been parsed and the visibility rule applied. */
interface ReviewSeat {
  readonly seat: number;
  readonly userId: string | null;
  readonly displayName: string;
  readonly isBot: boolean;
  readonly startingStack: number;
  /** Null while the hand is unsettled; `hand_seats.net_result` is only written at settlement. */
  readonly netResult: number | null;
  readonly status: string;
  readonly showedDown: boolean;
  /** False for a seat that sat the hand out. It holds no cards and is nobody's opponent. */
  readonly dealtIn: boolean;
  /** Null unless this is the viewer's own seat or the seat showed down. */
  readonly visibleNotation: readonly string[] | null;
  /** The same cards as `visibleNotation`, for the maths. Null under the same rule. */
  readonly visibleCards: readonly Card[] | null;
}

/**
 * Own seat always, any other seat only once it showed down. A folder's cards stay sealed after the
 * hand as well as during it.
 */
function toReviewSeat(row: HandSeatRow, viewerUserId: string): ReviewSeat {
  const isOwnSeat = row.user_id !== null && row.user_id === viewerUserId;
  const maySeeCards = isOwnSeat || row.showed_down;
  const parsed = maySeeCards ? cardsFromJson(row.hole_cards) : null;
  return {
    seat: row.seat,
    userId: row.user_id,
    displayName: asNonEmptyString(row.display_name) ?? `${DETACHED_SEAT_NAME} ${row.seat}`,
    isBot: row.is_bot,
    startingStack: row.starting_stack,
    netResult: row.net_result,
    status: row.status,
    showedDown: row.showed_down,
    dealtIn: row.status !== 'sittingOut' && row.starting_stack > 0,
    visibleNotation: parsed === null ? null : parsed.notation,
    visibleCards: parsed === null ? null : parsed.cards,
  };
}

function toResponseSeat(seat: ReviewSeat): HandReviewSeat {
  return {
    seat: seat.seat,
    displayName: seat.displayName,
    isBot: seat.isBot,
    startingStack: seat.startingStack,
    // The contract has no null here, so an unsettled hand reads as zero. `HandSummary.heroNet` is
    // nullable and does carry the distinction, which is where a client should look for it.
    net: seat.netResult ?? 0,
    holeCards: seat.visibleNotation,
    showedDown: seat.showedDown,
  };
}

interface RevealCheck {
  readonly reveal: DeckReveal | null;
  readonly verification: HandReviewResponse['verification'];
}

const HEX_32_BYTES = /^[0-9a-f]{64}$/;

function revealedCardFromJson(value: unknown): RevealedCard | null {
  const record = asRecord(value);
  if (record === null) return null;
  const index = asInteger(record['index']);
  const card = asInteger(record['card']);
  const saltHex = asNonEmptyString(record['saltHex']);
  const rawProof = record['proof'];
  if (index === null || index < 0 || index >= DECK_SIZE) return null;
  if (card === null || card < 0 || card >= DECK_SIZE) return null;
  if (saltHex === null || !HEX_32_BYTES.test(saltHex)) return null;
  if (!Array.isArray(rawProof) || rawProof.length !== PROOF_LENGTH) return null;
  const proof: string[] = [];
  for (const hash of rawProof) {
    if (typeof hash !== 'string' || !HEX_32_BYTES.test(hash)) return null;
    proof.push(hash);
  }
  return { index, card, saltHex, proof };
}

type RevealParse =
  | { readonly ok: true; readonly reveal: DeckReveal }
  | { readonly ok: false; readonly reason: string };

/**
 * Rebuilt field by field, as `redactFor` does, so an extra key in the column cannot reach a client.
 */
function revealFromJson(value: unknown, root: string, context: string): RevealParse {
  const record = asRecord(value);
  const commitmentRecord = record === null ? null : asRecord(record['commitment']);
  if (record === null || commitmentRecord === null) {
    return { ok: false, reason: 'the stored reveal is not in the expected shape' };
  }
  // `DeckCommitment` pins `algorithm` and `version` as literals, so a disagreeing value is refused.
  if (commitmentRecord['algorithm'] !== 'sha256' || commitmentRecord['version'] !== COMMITMENT_VERSION) {
    return { ok: false, reason: 'the stored reveal uses a commitment scheme this server cannot verify' };
  }
  const storedRoot = asNonEmptyString(commitmentRecord['root']);
  const storedContext = asNonEmptyString(commitmentRecord['context']);
  if (storedRoot === null || storedContext === null) {
    return { ok: false, reason: 'the stored reveal is missing its commitment root or context' };
  }
  // The reveal has to be a reveal *of this hand*. A proof set carrying another hand's root or
  // context would verify perfectly well against itself and mean nothing here.
  if (storedRoot !== root || storedContext !== context) {
    return { ok: false, reason: 'the stored reveal does not belong to this hand' };
  }
  // A complete reveal would expose every folder's cards. Two CHECK constraints refuse to store one, and
  // this refuses to serve one.
  if (record['complete'] !== false) {
    return { ok: false, reason: 'a whole-deck reveal is never valid for a hand and will not be served' };
  }

  const rawCards = record['cards'];
  if (!Array.isArray(rawCards)) {
    return { ok: false, reason: 'the stored reveal has no list of proved positions' };
  }
  const cards: RevealedCard[] = [];
  for (const entry of rawCards) {
    const card = revealedCardFromJson(entry);
    if (card === null) return { ok: false, reason: 'one of the stored proofs is malformed' };
    cards.push(card);
  }

  const commitment: DeckCommitment = {
    algorithm: 'sha256',
    version: COMMITMENT_VERSION,
    root: storedRoot,
    context: storedContext,
  };
  return { ok: true, reveal: { commitment, cards, complete: false } };
}

/**
 * A fold-out hand has an empty reveal, reported as `ok: true` with `verifiedPositions: 0`, never as a
 * failure.
 */
function checkReveal(hand: HandRow): RevealCheck {
  const stored = hand.reveal ?? resultReveal(hand.result);
  if (stored === null || stored === undefined) {
    return {
      reveal: null,
      verification: {
        ok: false,
        reason: 'this hand has not published a reveal yet, so there is nothing to verify',
        verifiedPositions: 0,
      },
    };
  }

  const parsed = revealFromJson(stored, hand.commitment_root, hand.commitment_context);
  if (!parsed.ok) {
    return { reveal: null, verification: { ok: false, reason: parsed.reason, verifiedPositions: 0 } };
  }

  const verified = verifyDeckReveal(parsed.reveal);
  const verification: { ok: boolean; reason?: string; verifiedPositions: number } = {
    ok: verified.ok,
    verifiedPositions: verified.verifiedIndices.length,
  };
  if (verified.reason !== undefined) verification.reason = verified.reason;
  if (verified.ok && verified.verifiedIndices.length === 0) {
    verification.reason =
      'nothing became public in this hand — no board was dealt and nobody showed — so there is ' +
      'nothing to prove, and an empty reveal is the correct result';
  }
  return { reveal: parsed.reveal, verification };
}

function resultReveal(result: unknown): unknown {
  const record = asRecord(result);
  return record === null ? null : (record['reveal'] ?? null);
}

function sumResultPots(result: unknown): number {
  const record = asRecord(result);
  if (record === null) return 0;
  const pots = record['pots'];
  if (!Array.isArray(pots)) return 0;
  let total = 0;
  for (const entry of pots) {
    const pot = asRecord(entry);
    const amount = pot === null ? null : asInteger(pot['amount']);
    if (amount !== null && amount > 0) total += amount;
  }
  return total;
}

function endedByFold(result: unknown): boolean {
  const record = asRecord(result);
  return record !== null && record['endedByFold'] === true;
}

export interface HandSummaryInput {
  readonly hand: HandSummaryRow;
  /** The viewer's own `hand_seats.net_result`, or null while the hand is unsettled. */
  readonly heroNet: number | null;
  /**
   * `max(pot_after)` over the hand's actions, or null with none. A hand with no actions falls back to
   * the sum of the settled pot layers.
   */
  readonly maxPotAfter: number | null;
}

/** The list row and the review header are the same shape, built in one place so they cannot drift. */
export function toHandSummary(input: HandSummaryInput): HandSummary {
  const { hand } = input;
  const board = cardsFromJson(hand.board);
  return {
    id: hand.id,
    roomId: hand.room_id,
    handNumber: hand.hand_number,
    startedAt: isoTimestamp(hand.started_at),
    completedAt: hand.completed_at === null ? null : isoTimestamp(hand.completed_at),
    board: board === null ? [] : board.notation,
    heroNet: input.heroNet,
    endedByFold: endedByFold(hand.result),
    potTotal: input.maxPotAfter ?? sumResultPots(hand.result),
  };
}

/** Mutable per-seat tally, rebuilt from the action log rather than read from anywhere. */
interface ReplaySeat {
  stack: number;
  committedThisStreet: number;
  folded: boolean;
  readonly dealtIn: boolean;
}

interface ReplayState {
  readonly seats: Map<number, ReplaySeat>;
  potInMiddle: number;
  betLevel: number;
  street: string;
}

/**
 * `smallBlindSeat` is null for a DEAD small blind, a legitimate dead-button outcome, spelled as the
 * engine spells it.
 */
interface PostedBlinds {
  readonly smallBlindSeat: number | null;
  readonly bigBlindSeat: number;
}

/**
 * `orderFrom` walks a full orbit and returns an occupied `from` last, so the element before it is the
 * previous dealt seat.
 */
function previousDealt(from: number, maxSeats: number, dealt: readonly number[]): number | null {
  const orbit = orderFrom(from, maxSeats, dealt);
  if (orbit[orbit.length - 1] !== from) return null;
  return orbit[orbit.length - 2] ?? null;
}

/**
 * The engine opens preflop at `firstToActPreflopFor`, which is invertible, so the first action row
 * names the big blind without reference to a possibly dead button. An ante that puts the opener
 * all-in breaks this, and the pot check in `openReplay` then refuses the hand.
 */
function recoverBigBlindSeat(
  hand: HandRow,
  config: TableConfigFields,
  dealt: readonly number[],
  opener: HandActionRow,
): number | null {
  // Heads-up the button is the small blind and also acts first, so the big blind is the other seat.
  if (dealt.length === 2) {
    if (!dealt.includes(hand.button_seat)) return null;
    return dealt.find((seat) => seat !== hand.button_seat) ?? null;
  }
  return previousDealt(opener.seat, config.maxSeats, dealt);
}

/**
 * Posts antes and blinds, mirroring `startHand`. An ante goes straight to the middle and a blind is a
 * live bet, so mixing them would skew every `toCall` by the ante. A dead small blind posts nothing.
 */
function openTally(
  hand: HandRow,
  seats: readonly ReviewSeat[],
  config: TableConfigFields,
  dealt: readonly number[],
  blinds: PostedBlinds,
): ReplayState {
  const tally = new Map<number, ReplaySeat>();
  for (const seat of seats) {
    tally.set(seat.seat, {
      stack: seat.startingStack,
      committedThisStreet: 0,
      folded: false,
      dealtIn: seat.dealtIn,
    });
  }

  const state: ReplayState = { seats: tally, potInMiddle: 0, betLevel: 0, street: 'preflop' };
  const post = (target: number, amount: number, isLiveBet: boolean): void => {
    const seat = state.seats.get(target);
    if (seat === undefined) return;
    const paid = Math.min(amount, seat.stack);
    seat.stack -= paid;
    if (isLiveBet) seat.committedThisStreet += paid;
    else state.potInMiddle += paid;
  };

  if (config.ante > 0) {
    for (const target of orderFrom(hand.button_seat, config.maxSeats, dealt)) {
      post(target, config.ante, false);
    }
  }
  if (blinds.smallBlindSeat !== null) post(blinds.smallBlindSeat, config.smallBlind, true);
  post(blinds.bigBlindSeat, config.bigBlind, true);

  // The opening level is the big blind, the largest FULL wager, not the largest commitment. A short
  // big blind does not lower what callers owe.
  let posted = 0;
  for (const seat of state.seats.values()) posted = Math.max(posted, seat.committedThisStreet);
  state.betLevel = Math.max(config.bigBlind, posted);
  return state;
}

function potTotal(state: ReplayState): number {
  return state.potInMiddle + sumCommitted(state);
}

/**
 * Opens the replay with the blinds the hand actually had. The first action names the big blind, and
 * the engine's pot before it decides between a live small blind and a dead one, the only two the
 * dead-button rule allows. Both candidates use the same `openTally`.
 * When neither matches, the first is returned anyway, so the pot cross-check refuses every decision
 * with a precise reason. `null` means there is no anchor at all.
 */
function openReplay(
  hand: HandRow,
  seats: readonly ReviewSeat[],
  config: TableConfigFields,
  actions: readonly HandActionRow[],
): ReplayState | null {
  const dealt = seats
    .filter((seat) => seat.dealtIn)
    .map((seat) => seat.seat)
    .sort((a, b) => a - b);
  if (dealt.length < 2) return null;

  // Both anchors come off the FIRST action, which must be preflop. A hand with no action rows has no
  // decisions to analyse.
  const opener = actions[0];
  if (opener === undefined || opener.street !== 'preflop') return null;
  const bigBlindSeat = recoverBigBlindSeat(hand, config, dealt, opener);
  if (bigBlindSeat === null) return null;
  const postedByForcedBets = opener.pot_after - opener.amount_paid;

  // Live first, so if an ante took the small blind's whole stack the result still names a seat.
  const smallBlindCandidates: readonly (number | null)[] = [
    dealt.length === 2 ? hand.button_seat : previousDealt(bigBlindSeat, config.maxSeats, dealt),
    null,
  ];
  const candidates = smallBlindCandidates.map((smallBlindSeat) =>
    openTally(hand, seats, config, dealt, { smallBlindSeat, bigBlindSeat }),
  );
  return candidates.find((state) => potTotal(state) === postedByForcedBets) ?? candidates[0] ?? null;
}

/** Sweeps a finished street's bets into the middle and resets the per-street tallies. */
function closeStreet(state: ReplayState, nextStreet: string): void {
  for (const seat of state.seats.values()) {
    state.potInMiddle += seat.committedThisStreet;
    seat.committedThisStreet = 0;
  }
  state.betLevel = 0;
  state.street = nextStreet;
}

/** What one seat faced at the moment it acted. */
interface Situation {
  readonly street: BettingStreetName;
  readonly potBefore: number;
  /**
   * The part of `potBefore` this seat could win. Lower when all-in for less than the bet. Grading
   * against the whole middle scored a correct fold as a large error.
   */
  readonly contestablePot: number;
  readonly toCall: number;
  /** What this seat had already put out on the street, for a legal raise total. */
  readonly committedThisStreet: number;
  readonly heroStack: number;
  readonly opponentStacks: readonly number[];
  readonly opponentCount: number;
}

function bettingStreetName(street: string): BettingStreetName | null {
  return BETTING_STREET_NAMES.find((candidate) => candidate === street) ?? null;
}

function situationBefore(state: ReplayState, action: HandActionRow): Situation | null {
  const street = bettingStreetName(action.street);
  const actor = state.seats.get(action.seat);
  if (street === null || actor === undefined) return null;
  // A folded or undealt seat cannot win, so the log is not replayable here. Checked before
  // `contestablePotFor`, which may throw on such a seat.
  if (replaySeatStatus(actor) !== 'active' && replaySeatStatus(actor) !== 'allIn') return null;

  // All-in opponents still hold cards and can win the pot they paid for.
  const opponentStacks: number[] = [];
  for (const [seat, entry] of state.seats) {
    if (seat === action.seat || entry.folded || !entry.dealtIn) continue;
    opponentStacks.push(entry.stack);
  }

  const potBefore = potTotal(state);
  const toCall = Math.max(0, Math.min(state.betLevel - actor.committedThisStreet, actor.stack));
  // The engine's `contestablePotFor`, the same layering settlement uses. Only this street's
  // commitments are passed. A seat to act has matched every earlier street's closing level, so
  // `potInMiddle` needs no per-seat split.
  const { contestable } = contestablePotFor({
    seats: [...state.seats].map(([seat, entry]) => ({
      seat,
      committedThisStreet: entry.committedThisStreet,
      status: replaySeatStatus(entry),
    })),
    heroSeat: action.seat,
    callAmount: toCall,
    potTotal: potBefore,
  });

  return {
    street,
    potBefore,
    contestablePot: contestable,
    toCall,
    committedThisStreet: actor.committedThisStreet,
    heroStack: actor.stack,
    opponentStacks,
    opponentCount: opponentStacks.length,
  };
}

/** The layering rule's view of a replayed seat, which says who is still live and who merely paid. */
function replaySeatStatus(entry: ReplaySeat): SeatStatus {
  if (!entry.dealtIn) return 'sittingOut';
  if (entry.folded) return 'folded';
  return entry.stack === 0 ? 'allIn' : 'active';
}

function sumCommitted(state: ReplayState): number {
  let total = 0;
  for (const seat of state.seats.values()) total += seat.committedThisStreet;
  return total;
}

/**
 * `amount_paid` and `bet_level_after` are what the engine recorded, so no min-raise rule is
 * re-derived.
 */
function applyReplayAction(state: ReplayState, action: HandActionRow): void {
  const actor = state.seats.get(action.seat);
  if (actor !== undefined) {
    actor.stack -= action.amount_paid;
    actor.committedThisStreet += action.amount_paid;
    if (action.action_type === 'fold') actor.folded = true;
  }
  state.betLevel = Math.max(state.betLevel, action.bet_level_after);
}

/** Server-side only. It reaches the log, never the response. */
export interface SkippedAnalysis {
  readonly sequence: number;
  readonly reason: string;
}

/**
 * FNV-1a over hand id and sequence, so a reloaded review reproduces every figure. It only picks the
 * sampled run-outs, never anything about dealing.
 */
function seedFor(handId: string, sequence: number): number {
  let hash = 0x811c9dc5;
  for (const character of `${handId}:${sequence}`) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  return (hash ^ sequence) >>> 0;
}

/** The one assumption the review adds on top of the Coach's own. */
function reviewRangeAssumption(opponentCount: number): string {
  const who = opponentCount === 1 ? 'The one opponent' : `Each of the ${opponentCount} opponents`;
  return (
    `${who} still in the hand is modelled with the same fixed range, "${REVIEW_OPPONENT_RANGE}". ` +
    'That is a stated assumption for the review, not a read of what they actually held: their ' +
    'cards are never disclosed unless they showed down, and this range does not narrow as the ' +
    'hand goes on.'
  );
}

/** One decision the review has decided to analyse, and everything that analysis needs. */
interface AnalysisRequest {
  readonly handId: string;
  readonly sequence: number;
  readonly heroCards: readonly Card[];
  readonly board: readonly Card[];
  readonly situation: Situation;
  readonly bigBlind: number;
  readonly samples: number;
}

/**
 * Derived from the situation, because a review never holds the `HandState`. An all-in opponent counts
 * as live with a zero stack, so "raise" is withheld against a table of all-in opponents. One function,
 * so the thread's task and the local report get the identical set.
 */
function legalActionsFor(situation: Situation): readonly CoachAction[] {
  return deriveLegalActions({
    toCall: situation.toCall,
    heroCommittedThisStreet: situation.committedThisStreet,
    heroStack: situation.heroStack,
    opponentStacks: situation.opponentStacks,
  });
}

/**
 * Opponents go as the notation string, which `equity-worker.ts` expands with the same `parseRange`
 * call. Only the viewer's own cards, the board for that street and the chip counts cross. No deck, no
 * salt, no other seat's cards.
 */
function coachTaskFor(request: AnalysisRequest): CoachTask {
  const { situation } = request;
  return {
    kind: 'coach',
    spec: {
      heroLabel: 'you',
      heroCards: request.heroCards,
      board: request.board,
      opponents: situation.opponentStacks.map((_stack, index) => ({
        kind: 'notation',
        label: `opponent ${index + 1}`,
        notation: REVIEW_OPPONENT_RANGE,
      })),
    },
    street: situation.street,
    pot: situation.potBefore,
    contestablePot: situation.contestablePot,
    toCall: situation.toCall,
    heroCommittedThisStreet: situation.committedThisStreet,
    heroStack: situation.heroStack,
    opponentStacks: situation.opponentStacks,
    bigBlind: request.bigBlind,
    legalActions: legalActionsFor(situation),
    samples: request.samples,
    seed: seedFor(request.handId, request.sequence),
  };
}

/**
 * Appended, never replaced. Applied outside the analysis so threaded and local reports carry the
 * same list.
 */
function withReviewAssumption(report: CoachReport, opponentCount: number): CoachReport {
  return { ...report, assumptions: [...report.assumptions, reviewRangeAssumption(opponentCount)] };
}

/**
 * The reference implementation, used by `buildHandReview`. `test/event-loop-budget.test.ts` asserts
 * the worker-pool review is deep-equal to it. NOT what `GET /hands/:handId` calls, because one flop
 * analysis measured 133 ms.
 */
function analyse(request: AnalysisRequest): CoachReport {
  const { situation } = request;
  const blockers = [...request.heroCards, ...request.board];
  const range: ParsedRange = parseRange(REVIEW_OPPONENT_RANGE, blockers);
  const opponents = situation.opponentStacks.map((_stack, index) => ({
    label: `opponent ${index + 1}`,
    range,
  }));

  const report = buildCoachReport({
    heroCards: request.heroCards,
    board: request.board,
    street: situation.street,
    opponents,
    pot: situation.potBefore,
    contestablePot: situation.contestablePot,
    toCall: situation.toCall,
    heroCommittedThisStreet: situation.committedThisStreet,
    heroStack: situation.heroStack,
    opponentStacks: situation.opponentStacks,
    bigBlind: request.bigBlind,
    legalActions: legalActionsFor(situation),
    samples: request.samples,
    seed: seedFor(request.handId, request.sequence),
  });

  return withReviewAssumption(report, opponents.length);
}

export interface BuildHandReviewInput {
  readonly hand: HandRow;
  readonly seats: readonly HandSeatRow[];
  /** Every action for the hand, in `sequence` order. */
  readonly actions: readonly HandActionRow[];
  /** The user asking. Their own seat is the only one whose decisions are analysed. */
  readonly viewerUserId: string;
  readonly maxPotAfter: number | null;
}

export interface BuildHandReviewOptions {
  readonly budgetMs?: number;
  readonly maxAnalysedDecisions?: number;
  readonly equitySamples?: number;
  /** Clock seam, so a test can prove the budget is respected without waiting for it. */
  readonly now?: () => number;
  readonly onAnalysisSkipped?: (detail: SkippedAnalysis) => void;
}

interface AnalysisBudget {
  readonly deadline: number;
  readonly now: () => number;
  remaining: number;
  readonly samples: number;
  readonly onSkipped: (detail: SkippedAnalysis) => void;
}

/**
 * Decides whether a decision gets a report, and describes the analysis without computing it, so the
 * local and off-thread paths share the rules. Every `null` after the seat check records a reason.
 * The cap is spent here, so "the first eight decisions" is a property of the walk. The deadline is
 * checked when the analysis runs.
 */
function planAnalysis(
  action: HandActionRow,
  context: {
    readonly hand: HandRow;
    readonly viewerSeat: number | null;
    readonly heroCards: readonly Card[] | null;
    readonly board: readonly Card[];
    readonly bigBlind: number;
    readonly situation: Situation | null;
    readonly persistedPotBefore: number;
    readonly budget: AnalysisBudget;
  },
): AnalysisRequest | null {
  const { budget, situation } = context;
  // Only the viewer's own seat, even for opponents who showed down. Their decision was made before
  // the cards were public.
  if (context.viewerSeat === null || action.seat !== context.viewerSeat) return null;

  const skip = (reason: string): null => {
    budget.onSkipped({ sequence: action.sequence, reason });
    return null;
  };

  if (context.heroCards === null || context.heroCards.length !== 2)
    return skip('no hole cards for this seat');
  if (situation === null) return skip('the situation could not be reconstructed');
  if (situation.opponentCount < 1 || situation.opponentCount > 5) {
    return skip(`the Coach handles 1 to 5 opponents, this spot had ${situation.opponentCount}`);
  }
  // The replay must agree with the engine's `pot_after` chain, or every derived figure is wrong.
  if (situation.potBefore !== context.persistedPotBefore) {
    return skip('the replayed pot disagrees with the persisted pot');
  }
  const expectedBoard = BOARD_LENGTH_BY_STREET[situation.street];
  if (expectedBoard === undefined || context.board.length < expectedBoard) {
    return skip(
      `the stored board has ${context.board.length} cards, ${situation.street} needs ${expectedBoard}`,
    );
  }
  if (budget.remaining <= 0) return skip('the per-review analysis cap was reached');

  budget.remaining -= 1;
  return {
    handId: context.hand.id,
    sequence: action.sequence,
    heroCards: context.heroCards,
    // The board as it stood on that street, never the final one. See `boardForStreet`.
    board: context.board.slice(0, expectedBoard),
    situation,
    bigBlind: context.bigBlind,
    samples: budget.samples,
  };
}

/**
 * `admits` is the wall-clock backstop, checked right before the work. Past it, the rest of the hand
 * gets `analysis: null`. `failed` turns a thrown analysis (including a full queue, an overrun or a
 * dead thread) into one null decision rather than a failed review.
 */
function admits(request: AnalysisRequest, budget: AnalysisBudget): boolean {
  if (budget.now() < budget.deadline) return true;
  budget.onSkipped({ sequence: request.sequence, reason: 'the analysis budget was exhausted' });
  return false;
}

function failed(request: AnalysisRequest, budget: AnalysisBudget, error: unknown): null {
  budget.onSkipped({
    sequence: request.sequence,
    reason: `the analysis threw: ${error instanceof Error ? error.name : 'unknown error'}`,
  });
  return null;
}

/** Runs a planned analysis on this thread. The fixture generator's path, and the tests'. */
function runAnalysis(request: AnalysisRequest, budget: AnalysisBudget): CoachReport | null {
  if (!admits(request, budget)) return null;
  try {
    return analyse(request);
  } catch (error) {
    return failed(request, budget, error);
  }
}

/**
 * Runs off this thread. The review's assumption is appended here, because the calculator thread knows
 * nothing of reviews.
 */
async function runAnalysisOn(
  request: AnalysisRequest,
  budget: AnalysisBudget,
  analyseOffThread: ReviewAnalyser,
): Promise<CoachReport | null> {
  if (!admits(request, budget)) return null;
  try {
    const report = await analyseOffThread(coachTaskFor(request));
    return withReviewAssumption(report, request.situation.opponentStacks.length);
  } catch (error) {
    return failed(request, budget, error);
  }
}

/**
 * Runs every planned analysis off this thread, ONE AT A TIME. `runBatch` admits a whole set or none
 * and the queue holds three per thread, so eight at once could lose the whole page. In parallel, one
 * review would also hold every thread. A review's wall clock becomes the sum of its analyses, traded
 * for every other player's action latency. `admits` stops the set once the budget is spent.
 */
async function runPlannedAnalyses(
  planned: readonly AnalysisRequest[],
  budget: AnalysisBudget,
  analyseOffThread: ReviewAnalyser,
): Promise<ReadonlyMap<number, CoachReport>> {
  const reports = new Map<number, CoachReport>();
  for (const request of planned) {
    const report = await runAnalysisOn(request, budget, analyseOffThread);
    if (report !== null) reports.set(request.sequence, report);
  }
  return reports;
}

interface DecisionContext {
  readonly hand: HandRow;
  readonly viewer: ReviewSeat | null;
  readonly board: readonly Card[];
  readonly bigBlind: number;
  /** Null when the situation could not be reconstructed; the actions are still reported. */
  readonly state: ReplayState | null;
  readonly budget: AnalysisBudget;
}

/** `decision.analysis` stays null unless the analysis produces a report. */
interface PlannedDecision {
  readonly decision: HandReviewDecision;
  readonly request: AnalysisRequest | null;
}

/**
 * Walks the action log in order, reporting each action and planning the viewer's own. The situation
 * is read BEFORE the action is applied, because a decision is described by what the player faced.
 * The walk costs 0.2 ms against 156 ms for the hand's Coach reports, so only the reports leave.
 */
function planDecisions(actions: readonly HandActionRow[], context: DecisionContext): PlannedDecision[] {
  const { state } = context;
  const planned: PlannedDecision[] = [];
  let previousPotAfter: number | null = null;

  for (const action of actions) {
    if (state !== null && action.street !== state.street) closeStreet(state, action.street);
    // The first `potBefore` is its own `pot_after` less what it paid, later ones the previous
    // `pot_after`. Both come from the engine.
    const persistedPotBefore = previousPotAfter ?? action.pot_after - action.amount_paid;

    planned.push({
      decision: {
        sequence: action.sequence,
        street: action.street,
        seat: action.seat,
        action: action.action_type,
        to: action.action_to,
        amountPaid: action.amount_paid,
        potBefore: persistedPotBefore,
        wasAutomatic: action.was_automatic,
        // As recorded, null included. Inferring one from `was_automatic` printed "the clock ran out"
        // beside a fold the reader chose.
        automaticReason: action.automatic_reason,
        analysis: null,
      },
      request: planAnalysis(action, {
        hand: context.hand,
        viewerSeat: context.viewer === null ? null : context.viewer.seat,
        heroCards: context.viewer === null ? null : context.viewer.visibleCards,
        board: context.board,
        bigBlind: context.bigBlind,
        situation: state === null ? null : situationBefore(state, action),
        persistedPotBefore,
        budget: context.budget,
      }),
    });

    if (state !== null) applyReplayAction(state, action);
    previousPotAfter = action.pot_after;
  }

  return planned;
}

/** A planned decision with whatever its analysis produced. `null` leaves the decision as it was. */
function withAnalysis(planned: PlannedDecision, report: CoachReport | null): HandReviewDecision {
  return report === null ? planned.decision : { ...planned.decision, analysis: report };
}

/**
 * One decision for `buildHandComparison`. Nothing persists a `PlayerView`, so it is rebuilt from the
 * same replay, read before the action is applied.
 */
export interface ComparisonDecisions {
  readonly board: readonly Card[];
  readonly decisions: readonly {
    readonly sequence: number;
    readonly seat: number;
    readonly action: Action;
    readonly view: PlayerView;
    readonly decision: null;
  }[];
  /** The Coach report for each of the viewer's own analysable decisions, by sequence. */
  readonly analysisBySequence: ReadonlyMap<number, CoachReport>;
}

/**
 * Replays a stored hand into the views its seats acted on. Null, never partial, when the rows cannot
 * be reproduced, because a drifted reconstruction gives plausible wrong numbers.
 * Exported for `build-comparison.ts` only. The replay stays private, so there is one walk.
 */
export async function buildComparisonDecisions(input: {
  readonly hand: HandRow;
  readonly seats: readonly HandSeatRow[];
  readonly actions: readonly HandActionRow[];
  readonly viewerUserId: string;
  readonly budgetMs: number;
  /** Where a decision's Coach report is computed. See `ReviewAnalyser`. */
  readonly analyse: ReviewAnalyser;
  readonly maxAnalysedDecisions?: number;
  readonly equitySamples?: number;
  readonly now?: () => number;
  readonly onAnalysisSkipped?: (detail: SkippedAnalysis) => void;
}): Promise<ComparisonDecisions | null> {
  const { hand } = input;
  const config = configFromJson(hand.config);
  const parsedBoard = cardsFromJson(hand.board);
  if (config === null || parsedBoard === null) return null;
  // `PlayerView.config` needs a real turn clock. Inventing one would put a number into a review that
  // nobody played under.
  const actionTimeoutSeconds = config.actionTimeoutSeconds;
  if (actionTimeoutSeconds === null) return null;

  const seats = input.seats.map((row) => toReviewSeat(row, input.viewerUserId));
  const viewer = seats.find((seat) => seat.userId !== null && seat.userId === input.viewerUserId) ?? null;
  const actions = [...input.actions].sort((a, b) => a.sequence - b.sequence);
  const state = openReplay(hand, seats, config, actions);
  if (state === null) return null;

  const now = input.now ?? ((): number => performance.now());
  const budget: AnalysisBudget = {
    now,
    deadline: now() + Math.max(0, input.budgetMs),
    remaining: Math.max(0, input.maxAnalysedDecisions ?? MAX_ANALYSED_DECISIONS),
    samples: input.equitySamples ?? REVIEW_EQUITY_SAMPLES,
    onSkipped: input.onAnalysisSkipped ?? ((): void => undefined),
  };

  const decisions: ComparisonDecisions['decisions'][number][] = [];
  const planned: AnalysisRequest[] = [];
  let previousPotAfter: number | null = null;

  for (const row of actions) {
    if (row.street !== state.street) closeStreet(state, row.street);
    const persistedPotBefore = previousPotAfter ?? row.pot_after - row.amount_paid;
    const situation = situationBefore(state, row);
    const action = actionFromRow(row);

    if (situation === null || action === null) return null;

    // Planned during the walk, run after. `situationBefore` returns a snapshot, so deferring is safe.
    const request = planAnalysis(row, {
      hand,
      viewerSeat: viewer === null ? null : viewer.seat,
      heroCards: viewer === null ? null : viewer.visibleCards,
      board: parsedBoard.cards,
      bigBlind: config.bigBlind,
      situation,
      persistedPotBefore,
      budget,
    });
    if (request !== null) planned.push(request);

    decisions.push({
      sequence: row.sequence,
      seat: row.seat,
      action,
      view: viewAtDecision({
        hand,
        config,
        actionTimeoutSeconds,
        seats,
        state,
        situation,
        row,
        action,
        board: parsedBoard.cards,
      }),
      // Permanently null. See the header of `build-comparison.ts`.
      decision: null,
    });

    applyReplayAction(state, row);
    previousPotAfter = row.pot_after;
  }

  const analysisBySequence = await runPlannedAnalyses(planned, budget, input.analyse);
  return { board: parsedBoard.cards, decisions, analysisBySequence };
}

/** A stored action row as the engine's own `Action`. Null for an `action_type` it does not know. */
function actionFromRow(row: HandActionRow): Action | null {
  switch (row.action_type) {
    case 'fold':
      return { type: 'fold' };
    case 'check':
      return { type: 'check' };
    case 'call':
      return { type: 'call' };
    case 'bet':
    case 'raise':
      // `action_to` is the street total. A bet without one is malformed, never defaulted, or the
      // comparison would assess a size nobody chose.
      return row.action_to === null ? null : { type: row.action_type, to: row.action_to };
    default:
      return null;
  }
}

/**
 * `prl.hands.board` holds the FINAL board, so it is truncated to the street's own length. A flop
 * decision must never show the river.
 */
function boardForStreet(board: readonly Card[], street: string): readonly Card[] {
  const length = BOARD_LENGTH_BY_STREET[street];
  return length === undefined ? board : board.slice(0, Math.min(length, board.length));
}

/**
 * The view one seat acted on, rebuilt from the replay. Faithful in every field `buildHandComparison`
 * reads. Hole cards are only what `toReviewSeat` and the SQL let through. `pots`, `forcedBets` and
 * `actions` are empty because the rows do not record them, and `result` is null as in a live view.
 * `legalActions` is derived as `analyse` does, then the action actually taken is added. The row
 * proves the engine offered it, and the derivation can miss a raise when an opponent is all-in.
 */
function viewAtDecision(context: {
  readonly hand: HandRow;
  readonly config: TableConfigFields;
  /** Resolved by the caller, which refuses the whole comparison when the row does not carry one. */
  readonly actionTimeoutSeconds: number;
  readonly seats: readonly ReviewSeat[];
  readonly state: ReplayState;
  readonly situation: Situation;
  readonly row: HandActionRow;
  readonly action: Action;
  readonly board: readonly Card[];
}): PlayerView {
  const { config, situation, row, state } = context;

  const derived = new Set<string>(
    deriveLegalActions({
      toCall: situation.toCall,
      heroCommittedThisStreet: situation.committedThisStreet,
      heroStack: situation.heroStack,
      opponentStacks: situation.opponentStacks,
    }),
  );
  derived.add(context.action.type);
  const maxTo = situation.committedThisStreet + situation.heroStack;
  const legalActions: LegalAction[] = [...derived].map((type) => {
    if (type === 'bet' || type === 'raise') {
      const minimum = Math.min(maxTo, state.betLevel + Math.max(config.bigBlind, state.betLevel));
      return { type: type as Action['type'], minTo: minimum, maxTo, allInAtMax: true };
    }
    if (type === 'call') return { type: 'call', minTo: state.betLevel, costAtMin: situation.toCall };
    return { type: type as Action['type'] };
  });

  return {
    handId: context.hand.id,
    roomId: context.hand.room_id,
    handNumber: context.hand.hand_number,
    config: {
      smallBlind: config.smallBlind,
      bigBlind: config.bigBlind,
      ante: config.ante,
      maxSeats: config.maxSeats,
      actionTimeoutSeconds: context.actionTimeoutSeconds,
    } satisfies TableConfig,
    street: situation.street,
    board: boardForStreet(context.board, situation.street),
    buttonSeat: context.hand.button_seat as SeatIndex,
    seats: context.seats.map((seat) => seatViewAt(seat, state, context.hand.button_seat, row.seat)),
    toAct: row.seat as SeatIndex,
    betLevel: state.betLevel,
    minimumRaiseTo: Math.min(maxTo, state.betLevel + Math.max(config.bigBlind, state.betLevel)),
    potTotal: situation.potBefore,
    pots: [],
    forcedBets: [],
    actions: [],
    actionSequence: row.sequence,
    legalActions,
    amountToCall: situation.toCall,
    commitmentRoot: context.hand.commitment_root,
    commitmentContext: context.hand.commitment_context,
    result: null,
    viewerSeat: row.seat as SeatIndex,
    // The hand's own recorded provenance, never a default. See the column's note on `HandRow`.
    randomSourceKind: context.hand.random_source_kind,
    // `isSelf` is relative to the ACTING seat, which `validateRecorded` checks against `viewerSeat`.
  } satisfies PlayerView;
}

function seatViewAt(seat: ReviewSeat, state: ReplayState, buttonSeat: number, actingSeat: number): SeatView {
  const tallied = state.seats.get(seat.seat);
  const cards = seat.visibleCards;
  return {
    seat: seat.seat as SeatIndex,
    playerId: seat.userId ?? `seat-${seat.seat}`,
    stack: tallied?.stack ?? seat.startingStack,
    committedThisStreet: tallied?.committedThisStreet ?? 0,
    // The replay tracks only the street, so that is the value actually known.
    committedTotal: tallied?.committedThisStreet ?? 0,
    status: seatStatusFor(seat, tallied),
    position: null,
    holeCards: cards !== null && cards.length === 2 ? ([cards[0], cards[1]] as [Card, Card]) : null,
    isSelf: seat.seat === actingSeat,
    isButton: seat.seat === buttonSeat,
    isToAct: seat.seat === actingSeat,
  };
}

function seatStatusFor(seat: ReviewSeat, tallied: ReplaySeat | undefined): SeatStatus {
  if (!seat.dealtIn) return 'sittingOut';
  if (tallied?.folded === true) return 'folded';
  if (tallied !== undefined && tallied.stack === 0) return 'allIn';
  return 'active';
}

/**
 * Assembled member by member, never spread from a row, so a new column cannot reach a client. Both
 * entry points share it, so they differ only in where the Coach reports are computed.
 */
interface PlannedReview {
  readonly planned: readonly PlannedDecision[];
  readonly budget: AnalysisBudget;
  /** The response with every `analysis` still null; `assemble` fills them in. */
  readonly assemble: (decisions: readonly HandReviewDecision[]) => HandReviewResponse;
}

function planHandReview(input: BuildHandReviewInput, options: BuildHandReviewOptions): PlannedReview {
  const { hand } = input;
  const now = options.now ?? (() => performance.now());
  const budget: AnalysisBudget = {
    now,
    deadline: now() + Math.max(0, options.budgetMs ?? DEFAULT_ANALYSIS_BUDGET_MS),
    remaining: Math.max(0, options.maxAnalysedDecisions ?? MAX_ANALYSED_DECISIONS),
    samples: options.equitySamples ?? REVIEW_EQUITY_SAMPLES,
    onSkipped: options.onAnalysisSkipped ?? ((): void => undefined),
  };

  const seats = input.seats.map((row) => toReviewSeat(row, input.viewerUserId));
  const viewer = seats.find((seat) => seat.userId !== null && seat.userId === input.viewerUserId) ?? null;
  const board = cardsFromJson(hand.board);
  const config = configFromJson(hand.config);
  // Sorted once and shared. The replay recovers the posted blinds from the same first action the
  // walk starts from.
  const actions = [...input.actions].sort((a, b) => a.sequence - b.sequence);

  const planned = planDecisions(actions, {
    hand,
    viewer,
    board: board === null ? [] : board.cards,
    bigBlind: config === null ? 0 : config.bigBlind,
    state: config === null ? null : openReplay(hand, seats, config, actions),
    budget,
  });

  const revealCheck = checkReveal(hand);
  return {
    planned,
    budget,
    assemble: (decisions) => ({
      hand: toHandSummary({
        hand,
        heroNet: viewer === null ? null : viewer.netResult,
        maxPotAfter: input.maxPotAfter,
      }),
      commitmentRoot: hand.commitment_root,
      commitmentContext: hand.commitment_context,
      reveal: revealCheck.reveal,
      verification: revealCheck.verification,
      seats: seats.map((seat) => toResponseSeat(seat)),
      decisions: [...decisions],
    }),
  };
}

/**
 * Computes every analysis on the calling thread. Used by `scripts/regenerate-web-fixtures.mjs` and
 * the tests, NOT by the API. `test/event-loop-budget.test.ts` asserts it deep-equal to
 * `buildHandReviewOn`, which `GET /hands/:handId` serves.
 */
export function buildHandReview(
  input: BuildHandReviewInput,
  options: BuildHandReviewOptions = {},
): HandReviewResponse {
  const review = planHandReview(input, options);
  return review.assemble(
    review.planned.map((entry) =>
      withAnalysis(entry, entry.request === null ? null : runAnalysis(entry.request, review.budget)),
    ),
  );
}

/** What `GET /hands/:handId` serves. Only the Coach reports leave this thread, one at a time. */
export async function buildHandReviewOn(
  input: BuildHandReviewInput,
  options: BuildHandReviewOptions,
  analyseOffThread: ReviewAnalyser,
): Promise<HandReviewResponse> {
  const review = planHandReview(input, options);
  const requests = review.planned.flatMap((entry) => (entry.request === null ? [] : [entry.request]));
  const reports = await runPlannedAnalyses(requests, review.budget, analyseOffThread);
  return review.assemble(
    review.planned.map((entry) =>
      withAnalysis(entry, entry.request === null ? null : (reports.get(entry.request.sequence) ?? null)),
    ),
  );
}
