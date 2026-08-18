/**
 * A hand played at a live table, read back out of Postgres.
 *
 * ## The hole this closes
 *
 * `postgresArchive` (`src/rooms/registry.ts`) is the only thing that writes a hand down, and
 * nothing exercised it. Every suite that plays a hand uses `noopArchive`; every suite that reads a
 * hand back inserts its rows by hand. So the join between the two — the live table's notices
 * becoming durable rows — was covered at both ends and not in the middle, and the release audit
 * was right to refuse to treat the API suite as evidence about the database.
 *
 * Worse, the guarantee this system is built around was in that gap. "One player never receives
 * another player's private cards" is asserted over live sockets and over the HTTP hand routes, both
 * of which read *this process's memory* or a fixture somebody typed. Neither says anything about
 * what is durably stored. A leak in the archive would put the cards in the table, where every
 * later read, backup and replica would carry them, and no test would have noticed.
 *
 * So this file plays real hands through `RoomRegistry` — with `postgresArchive` and
 * `postgresRoomStore` both bound to a real database — and then asks the database what it kept.
 *
 * ## What "faithful" is asserted against
 *
 * The archive's own inputs. The tap below wraps the real `postgresArchive`, delegates every call
 * to it unchanged, and keeps a copy of what went in: the `ArchivedDeal`, the `LoggedAction`s and
 * the `ArchivedResult`. The rows are then compared against those, so a binding that dropped a
 * field, transposed two arguments or swallowed a rejection fails here. Nothing is stubbed — the
 * tap adds an observation and changes no behaviour.
 *
 * ## How the test knows the writes have finished
 *
 * Archive writes are deliberately fire-and-forget: `LiveRoom.archiveNotice` appends them to a
 * per-room promise chain that nobody awaits, because a failing history write must never stop a
 * hand. That makes "the hand is over" and "the hand is written" two different moments, and a test
 * that read the rows at the first would be a flake generator.
 *
 * `roomStatusChanged` is the last call in the chain for both the deal and the completion, so the
 * tap records it and `waitFor` resolves on the recorded fact. No sleeps, no polling: the condition
 * is the write itself. A chain that *rejects* is reported to `onProblem`, which fails the waiter
 * immediately with the underlying error rather than hanging until a timeout. The one timer in this
 * file is a watchdog inside `waitFor` that turns "the write never happened" into a named failure —
 * `node --test` has no default timeout, so the alternative is a suite that hangs.
 *
 * ## Everything runs inside one rolled-back transaction
 *
 * `postgresArchive` and `postgresRoomStore` both take `() => Db`, so both can be bound to a
 * transaction handle. Each case therefore creates its own accounts, room, hands and actions and
 * leaves nothing behind, which is what lets this file run repeatedly, next to the other suites,
 * and against a seeded development database.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { Card, LoggedAction } from '@prl/poker-engine';
import { cardToString, createSecureRandom } from '@prl/poker-engine';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql, type TransactionSql } from '../src/db.ts';
import * as handsRepository from '../src/repositories/hands.ts';
import { MAX_PUBLIC_REVEALED_CARDS } from '../src/repositories/hands.ts';
import * as usersRepository from '../src/repositories/users.ts';
import { type HandArchive, postgresArchive, postgresRoomStore, RoomRegistry } from '../src/rooms/registry.ts';
import type {
  ArchivedDeal,
  ArchivedDealSeat,
  ArchivedResult,
  ArchivedResultSeat,
  LiveTable,
} from '../src/rooms/table.ts';
import { createManualClock } from '../src/rooms/timers.ts';
import { databaseSkip, TEST_DATABASE_URL } from './helpers/database.ts';

const TEST_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';

const databaseUrl = TEST_DATABASE_URL;
let client: Sql | null = null;
let skipReason: string | false = databaseSkip('the Postgres hand archive');

if (databaseUrl !== undefined) {
  try {
    const probe = createDatabaseClient(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
        SESSION_COOKIE_SECRET: TEST_SECRET,
        DATABASE_POOL_MAX: '2',
        // A hand is many statements inside one transaction, and the driver derives
        // `idle_in_transaction_session_timeout` from this. The default 5s ceiling is ample on an
        // idle laptop and not obviously ample on a loaded CI box; 30s keeps the bound (a runaway
        // transaction still dies) without making this suite the first thing to fail under load.
        DATABASE_STATEMENT_TIMEOUT_MS: '30000',
      }),
    );
    await probe`select 1 from prl.users limit 1`;
    client = probe;
  } catch (error) {
    skipReason = `prl schema is not reachable (${error instanceof Error ? error.name : 'error'}): run pnpm db:migrate`;
  }
}

if (skipReason !== false) {
  console.info(`[coverage-postgres-archive.test.ts] skipping database-backed tests: ${skipReason}`);
}

const dbOptions = { skip: skipReason };

after(async () => {
  if (client !== null) await client.end({ timeout: 5 });
});

const ROLLBACK = new Error('rollback: this transaction was only ever a test');

async function inRollback(fn: (tx: TransactionSql) => Promise<void>): Promise<void> {
  const handle = client;
  if (handle === null) throw new Error('inRollback called without a database');
  try {
    await handle.begin(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

// ---------------------------------------------------------------------------
// The tap: the real archive, plus a record of what it was asked to write
// ---------------------------------------------------------------------------

interface ArchiveTap {
  /** The archive the registry is given. Delegates every call to `postgresArchive`. */
  readonly archive: HandArchive;
  /** Resolves once `fact` has been written, or rejects if the write chain failed. */
  readonly waitFor: (fact: string) => Promise<void>;
  /** Called by the registry when a write chain rejects. Fails any waiter at once. */
  readonly noteProblem: (message: string) => void;
  readonly deals: ArchivedDeal[];
  readonly results: ArchivedResult[];
  /** Every `LoggedAction` handed to the archive, by hand id, in the order it arrived. */
  readonly actions: Map<string, LoggedAction[]>;
  readonly problems: string[];
}

