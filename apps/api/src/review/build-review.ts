/**
 * Hand review: the analysis, assembled at read time from the rows a finished hand left behind.
 *
 * Nothing in this file talks to a database and nothing in it is a Fastify handler. It takes the
 * persisted rows (`prl.hands`, `prl.hand_seats`, `prl.hand_actions`) plus the id of the user asking,
 * and returns the `HandReviewResponse` from `@prl/contracts`. That shape is what makes it unit
 * testable without Postgres, and it is why `test/hands.test.ts` can prove the visibility rules
 * without a live table anywhere.
 *
 * ## WHY REVIEW WORKS WITHOUT THE DECK EVER BEING STORED
 *
 * `db/migrations/0001_initial.sql` says it in capitals: there is no column for the deck and no
 * column for the commitment salts, so a replay cannot deal cards a second time. It does not need
 * to. A review only ever has to reconstruct the *situation* at each decision, and every ingredient
 * of a situation is already a row:
 *
 *   - the community cards come from `prl.hands.board`, which holds exactly the cards that were
 *     actually dealt and are public by definition. The board as of a given street is a prefix of
 *     that array (0 preflop, 3 on the flop, 4 on the turn, 5 on the river);
 *   - the hole cards come from `prl.hand_seats.hole_cards`, and are read under the rule on that
 *     column — the requesting user's own seat, or any seat whose `showed_down` is true;
 *   - every chip movement comes from `prl.hand_actions`: `amount_paid` is what actually left a
 *     stack, `bet_level_after` is the level the next player faced, and `pot_after` is the engine's
 *     own total. Stacks, per-street commitments and the pot are re-derived by adding those up;
 *   - the blinds and antes are the one thing that is not an action row, so they are re-derived
 *     from `prl.hands.config` and `button_seat` using the engine's own `assignBlinds` and
 *     `orderFrom` — the same functions `startHand` used to post them in the first place.
 *
 * The deck was only ever needed to *choose* those cards. Once chosen, the ones that legitimately
 * became public are persisted and the rest are gone for good — which is the point. A replay that
 * needed the deck would be a replay that could show a learner the cards an opponent folded.
 *
 * ## Whose decisions get analysed, and why only theirs
 *
 * Only the requesting user's own decisions. A Coach report needs the acting player's two cards, and
 * for anybody else those cards are either sealed forever (they folded) or belong to a different
 * learner. The honest answer for an opponent's decision is `analysis: null`, and the client says
 * why. Inventing a holding — picking a hand from a range and analysing that — would produce a
 * confident-looking report about a spot that never existed.
 *
 * The opponents in the analysis are therefore modelled by one fixed, written-out range
 * (`REVIEW_OPPONENT_RANGE`), stated in the report's own assumptions. That is a modelling choice,
 * not a read of what the opponent actually held, and the appended assumption line says exactly
 * that so no learner can mistake it for one.
 *
 * ## Bounded work
 *
 * Every figure is recomputed on every read (no computed poker number is ever stored — see decision
 * 7 in the migration), so a review is genuinely expensive: a six-handed preflop spot costs a
 * bounded Monte Carlo run. Three limits keep one request from becoming a denial of service:
 * `maxAnalysedDecisions`, a fixed sample count, and a wall-clock budget checked before each
 * report. The budget is a backstop rather than a routine cutoff — with the default cap it should
 * never fire — because a learner re-reading a hand must see the same numbers every time, and a
 * time-based cutoff makes the output depend on how busy the machine was.
 */

import type {
  CoachReport,
  HandReviewDecision,
  HandReviewResponse,
  HandReviewSeat,
  HandSummary,
} from '@prl/contracts';
import type { Card, DeckCommitment, DeckReveal, RevealedCard } from '@prl/poker-engine';
import {
  assignBlinds,
  COMMITMENT_VERSION,
  cardToString,
  DECK_SIZE,
  orderFrom,
  PROOF_LENGTH,
  parseCard,
  verifyDeckReveal,
} from '@prl/poker-engine';
import type { Street as BettingStreetName, ParsedRange } from '@prl/poker-math';
import { buildCoachReport, deriveLegalActions, parseRange } from '@prl/poker-math';

