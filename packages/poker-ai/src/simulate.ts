/**
 * Bulk deterministic simulation: the machinery that turns "twelve distinct styles" into a
 * measurement rather than a claim on a card.
 *
 * ## Why this drives the real engine
 *
 * The temptation in a statistics harness is to fake the table: deal two cards, ask the policy
 * for a number, tally it. That harness measures the harness. Every figure it produced would
 * be a statement about a simplified game nobody plays, and the one thing the numbers are
 * supposed to support — "this model behaves the way its card says when it actually plays
 * poker" — would be exactly what went untested.
 *
 * So this module calls `startHand`, `redactFor`, `decide` and `applyAction`, in that order,
 * with no shortcuts. The blinds are posted by the engine, the button rotates, the min-raise
 * rule is the engine's, showdowns are evaluated by the engine, and the pots are split by the
 * engine. If a policy proposes something illegal, the engine rejects it and the run fails
 * loudly instead of quietly producing a plausible-looking table of numbers.
 *
 * ## The asymmetry between the observer and the players, stated on purpose
 *
 * This file reads `HandState` — hole cards, statuses, results. It has to: it is the dealer
 * and the scorekeeper. A **policy** never sees any of that. Each policy is handed
 * `redactFor(state, { viewerSeat })` plus its own two cards, and nothing else, so the
 * information it could cheat with is not present in its input at all (see
 * `packages/poker-engine/src/redact.ts`, and §7 of `docs/AI-LEGENDS.md`). The asymmetry is
 * the point, and it is worth naming because "the simulation reads the deck" and "the policy
 * reads the deck" look similar in a diff and are opposites in effect.
 *
 * `holdingIsAir` is the same story: the harness classifies an aggressive action as a bluff by
 * looking at cards the actor's opponents cannot see. That is what an observer is for. Nothing
 * computed from it is ever handed back to a policy.
 *
 * ## Traps this design avoids, each of which silently corrupts every number downstream
 *
 * 1. **One shared generator for the whole run.** Convenient, and wrong twice over. Seat 1's
 *    card draws would depend on how many random draws seat 0 happened to make, so changing
 *    one profile's decision logic would change every other seat's *cards* — turning a
 *    behavioural comparison into a comparison of different deals. And the deal would be
 *    entangled with the decisions, so a policy that consumed one more random number would
 *    reshuffle the deck. Instead every stream is derived independently from
 *    `(streamTag, config.seed, handIndex, seat)`, so seats are independent, the deal is
 *    independent of all of them, and the whole run reproduces from one integer.
 *
 * 2. **Letting the run bust out.** With stacks carried forward, a 20,000-hand heads-up run
 *    against a losing profile is a few hundred hands followed by a bust, and the statistics
 *    then describe *survival* rather than style. `resetStacksEachHand` therefore defaults to
 *    **true**: the safe default is the one you get by not thinking about it. Carrying stacks
 *    forward is available, and a run that ends early says so in `stoppedEarly` rather than
 *    reporting a smaller `handsCompleted` and hoping someone notices.
 *
 * 3. **Computing what an action cost.** The chips a call or a short all-in actually moves are
 *    not `to - betLevel`; they are clamped by the stack, and getting that wrong biases the
 *    mean bet size. So the cost recorded here is the engine's own `amountPaid` from the
 *    logged action, read after the action was applied.
 *
 * 4. **Repairing an illegal proposal.** A harness that quietly clamped a policy's out-of-
 *    range raise would hide the bug and keep publishing numbers. Proposals of a type the
 *    engine did not offer are refused outright; sizes are clamped into the engine's
 *    `minTo`/`maxTo` and **counted**, so `sizeClampsApplied` is an assertable 0 rather than
 *    an invisible correction.
 *
 * 5. **Measuring frequencies over the wrong denominator.** That trap lives in `stats.ts`,
 *    which owns every ratio and documents every denominator. This module's job is only to
 *    call `beginHand`, `noteDecision` and `endHand` at exactly the right moments — which is
 *    why those are three explicit calls on a stateful accumulator rather than a pile of
 *    counters incremented inline.
 *
 * ## The equity budget is smaller here than in a live hand, and that is a stated trade-off
 *
 * A policy assesses its own hand with bounded Monte Carlo, and `DIFFICULTY_SETTINGS` budgets
 * 4,000 to 12,000 samples for a decision made in front of a person waiting for it. A
 * statistical run makes on the order of a hundred thousand such decisions, so the live budget
 * would put a single differentiation test into the hours.
 *
 * `SIMULATION_EQUITY_SAMPLES` is therefore 500 by default, overridable per run. At 500
 * samples the 95% half-width on an equity near 0.5 is `1.96 x 0.5 / sqrt(500)` = 0.044, i.e.
 * ±4.4 percentage points. What that costs, honestly: a decision sitting within about four
 * points of a threshold can flip. The noise is symmetric about the true equity, so it does
 * not push a frequency in a consistent direction, but "symmetric noise through a nonlinear
 * threshold" is not the same as "no effect", and no claim is made that the effect is exactly
 * zero. It is small next to the deliberate difficulty noise (0.05 to 0.18) that the design
 * adds on purpose, and every tolerance asserted in
 * `test/simulation/profile-differentiation.test.ts` is stated with this in it. A run that
 * wants the live budget passes `equitySamples` explicitly.
 *
 * ## Two observers, watching the same hand for different reasons
 *
 * Every turn feeds two accumulators, and confusing them would be easy and wrong:
 *
 *   - `SeatObservations` in `stats.ts` is the **measurement**. It exists outside the game, is
 *     never shown to a policy, and its air classification reads cards nobody else may see.
 *   - `OpponentModel` in `opponent-model.ts` is **part of the game**. It is what a policy is
 *     allowed to know about its opponents, so it is fed only `PublicActionEvent`s and the
 *     completed `PlayerView` — never a hole card, never a hand state.
 *
 * They take almost the same fields, from the same place in this loop, which is exactly why the
 * distinction is written down here rather than left to be inferred. Both are fed from the
 * pre-action view plus the engine's own `amountPaid`, so the two can never disagree about what
 * happened; only about who is entitled to know it.
 */

