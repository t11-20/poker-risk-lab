/**
 * The shape of a hand of No-Limit Hold'em. The engine is a pure function of (state, action) to
 * (state, events). Chips are integers. The user-facing word is "units", and they are valueless.
 */

import type { Card } from './cards.ts';
import type { DeckCommitment, DeckReveal } from './commitment.ts';
import type { HandScore } from './evaluate.ts';

export type SeatIndex = number;

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete';

export const BETTING_STREETS = ['preflop', 'flop', 'turn', 'river'] as const;
export type BettingStreet = (typeof BETTING_STREETS)[number];

export type SeatStatus =
  /** Holds cards and has chips behind; may still act. */
  | 'active'
  | 'folded'
  /** Holds cards but has no chips behind; cannot act, can still win. */
  | 'allIn'
  | 'sittingOut';

export interface TableConfig {
  readonly smallBlind: number;
  readonly bigBlind: number;
  /** Per-player forced bet before cards, 0 for a cash-style game. */
  readonly ante: number;
  /** 2..6. Heads-up (2) uses the reversed blind and action order. */
  readonly maxSeats: number;
  /** Seconds to act before the server checks or folds. The server enforces it. */
  readonly actionTimeoutSeconds: number;
}

export interface SeatState {
  readonly seat: SeatIndex;
  readonly playerId: string;
  /** Chips behind, i.e. not yet committed. */
  readonly stack: number;
  readonly committedThisStreet: number;
  /** Chips pushed forward across the whole hand, including antes and blinds. */
  readonly committedTotal: number;
  /** Null for every seat but the recipient in a redacted view. */
  readonly holeCards: readonly [Card, Card] | null;
  readonly status: SeatStatus;
  /**
   * The bet level when this seat last acted this street, or null. Drives both "who still acts" and
   * "who may raise". See betting.ts.
   */
  readonly lastActedAtBetLevel: number | null;
  /** True once the seat has gone all-in this hand. */
  readonly isAllInThisHand: boolean;
}

export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise';

/**
 * A player's decision. `to` is "raise to", the seat's TOTAL street commitment after the action,
 * not the increment.
 */
export type Action =
  | { readonly type: 'fold' }
  | { readonly type: 'check' }
  | { readonly type: 'call' }
  | { readonly type: 'bet'; readonly to: number }
  | { readonly type: 'raise'; readonly to: number };

export interface SubmittedAction {
  readonly action: Action;
  /** Client-generated, stable across retries. Used for idempotency. */
  readonly actionId: string;
  /** The `actionSequence` the client saw. A mismatch rejects the action as stale. */
  readonly expectedSequence: number;
}

export interface LoggedAction {
  readonly sequence: number;
  readonly street: BettingStreet;
  readonly seat: SeatIndex;
  readonly playerId: string;
  readonly action: Action;
  /** Chips actually moved from stack to pot by this action. */
  readonly amountPaid: number;
  readonly betLevelAfter: number;
  /** Total pot after the action, including all previous streets. */
  readonly potAfter: number;
  /**
   * True when the server acted for the seat (clock ran out, or the player stood up holding cards).
   * See `ArchivedAction.automaticReason` in `apps/api/src/rooms/table.ts`.
   */
  readonly wasAutomatic: boolean;
  readonly actionId: string | null;
}

/** A blind or ante, posted before anyone chooses anything. */
export interface ForcedBet {
  readonly kind: 'ante' | 'smallBlind' | 'bigBlind';
  readonly seat: SeatIndex;
  readonly amount: number;
  readonly wasShort: boolean;
}

export interface Pot {
  readonly amount: number;
  /** Seats eligible to win it, still in the hand and committed to this level. */
  readonly eligibleSeats: readonly SeatIndex[];
  /** Per-seat total commitment that caps this layer. The main pot has the lowest. */
  readonly capPerSeat: number;
  /** 0 for the main pot, 1.. for side pots in ascending cap order. */
  readonly index: number;
}

export interface SeatShowdown {
  readonly seat: SeatIndex;
  readonly playerId: string;
  readonly holeCards: readonly [Card, Card];
  readonly score: HandScore;
  readonly description: string;
  readonly bestFive: readonly Card[];
}

export interface PotAward {
  readonly potIndex: number;
  readonly amount: number;
  readonly seat: SeatIndex;
  readonly playerId: string;
  readonly wasSplit: boolean;
  /** Extra chip(s) given to resolve an indivisible split. */
  readonly oddChips: number;
}