// ---------------------------------------------------------------------------
// The persisted rows this module reads
// ---------------------------------------------------------------------------

/**
 * The columns a `HandSummary` reads, and nothing more.
 *
 * Declared separately from `HandRow` so the list endpoint can pass its own narrower projection
 * without inventing placeholder values for the columns a summary never looks at. `HandRow` extends
 * it, so one mapping serves both endpoints and the two cannot drift.
 *
 * `jsonb` columns are `unknown` on purpose. They are parsed and narrowed below rather than asserted
 * into shape: a row written by an older version of the server, or edited by hand, must degrade to
 * "no analysis" instead of throwing inside a response serializer.
 *
 * Timestamps admit `string` as well as `Date` because that is genuinely driver-dependent, and a
 * review that crashes on a string is a worse outcome than one that normalises it.
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
}

/**
 * `prl.hand_seats` joined to `prl.users` for the display name.
 *
 * `hole_cards` MUST already have been filtered by the query that produced this row — the column
 * comment in the migration requires `user_id = :viewer OR showed_down` on every read path. This
 * module applies the same rule again when it builds the response, so a query that forgot it still
 * cannot leak. Two independent layers, because one of them is a SQL predicate somebody could edit.
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
}

// ---------------------------------------------------------------------------
// Knobs
// ---------------------------------------------------------------------------

/**
 * The opponent range every review assumes.
 *
 * Written out rather than computed as a top-percentage for two reasons. It is instant, where
 * `topPercentRange` has to build the strength table (a few seconds on the first call in a
 * process — not something a request handler should ever wear). And it is legible: this exact
 * string reaches the learner inside the report's assumptions, so they can see the assumption and
 * disagree with it.
 *
 * It is deliberately a middling, unadjusted range — about a fifth of all hands. It is not a read
 * of the opponent, it does not tighten as the streets go by, and the note appended to every
 * report says so.
 */
export const REVIEW_OPPONENT_RANGE = '22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo';

/**
 * Sample cap for a review's Monte Carlo runs.
 *
 * Small on purpose. A review prints its own confidence interval, and at this sample count that
 * interval is about a percentage point — wide enough to be honest about, narrow enough that no
 * teaching point in the report turns on it. Spending ten times the CPU to shrink it would change
 * the third digit of a number whose second digit is an assumption.
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

// ---------------------------------------------------------------------------
// Narrowing helpers for the jsonb columns
// ---------------------------------------------------------------------------

/**
 * A `jsonb` object as a plain record, or null for anything that is not one.
 *
 * Each property is read with `Reflect.get` into an `unknown` binding — the containment trick
 * `logging.ts` documents. It reads properties off an object of unknown shape without letting an
 * `any` loose in the rest of the file, and without a cast.
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

/**
 * Card notation from a `jsonb` array, normalised through the engine's parser.
 *
 * Returns `null` — never a partial list — when anything does not parse. A half-read board would
 * quietly produce an analysis of a different spot, which is worse than no analysis.
 */
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

interface TableConfigFields {
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante: number;
  readonly maxSeats: number;
}

function configFromJson(value: unknown): TableConfigFields | null {
  const record = asRecord(value);
  if (record === null) return null;
  const smallBlind = asInteger(record['smallBlind']);
  const bigBlind = asInteger(record['bigBlind']);
  const ante = asInteger(record['ante']);
  const maxSeats = asInteger(record['maxSeats']);
  if (smallBlind === null || bigBlind === null || ante === null || maxSeats === null) return null;
  if (smallBlind <= 0 || bigBlind <= 0 || ante < 0 || maxSeats < 2 || maxSeats > 6) return null;
  return { smallBlind, bigBlind, ante, maxSeats };
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

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
  /** False for a seat that sat the hand out: it holds no cards and is nobody's opponent. */
  readonly dealtIn: boolean;
  /** Null unless this is the viewer's own seat or the seat showed down. */
  readonly visibleNotation: readonly string[] | null;
  /** The same cards as `visibleNotation`, for the maths. Null under the same rule. */
  readonly visibleCards: readonly Card[] | null;
}