import {
  type Action,
  applyAction,
  createDeterministicRandomForTests,
  type HandState,
  type LegalAction,
  type RandomSource,
  redactFor,
  seatAt,
  startHand,
  type TableConfig,
} from '@prl/poker-engine';
import type { StrengthAssessment } from './hand-strength.ts';
import { createOpponentModel, type OpponentModel, type PublicActionEvent } from './opponent-model.ts';
import { decide, type PolicyInput } from './policy.ts';
import {
  DIFFICULTY_SETTINGS,
  type Difficulty,
  type DifficultySettings,
  expressTraits,
  requireProfile,
} from './profiles.ts';
import { holdingIsAir, SeatObservations, type SeatSimulationStats } from './stats.ts';
import type { Traits } from './traits.ts';

export class SimulationError extends Error {
  override readonly name = 'SimulationError';
}

/**
 * Monte Carlo samples a policy may use per decision during a bulk run. See the module
 * comment for the arithmetic and for what the reduction costs.
 */
export const SIMULATION_EQUITY_SAMPLES = 500;

/**
 * Stream tags. Mixed in first so that the deal and every seat's decisions draw from streams
 * that cannot coincide, however the other parts happen to line up.
 */
const DEAL_STREAM = 1;
const DECISION_STREAM = 2;

/** Matches the engine's own fuzz guard. A hand that exceeds this is a harness bug. */
const MAX_ACTIONS_PER_HAND = 400;

/** Recorded in the table config and never used: the harness has no clock to time out on. */
const ACTION_TIMEOUT_SECONDS = 30;

export interface SimulationConfig {
  /** One profile id per seat, 2 (heads-up) to 6. Order is seat order. */
  readonly profileIds: readonly string[];
  readonly difficulty: Difficulty;
  readonly hands: number;
  /** The whole run reproduces from this one integer. */
  readonly seed: number;
  readonly startingStack: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante?: number;
  /**
   * Reset stacks each hand so results are per-hand and not confounded by busting. Defaults
   * to **true** — see trap 2 in the module comment for why that is the safe default.
   */
  readonly resetStacksEachHand?: boolean;
  /**
   * Monte Carlo samples per decision. Defaults to `SIMULATION_EQUITY_SAMPLES`, which is far
   * below the live budget on purpose and for a stated reason.
   */
  readonly equitySamples?: number;
}