export interface HandResult {
  /** Empty when the hand ended before showdown (everyone else folded). */
  readonly showdowns: readonly SeatShowdown[];
  readonly pots: readonly Pot[];
  readonly awards: readonly PotAward[];
  /** Net chip change per seat across the hand, keyed by seat index. */
  readonly netBySeat: Readonly<Record<number, number>>;
  readonly endedByFold: boolean;
  /**
   * Merkle proofs for exactly the cards that became public, the board and the hole cards of seats
   * that showed. Everything else stays sealed. See commitment.ts.
   */
  readonly reveal: DeckReveal;
}

export interface HandState {
  readonly handId: string;
  readonly roomId: string;
  readonly handNumber: number;
  readonly config: TableConfig;
  /**
   * Where the button sat. Under the dead-button rule it may be an empty chair. Nothing derives the
   * blinds from it, `smallBlindSeat` and `bigBlindSeat` record where they fell.
   */
  readonly buttonSeat: SeatIndex;
  /** Who posted the small blind, or null when it was dead and nobody did. */
  readonly smallBlindSeat: SeatIndex | null;
  /** Who posted the big blind. Always a seat that was dealt in. */
  readonly bigBlindSeat: SeatIndex;
  readonly seats: readonly SeatState[];
  readonly board: readonly Card[];
  readonly street: Street;
  /**
   * The hand's secrets. Deck, cursor and salts reveal every undealt card. `redactFor()` strips them
   * and `test/hidden-information.test.ts` asserts it. Nothing outside this package reads them.
   */
  readonly deck: readonly Card[];
  readonly deckCursor: number;
  /** One 32-byte Merkle salt per deck position: 52 × 32 bytes. */
  readonly deckSalts: Uint8Array;
  readonly commitment: DeckCommitment;
  readonly toAct: SeatIndex | null;
  /** Highest `committedThisStreet` among all seats. */
  readonly betLevel: number;
  /**
   * The bet level set by the last COMPLETE bet or raise this street. A short all-in raises `betLevel`
   * without moving this, so it does not reopen the action.
   */
  readonly lastFullRaiseBetLevel: number;
  /** Size of the last complete bet or raise increment, for the min-raise rule. */
  readonly lastFullRaiseIncrement: number;
  readonly potFromPreviousStreets: number;
  readonly forcedBets: readonly ForcedBet[];
  readonly actions: readonly LoggedAction[];
  /** Increments on every applied action; used for optimistic concurrency. */
  readonly actionSequence: number;
  readonly result: HandResult | null;
  /** How the deck was produced, recorded so an unfair deal never looks like a fair one. */
  readonly randomSourceKind: 'csprng' | 'deterministic-test-only' | 'fixed-deck-scenario';

  /** Deck positions of each seat's hole cards and of the board so far, for settlement proofs. Secret. */
  readonly holeCardPositions: Readonly<Record<number, readonly number[]>>;
  readonly boardPositions: readonly number[];
}

/** Everything the engine emits, for the server to fan out and persist. */
export type HandEvent =
  | { readonly type: 'handStarted'; readonly handId: string; readonly commitment: string }
  | { readonly type: 'forcedBetsPosted'; readonly forcedBets: readonly ForcedBet[] }
  | { readonly type: 'holeCardsDealt'; readonly seats: readonly SeatIndex[] }
  | { readonly type: 'actionApplied'; readonly action: LoggedAction }
  | { readonly type: 'streetAdvanced'; readonly street: Street; readonly newCards: readonly Card[] }
  | { readonly type: 'potsFormed'; readonly pots: readonly Pot[] }
  | { readonly type: 'handComplete'; readonly result: HandResult };

/** A legal action, with the exact bounds the client may submit. */
export interface LegalAction {
  readonly type: ActionType;
  /** For call: the total this seat must reach. For bet/raise: the minimum. */
  readonly minTo?: number;
  /** For bet/raise: the maximum (i.e. all-in). */
  readonly maxTo?: number;
  /** Chips leaving the stack at `minTo`. */
  readonly costAtMin?: number;
  /** True when `maxTo` equals the seat's whole remaining stack. */
  readonly allInAtMax?: boolean;
  /** Plain-language reason this action exists, for the Coach panel. */
  readonly note?: string;
}