/**
 * Wraps the real archive so a test can tell when a write has landed and compare rows against what
 * went in.
 *
 * Emphatically not a stand-in: every method awaits the real `postgresArchive`, and the recording
 * happens after that await, so a fact is only recorded once the row is genuinely there.
 */
function tapArchive(inner: HandArchive): ArchiveTap {
  const facts = new Set<string>();
  const waiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }[]>();
  const problems: string[] = [];
  const actions = new Map<string, LoggedAction[]>();

  const record = (fact: string): void => {
    facts.add(fact);
    for (const waiter of waiters.get(fact) ?? []) waiter.resolve();
    waiters.delete(fact);
  };

  const failEveryone = (error: Error): void => {
    for (const list of waiters.values()) for (const waiter of list) waiter.reject(error);
    waiters.clear();
  };

  const archive: HandArchive = {
    // Spread first, so every method this tap does not care about is the real one, and so a method
    // ADDED to `HandArchive` later is forwarded rather than missing. That is not hypothetical: two
    // (`lastDealtHand`, `abandonInterruptedHands`) arrived while this file was being written, and
    // an enumerated wrapper answered them with `undefined is not a function` on the archive chain.
    // The overrides below are only the calls this file needs to observe.
    ...inner,
    handStarted: async (deal) => {
      await inner.handStarted(deal);
      // Recorded after the write, so `deals` never describes a hand the database refused.
      tap.deals.push(deal);
      record(`started:${deal.handId}`);
    },
    actionsApplied: async (handId, applied) => {
      await inner.actionsApplied(handId, applied);
      const existing = actions.get(handId) ?? [];
      existing.push(...applied);
      actions.set(handId, existing);
    },
    streetAdvanced: async (handId, street, board) => {
      await inner.streetAdvanced(handId, street, board);
      record(`street:${handId}:${street}`);
    },
    handCompleted: async (result) => {
      await inner.handCompleted(result);
      tap.results.push(result);
      record(`completed:${result.handId}`);
    },
    stacksSettled: async (stacks) => {
      await inner.stacksSettled(stacks);
      record(`settled:${stacks.roomId}`);
    },
    roomStatusChanged: async (roomId, status) => {
      await inner.roomStatusChanged(roomId, status);
      // The last call in both chains, which is what makes it the one worth waiting on.
      record(`status:${roomId}:${status}`);
    },
  };

  const tap: ArchiveTap = {
    archive,
    deals: [],
    results: [],
    actions,
    problems,
    noteProblem: (message) => {
      problems.push(message);
      failEveryone(new Error(`the archive write chain failed: ${message}`));
    },
    waitFor: (fact) =>
      new Promise<void>((resolve, reject) => {
        if (facts.has(fact)) {
          resolve();
          return;
        }
        if (problems.length > 0) {
          reject(new Error(`the archive write chain already failed: ${problems.join('; ')}`));
          return;
        }
        // A failure guard, not a synchronisation device: the resolution above is the write itself,
        // and this only fires when a write that should have happened never did. It exists because
        // `node --test` has no default timeout, so without it a wiring mistake here would hang the
        // whole package suite instead of failing it. `unref` so it can never hold the process open.
        const watchdog = setTimeout(() => {
          reject(
            new Error(`the archive never wrote "${fact}" (waited 20s); recorded: ${[...facts].join(', ')}`),
          );
        }, 20_000);
        watchdog.unref();
        const list = waiters.get(fact) ?? [];
        list.push({
          resolve: () => {
            clearTimeout(watchdog);
            resolve();
          },
          reject: (error) => {
            clearTimeout(watchdog);
            reject(error);
          },
        });
        waiters.set(fact, list);
      }),
  };
  return tap;
}