export interface SimulationResult {
  readonly config: SimulationConfig;
  readonly handsCompleted: number;
  readonly bySeat: readonly SeatSimulationStats[];
  readonly elapsedMs: number;
  readonly actionsApplied: number;
  /**
   * Hands whose chip total was verified unchanged from deal to settlement. Equals
   * `handsCompleted`, because a mismatch throws — carried anyway so a caller can assert on
   * the check having actually run rather than trusting that it did.
   */
  readonly chipConservationChecks: number;
  /**
   * Bet or raise sizes the harness had to pull into the engine's bounds. A correct policy
   * clamps its own sizes, so this is an assertable 0 rather than a silent correction.
   */
  readonly sizeClampsApplied: number;
  /** Why the run stopped before `config.hands` hands, or null if it did not. */
  readonly stoppedEarly: string | null;
  /** The equity sample budget the policies were actually given. */
  readonly equitySamples: number;
}

/**
 * The part of a policy's decision the harness uses.
 *
 * Deliberately almost nothing. The reasoning, the pre-sampling distribution and the driving
 * traits are the replay view's business; a harness that depended on their shape would break
 * every time that shape changed, and 100,000 decisions per run is the wrong place to be
 * building explanatory prose.
 *
 * The one exception is `strength`, and it is here for a stated reason. `aggressionFrequency` is
 * declared as the rate on a NEUTRAL hand assessment (`traits.ts`), so the only honest way to
 * measure the declared quantity is to condition on the assessment the model actually made —
 * which is the model's own output and nothing else's. Left optional so that the trivial
 * stand-ins `test/stats.test.ts` drives the harness with still satisfy the seam; when it is
 * absent the observer records `null` and simply counts no neutral spots, rather than guessing
 * one. Nothing computed from it is ever handed back to a policy: this is the observer's channel
 * out of the game, in the same direction as `holdingIsAir`.
 */
export interface ProposedAction {
  readonly action: Action;
  /** The model's own assessment of its holding, if it published one. Never fed back in. */
  readonly strength?: StrengthAssessment;
}

export interface SimulationHooks {
  /**
   * Replaces the policy under test. The default is `decide` from `./policy.ts`, and the
   * differentiation tests use the default — a statistical claim about the profiles has to be
   * a claim about the real policy.
   *
   * The seam exists for two narrower jobs. `test/stats.test.ts` drives the harness with a
   * trivial stand-in so that harness bookkeeping (denominators, chip conservation, button
   * rotation) can be tested in milliseconds rather than minutes. And a hidden-information
   * test can wrap the input in a recording `Proxy` and assert on the property paths the
   * policy actually read.
   */
  readonly decide?: (input: PolicyInput) => ProposedAction;
}

/**
 * Derives one 32-bit seed from several integers.
 *
 * The SplitMix32 finalizer — two multiply-xorshift rounds — applied once per part, so every
 * part reaches every output bit. It is not cryptographic and does not need to be; it needs to
 * make `(2, 7, 1)` and `(2, 1, 7)` land in unrelated places, which a sum or an XOR would not.
 * Deriving rather than incrementing is what keeps a seat's stream independent of how many
 * random numbers its opponents consumed.
 */
export function deriveSeed(...parts: readonly number[]): number {
  let hash = 0x9e37_79b9 >>> 0;
  for (const part of parts) {
    if (!Number.isInteger(part)) {
      throw new SimulationError(`deriveSeed needs integers, received ${String(part)}`);
    }
    hash = (hash ^ (part >>> 0)) >>> 0;
    hash = Math.imul(hash ^ (hash >>> 16), 0x21f0_aaad) >>> 0;
    hash = Math.imul(hash ^ (hash >>> 15), 0x735a_2d97) >>> 0;
    hash = (hash ^ (hash >>> 15)) >>> 0;
  }
  return hash >>> 0;
}

/** Everything one seat carries for the length of a run. */
interface SeatRuntime {
  readonly seat: number;
  readonly profileId: string;
  readonly traits: Traits;
  readonly model: OpponentModel;
  readonly observer: SeatObservations;
  /**
   * This seat's generator for the hand in progress, replaced at the start of every hand and
   * cleared at the end of it. Held per hand rather than per run so that the stream a seat
   * draws from depends only on `(seed, handIndex, seat)` — never on how many random numbers
   * the seats before it happened to consume.
   */
  random: RandomSource | null;
}

