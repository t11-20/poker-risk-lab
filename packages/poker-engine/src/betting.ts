/**
 * Betting rules: who may act, what they may do, and what it costs.
 *
 * Minimum raise. The increment is the largest complete bet or raise this street, and the big blind
 * counts as one preflop. A raise to 100 over a bet of 20 makes the next minimum 180.
 *
 * A short all-in does not reopen the action (TDA 43-C). `state.lastFullRaiseBetLevel` is the level
 * set by the last COMPLETE bet or raise, and a short all-in leaves it alone. `seat.lastActedAtBetLevel`
 * is the level when the seat last acted this street, or null. See `mayRaise` for the full rule.
 *
 * Betting closes for the whole hand once no chip can move, which differs from "everyone has acted".
 * See `isBettingClosedForHand`.
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

export function owesAction(state: HandState, seat: SeatState): boolean {
  if (seat.status !== 'active') return false;
  if (seat.lastActedAtBetLevel === null) return true;
  return seat.committedThisStreet < state.betLevel;
}

/**
 * True when this seat may raise rather than only call or fold. Either a complete raise has landed
 * since it acted, or the total increase since it acted is at least a full raise (TDA 43-C, "facing
 * at least a full raise when the action returns"). Two short all-ins can add up to that. With blinds
 * 5/10, a raise to 100, a call, then short all-ins to 150 and 220, the raiser faces +120 against an
 * increment of 90 and may re-raise. Missing that clause, a 30,000-hand fuzz found 44 wrongly denied
 * raises. The full-raise bar matches `minimumRaiseTo`.
 */
export function mayRaise(state: HandState, seat: SeatState): boolean {
  if (seat.lastActedAtBetLevel === null) return true;
  if (seat.lastActedAtBetLevel < state.lastFullRaiseBetLevel) return true;
  const fullRaise = Math.max(state.lastFullRaiseIncrement, state.config.bigBlind);
  return state.betLevel - seat.lastActedAtBetLevel >= fullRaise;
}

/**
 * The minimum total a raise must reach. The increment is at least the last complete aggression and
 * at least one big blind (the postflop opening bet, where the increment so far is zero).
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
 * Whether any further wagering is possible this hand. When not, the remaining streets are dealt
 * and the hand is shown down. The cases:
 *
 *   1. At most one seat holds cards. CLOSED.
 *   2. Several hold cards and none has chips behind. CLOSED.
 *   3. One seat has chips behind and has matched the bet level. Nobody can call it, so CLOSED, and
 *      it gets no fold (forfeiting a fully paid pot is not a legal NLHE option).
 *   4. One seat has chips behind and is SHORT of the bet level. It may call or fold. NOT CLOSED.
 *
 * Independent of `owesAction`, because `advanceStreets` runs after `closeStreet` resets
 * `lastActedAtBetLevel` to null, and case 3 would then be unreachable.
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
 * Whether the current betting round is finished. True when no seat that can act owes an action, or
 * whenever the hand's betting is closed.
 */
export function isBettingRoundComplete(state: HandState): boolean {
  if (isBettingClosedForHand(state)) return true;
  // With one seat able to act and everyone else all-in, reaching here means that seat is short.
  return !seatsAbleToAct(state).some((seat) => owesAction(state, seat));
}

/**
 * Every legal action for this seat now, with exact bounds. The single definition of "legal". The
 * server re-derives and re-validates it, so a tampered client cannot invent an action.
 */
export function legalActions(state: HandState, seat: SeatIndex): LegalAction[] {
  if (state.toAct !== seat) return [];
  const actor = seatAt(state, seat);
  if (actor.status !== 'active') return [];
  // Nothing can be wagered and this seat owes nothing, so no action, not even a fold.
  // `advanceStreets` never sets `toAct` here. This guards a hand-built or tampered state.
  if (isBettingClosedForHand(state)) return [];

  const out: LegalAction[] = [];
  const toCall = amountToCall(state, actor);
  const maxTo = maximumBetTo(actor);
  // If every opponent is all-in, a bet cannot be called, so only call and fold remain.
  const someOpponentCanAct = state.seats.some(
    (other) => other.seat !== seat && other.status === 'active' && other.stack > 0,
  );

  // Folding when a check is free is legal, so it is offered with a note rather than hidden.
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

  const isOpening = state.betLevel === 0;
  if (mayRaise(state, actor) && actor.stack > 0 && someOpponentCanAct) {
    const minTo = isOpening
      ? Math.max(state.config.bigBlind, state.lastFullRaiseIncrement)
      : minimumRaiseTo(state);
    if (maxTo > state.betLevel) {
      // A seat short of the minimum may still shove, as an incomplete raise.
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
 * A proposed action checked against `legalActions`, with the chips it costs. Separate from
 * `applyAction` so client and server run the same validation.
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
      // Fold is refused only when betting is closed and the seat owes nothing.
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
        // Only a raise that reaches the true minimum reopens the action.
        isCompleteRaise: to >= fullMinimum,
      };
    }

    default:
      throw new BettingRuleError(`unknown action type "${action.type}"`);
  }
}