// ---------------------------------------------------------------------------
// A live room with two seated learners, everything bound to the transaction
// ---------------------------------------------------------------------------

interface Learner {
  readonly userId: string;
  readonly displayName: string;
}

interface LiveFixture {
  readonly registry: RoomRegistry;
  readonly tap: ArchiveTap;
  readonly roomId: string;
  readonly table: LiveTable;
  readonly alice: Learner;
  readonly bob: Learner;
}

async function guest(tx: TransactionSql, displayName: string): Promise<Learner> {
  const row = await usersRepository.createGuest(tx, { displayName });
  return { userId: row.id, displayName: row.display_name };
}

function registryOn(tx: TransactionSql, tap: ArchiveTap): RoomRegistry {
  return new RoomRegistry({
    // A manual clock, never advanced: a turn timer that fires mid-assertion would apply an
    // automatic fold and make the hand's shape depend on how loaded the machine is. Nothing here
    // is about timeouts, so nothing here should be able to time out.
    clock: createManualClock(),
    random: createSecureRandom(),
    archive: tap.archive,
    store: postgresRoomStore(() => tx),
    onProblem: (message, detail) => tap.noteProblem(`${message} ${JSON.stringify(detail ?? {})}`),
  });
}

/** Two learners, a private room, both seated. Every write goes to the real database. */
async function seatTwo(tx: TransactionSql, names: readonly [string, string]): Promise<LiveFixture> {
  const tap = tapArchive(postgresArchive(() => tx));
  const registry = registryOn(tx, tap);
  const alice = await guest(tx, names[0]);
  const bob = await guest(tx, names[1]);

  const created = await registry.createRoom(alice, {
    name: 'Archive table',
    maxSeats: 6,
    smallBlind: 1,
    bigBlind: 2,
    startingStack: 200,
    actionTimeoutSeconds: 300,
  });
  const roomId = created.room.record.id;
  await registry.joinByInviteCode(bob, created.inviteCode);
  await registry.sitAtTable(roomId, alice, 0);
  await registry.sitAtTable(roomId, bob, 1);

  return { registry, tap, roomId, table: created.room.table, alice, bob };
}

/** Who is to act, and the sequence they must quote. Read from the table, never assumed. */
function toAct(
  table: LiveTable,
  anyViewer: string,
): { readonly userId: string; readonly sequence: number } | null {
  const view = table.viewFor(anyViewer);
  if (view === null || view.street === 'complete' || view.toAct === null) return null;
  const seat = view.seats.find((entry) => entry.seat === view.toAct);
  assert.ok(seat !== undefined, `seat ${String(view.toAct)} is not in the view`);
  return { userId: seat.playerId, sequence: view.actionSequence };
}

/**
 * Plays the hand out, choosing from the engine's own legal set rather than from an assumption.
 *
 * `passive` checks when it can and calls otherwise, which walks any two-handed hand to showdown.
 * `fold` folds whoever is asked to act, which ends the hand before a card becomes public.
 *
 * Both styles loop until the hand is genuinely over rather than counting actions: heads-up, one
 * fold ends it, but "one fold is enough" is an assumption about the table's rules, and this file is
 * about persistence. The bounded loop turns a hand that will not end into a failed assertion rather
 * than a suite that hangs.
 *
 * Reading the legal actions off the view is what keeps this robust while the blind rules are being
 * worked on elsewhere: if the first seat to act preflop changes, or a forced bet moves, this loop
 * still submits something legal and the assertions stay about persistence.
 */