function validateConfig(config: SimulationConfig): void {
  const seats = config.profileIds.length;
  if (seats < 2 || seats > 6) {
    throw new SimulationError(`a simulation needs 2..6 seats, received ${seats}`);
  }
  if (!Number.isInteger(config.hands) || config.hands < 1) {
    throw new SimulationError(`hands must be a positive integer, received ${String(config.hands)}`);
  }
  if (!Number.isInteger(config.seed)) {
    throw new SimulationError(`seed must be an integer, received ${String(config.seed)}`);
  }
  for (const [name, value] of [
    ['smallBlind', config.smallBlind],
    ['bigBlind', config.bigBlind],
    ['startingStack', config.startingStack],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new SimulationError(`${name} must be a positive integer, received ${String(value)}`);
    }
  }
  if (config.bigBlind < config.smallBlind) {
    throw new SimulationError('bigBlind must be at least smallBlind');
  }
  if (config.startingStack < config.bigBlind) {
    throw new SimulationError(
      `startingStack ${config.startingStack} is below one big blind, so every hand would be an ` +
        'all-in blind post and the run would measure the blind structure rather than the styles',
    );
  }
  const ante = config.ante ?? 0;
  if (!Number.isInteger(ante) || ante < 0) {
    throw new SimulationError(`ante must be a non-negative integer, received ${String(ante)}`);
  }
  const samples = config.equitySamples;
  if (samples !== undefined && (!Number.isInteger(samples) || samples < 1)) {
    throw new SimulationError(`equitySamples must be a positive integer, received ${String(samples)}`);
  }
}

/**
 * The difficulty settings a bulk run hands to the policies: the real ones, with the equity
 * budget replaced. Everything a difficulty is *for* — trait expression, noise, whether
 * adaptation is on — is untouched, because those are the things the differentiation test
 * makes claims about. Only the sample count moves, and only for the reason stated above.
 */
export function simulationDifficultySettings(config: SimulationConfig): DifficultySettings {
  return {
    ...DIFFICULTY_SETTINGS[config.difficulty],
    equitySamples: config.equitySamples ?? SIMULATION_EQUITY_SAMPLES,
  };
}

/**
 * Checks a proposal against the legal set and pulls its size into the engine's bounds.
 *
 * Two different failures, treated differently on purpose. A type the engine did not offer is
 * a policy bug that invalidates the run, so it throws. A size outside `minTo`/`maxTo` is also
 * a policy bug, but a recoverable one — the engine supplied the bounds, so the harness can
 * apply them and count that it had to, which turns "the policy does clamp its own sizes" into
 * an assertion instead of an assumption.
 */
function resolveAction(
  proposed: Action,
  legal: readonly LegalAction[],
  where: string,
): { readonly action: Action; readonly clamped: boolean } {
  const entry = legal.find((candidate) => candidate.type === proposed.type);
  if (entry === undefined) {
    throw new SimulationError(
      `${where}: the policy proposed "${proposed.type}", which the engine did not offer ` +
        `(offered: ${legal.map((candidate) => candidate.type).join(', ')})`,
    );
  }
  if (proposed.type !== 'bet' && proposed.type !== 'raise') {
    return { action: proposed, clamped: false };
  }
  const minTo = entry.minTo ?? 0;
  const maxTo = entry.maxTo ?? minTo;
  const rounded = Math.round(proposed.to);
  const to = Math.min(Math.max(rounded, minTo), maxTo);
  const clamped = to !== proposed.to;
  const action: Action = proposed.type === 'bet' ? { type: 'bet', to } : { type: 'raise', to };
  return { action, clamped };
}

/** Everything a hand needs that does not change from hand to hand. */
interface RunContext {
  readonly config: SimulationConfig;
  readonly tableConfig: TableConfig;
  readonly settings: DifficultySettings;
  readonly propose: (input: PolicyInput) => ProposedAction;
  readonly runtimeAt: (seat: number, where: string) => SeatRuntime;
}

/** What one turn produced, beyond the new state. */
interface TurnResult {
  readonly state: HandState;
  readonly clamped: boolean;
  /**
   * The turn as public information, for every seat's opponent model. Built here rather than in
   * `playHand` because the fields it needs — the amount to call, the pot before, whether a
   * raise was actually legal — only exist before the action was applied, and reconstructing
   * them afterwards is how a "public" model quietly starts describing a different situation.
   */
  readonly event: PublicActionEvent;
}

