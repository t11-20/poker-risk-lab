/**
 * One reader's table: six seats, five bots, stacks that carry from hand to hand.
 *
 * This is the chat client's copy of what `apps/api/src/rooms/table.ts` and `bots.ts` do for the
 * web, cut down to one person and no clock. It is a copy and not an import because an app must
 * not depend on an app; ADR 0014 says why the bot runs the packages in-process at all.
 *
 * ## The reader only ever sees `redactFor(state, { viewerSeat: READER_SEAT })`
 *
 * The `HandState` here holds every seat's cards and the deck. Nothing in this file renders text;
 * `readerView` is the only way out of it toward a message, and it is the engine's own redaction.
 * `test/step.test.ts` scans every message of a played hand for the bots' cards to hold that line.
 *
 * ## Bots act synchronously, the way `simulate.ts` drives them
 *
 * The web's `BotRunner` waits 700 ms per decision so a watcher can follow the table. A chat
 * message is edited once per reader decision, so the delay buys nothing here: the bots act inside
 * the same `step`, and the message shows what they did since the reader's last move.
 *
 * ## Cards come from the injected dealer, which is `createSecureRandom()` outside tests
 *
 * `Dealer` is a seam so a test can deal a scripted hand. The engine refuses a sampling source for
 * dealing and refuses the test-only generator in production, and `test/source-randomness.test.ts`
 * asserts no file under `src/` names the test-only generator at all.
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

/**
 * The same table the web's `/play` page asks for: `BOT_TABLE_REQUEST` in
 * `apps/web/src/lib/table-rooms.ts` — six seats, 5/10, 1,000 units each.
 */
export const TABLE_CONFIG: TableConfig = {
  smallBlind: 5,
  bigBlind: 10,
  ante: 0,
  maxSeats: 6,
  actionTimeoutSeconds: 60,
};
export const STARTING_STACK = 1_000;

/**
 * The web's `BOT_TABLE`, already mapped through `LEGACY_PROFILE_IDS` (`apps/api/src/rooms/bots.ts`):
 * two `tight-aggressive`, then `calling-station`, `loose-aggressive`, `nit`. The plates are what
 * `botDisplayName` makes of each id, so a reader sees the same names in both clients.
 */
const LINEUP: readonly { readonly profileId: string; readonly plate: string }[] = [
  { profileId: 'patient-technician', plate: 'Patient Technician' },
  { profileId: 'patient-technician', plate: 'Patient Technician' },
  { profileId: 'calling-station', plate: 'Calling Station' },
  { profileId: 'reading-pressure-specialist', plate: 'Reading Pressure' },
  { profileId: 'disciplined-specialist', plate: 'Disciplined Specialist' },
];

/**
 * `realistic`, because a web bot table seats its bots at `realistic` (`seatRequestedBots` in
 * `apps/api/src/routes/rooms.ts`) and "same bots" has to mean the same difficulty too.
 */
const BOT_DIFFICULTY: Difficulty = 'realistic';

export interface BotSeat {
  readonly seat: SeatIndex;
  readonly profileId: string;
  readonly plate: string;
  /** The archetype name, never the attributed one: see `lineupNames`. */
  readonly archetypeName: string;
  readonly traits: Traits;
  readonly settings: DifficultySettings;
  /** Mutable: fed every public action and every completed hand, as `simulate.ts` does. */
  readonly model: OpponentModel;
  /** Mutable stream for this bot's decisions. Never deals. */
  readonly random: RandomSource;
}

export interface Dealer {
  /** The source a hand's deck is shuffled from. `createSecureRandom()` outside tests. */
  readonly dealRandom: () => RandomSource;
  /** One decision stream per bot seat. */
  readonly decisionRandom: (seat: SeatIndex) => RandomSource;
}

/** What lasts between hands: the seats, the stacks, the button. */
export interface Table {
  /**
   * Random per table, and part of every hand id, so a button from before a restart can never
   * name a hand of the table that replaced it. Hand numbers restart at 1 with a new table, so
   * without this "hand 3, action 5" on yesterday's message would match today's hand 3.
   */
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
        // Archetype mode is fixed here rather than read from `PRL_LEGEND_NAMING`. A chat message
        // is forwarded and screenshotted without the page around it, so this client never shows
        // an attributed name; turning that on is a decision for its own review (ADR 0011).
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

/** Every seat with units can be dealt in, and a table needs the reader plus one more. */
export function canDeal(table: Table): boolean {
  const withUnits = table.stacks.filter((stack) => stack > 0).length;
  return (table.stacks[READER_SEAT] ?? 0) > 0 && withUnits >= 2;
}

export function resetUnits(table: Table): Table {
  return { ...table, stacks: table.stacks.map(() => STARTING_STACK) };
}

/**
 * Deals the next hand and lets the bots act until the reader must decide or the hand is over.
 *
 * The button moves one seat on, skipping nobody: a seat at zero is dealt out (`sittingOut`) and
 * the engine derives the blinds from the button among the seats that are dealt in. The web table
 * runs the full dead-button rule (`advanceBlindRotation`) because players come and go; here the
 * only way to leave is to reach zero, and the reader can always reset.
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

/**
 * Applies the reader's action, then lets the bots act.
 *
 * Throws the engine's own `BettingRuleError` for an action it would not accept: the engine is the
 * authority on legality (ADR 0002), and the caller turns the refusal into a toast.
 */
export function readerActs(table: Table, state: HandState, action: Action, actionId: string): HandState {
  const applied = applyAction(state, READER_SEAT, action, { actionId });
  observeLast(table, state, applied.state);
  return runBots(table, applied.state);
}

/** Stacks after a completed hand, and the bots' models told how it ended. */
export function settle(table: Table, state: HandState): Table {
  for (const bot of table.bots) {
    if (state.seats.some((seat) => seat.seat === bot.seat)) {
      // The bot's OWN view: `result.showdowns` holds only the hands actually turned over, so a
      // hand that ended in a fold teaches no model anything about anybody's cards.
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
 * Bots act until it is the reader's turn or nobody can act.
 *
 * Each bot is handed its own redacted view and its own two cards, exactly the `PolicyInput`
 * `buildPolicyInput` in `apps/api/src/rooms/bots.ts` builds, and its proposal goes through
 * `applyAction` like the reader's does. The loop bound is the engine's own termination: every
 * action either advances `actionSequence` or throws.
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

/**
 * Tells every bot's model about the action just taken, from public information only.
 *
 * Built the way `takeTurn` in `packages/poker-ai/src/simulate.ts` builds it: the pre-action
 * numbers read from the acting seat's view before `applyAction`, the chips moved read from the
 * engine's own log after it.
 */
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