async function playOut(fixture: LiveFixture, style: 'passive' | 'fold'): Promise<void> {
  for (let guard = 0; guard < 40; guard += 1) {
    const next = toAct(fixture.table, fixture.alice.userId);
    if (next === null) return;
    const view = fixture.table.viewFor(next.userId);
    assert.ok(view !== null, 'the actor has no view of the hand they are in');
    const legal = view.legalActions.map((entry) => entry.type);
    const wanted =
      style === 'fold' ? (['fold', 'check', 'call'] as const) : (['check', 'call', 'fold'] as const);
    const choice = wanted.find((type) => legal.includes(type));
    assert.ok(choice !== undefined, `no playable action in ${JSON.stringify(legal)}`);
    await fixture.table.submitAction(next.userId, {
      action: { type: choice },
      actionId: `act-${view.handId.slice(-8)}-${guard}`,
      expectedSequence: next.sequence,
    });
  }
  assert.fail('the hand did not complete within 40 actions');
}

/** Deals, plays and waits for every archive write of that hand to land. */
async function playOneHand(fixture: LiveFixture, style: 'passive' | 'fold'): Promise<string> {
  const started = await fixture.table.startHand();
  await fixture.tap.waitFor(`status:${fixture.roomId}:playing`);
  await playOut(fixture, style);
  await fixture.tap.waitFor(`completed:${started.handId}`);
  await fixture.tap.waitFor(`status:${fixture.roomId}:open`);
  assert.deepEqual(fixture.tap.problems, [], 'no archive write may fail');
  return started.handId;
}

// ---------------------------------------------------------------------------
// Reading the persisted hand back
// ---------------------------------------------------------------------------

interface PersistedHandRow {
  readonly id: string;
  readonly room_id: string;
  readonly hand_number: number;
  readonly button_seat: number;
  readonly config: unknown;
  readonly commitment_root: string;
  readonly commitment_context: string;
  readonly random_source_kind: string;
  readonly board: unknown;
  readonly street: string;
  readonly result: unknown;
  readonly reveal: unknown;
  readonly completed_at: Date | null;
}

async function readHand(tx: TransactionSql, handId: string): Promise<PersistedHandRow> {
  const rows = await tx<PersistedHandRow[]>`
    select id, room_id, hand_number, button_seat, config, commitment_root, commitment_context,
           random_source_kind, board, street, result, reveal, completed_at
      from prl.hands where id = ${handId}
  `;
  const row = rows[0];
  assert.ok(row !== undefined, `no hand row was written for ${handId}`);
  return row;
}

/** Every key name appearing anywhere in a parsed jsonb value. */
function keyNames(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value as readonly unknown[]) keyNames(entry, into);
    return into;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      keyNames(nested, into);
    }
  }
  return into;
}

interface RevealedCardView {
  readonly index: number;
  readonly card: number;
  readonly saltHex: string;
  readonly proofLength: number;
}

/**
 * The persisted reveal, read structurally rather than asserted into existence.
 *
 * `HandRow.reveal` is `unknown` — the driver hands back parsed jsonb and nothing at the type level
 * says what it parsed — so every field is checked as it is read. That is the same reasoning as
 * `cardNotationArray` in the repository: an assertion here would be a promise nobody checks.
 */
function readReveal(value: unknown): { complete: boolean; cards: readonly RevealedCardView[] } {
  assert.ok(value !== null && typeof value === 'object', 'the reveal must be a jsonb object');
  const complete: unknown = Reflect.get(value, 'complete');
  const cards: unknown = Reflect.get(value, 'cards');
  assert.equal(typeof complete, 'boolean', 'reveal.complete must be a boolean');
  assert.ok(Array.isArray(cards), 'reveal.cards must be an array');
  const entries: readonly unknown[] = cards;
  return {
    complete: complete === true,
    cards: entries.map((entry) => {
      assert.ok(entry !== null && typeof entry === 'object', 'a revealed card must be an object');
      const index: unknown = Reflect.get(entry, 'index');
      const card: unknown = Reflect.get(entry, 'card');
      const saltHex: unknown = Reflect.get(entry, 'saltHex');
      const proof: unknown = Reflect.get(entry, 'proof');
      assert.equal(typeof index, 'number');
      assert.equal(typeof card, 'number');
      assert.equal(typeof saltHex, 'string');
      assert.ok(Array.isArray(proof));
      return {
        index: Number(index),
        card: Number(card),
        saltHex: String(saltHex),
        proofLength: (proof as readonly unknown[]).length,
      };
    }),
  };
}