/**
 * One seat's turn: build its view, ask its policy, check the proposal, apply it, record it.
 *
 * Extracted so that the order of the six steps is readable in one screen. The order matters:
 * the pre-action quantities (`toCall`, the pot, whether aggression was available) have to be
 * captured **before** `applyAction`, and the cost has to be read **after** it.
 */
function takeTurn(context: RunContext, state: HandState, handIndex: number, step: number): TurnResult {
  const seat = state.toAct;
  if (seat === null) {
    throw new SimulationError(`hand ${handIndex} stalled on ${state.street} with nobody to act`);
  }
  const street = state.street;
  if (street === 'showdown' || street === 'complete') {
    throw new SimulationError(`hand ${handIndex}: seat ${seat} is to act during ${street}`);
  }
  const where = `hand ${handIndex} action ${step} (seat ${seat}, ${street})`;

  const actor = seatAt(state, seat);
  const holeCards = actor.holeCards;
  if (holeCards === null) throw new SimulationError(`${where}: the actor holds no cards`);

  // The one line that defines the information boundary: the policy is handed this view and
  // its own two cards, and there is no other channel into it.
  const view = redactFor(state, { viewerSeat: seat });
  const legal = view.legalActions;
  if (legal.length === 0) throw new SimulationError(`${where}: the engine offered no legal actions`);

  const aggressionAvailable = legal.some((entry) => entry.type === 'bet' || entry.type === 'raise');
  // Air detection is only computed where `stats.ts` will use it — a postflop turn on which
  // aggression was available. Everywhere else the accumulator ignores the flag, and this is
  // the most expensive thing in the loop that the engine does not already do for us.
  const isAir = street !== 'preflop' && aggressionAvailable && holdingIsAir(holeCards, state.board);

  const runtime = context.runtimeAt(seat, where);
  const random = runtime.random;
  if (random === null) throw new SimulationError(`${where}: seat ${seat} has no random source`);

  const input: PolicyInput = {
    view,
    holeCards,
    seat,
    observations: runtime.model,
    traits: runtime.traits,
    difficulty: context.settings,
    random,
  };
  const proposed = context.propose(input);
  const resolved = resolveAction(proposed.action, legal, where);

  const toCall = view.amountToCall;
  const potBefore = view.potTotal;
  const facingPreflopRaise = street === 'preflop' && state.betLevel > context.tableConfig.bigBlind;

  const next = applyAction(state, seat, resolved.action, { actionId: `sim-${handIndex}-${step}` }).state;

  // The chips this action actually moved, as the engine recorded them — not as the harness
  // re-derived them. See trap 3 in the module comment.
  const logged = next.actions[next.actions.length - 1];
  if (logged === undefined) throw new SimulationError(`${where}: the engine logged no action`);

  runtime.observer.noteDecision({
    street,
    toCall,
    potBefore,
    aggressionAvailable,
    facingPreflopRaise,
    action: resolved.action.type,
    cost: logged.amountPaid,
    holdingIsAir: isAir,
    // The model's own reading of its holding, which is the condition `aggressionFrequency` is
    // declared on. Null when the policy under test published none — see `ProposedAction`.
    assessedRelativeStrength: proposed.strength?.relativeStrength ?? null,
  });

  return {
    state: next,
    clamped: resolved.clamped,
    event: {
      handId: state.handId,
      seat,
      street,
      action: resolved.action.type,
      toCall,
      potBefore,
      amountPaid: logged.amountPaid,
      facingPreflopRaise,
      // `raiseWasAvailable` is read off the engine's own legal set, never guessed. After a short
      // all-in `mayRaise` is false, and calling that turn a declined 3-bet opportunity would
      // understate every seat's 3-bet frequency.
      raiseWasAvailable: aggressionAvailable,
    },
  };
}

/** What one hand contributed to the run's totals. */
interface HandTotals {
  readonly actions: number;
  readonly clamps: number;
  /**
   * 1 when this hand's chip total was verified. Returned by the code that does the checking
   * rather than inferred from the hand count, so `chipConservationChecks === handsCompleted`
   * is a real assertion about the harness and not a restatement of a loop counter.
   */
  readonly chipChecks: number;
}

/**
 * Deals one hand, plays it to completion, and closes the books on it.
 *
 * `stacks` is read for the deal and written back at settlement, which is what makes
 * `resetStacksEachHand: false` a carry-forward run rather than a series of independent ones.
 */
