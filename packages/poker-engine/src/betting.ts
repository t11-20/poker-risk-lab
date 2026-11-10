/**
 * Betting rules: who may act, what they may do, and what it costs.
 *
 * The two rules that implementations usually get wrong, and how they are handled
 * here:
 *
 * ## 1. The minimum raise
 *
 * The minimum raise *increment* is the size of the largest complete bet or raise
 * so far on this street. Preflop, the big blind counts as a bet of one big blind,
 * so the first raise must be to at least 2 BB. If A raises to 100 over a bet of
 * 20, the increment is 80, and the next raise must be to at least 180 — not 200,
 * and not 120.
 *
 * ## 2. A short all-in does not reopen the action
 *
 * If a player is all-in for more than the current bet but for less than a full
 * raise, players who have already acted at the current level may call the extra
 * or fold, but may NOT raise. Players who have not yet acted may still raise.
 *
 * This is implemented with two fields rather than a pile of booleans:
 *
 *   - `state.lastFullRaiseBetLevel` — the bet level produced by the most recent
 *     COMPLETE bet or raise. A short all-in raises `betLevel` but leaves this
 *     untouched.
 *   - `seat.lastActedAtBetLevel` — the bet level in force when this seat last
 *     acted this street, or null if it has not acted.
 *
 * A seat still owes an action when it is active and either has not acted or is
 * short of `betLevel`. A seat may raise when it has not acted, when a COMPLETE
 * raise has landed since it acted (`lastActedAtBetLevel < lastFullRaiseBetLevel`),
 * or when the total increase since it acted is itself at least a full raise
 * (`betLevel - lastActedAtBetLevel >= max(lastFullRaiseIncrement, bigBlind)`).
 *
 * That third clause is not a refinement, it is the rule: TDA 43-C reopens the
 * action to a seat that "is facing at least a full raise when the action returns
 * to him". One short all-in never reaches that bar; two consecutive ones can,
 * because their increments add. Working the single-short-all-in case through the
 * first two clauses alone comes out right, which is exactly why the missing third
 * one survived — see `mayRaise` for the hand that exposed it.
 *
 * ## 3. When the betting is closed for the whole hand
 *
 * Betting ends for good as soon as no further wagering is *possible*, which is a
 * different question from "has everybody acted". It is closed when at most one seat
 * has chips behind AND that seat owes nothing, because then no chip can move: there
 * is nobody to bet into and nobody to call. The board is dealt out and the hands are
 * tabled with no further action — in particular no fold, because a seat that has
 * already paid in full and cannot be raised has nothing left to give up. See
 * `isBettingClosedForHand`, which enumerates the cases.
 */

import type { HandState, LegalAction, SeatIndex, SeatState } from './types.ts';

export class BettingRuleError extends Error {
  override readonly name = 'BettingRuleError';
}

export function seatAt(state: HandState, seat: SeatIndex): SeatState {
  const found = state.seats.find((candidate) => candidate.seat === seat);
  if (found === undefined) throw new BettingRuleError(`no seat ${seat} at this table`);
  return found;
}

/** Seats holding cards: they can still win, whether or not they can still act. */
export function seatsInHand(state: HandState): readonly SeatState[] {
  return state.seats.filter((seat) => seat.status === 'active' || seat.status === 'allIn');
}

/** Seats that can still put chips in. */
export function seatsAbleToAct(state: HandState): readonly SeatState[] {
  return state.seats.filter((seat) => seat.status === 'active');
}

/** Total chips in the middle: previous streets plus this street's commitments. */
export function totalPot(state: HandState): number {
  let sum = state.potFromPreviousStreets;
  for (const seat of state.seats) sum += seat.committedThisStreet;
  return sum;
}

/** What this seat must add to match the current bet. Never negative. */
export function amountToCall(state: HandState, seat: SeatState): number {
  return Math.max(0, Math.min(state.betLevel - seat.committedThisStreet, seat.stack));
}

/** True when this seat still owes an action on this street. */
export function owesAction(state: HandState, seat: SeatState): boolean {
  if (seat.status !== 'active') return false;
  if (seat.lastActedAtBetLevel === null) return true;
  return seat.committedThisStreet < state.betLevel;
}