/** The hole cards of every seat that actually showed, from the persisted `hand_seats` rows. */
async function shownHoleCards(tx: TransactionSql, handId: string): Promise<Set<string>> {
  const rows = await tx<{ hole_cards: unknown }[]>`
    select hole_cards from prl.hand_seats where hand_id = ${handId} and showed_down = true
  `;
  const shown = new Set<string>();
  for (const row of rows)
    for (const card of handsRepository.cardNotationArray(row.hole_cards)) {
      shown.add(card);
    }
  return shown;
}

function notationOf(cards: readonly Card[]): readonly string[] {
  return cards.map((card) => cardToString(card));
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe('postgresArchive — a played hand is durable and faithful', dbOptions, () => {
  it('writes the deal, every action, the board and the settlement as the table reported them', async () => {
    await inRollback(async (tx) => {
      const fixture = await seatTwo(tx, ['Alice', 'Bob']);
      try {
        const handId = await playOneHand(fixture, 'passive');

        // Annotated rather than inferred: `assert.ok` is an assertion function, and narrowing an
        // inferred `const` through one makes its own type circular (TS7022).
        const deal: ArchivedDeal | undefined = fixture.tap.deals.at(-1);
        const result: ArchivedResult | undefined = fixture.tap.results.at(-1);
        assert.ok(deal !== undefined && result !== undefined, 'the tap saw no deal or no result');
        assert.equal(deal.handId, handId);

        const row = await readHand(tx, handId);
        assert.equal(row.room_id, fixture.roomId);
        assert.equal(row.hand_number, 1, 'the first hand of a fresh room is hand 1');
        assert.equal(row.button_seat, deal.buttonSeat);
        assert.equal(row.commitment_root, deal.commitmentRoot);
        assert.equal(row.commitment_context, deal.commitmentContext);
        assert.equal(row.random_source_kind, 'csprng', 'a live table deals from the CSPRNG');
        assert.equal(row.street, 'complete');
        assert.ok(row.completed_at instanceof Date, 'a settled hand records when it settled');
        assert.deepEqual(row.config, deal.config, 'the table configuration is snapshotted per hand');
        assert.deepEqual(
          handsRepository.cardNotationArray(row.board),
          notationOf(result.board),
          'the persisted board is the board the hand finished with',
        );

        // The seats, against the deal and the settlement the table published.
        const seats = await handsRepository.seatsOf(tx, handId, null);
        assert.equal(seats.length, deal.seats.length, 'every dealt seat is written');
        for (const dealt of deal.seats) {
          const persisted = seats.find((seat) => seat.seat === dealt.seat);
          assert.ok(persisted !== undefined, `seat ${dealt.seat} was not written`);
          assert.equal(persisted.userId, dealt.userId, 'a hand seat belongs to a person, not a chair');
          assert.equal(persisted.isBot, dealt.isBot);
          assert.equal(persisted.startingStack, dealt.startingStack);
          const settled: ArchivedResultSeat | undefined = result.seats.find(
            (seat) => seat.seat === dealt.seat,
          );
          assert.ok(settled !== undefined);
          assert.equal(persisted.netResult, settled.netResult);
          assert.equal(persisted.status, settled.status);
          assert.equal(persisted.showedDown, settled.showedDown);
        }
        assert.equal(
          seats.reduce((sum, seat) => sum + (seat.netResult ?? 0), 0),
          0,
          'chips are conserved: the nets of a settled hand sum to zero',
        );

        // The actions, against the engine's own log. Sequence, sizing and the automatic flag all
        // have to survive the binding, because the hand review is replayed from these rows.
        const logged = fixture.tap.actions.get(handId) ?? [];
        assert.ok(logged.length > 0, 'a hand played to showdown logs at least one action');
        const persistedActions = await handsRepository.actionsOf(tx, handId);
        assert.equal(persistedActions.length, logged.length, 'every logged action is a row');
        for (const [index, action] of logged.entries()) {
          const persisted = persistedActions[index];
          assert.ok(persisted !== undefined);
          assert.equal(persisted.sequence, action.sequence);
          assert.equal(persisted.street, action.street);
          assert.equal(persisted.seat, action.seat);
          assert.equal(persisted.action_type, action.action.type);
          assert.equal(persisted.amount_paid, action.amountPaid);
          assert.equal(persisted.bet_level_after, action.betLevelAfter);
          assert.equal(persisted.pot_after, action.potAfter);
          assert.equal(persisted.was_automatic, action.wasAutomatic);
          const sized = action.action.type === 'bet' || action.action.type === 'raise';
          assert.equal(
            persisted.action_to,
            sized && 'to' in action.action ? action.action.to : null,
            'sizing is present exactly for bets and raises',
          );
        }

        // `stacksSettled` and `roomStatusChanged`: the roster and the lobby agree with the table.
        const snapshot = fixture.table.snapshot();
        const members = await tx<{ user_id: string; stack: number }[]>`
          select user_id, stack from prl.room_members where room_id = ${fixture.roomId}
        `;
        for (const seat of snapshot.seats) {
          const member = members.find((entry) => entry.user_id === seat.userId);
          assert.equal(member?.stack, seat.stack, `settled stack for ${seat.displayName}`);
        }
        const room = await tx<{ status: string }[]>`
          select status from prl.rooms where id = ${fixture.roomId}
        `;
        assert.equal(room[0]?.status, 'open', 'a room that is not mid-hand reads as open again');
      } finally {
        fixture.registry.closeAll();
      }
    });
  });

  it('numbers hands from the database, so a re-opened room cannot collide with a played one', async () => {
    await inRollback(async (tx) => {
      const fixture = await seatTwo(tx, ['Alice', 'Bob']);
      let reopened: RoomRegistry | null = null;
      try {
        const first = await playOneHand(fixture, 'fold');
        const second = await playOneHand(fixture, 'fold');
        fixture.registry.closeAll();

        // A restart: a brand-new registry over the same database, with no memory of the room. It
        // has to re-open the room from its rows, re-take the recorded seats, and continue the
        // numbering — `hands_room_hand_number_key` is unique, so a table that started again from
        // zero would fail its first deal.
        const tap = tapArchive(postgresArchive(() => tx));
        reopened = registryOn(tx, tap);
        const room = await reopened.ensureOpen(fixture.roomId);
        assert.ok(room !== null, 'a room with rows must re-open');
        assert.equal(room.table.seatCount, 2, 'seats recorded in the database are re-taken');

        const third = await playOneHand({ ...fixture, registry: reopened, tap, table: room.table }, 'fold');

        const numbers = await tx<{ id: string; hand_number: number }[]>`
          select id, hand_number from prl.hands where room_id = ${fixture.roomId} order by hand_number
        `;
        assert.deepEqual(
          numbers.map((entry) => entry.hand_number),
          [1, 2, 3],
          'hand numbers continue across a restart',
        );
        assert.deepEqual(
          numbers.map((entry) => entry.id),
          [first, second, third],
        );
      } finally {
        fixture.registry.closeAll();
        reopened?.closeAll();
      }
    });
  });
});

describe('postgresArchive — the hidden-information guarantee, on the persisted rows', dbOptions, () => {
  it('has nowhere to store a deck, a cursor or the salts, and stores none of them', async () => {
    await inRollback(async (tx) => {
      const fixture = await seatTwo(tx, ['Alice', 'Bob']);
      try {
        const handId = await playOneHand(fixture, 'passive');

        // 1. The schema. `HandState` carries `deck`, `deckCursor` and `deckSalts`; the point of
        //    the design is that there is no column any of them could reach.
        const columns = await tx<{ table_name: string; column_name: string }[]>`
          select table_name, column_name from information_schema.columns where table_schema = 'prl'
        `;
        const suspicious = columns.filter((column) =>
          /(^|_)(deck|deck_cursor|salt|salts)(_|$)/i.test(column.column_name),
        );
        assert.deepEqual(
          suspicious.map((column) => `${column.table_name}.${column.column_name}`),
          [],
          'no column may store the deck order, the deal cursor or the commitment salts',
        );

        // 2. The rows. A key named for any of the three would mean the whole secret went into a
        //    jsonb document instead — same leak, no new column.
        const row = await readHand(tx, handId);
        const keys = new Set([
          ...keyNames(row.config),
          ...keyNames(row.result),
          ...keyNames(row.reveal),
          ...keyNames(row.board),
        ]);
        for (const forbidden of ['deck', 'deckCursor', 'deckSalts', 'salts', 'secret']) {
          assert.equal(keys.has(forbidden), false, `the persisted hand carries a "${forbidden}" key`);
        }
      } finally {
        fixture.registry.closeAll();
      }
    });
  });

  it('reveals only what became public: no proof for a sealed card, and none at all after a fold', async () => {
    await inRollback(async (tx) => {
      const fixture = await seatTwo(tx, ['Alice', 'Bob']);
      try {
        // A hand that ends when the first seat folds. Nothing became public — no board, no
        // showdown — so a faithful archive has nothing to prove, and every salt is still sealed.
        const folded = await playOneHand(fixture, 'fold');
        const foldedRow = await readHand(tx, folded);
        const foldedReveal = readReveal(foldedRow.reveal);
        assert.equal(foldedReveal.complete, false, 'a hand result never carries a complete reveal');
        assert.deepEqual(
          handsRepository.cardNotationArray(foldedRow.board),
          [],
          'a hand folded before the flop has no public board',
        );
        assert.deepEqual(
          foldedReveal.cards.map((card) => card.index),
          [],
          'nothing became public, so no deck position may be unsealed — and no salt published',
        );
        assert.equal(
          await shownHoleCards(tx, folded).then((shown) => shown.size),
          0,
          'nobody showed, so no seat is marked as having shown',
        );

        // A hand played to showdown. Now some cards are public, and exactly those may be proved.
        const shown = await playOneHand(fixture, 'passive');
        const shownRow = await readHand(tx, shown);
        const reveal = readReveal(shownRow.reveal);
        const board = handsRepository.cardNotationArray(shownRow.board);
        const shownCards = await shownHoleCards(tx, shown);
        const public_ = new Set([...board, ...shownCards]);

        // Pinned so the equality below cannot pass by both sides being empty. A hand nobody folded
        // runs the whole board out and both seats show, which is 5 + 2 + 2 = 9 public cards; if a
        // future change to the betting rules ends this hand early, this fails and says so rather
        // than quietly turning the assertion underneath into `0 === 0`.
        assert.equal(board.length, 5, 'a hand played out passively reaches the river');
        assert.equal(shownCards.size, 4, 'both seats show at a two-handed showdown');

        assert.equal(reveal.complete, false, 'a hand result never carries a complete reveal');
        assert.ok(
          reveal.cards.length <= MAX_PUBLIC_REVEALED_CARDS,
          `${reveal.cards.length} revealed cards exceeds the ${MAX_PUBLIC_REVEALED_CARDS} that can be public`,
        );
        assert.equal(
          reveal.cards.length,
          public_.size,
          'exactly the cards that became public are proved — no more, and no fewer',
        );
        for (const card of reveal.cards) {
          assert.ok(
            public_.has(cardToString(card.card as Card)),
            `deck position ${card.index} unsealed a card (${cardToString(card.card as Card)}) that never became public`,
          );
          // One salt per unsealed position, and only for these. A salt is what makes a Merkle leaf
          // checkable, so publishing one for a card nobody saw would make that card brute-forceable.
          assert.match(card.saltHex, /^[0-9a-f]{64}$/, 'a published salt is the leaf salt, hex');
          assert.ok(card.proofLength > 0, 'a revealed card carries its Merkle path');
        }

        // The same reveal is written twice — `hands.reveal` and inside `hands.result` — and both
        // copies carry their own CHECK constraints. A guard applied to one and not the other would
        // be no guard at all.
        assert.ok(shownRow.result !== null && typeof shownRow.result === 'object');
        const inResult = readReveal(Reflect.get(shownRow.result, 'reveal'));
        assert.equal(inResult.complete, false);
        assert.deepEqual(
          inResult.cards.map((card) => card.index).sort((left, right) => left - right),
          reveal.cards.map((card) => card.index).sort((left, right) => left - right),
        );
      } finally {
        fixture.registry.closeAll();
      }
    });
  });

  it('hands back a seat’s hole cards only to its owner, or once that seat has shown', async () => {
    await inRollback(async (tx) => {
      const fixture = await seatTwo(tx, ['Alice', 'Bob']);
      const stranger = await guest(tx, 'Stranger');
      try {
        const handId = await playOneHand(fixture, 'fold');
        const deal: ArchivedDeal | undefined = fixture.tap.deals.at(-1);
        assert.ok(deal !== undefined);
        // A folded hand shows nobody's cards, so the entitlement check below is exercised on a
        // holding that genuinely stayed hidden rather than on one that was public anyway.
        assert.equal((await shownHoleCards(tx, handId)).size, 0, 'a fold makes no card public');

        // The rule, as `seatsOf` states it: cards come back when the seat showed down, or when the
        // viewer is the seat's own player. Asserted as an equivalence rather than case by case, so
        // it holds whichever way the hand happened to end.
        for (const viewer of [fixture.alice, fixture.bob, stranger]) {
          const seats = await handsRepository.seatsOf(tx, handId, viewer.userId);
          for (const seat of seats) {
            const entitled = seat.showedDown || seat.userId === viewer.userId;
            assert.equal(
              seat.holeCards !== null,
              entitled,
              `${viewer.displayName} ${entitled ? 'must' : 'must not'} see seat ${seat.seat}'s cards`,
            );
            if (!entitled) continue;
            const dealt: ArchivedDealSeat | undefined = deal.seats.find((entry) => entry.seat === seat.seat);
            assert.ok(dealt?.holeCards != null);
            assert.deepEqual(
              seat.holeCards,
              notationOf(dealt.holeCards),
              'the cards read back are the cards that were dealt',
            );
          }
        }

        // An anonymous reader is a stranger with fewer rights, never more.
        const anonymous = await handsRepository.seatsOf(tx, handId, null);
        for (const seat of anonymous) {
          assert.equal(seat.holeCards !== null, seat.showedDown, 'nobody sees an unshown holding');
        }

        // Fold or showdown, one thing never varies: a card that stayed sealed is in no row a
        // non-owner can reach. Checked by set difference rather than by re-stating the rule.
        const bobSeats = await handsRepository.seatsOf(tx, handId, fixture.bob.userId);
        const visibleToBob = new Set(bobSeats.flatMap((seat) => seat.holeCards ?? []));
        const aliceSeat: ArchivedDealSeat | undefined = deal.seats.find(
          (seat) => seat.userId === fixture.alice.userId,
        );
        const aliceShown = bobSeats.find((seat) => seat.userId === fixture.alice.userId)?.showedDown;
        if (aliceShown === false) {
          assert.ok(aliceSeat?.holeCards != null);
          for (const card of notationOf(aliceSeat.holeCards)) {
            assert.equal(visibleToBob.has(card), false, `Bob can read Alice's ${card}`);
          }
        }
      } finally {
        fixture.registry.closeAll();
      }
    });
  });

  it('keeps one learner’s history out of another’s, at both tables', async () => {
    await inRollback(async (tx) => {
      const first = await seatTwo(tx, ['Alice', 'Bob']);
      const second = await seatTwo(tx, ['Carol', 'Dave']);
      const stranger = await guest(tx, 'Stranger');
      try {
        const aliceHand = await playOneHand(first, 'fold');
        const carolHand = await playOneHand(second, 'fold');

        const aliceHistory = await handsRepository.listForUser(tx, { userId: first.alice.userId });
        assert.deepEqual(
          aliceHistory.hands.map((hand) => hand.id),
          [aliceHand],
          "a learner's history is the hands they were dealt into, and nothing else",
        );
        const carolHistory = await handsRepository.listForUser(tx, { userId: second.alice.userId });
        assert.deepEqual(
          carolHistory.hands.map((hand) => hand.id),
          [carolHand],
        );
        const strangerHistory = await handsRepository.listForUser(tx, { userId: stranger.userId });
        assert.deepEqual(
          strangerHistory.hands.map((hand) => hand.id),
          [],
        );

        // And the single-hand read is entitled the same way: a seat in the hand, or membership of
        // its room. Carol has neither at Alice's table, so the answer is the one a fictional hand
        // id gets — which is what stops the endpoint confirming which ids are real.
        assert.equal((await handsRepository.byId(tx, aliceHand, first.bob.userId))?.id, aliceHand);
        assert.equal(await handsRepository.byId(tx, aliceHand, second.alice.userId), null);
        assert.equal(await handsRepository.byId(tx, aliceHand, stranger.userId), null);
        assert.equal(await handsRepository.byId(tx, carolHand, first.alice.userId), null);
      } finally {
        first.registry.closeAll();
        second.registry.closeAll();
      }
    });
  });
});
