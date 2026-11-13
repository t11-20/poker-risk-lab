/**
 * One reader's table: six seats, five bots, stacks that carry between hands. A copy of the API's
 * room and bot logic cut down to one person and no clock, because an app must not depend on an app
 * (ADR 0014).
 * The `HandState` holds every card. `readerView` (the engine's redaction) is the only way toward a
 * message, and `test/step.test.ts` scans played hands for bot cards.
 * Bots act synchronously inside `step`, since a chat message is edited once per reader decision.
 * `Dealer` is a seam for scripted test hands. Outside tests it is `createSecureRandom()`.
 */

import {
  DIFFICULTY_SETTINGS,
  type Difficulty,
  type DifficultySettings,
  decide,
  expressTraits,
  OpponentModel,
  profileDisclosure,
  requireProfile,
  type Traits,
} from '@prl/poker-ai';
import {
  type Action,
  applyAction,
  type HandState,
  type PlayerView,
  type RandomSource,
  redactFor,
  type SeatIndex,
  startHand,
  type TableConfig,
} from '@prl/poker-engine';

export const READER_SEAT: SeatIndex = 0;
const READER_ID = 'reader';

/** The web's `BOT_TABLE_REQUEST` in `apps/web/src/lib/table-rooms.ts`. */
export const TABLE_CONFIG: TableConfig = {
  smallBlind: 5,
  bigBlind: 10,
  ante: 0,
  maxSeats: 6,
  actionTimeoutSeconds: 60,
};
export const STARTING_STACK = 1_000;

/**
 * The web's `BOT_TABLE` mapped through `LEGACY_PROFILE_IDS` (`apps/api/src/rooms/bots.ts`). Plates
 * match `botDisplayNames`, so both clients show the same names.
 */
const LINEUP: readonly { readonly profileId: string; readonly plate: string }[] = [
  { profileId: 'patient-technician', plate: 'Patient Technician 1' },
  { profileId: 'patient-technician', plate: 'Patient Technician 2' },
  { profileId: 'calling-station', plate: 'Calling Station' },
  { profileId: 'reading-pressure-specialist', plate: 'Reading Pressure' },
  { profileId: 'disciplined-specialist', plate: 'Disciplined Specialist' },
];

/** Matches `seatRequestedBots` in `apps/api/src/routes/rooms.ts`. */
const BOT_DIFFICULTY: Difficulty = 'realistic';

export interface BotSeat {
  readonly seat: SeatIndex;
  readonly profileId: string;
  readonly plate: string;
  /** The archetype name, never the attributed one. */
  readonly archetypeName: string;
  readonly traits: Traits;
  readonly settings: DifficultySettings;
  /** Mutable: fed every public action and every completed hand, as `simulate.ts` does. */
  readonly model: OpponentModel;
  /** Never deals. */
  readonly random: RandomSource;
}

export interface Dealer {
  readonly dealRandom: () => RandomSource;
  readonly decisionRandom: (seat: SeatIndex) => RandomSource;
}

export interface Table {
  /** Random per table and part of every hand id, so a button from before a restart matches nothing. */
  readonly tag: string;
  readonly stacks: readonly number[];
  readonly buttonSeat: SeatIndex;
  readonly handsDealt: number;
  readonly bots: readonly BotSeat[];
}

export function newTable(tag: string, dealer: Dealer): Table {
  return {
    tag,
    stacks: [STARTING_STACK, ...LINEUP.map(() => STARTING_STACK)],
    // The first `dealNext` moves it one seat on, so the reader starts on the button.
    buttonSeat: TABLE_CONFIG.maxSeats - 1,
    handsDealt: 0,
    bots: LINEUP.map((entry, index) => {
      const seat = index + 1;
      const profile = requireProfile(entry.profileId);
      return {
        seat,
        profileId: entry.profileId,
        plate: entry.plate,
        // Fixed to archetype, not read from `PRL_LEGEND_NAMING`. A chat message travels without the
        // page around it, so this client never shows an attributed name (ADR 0011).
        archetypeName: profileDisclosure(profile.naming, 'archetype').archetypeName,
        traits: expressTraits(profile, BOT_DIFFICULTY),
        settings: DIFFICULTY_SETTINGS[BOT_DIFFICULTY],
        model: new OpponentModel(seat),
        random: dealer.decisionRandom(seat),
      };
    }),
  };
}

export function nameOf(table: Table, seat: SeatIndex): string {
  if (seat === READER_SEAT) return 'You';
  return table.bots.find((bot) => bot.seat === seat)?.plate ?? `Seat ${seat + 1}`;
}

export function canDeal(table: Table): boolean {
  const withUnits = table.stacks.filter((stack) => stack > 0).length;
  return (table.stacks[READER_SEAT] ?? 0) > 0 && withUnits >= 2;
}