/**
 * True when this seat is allowed to raise, as opposed to only call or fold.
 *
 * Two ways in: a complete raise has landed since this seat acted, or the total increase since it
 * acted is itself at least a full raise. The second clause is the half this function used to be
 * missing, and it is the half the rule is actually written with.
 *
 * TDA Rule 43-C and Robert's Rules both say an all-in wager of less than a full raise does not
 * reopen the betting to a player who has already acted **and is not facing at least a full raise
 * when the action returns to him**. One short all-in cannot reach that bar, which is why keying
 * only on `lastFullRaiseBetLevel` looks complete and passes the one-short-all-in test. Two or
 * more consecutive short all-ins can: their increments add up.
 *
 * The case, reproduced: blinds 5/10, seat 3 raises to 100 (a full raise, increment 90), seat 0
 * calls 100, seat 1 is all-in to 150 (short — the minimum was 190), seat 2 is all-in to 220
 * (short — the minimum was 240). `lastFullRaiseBetLevel` is still 100, so the old test refused
 * seat 3 and seat 0 a re-raise. But seat 3 last acted at 100 and now faces 220: an increase of
 * 120 against a full-raise increment of 90. It is facing more than a full raise and the action is
 * reopened. A 30,000-hand fuzz found 44 wrongly-denied raises across 34 hands.
 *
 * The error was one-directional — `lastActedAtBetLevel < lastFullRaiseBetLevel` implies the seat
 * is facing at least a full raise, so the old code never *permitted* an illegal raise, it only
 * refused legal ones — which is why nothing detected it as chips going missing.
 *
 * `max(lastFullRaiseIncrement, bigBlind)` is the same bar `minRaiseTo` uses, and deliberately so:
 * "a full raise" has one meaning in this file.
 */
export function mayRaise(state: HandState, seat: SeatState): boolean {
  if (seat.lastActedAtBetLevel === null) return true;
  if (seat.lastActedAtBetLevel < state.lastFullRaiseBetLevel) return true;
  const fullRaise = Math.max(state.lastFullRaiseIncrement, state.config.bigBlind);
  return state.betLevel - seat.lastActedAtBetLevel >= fullRaise;
}

/**
 * The minimum total a raise must reach.
 *
 * `betLevel + max(lastFullRaiseIncrement, bigBlind)`: the increment must at least
 * match the last complete aggression, and never be smaller than one big blind
 * (which covers the opening bet on a postflop street, where the increment so far
 * is zero).
 */
export function minimumRaiseTo(state: HandState): number {
  const increment = Math.max(state.lastFullRaiseIncrement, state.config.bigBlind);
  return state.betLevel + increment;
}

/** The most this seat can put out: its whole stack plus what it already committed. */
export function maximumBetTo(seat: SeatState): number {
  return seat.committedThisStreet + seat.stack;
}

/**
 * Whether any further wagering is possible for the rest of the hand. When it is
 * not, nobody may act again: the remaining streets are dealt out and the hand is
 * shown down.
 *
 * The four cases, exhaustively:
 *
 *   1. At most one seat still holds cards. The hand is already decided.
 *      → CLOSED.
 *   2. Two or more seats hold cards and none has chips behind (everyone all-in).
 *      Nobody can put another chip in. → CLOSED.
 *   3. Exactly one seat has chips behind, every other contender is all-in, and
 *      that seat has already matched the bet level. There is nobody left who
 *      could call a bet, and this seat cannot be raised off a pot it has paid for
 *      in full, so it has no decision to make. → CLOSED. Offering it a fold here
 *      would let it forfeit chips it can no longer lose, which is not a legal
 *      option in No-Limit Hold'em.
 *   4. Exactly one seat has chips behind and it is still SHORT of the bet level
 *      (it owes chips to match an opponent's all-in, whether or not its own stack
 *      can cover them). That is a real live decision — call, possibly all-in for
 *      less, or fold. → NOT CLOSED.
 *
 * Deliberately independent of `owesAction`/`lastActedAtBetLevel`. This function is
 * evaluated from `advanceStreets`, which runs AFTER `closeStreet` has reset
 * `lastActedAtBetLevel` to null for every seat; the previous implementation also
 * required `!owesAction(state, only)`, which is therefore always false at a street
 * boundary, and case 3 could never be reached. Whether the lone seat has acted this
 * street has no bearing on whether anyone is left to wager against it.
 */
export function isBettingClosedForHand(state: HandState): boolean {
  const contenders = seatsInHand(state);
  if (contenders.length <= 1) return true; // case 1
  const withChips = contenders.filter((seat) => seat.status === 'active');
  if (withChips.length === 0) return true; // case 2
  if (withChips.length === 1) {
    const [only] = withChips;
    if (only === undefined) return true;
    return only.committedThisStreet >= state.betLevel; // cases 3 and 4
  }
  return false;
}

