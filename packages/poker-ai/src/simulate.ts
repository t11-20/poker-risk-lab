/**
 * Bulk deterministic simulation that drives the real engine (`startHand`, `redactFor`, `decide`,
 * `applyAction`), so the measured numbers describe the game people play and an illegal proposal fails
 * the run. This file reads `HandState` because it is the dealer and scorekeeper. A policy only ever
 * gets `redactFor(state, { viewerSeat })` plus its own two cards, and nothing computed from hidden
 * cards (such as `holdingIsAir`) is handed back to it.
 *
 * Every random stream is derived from `(streamTag, seed, handIndex, seat)`, so seats are independent
 * of each other and of the deal, and the whole run reproduces from one integer. Action cost is the
 * engine's own `amountPaid`, because the stack clamps it. `SeatObservations` (stats.ts) is the
 * measurement and reads hidden cards. `OpponentModel` is part of the game and sees public events only.
 *
 * Equity uses 500 samples per decision instead of the live 4,000 to 12,000. The 95% half-width near
 * 0.5 is 1.96 x 0.5 / sqrt(500) = 0.044, so a decision within about 4 points of a threshold can flip.
 * That is small next to the 0.05 to 0.18 difficulty noise, and the differentiation test tolerances
 * account for it.
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

/** Monte Carlo samples per decision in a bulk run. The module comment has the arithmetic. */
export const SIMULATION_EQUITY_SAMPLES = 500;

/** Stream tags, mixed in first so the deal and the decision streams can never coincide. */
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
   * Defaults to true. Carried-forward stacks bust a losing profile within a few hundred hands, and the
   * statistics would then describe survival rather than style.
   */
  readonly resetStacksEachHand?: boolean;
  /** Monte Carlo samples per decision. Defaults to `SIMULATION_EQUITY_SAMPLES`. */
  readonly equitySamples?: number;
}

export interface SimulationResult {
  readonly config: SimulationConfig;
  readonly handsCompleted: number;
  readonly bySeat: readonly SeatSimulationStats[];
  readonly elapsedMs: number;
  readonly actionsApplied: number;
  /** Hands whose chip total was verified. A mismatch throws, so this lets a caller assert the check ran. */
  readonly chipConservationChecks: number;
  /** Sizes the harness pulled into the engine's bounds. A correct policy makes this 0. */
  readonly sizeClampsApplied: number;
  /** Why the run stopped before `config.hands` hands, or null if it did not. */
  readonly stoppedEarly: string | null;
  readonly equitySamples: number;
}

/**
 * The part of a policy's decision the harness uses. `strength` is there because
 * `aggressionFrequency` is declared on a neutral assessment, so measuring it means conditioning on the
 * model's own assessment. It is optional for test stand-ins. When absent, no neutral spots are counted.
 */
export interface ProposedAction {
  readonly action: Action;
  /** The model's own assessment of its holding, if it published one. Never fed back in. */
  readonly strength?: StrengthAssessment;
}

export interface SimulationHooks {
  /**
   * Replaces the policy under test, which defaults to `decide`. Used by `test/stats.test.ts` for fast
   * bookkeeping tests and by a hidden-information test that records which input paths a policy reads.
   */
  readonly decide?: (input: PolicyInput) => ProposedAction;
}

/**
 * Derives one 32-bit seed from several integers with the SplitMix32 finalizer applied per part. Not
 * cryptographic. It makes `(2, 7, 1)` and `(2, 1, 7)` unrelated, which a sum or an XOR would not.
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

interface SeatRuntime {
  readonly seat: number;
  readonly profileId: string;
  readonly traits: Traits;
  readonly model: OpponentModel;
  readonly observer: SeatObservations;
  /** Replaced every hand, so the stream depends only on `(seed, handIndex, seat)`. */
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

/** The real difficulty settings with only the equity sample budget replaced. */
export function simulationDifficultySettings(config: SimulationConfig): DifficultySettings {
  return {
    ...DIFFICULTY_SETTINGS[config.difficulty],
    equitySamples: config.equitySamples ?? SIMULATION_EQUITY_SAMPLES,
  };
}

/**
 * An action type the engine did not offer throws. A size outside `minTo`/`maxTo` is clamped and
 * counted, so a test can assert the policy clamps its own sizes.
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

interface RunContext {
  readonly config: SimulationConfig;
  readonly tableConfig: TableConfig;
  readonly settings: DifficultySettings;
  readonly propose: (input: PolicyInput) => ProposedAction;
  readonly runtimeAt: (seat: number, where: string) => SeatRuntime;
}

interface TurnResult {
  readonly state: HandState;
  readonly clamped: boolean;
  /** The turn as public information. Built here because its fields only exist before the action. */
  readonly event: PublicActionEvent;
}

/** Pre-action quantities are captured before `applyAction`, and the cost is read after it. */
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

  // The information boundary. The policy gets this view and its own two cards, nothing else.
  const view = redactFor(state, { viewerSeat: seat });
  const legal = view.legalActions;
  if (legal.length === 0) throw new SimulationError(`${where}: the engine offered no legal actions`);

  const aggressionAvailable = legal.some((entry) => entry.type === 'bet' || entry.type === 'raise');
  // Computed only where `stats.ts` reads it, because it is the costliest step outside the engine.
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
      // Read off the legal set. After a short all-in no raise is allowed, and counting that turn as a
      // declined 3-bet would understate every seat's 3-bet frequency.
      raiseWasAvailable: aggressionAvailable,
    },
  };
}

interface HandTotals {
  readonly actions: number;
  readonly clamps: number;
  /** Returned by the code that checks, so the total is not a restated loop counter. */
  readonly chipChecks: number;
}

/** `stacks` is read for the deal and written back at settlement. */
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

  // Snapshotted when the flop appears, because a seat that folded on the turn did see the flop.
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
    // Every seat's model sees every action, its own included, because the action log is public.
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
    // Fed the hand as this seat saw it. A folded hand reveals nothing about whether the folder bluffed.
    runtime.model.observe(redactFor(state, { viewerSeat: seat }));
    runtime.random = null;
  }

  for (const seat of state.seats) stacks[seat.seat] = seat.stack;
  return { actions, clamps, chipChecks };
}

/**
 * Fully deterministic for a given `config`, byte for byte. The only field of the result that varies
 * between runs is `elapsedMs`.
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

    // Rotating the button gives every seat the same share of positions, so seat is not confounded.
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
 * Seat 0 is the profile under test and seat 1 a fixed reference. Heads-up, because at a full table
 * observed VPIP depends on who opened in front, which confounds style with company.
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

export function seatStats(result: SimulationResult, seat: number): SeatSimulationStats {
  const stats = result.bySeat[seat];
  if (stats === undefined) {
    throw new SimulationError(`this run has ${result.bySeat.length} seats, so seat ${seat} does not exist`);
  }
  return stats;
}