export function resetUnits(table: Table): Table {
  return { ...table, stacks: table.stacks.map(() => STARTING_STACK) };
}

/**
 * The button moves to the next seat with chips. No dead-button rule, because the only way to leave
 * is to reach zero and the reader can always reset.
 */
export function dealNext(table: Table, dealer: Dealer): { table: Table; state: HandState } {
  const handNumber = table.handsDealt + 1;
  const dealtIn = table.stacks.map((stack, seat) => ({ seat, stack })).filter((entry) => entry.stack > 0);
  let buttonSeat = (table.buttonSeat + 1) % TABLE_CONFIG.maxSeats;
  while ((table.stacks[buttonSeat] ?? 0) === 0) buttonSeat = (buttonSeat + 1) % TABLE_CONFIG.maxSeats;
  const started = startHand({
    handId: handIdOf(table.tag, handNumber),
    roomId: `chat-${table.tag}`,
    handNumber,
    config: TABLE_CONFIG,
    buttonSeat,
    seats: dealtIn.map((entry) => ({
      seat: entry.seat,
      playerId: playerIdOf(entry.seat),
      stack: entry.stack,
    })),
    random: dealer.dealRandom(),
  });
  const next: Table = { ...table, buttonSeat, handsDealt: handNumber };
  return { table: next, state: runBots(next, started.state) };
}

export function handIdOf(tag: string, handNumber: number): string {
  return `${tag}-${handNumber}`;
}

/** Throws the engine's `BettingRuleError` for an illegal action (ADR 0002). */
export function readerActs(table: Table, state: HandState, action: Action, actionId: string): HandState {
  const applied = applyAction(state, READER_SEAT, action, { actionId });
  observeLast(table, state, applied.state);
  return runBots(table, applied.state);
}

export function settle(table: Table, state: HandState): Table {
  for (const bot of table.bots) {
    if (state.seats.some((seat) => seat.seat === bot.seat)) {
      // The bot's own view, so only cards actually shown reach a model.
      bot.model.observe(redactFor(state, { viewerSeat: bot.seat }));
    }
  }
  const stacks = [...table.stacks];
  for (const seat of state.seats) stacks[seat.seat] = seat.stack;
  return { ...table, stacks };
}

export function readerView(state: HandState): PlayerView {
  return redactFor(state, { viewerSeat: READER_SEAT });
}

function playerIdOf(seat: SeatIndex): string {
  return seat === READER_SEAT ? READER_ID : `bot-${seat}`;
}

/**
 * Each bot gets its own redacted view and cards, as `buildPolicyInput` in the API builds. The loop
 * ends because every action advances `actionSequence` or throws.
 */
function runBots(table: Table, start: HandState): HandState {
  let state = start;
  while (state.street !== 'complete' && state.toAct !== null && state.toAct !== READER_SEAT) {
    const seat = state.toAct;
    const bot = table.bots.find((entry) => entry.seat === seat);
    if (bot === undefined) throw new Error(`seat ${seat} is to act and is neither the reader nor a bot`);
    const view = redactFor(state, { viewerSeat: seat });
    const own = view.seats.find((entry) => entry.seat === seat);
    if (own?.holeCards == null) throw new Error(`seat ${seat} has no cards in its own view`);
    const decision = decide({
      view,
      holeCards: own.holeCards,
      seat,
      traits: bot.traits,
      difficulty: bot.settings,
      observations: bot.model,
      random: bot.random,
    });
    const next = applyAction(state, seat, decision.action, { actionId: `bot-${state.actionSequence}` }).state;
    observeLast(table, state, next);
    state = next;
  }
  return state;
}

/** Public information only, built as `takeTurn` in `packages/poker-ai/src/simulate.ts` builds it. */
function observeLast(table: Table, before: HandState, after: HandState): void {
  const logged = after.actions[after.actions.length - 1];
  if (logged === undefined || before.street === 'showdown' || before.street === 'complete') return;
  const view = redactFor(before, { viewerSeat: logged.seat });
  const event = {
    handId: before.handId,
    seat: logged.seat,
    street: before.street,
    action: logged.action.type,
    toCall: view.amountToCall,
    potBefore: view.potTotal,
    amountPaid: logged.amountPaid,
    facingPreflopRaise: before.street === 'preflop' && before.betLevel > before.config.bigBlind,
    raiseWasAvailable: view.legalActions.some((entry) => entry.type === 'bet' || entry.type === 'raise'),
  };
  for (const bot of table.bots) {
    if (after.seats.some((seat) => seat.seat === bot.seat)) bot.model.observeAction(event);
  }
}