function playHand(context: RunContext, handIndex: number, stacks: number[], buttonSeat: number): HandTotals {
  const { config } = context;
  const chipsAtStart = stacks.reduce((sum, stack) => sum + stack, 0);
  const started = startHand({
    handId: `sim-${config.seed}-${handIndex}`,
    roomId: `sim-${config.seed}`,
    handNumber: handIndex,
    config: context.tableConfig,
    buttonSeat,
    seats: stacks.map((stack, seat) => ({
      seat,
      playerId: `seat${seat}:${context.runtimeAt(seat, `hand ${handIndex}`).profileId}`,
      stack,
    })),
    random: createDeterministicRandomForTests(deriveSeed(DEAL_STREAM, config.seed, handIndex)),
  });

  let state = started.state;
  const dealtSeats = state.seats.filter((seat) => seat.status !== 'sittingOut').map((seat) => seat.seat);
  for (const seat of dealtSeats) {
    const runtime = context.runtimeAt(seat, `hand ${handIndex}`);
    runtime.observer.beginHand();
    runtime.random = createDeterministicRandomForTests(
      deriveSeed(DECISION_STREAM, config.seed, handIndex, seat),
    );
  }

  // Which seats still held cards when the flop appeared. Snapshotted the first time the board
  // reaches three cards rather than reconstructed at the end, because seat statuses are
  // deliberately not reset at settlement and a seat that folded on the turn did see the flop.
  let flopWitnesses: readonly number[] | null = null;
  let actions = 0;
  let clamps = 0;
  let chipChecks = 0;

  for (let step = 0; state.street !== 'complete'; step++) {
    if (step >= MAX_ACTIONS_PER_HAND) {
      throw new SimulationError(`hand ${handIndex} did not terminate after ${MAX_ACTIONS_PER_HAND} actions`);
    }
    const turn = takeTurn(context, state, handIndex, step);
    state = turn.state;
    actions += 1;
    if (turn.clamped) clamps += 1;
    // Every seat's model sees every action, because the action log is public and a model that
    // only watched its opponents could not tell how its own line looked to them.
    for (const seat of dealtSeats)
      context.runtimeAt(seat, `hand ${handIndex}`).model.observeAction(turn.event);
    if (flopWitnesses === null && state.board.length >= 3) {
      flopWitnesses = state.seats
        .filter((entry) => entry.status === 'active' || entry.status === 'allIn')
        .map((entry) => entry.seat);
    }
  }

  const result = state.result;
  if (result === null) throw new SimulationError(`hand ${handIndex} completed without a result`);

  const chipsAtEnd = state.seats.reduce((sum, seat) => sum + seat.stack, 0);
  if (chipsAtEnd !== chipsAtStart) {
    throw new SimulationError(
      `hand ${handIndex} created or destroyed chips: started with ${chipsAtStart}, ended with ${chipsAtEnd}`,
    );
  }
  chipChecks += 1;

  const sawFlop = new Set<number>(flopWitnesses ?? []);
  const showedDown = new Set<number>(result.showdowns.map((showdown) => showdown.seat));
  for (const seat of dealtSeats) {
    const runtime = context.runtimeAt(seat, `hand ${handIndex}`);
    runtime.observer.endHand({
      sawFlop: sawFlop.has(seat),
      showedDown: showedDown.has(seat),
      netChips: result.netBySeat[seat] ?? 0,
    });
    // The opponent model is fed the completed hand exactly as that seat saw it: the public
    // action log plus whatever was actually shown down. A hand that ended in a fold reveals
    // nothing, so no model can learn from the run-out whether a folder was bluffing — which is
    // precisely the information the game is played over.
    runtime.model.observe(redactFor(state, { viewerSeat: seat }));
    runtime.random = null;
  }

  for (const seat of state.seats) stacks[seat.seat] = seat.stack;
  return { actions, clamps, chipChecks };
}

/**
 * Plays `config.hands` hands and reports what each seat did.
 *
 * Fully deterministic for a given `config`: same seed, same numbers, byte for byte. The only
 * field of the result that varies between runs is `elapsedMs`.
 */