/**
 * Whether the current betting round is finished.
 *
 * A round ends when nobody who can act still owes an action, and also whenever no
 * further wagering is possible for the whole hand — if the hand's betting is closed
 * then this street's certainly is, including the case where the one seat with chips
 * has not "acted" but has nothing left to act on.
 */
export function isBettingRoundComplete(state: HandState): boolean {
  // Subsumes the old shortcuts: one contender left, or nobody with chips behind.
  if (isBettingClosedForHand(state)) return true;
  // Exactly one seat able to act and everyone else all-in reaches here only when
  // that seat is short of the bet level, i.e. it may still call or fold.
  return !seatsAbleToAct(state).some((seat) => owesAction(state, seat));
}

/**
 * Every action this seat may legally take right now, with exact bounds.
 *
 * The client renders from this list and submits values within these bounds; the
 * server re-derives the same list and re-validates, so a tampered client cannot
 * invent an action. This function is the single definition of "legal".
 */
export function legalActions(state: HandState, seat: SeatIndex): LegalAction[] {
  if (state.toAct !== seat) return [];
  const actor = seatAt(state, seat);
  if (actor.status !== 'active') return [];
  // Nothing can be wagered for the rest of the hand and this seat owes nothing:
  // there is no action to take, not even a fold. The board runs out and the hands
  // are tabled. `advanceStreets` never sets `toAct` in such a state, so this is a
  // second line of defence for a state assembled by hand or by a tampered client.
  if (isBettingClosedForHand(state)) return [];

  const out: LegalAction[] = [];
  const toCall = amountToCall(state, actor);
  const maxTo = maximumBetTo(actor);
  // Aggression needs somebody who could answer it. If every opponent still in the
  // hand is all-in, a bet or raise cannot be called and would simply be returned,
  // so the only decisions left are call and fold.
  const someOpponentCanAct = state.seats.some(
    (other) => other.seat !== seat && other.status === 'active' && other.stack > 0,
  );

  // Folding is always available while facing a bet; folding when you could check
  // for free is legal in poker but is never a good idea, so it is offered with a
  // note rather than hidden.
  out.push({
    type: 'fold',
    note:
      toCall > 0
        ? 'Give up the hand and lose what you have already put in.'
        : 'Legal, but checking costs nothing.',
  });

  if (toCall === 0) {
    out.push({ type: 'check', costAtMin: 0, note: 'Stay in the hand for free.' });
  } else {
    out.push({
      type: 'call',
      minTo: Math.min(state.betLevel, maxTo),
      costAtMin: toCall,
      allInAtMax: toCall === actor.stack,
      note:
        toCall === actor.stack
          ? 'Calling puts your whole remaining stack in.'
          : 'Match the bet to see the next card.',
    });
  }

  // Aggression: a bet if nobody has bet yet this street, otherwise a raise.
  const isOpening = state.betLevel === 0;
  if (mayRaise(state, actor) && actor.stack > 0 && someOpponentCanAct) {
    const minTo = isOpening
      ? Math.max(state.config.bigBlind, state.lastFullRaiseIncrement)
      : minimumRaiseTo(state);
    if (maxTo > state.betLevel) {
      // A seat that cannot reach the minimum may still shove: a short all-in is a
      // legal (incomplete) raise.
      const effectiveMinTo = Math.min(minTo, maxTo);
      out.push({
        type: isOpening ? 'bet' : 'raise',
        minTo: effectiveMinTo,
        maxTo,
        costAtMin: effectiveMinTo - actor.committedThisStreet,
        allInAtMax: true,
        note:
          effectiveMinTo === maxTo
            ? 'Your stack only reaches an all-in, which counts as a raise even if it is short of the minimum.'
            : isOpening
              ? 'Open the betting.'
              : 'Increase the bet. Opponents must match the new total or fold.',
      });
    }
  }

  return out;
}

/**
 * Validates a proposed action against `legalActions` and returns the exact chips
 * that would leave the stack.
 *
 * Kept separate from `applyAction` so the same validation can run on a client for
 * instant feedback and on the server as the authority, with no chance of the two
 * drifting apart.
 */
export interface ValidatedAction {
  readonly kind: 'fold' | 'check' | 'call' | 'bet' | 'raise';
  /** Total street commitment after the action. */
  readonly to: number;
  /** Chips moving from stack to pot. */
  readonly cost: number;
  /** True when this action leaves the seat with no chips behind. */
  readonly isAllIn: boolean;
  /** True when a bet/raise reached the minimum, i.e. it reopens the action. */
  readonly isCompleteRaise: boolean;
}