/**
 * Applies the hole-card rule.
 *
 * Own seat always; any other seat only once it showed down. Nothing else opens the cards — not the
 * hand being over, not the seat having folded, not the room's owner asking. Whether a folder was
 * bluffing is the information the whole commitment scheme exists to keep sealed, so it stays
 * sealed after the hand as well as during it.
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

// ---------------------------------------------------------------------------
// The reveal and its verification
// ---------------------------------------------------------------------------

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
 * Rebuilds a `DeckReveal` from the stored jsonb, field by field.
 *
 * Field by field rather than by handing the raw jsonb straight out, for the same reason
 * `redactFor` builds a `PlayerView` instead of deleting fields from a `HandState`: a column that
 * somehow acquired an extra key cannot then carry it to a client. Anything that does not fit the
 * shape is refused with its own reason rather than passed to `verifyDeckReveal`.
 */
function revealFromJson(value: unknown, root: string, context: string): RevealParse {
  const record = asRecord(value);
  const commitmentRecord = record === null ? null : asRecord(record['commitment']);
  if (record === null || commitmentRecord === null) {
    return { ok: false, reason: 'the stored reveal is not in the expected shape' };
  }
  // The literals matter: `DeckCommitment` pins both `algorithm` and `version`, and a stored value
  // that disagrees cannot be widened into one. Refusing it here says the same thing
  // `verifyDeckReveal` would have said, without pretending the object was a reveal.
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
  // A complete reveal is every one of the 52 positions, which would expose the hole cards of every
  // seat that folded. Two CHECK constraints already refuse to store one against a hand; this
  // refuses to serve one if it ever gets past them.
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
 * Verifies the stored reveal against the published root.
 *
 * A FOLD-OUT HAND HAS AN EMPTY REVEAL, AND THAT IS CORRECT. No board card was dealt and nobody
 * showed, so there is nothing that legitimately became public and nothing to prove. It reports
 * `ok: true` with `verifiedPositions: 0` — verified, with nothing to prove — and never as a
 * failure. Reporting it as a failure would train players to ignore the one signal that matters.
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
  // Said out loud rather than left as a bare zero, so an empty reveal reads as the correct
  // outcome for a fold-out hand instead of as a missing proof.
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

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

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
   * `max(pot_after)` over the hand's actions, or null when it has none.
   *
   * The engine's own running total, so it needs no re-derivation. The fallback for a hand with no
   * actions at all — everyone all-in from the blinds — is the sum of the settled pot layers, which
   * is the only other place the figure exists.
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

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

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
 * Posts the antes and blinds, mirroring `startHand`.
 *
 * This is the one part of a hand that is not an action row, and it is re-derived rather than
 * guessed: `assignBlinds` and `orderFrom` are the engine's own functions, so the seats charged
 * here are exactly the seats charged when the hand was dealt. An ante is dead money — it goes
 * straight to the middle and buys no part of the bet level — while a blind is a live bet, and
 * conflating the two would make every `toCall` in the review wrong by the ante.
 */
function openReplay(
  hand: HandRow,
  seats: readonly ReviewSeat[],
  config: TableConfigFields,
): ReplayState | null {
  const dealt = seats
    .filter((seat) => seat.dealtIn)
    .map((seat) => seat.seat)
    .sort((a, b) => a - b);
  if (dealt.length < 2 || !dealt.includes(hand.button_seat)) return null;

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

  try {
    if (config.ante > 0) {
      for (const target of orderFrom(hand.button_seat, config.maxSeats, dealt)) {
        post(target, config.ante, false);
      }
    }
    const { smallBlindSeat, bigBlindSeat } = assignBlinds(hand.button_seat, config.maxSeats, dealt);
    post(smallBlindSeat, config.smallBlind, true);
    post(bigBlindSeat, config.bigBlind, true);
  } catch {
    // `assignBlinds` and `orderFrom` throw on a seat layout they cannot make sense of. A review
    // still shows the action log; it simply has no situation to analyse.
    return null;
  }

  for (const seat of state.seats.values()) {
    state.betLevel = Math.max(state.betLevel, seat.committedThisStreet);
  }
  return state;
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

  // Opponents are the seats that were dealt in and have not folded — all-in ones included, since
  // they still hold cards and can still win the pot they paid for.
  const opponentStacks: number[] = [];
  for (const [seat, entry] of state.seats) {
    if (seat === action.seat || entry.folded || !entry.dealtIn) continue;
    opponentStacks.push(entry.stack);
  }

  return {
    street,
    potBefore: state.potInMiddle + sumCommitted(state),
    toCall: Math.max(0, Math.min(state.betLevel - actor.committedThisStreet, actor.stack)),
    committedThisStreet: actor.committedThisStreet,
    heroStack: actor.stack,
    opponentStacks,
    opponentCount: opponentStacks.length,
  };
}

function sumCommitted(state: ReplayState): number {
  let total = 0;
  for (const seat of state.seats.values()) total += seat.committedThisStreet;
  return total;
}

/**
 * Applies one persisted action.
 *
 * `amount_paid` is the chips that actually left the stack, for every action type, so one line
 * covers a call, a bet, a raise and a short all-in alike — there is no need to re-derive the
 * min-raise rule at review time. `bet_level_after` is taken as authoritative for the same reason:
 * it is what the engine recorded, and the next player really did face it.
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

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Why a decision of the viewer's own went unanalysed.
 *
 * Server-side only. It reaches the log, never the response: the contract's `analysis` is a report
 * or null, and a client that knows the decision was its own can already tell the difference.
 */
export interface SkippedAnalysis {
  readonly sequence: number;
  readonly reason: string;
}

/**
 * A stable seed per decision.
 *
 * FNV-1a over the hand id and the sequence number. Deterministic and cheap, so re-reading a hand
 * reproduces every figure exactly — a learner who reloads a review and sees the equity move by a
 * point has been taught that the numbers are arbitrary. Nothing here is a source of randomness for
 * dealing; it only picks which sampled run-outs a Monte Carlo run walks.
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

interface AnalysisRequest {
  readonly handId: string;
  readonly sequence: number;
  readonly heroCards: readonly Card[];
  readonly board: readonly Card[];
  readonly situation: Situation;
  readonly bigBlind: number;
  readonly samples: number;
}

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
    toCall: situation.toCall,
    heroCommittedThisStreet: situation.committedThisStreet,
    heroStack: situation.heroStack,
    opponentStacks: situation.opponentStacks,
    bigBlind: request.bigBlind,
    // A review replays stored rows; it never holds the `HandState` those rows came from,
    // so the engine's own `legalActions` is not available and the set is derived from the
    // situation. This is the surface where the derived rule bites most often: `situation`
    // counts an all-in opponent as a live opponent with a stack of 0 — correctly, they can
    // still win the pot — and a review that offered "raise" against a table of all-in
    // opponents would be telling a learner they missed a line the server would have
    // rejected on the night.
    legalActions: deriveLegalActions({
      toCall: situation.toCall,
      heroCommittedThisStreet: situation.committedThisStreet,
      heroStack: situation.heroStack,
      opponentStacks: situation.opponentStacks,
    }),
    samples: request.samples,
    seed: seedFor(request.handId, request.sequence),
  });

  // Appended, never replaced: `assumptions` is the list of everything the numbers depend on, and
  // the review's choice of opponent range is one of those things. Adding to it can only make the
  // report more honest, which is the direction this list is allowed to move in.
  return { ...report, assumptions: [...report.assumptions, reviewRangeAssumption(opponents.length)] };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

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
 * Decides whether this decision gets a report, and produces one if so.
 *
 * Every `null` here is a deliberate refusal, and each has its own recorded reason: not the
 * viewer's seat, no cards the server may use, a street that is not a decision point, a board that
 * does not match the street, an opponent count the Coach does not handle, a replay that disagreed
 * with the persisted pot, or a limit reached.
 */
function analysisFor(
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
): CoachReport | null {
  const { budget, situation } = context;
  // Not the viewer's seat: no analysis, and no recorded reason either, because this is the rule
  // rather than a failure. It holds even for a seat that showed down and whose cards are therefore
  // public — the decision was made when they were not, and a review that offered more analysis of
  // other people the further a hand went would be teaching the wrong thing about what is knowable.
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
  // The replay and the engine's own `pot_after` chain have to agree. If they do not, the
  // reconstruction is wrong somewhere and every figure derived from it would be wrong too.
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
  if (budget.now() >= budget.deadline) return skip('the analysis budget was exhausted');

  budget.remaining -= 1;
  try {
    return analyse({
      handId: context.hand.id,
      sequence: action.sequence,
      heroCards: context.heroCards,
      board: context.board.slice(0, expectedBoard),
      situation,
      bigBlind: context.bigBlind,
      samples: budget.samples,
    });
  } catch (error) {
    // A Coach report that cannot be produced is one null decision, not a failed review. The reason
    // goes to the caller's log; the client is simply told there is no analysis for this decision.
    return skip(`the analysis threw: ${error instanceof Error ? error.name : 'unknown error'}`);
  }
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

/**
 * Walks the action log in sequence order, reporting each action and analysing the viewer's own.
 *
 * The replay advances alongside the walk: a street change sweeps the previous street's bets into
 * the middle, the situation is read *before* the action is applied, and then the action is applied.
 * Reading before applying is the whole point — a decision is described by what the player faced,
 * not by what they left behind.
 */
function buildDecisions(actions: readonly HandActionRow[], context: DecisionContext): HandReviewDecision[] {
  const { state } = context;
  const decisions: HandReviewDecision[] = [];
  let previousPotAfter: number | null = null;

  for (const action of actions) {
    if (state !== null && action.street !== state.street) closeStreet(state, action.street);
    // The first action's `potBefore` is its own `pot_after` less what it paid; every later one is
    // simply the previous action's `pot_after`. Both come from the engine, so this is the
    // authoritative figure, and the replay is checked against it before anything is analysed.
    const persistedPotBefore = previousPotAfter ?? action.pot_after - action.amount_paid;

    decisions.push({
      sequence: action.sequence,
      street: action.street,
      seat: action.seat,
      action: action.action_type,
      to: action.action_to,
      amountPaid: action.amount_paid,
      potBefore: persistedPotBefore,
      wasAutomatic: action.was_automatic,
      analysis: analysisFor(action, {
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

  return decisions;
}

/**
 * Builds the whole review.
 *
 * The response is assembled member by member from the values above. Nothing is spread in from a
 * database row, so a column that gains a field cannot carry it to a client — the same fail-closed
 * construction `redactFor` uses in the engine, for the same reason.
 */
export function buildHandReview(
  input: BuildHandReviewInput,
  options: BuildHandReviewOptions = {},
): HandReviewResponse {
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

  const decisions = buildDecisions(
    [...input.actions].sort((a, b) => a.sequence - b.sequence),
    {
      hand,
      viewer,
      board: board === null ? [] : board.cards,
      bigBlind: config === null ? 0 : config.bigBlind,
      state: config === null ? null : openReplay(hand, seats, config),
      budget,
    },
  );

  const revealCheck = checkReveal(hand);
  return {
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
    decisions,
  };
}
