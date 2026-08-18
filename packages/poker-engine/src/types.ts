/**
 * The shape of a hand of No-Limit Hold'em.
 *
 * Everything here is data. The engine is a pure function of (state, action) →
 * (state, events); it never reads a clock, never reads the network, and never
 * mutates its input. That is what makes it testable to the degree this project
 * needs, and what lets the server treat it as the single authority on what is
 * legal.
 *
 * Chips are integers throughout. "Units" is the user-facing word — they are free,
 * resettable and valueless, and nothing in this codebase converts them to or from
 * money.
 */

import type { Card } from './cards.ts';
import type { DeckCommitment, DeckReveal } from './commitment.ts';
import type { HandScore } from './evaluate.ts';

export type SeatIndex = number;

/** Betting rounds, plus the two terminal phases. */
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'complete';

export const BETTING_STREETS = ['preflop', 'flop', 'turn', 'river'] as const;
export type BettingStreet = (typeof BETTING_STREETS)[number];

export type SeatStatus =
  /** Holds cards and has chips behind; may still act. */
  | 'active'
  /** Has folded this hand. */
  | 'folded'
  /** Holds cards but has no chips behind; cannot act, can still win. */
  | 'allIn'
  /** Not dealt into this hand. */
  | 'sittingOut';

export interface TableConfig {
  readonly smallBlind: number;
  readonly bigBlind: number;
  /** Per-player forced bet before cards, 0 for a cash-style game. */
  readonly ante: number;
  /** 2..6. Heads-up (2) uses the reversed blind and action order. */
  readonly maxSeats: number;
  /**
   * Seconds a player has to act before the server takes the default action
   * (check if legal, otherwise fold). Enforced by the server, recorded here so
   * the engine's legal-action output can carry it to the client.
   */
  readonly actionTimeoutSeconds: number;
}

export interface SeatState {
  readonly seat: SeatIndex;
  readonly playerId: string;
  /** Chips behind, i.e. not yet committed. */
  readonly stack: number;
  /** Chips pushed forward on the current street. */
  readonly committedThisStreet: number;
  /** Chips pushed forward across the whole hand, including antes and blinds. */
  readonly committedTotal: number;
  /** Null for every seat but the recipient in a redacted view. */
  readonly holeCards: readonly [Card, Card] | null;
  readonly status: SeatStatus;
  /**
   * The bet level (`currentBet`) in force when this seat last acted on this
   * street, or null if it has not acted yet. This one field implements both
   * "who still needs to act" and "who may still raise" — see betting.ts.
   */
  readonly lastActedAtBetLevel: number | null;
  /** True once the seat has voluntarily put chips in on this street. */
  readonly isAllInThisHand: boolean;
}

export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise';

/**
 * A player's decision.
 *
 * `to` uses "raise to" semantics: it is the seat's TOTAL commitment for the
 * street after the action, not the increment. "Raise to 300" is unambiguous;
 * "raise 300" is not, and the ambiguity is a classic source of both UI bugs and
 * player disputes.
 */
export type Action =
  | { readonly type: 'fold' }
  | { readonly type: 'check' }
  | { readonly type: 'call' }
  | { readonly type: 'bet'; readonly to: number }
  | { readonly type: 'raise'; readonly to: number };

/** An action as submitted by a client, with the fields the server needs. */
export interface SubmittedAction {
  readonly action: Action;
  /** Client-generated, stable across retries. Used for idempotency. */
  readonly actionId: string;
  /**
   * The `actionSequence` the client believed was current. A mismatch means the
   * client acted on a stale view, and the action is rejected rather than applied
   * to a different situation than the player saw.
   */
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
  /** Bet level after the action. */
  readonly betLevelAfter: number;
  /** Total pot after the action, including all previous streets. */
  readonly potAfter: number;
  /** True when the server acted for a player who ran out of time. */
  readonly wasAutomatic: boolean;
  readonly actionId: string | null;
}

/** A blind, ante or straddle — money in before anyone chooses anything. */
export interface ForcedBet {
  readonly kind: 'ante' | 'smallBlind' | 'bigBlind';
  readonly seat: SeatIndex;
  readonly amount: number;
  /** True when the seat could not cover the forced bet in full. */
  readonly wasShort: boolean;
}

export interface Pot {
  /** Chips in this pot. */
  readonly amount: number;
  /** Seats eligible to win it — still in the hand and committed to this level. */
  readonly eligibleSeats: readonly SeatIndex[];
  /**
   * Per-seat total commitment that defines this layer. The main pot has the
   * lowest cap; each side pot caps higher.
   */
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
  /** The five cards that make the hand, for highlighting in review. */
  readonly bestFive: readonly Card[];
}

export interface PotAward {
  readonly potIndex: number;
  readonly amount: number;
  readonly seat: SeatIndex;
  readonly playerId: string;
  /** True when this seat shared the pot with others. */
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
  /** True if the hand ended without cards being shown. */
  readonly endedByFold: boolean;
  /**
   * Merkle proofs for exactly the cards that legitimately became public: every
   * board card, plus the hole cards of seats that actually showed at showdown.
   * Cards nobody was entitled to see stay sealed — see commitment.ts for why
   * revealing the whole deck here would be a serious information leak.
   */
  readonly reveal: DeckReveal;
}

export interface HandState {
  readonly handId: string;
  readonly roomId: string;
  readonly handNumber: number;
  readonly config: TableConfig;
  readonly buttonSeat: SeatIndex;
  readonly seats: readonly SeatState[];
  readonly board: readonly Card[];
  readonly street: Street;
  /**
   * The shuffled deck, the read cursor and the commitment salt.
   *
   * These three fields are the hand's secrets: together they reveal every undealt
   * card. `redactFor()` in redact.ts strips all three, and
   * `test/hidden-information.test.ts` asserts that no redacted view can contain
   * them. Nothing outside this package should ever read them.
   */
  readonly deck: readonly Card[];
  readonly deckCursor: number;
  /** One 32-byte Merkle salt per deck position: 52 × 32 bytes. */
  readonly deckSalts: Uint8Array;
  readonly commitment: DeckCommitment;
  /** Whose turn it is, or null when no one may act. */
  readonly toAct: SeatIndex | null;
  /** Highest `committedThisStreet` among all seats. */
  readonly betLevel: number;
  /**
   * The bet level created by the most recent COMPLETE bet or raise this street.
   * A short all-in raises `betLevel` without moving this, which is exactly what
   * stops it from reopening the action. See betting.ts.
   */
  readonly lastFullRaiseBetLevel: number;
  /** Size of the last complete bet or raise increment, for the min-raise rule. */
  readonly lastFullRaiseIncrement: number;
  /** Chips already collected from completed streets. */
  readonly potFromPreviousStreets: number;
  readonly forcedBets: readonly ForcedBet[];
  readonly actions: readonly LoggedAction[];
  /** Increments on every applied action; used for optimistic concurrency. */
  readonly actionSequence: number;
  readonly result: HandResult | null;
  /**
   * How this hand's deck was produced, recorded permanently so a hand can never
   * silently look like a fairly dealt one when it was not.
   */
  readonly randomSourceKind: 'csprng' | 'deterministic-test-only' | 'fixed-deck-scenario';

  /**
   * Deck positions each seat's hole cards came from, and the positions of the
   * board cards dealt so far. Kept so that settlement can build Merkle proofs for
   * exactly the cards that became public. Secret, like the deck itself.
   */
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