export function validateAction(
  state: HandState,
  seat: SeatIndex,
  action: { type: string; to?: number },
): ValidatedAction {
  if (state.street === 'showdown' || state.street === 'complete') {
    throw new BettingRuleError(`no actions are legal during ${state.street}`);
  }
  if (state.toAct !== seat) {
    throw new BettingRuleError(`it is not seat ${seat}'s turn (waiting on ${String(state.toAct)})`);
  }
  const actor = seatAt(state, seat);
  if (actor.status !== 'active') {
    throw new BettingRuleError(`seat ${seat} cannot act with status ${actor.status}`);
  }

  const legal = legalActions(state, seat);
  const permitted = new Set(legal.map((entry) => entry.type));
  const toCall = amountToCall(state, actor);
  const maxTo = maximumBetTo(actor);

  switch (action.type) {
    case 'fold': {
      // Folding is legal at almost every decision point, including facing no bet.
      // The one exception is a closed betting round: with nothing to call and no
      // opponent able to wager, the cards are tabled and the board runs out, so a
      // fold here would throw away a pot the seat has already paid for in full.
      if (!permitted.has('fold')) {
        throw new BettingRuleError(
          'you cannot fold here: nobody can bet again and you owe nothing, so the board runs out',
        );
      }
      return { kind: 'fold', to: actor.committedThisStreet, cost: 0, isAllIn: false, isCompleteRaise: false };
    }

    case 'check': {
      if (!permitted.has('check')) {
        throw new BettingRuleError(
          toCall > 0
            ? `cannot check facing a bet of ${state.betLevel}; ${toCall} to call`
            : 'you cannot check here: nobody can bet again, so the board runs out on its own',
        );
      }
      return {
        kind: 'check',
        to: actor.committedThisStreet,
        cost: 0,
        isAllIn: false,
        isCompleteRaise: false,
      };
    }

    case 'call': {
      if (!permitted.has('call')) throw new BettingRuleError('nothing to call — check instead');
      const to = actor.committedThisStreet + toCall;
      return {
        kind: 'call',
        to,
        cost: toCall,
        isAllIn: toCall === actor.stack,
        isCompleteRaise: false,
      };
    }

    case 'bet':
    case 'raise': {
      const entry = legal.find((candidate) => candidate.type === action.type);
      if (entry === undefined) {
        const other = legal.find((candidate) => candidate.type === 'bet' || candidate.type === 'raise');
        if (other !== undefined) {
          throw new BettingRuleError(`use "${other.type}" here, not "${action.type}"`);
        }
        if (!mayRaise(state, actor)) {
          throw new BettingRuleError(
            'you may not raise: the last increase was a short all-in, so you may only call or fold',
          );
        }
        throw new BettingRuleError(
          seatsAbleToAct(state).length <= 1
            ? 'no bet or raise is available: every opponent is all-in, so there is nobody to call it'
            : 'no bet or raise is available',
        );
      }
      const to = action.to;
      if (typeof to !== 'number' || !Number.isInteger(to)) {
        throw new BettingRuleError(`${action.type} requires an integer "to" amount`);
      }
      const minTo = entry.minTo ?? 0;
      const entryMaxTo = entry.maxTo ?? maxTo;
      if (to < minTo) {
        throw new BettingRuleError(`${action.type} to ${to} is below the minimum of ${minTo}`);
      }
      if (to > entryMaxTo) {
        throw new BettingRuleError(`${action.type} to ${to} exceeds your maximum of ${entryMaxTo}`);
      }
      const cost = to - actor.committedThisStreet;
      if (cost > actor.stack) {
        throw new BettingRuleError(`${action.type} to ${to} costs ${cost} but only ${actor.stack} is behind`);
      }
      const fullMinimum =
        state.betLevel === 0
          ? Math.max(state.config.bigBlind, state.lastFullRaiseIncrement)
          : minimumRaiseTo(state);
      return {
        kind: action.type,
        to,
        cost,
        isAllIn: cost === actor.stack,
        // A raise that reaches the true minimum is complete and reopens the
        // action. A short all-in below it does not.
        isCompleteRaise: to >= fullMinimum,
      };
    }

    default:
      throw new BettingRuleError(`unknown action type "${action.type}"`);
  }
}