export function simulate(config: SimulationConfig, hooks: SimulationHooks = {}): SimulationResult {
  validateConfig(config);
  const startedAt = Date.now();

  const settings = simulationDifficultySettings(config);
  const seatCount = config.profileIds.length;
  const table: readonly SeatRuntime[] = config.profileIds.map((id, seat) => {
    const profile = requireProfile(id);
    return {
      seat,
      profileId: profile.naming.id,
      traits: expressTraits(profile, config.difficulty),
      model: createOpponentModel(seat),
      observer: new SeatObservations(seat, profile.naming.id),
      random: null,
    };
  });

  const context: RunContext = {
    config,
    settings,
    propose: hooks.decide ?? decide,
    tableConfig: {
      smallBlind: config.smallBlind,
      bigBlind: config.bigBlind,
      ante: config.ante ?? 0,
      maxSeats: seatCount,
      actionTimeoutSeconds: ACTION_TIMEOUT_SECONDS,
    },
    runtimeAt: (seat: number, where: string): SeatRuntime => {
      const runtime = table[seat];
      if (runtime === undefined)
        throw new SimulationError(`${where}: seat ${seat} is not in this simulation`);
      return runtime;
    },
  };

  const resetEachHand = config.resetStacksEachHand ?? true;
  const stacks = new Array<number>(seatCount).fill(config.startingStack);

  let handsCompleted = 0;
  let actionsApplied = 0;
  let sizeClampsApplied = 0;
  let chipConservationChecks = 0;
  let stoppedEarly: string | null = null;

  for (let handIndex = 0; handIndex < config.hands; handIndex++) {
    if (resetEachHand) stacks.fill(config.startingStack);

    const withChips: number[] = [];
    for (let seat = 0; seat < seatCount; seat++) {
      if ((stacks[seat] ?? 0) > 0) withChips.push(seat);
    }
    if (withChips.length < 2) {
      stoppedEarly =
        `only ${withChips.length} seat(s) still had chips before hand ${handIndex}; ` +
        'set resetStacksEachHand to measure per-hand behaviour instead of survival';
      break;
    }

    // The button moves one live seat per hand, so over a long run every seat spends the same
    // share of hands in every position. Without this, a positional trait would read as a
    // difference between profiles when it is really a difference between seats.
    const buttonSeat = withChips[handIndex % withChips.length];
    if (buttonSeat === undefined) throw new SimulationError(`hand ${handIndex}: no button seat`);

    const totals = playHand(context, handIndex, stacks, buttonSeat);
    actionsApplied += totals.actions;
    sizeClampsApplied += totals.clamps;
    chipConservationChecks += totals.chipChecks;
    handsCompleted += 1;
  }

  return {
    config,
    handsCompleted,
    bySeat: table.map((runtime) => runtime.observer.finalise(config.bigBlind)),
    elapsedMs: Date.now() - startedAt,
    actionsApplied,
    chipConservationChecks,
    sizeClampsApplied,
    stoppedEarly,
    equitySamples: settings.equitySamples,
  };
}

/**
 * One profile heads-up against a fixed reference profile, which is the shape every
 * declared-versus-observed comparison uses.
 *
 * Heads-up rather than six-handed, deliberately. At a full table a profile's observed VPIP is
 * partly a function of who opened in front of it, so comparing twelve profiles measured at
 * different tables would confound the style with the company it kept. Two seats, one fixed
 * reference, and a rotating button isolates the profile under test.
 *
 * Seat 0 is the profile under test; seat 1 is the reference.
 */
export function simulateHeadsUpAgainstReference(options: {
  readonly profileId: string;
  readonly referenceProfileId: string;
  readonly difficulty: Difficulty;
  readonly hands: number;
  readonly seed: number;
  readonly startingStack?: number;
  readonly bigBlind?: number;
  readonly equitySamples?: number;
}): SimulationResult {
  const bigBlind = options.bigBlind ?? 100;
  const config: SimulationConfig = {
    profileIds: [options.profileId, options.referenceProfileId],
    difficulty: options.difficulty,
    hands: options.hands,
    seed: options.seed,
    startingStack: options.startingStack ?? bigBlind * 100,
    smallBlind: Math.floor(bigBlind / 2),
    bigBlind,
    resetStacksEachHand: true,
    ...(options.equitySamples === undefined ? {} : { equitySamples: options.equitySamples }),
  };
  return simulate(config);
}

/** The seat's stats out of a run, by seat index, with a message rather than an undefined. */
export function seatStats(result: SimulationResult, seat: number): SeatSimulationStats {
  const stats = result.bySeat[seat];
  if (stats === undefined) {
    throw new SimulationError(`this run has ${result.bySeat.length} seats, so seat ${seat} does not exist`);
  }
  return stats;
}
