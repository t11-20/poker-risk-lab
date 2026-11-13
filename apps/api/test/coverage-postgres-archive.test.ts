/**
 * Plays real hands through `RoomRegistry` with `postgresArchive` and `postgresRoomStore` bound to a
 * real database, then reads back what it kept. Rows are compared against the archive's own inputs,
 * recorded by a tap that delegates every call unchanged. Archive writes are fire-and-forget, so
 * tests wait on the recorded `roomStatusChanged` write, never a sleep. Each case runs in one
 * rolled-back transaction.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { Card } from '@prl/poker-engine';
import { cardToString, createSecureRandom } from '@prl/poker-engine';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql, type TransactionSql } from '../src/db.ts';
import * as handsRepository from '../src/repositories/hands.ts';
import { MAX_PUBLIC_REVEALED_CARDS } from '../src/repositories/hands.ts';
import * as usersRepository from '../src/repositories/users.ts';
import { type HandArchive, postgresArchive, postgresRoomStore, RoomRegistry } from '../src/rooms/registry.ts';
import type {
  ArchivedAction,
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
        // The driver derives `idle_in_transaction_session_timeout` from this, and a hand is many
        // statements in one transaction. 30s survives a loaded CI box.
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

interface ArchiveTap {
  readonly archive: HandArchive;
  readonly waitFor: (fact: string) => Promise<void>;
  /** Fails any waiter at once. */
  readonly noteProblem: (message: string) => void;
  readonly deals: ArchivedDeal[];
  readonly results: ArchivedResult[];
  readonly actions: Map<string, ArchivedAction[]>;
  readonly problems: string[];
}

/** Every method awaits the real `postgresArchive` before recording, so a fact means the row exists. */
function tapArchive(inner: HandArchive): ArchiveTap {
  const facts = new Set<string>();
  const waiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }[]>();
  const problems: string[] = [];
  const actions = new Map<string, ArchivedAction[]>();

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
    // Spread first so a method added to `HandArchive` later is forwarded, not `undefined`.
    ...inner,
    handStarted: async (deal) => {
      await inner.handStarted(deal);
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
      // The last call in both chains.
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
        // `node --test` has no default timeout, so this turns a write that never happened into a
        // named failure. `unref` so it cannot hold the process open.
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
    // Never advanced, so no turn timer can fold mid-assertion.
    clock: createManualClock(),
    random: createSecureRandom(),
    archive: tap.archive,
    store: postgresRoomStore(() => tx),
    onProblem: (message, detail) => tap.noteProblem(`${message} ${JSON.stringify(detail ?? {})}`),
  });
}

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
 * `passive` walks to showdown and `fold` ends the hand before a card is public. Both choose from
 * the engine's legal set and loop until the hand is over, bounded so it cannot hang.
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

async function playOneHand(fixture: LiveFixture, style: 'passive' | 'fold'): Promise<string> {
  const started = await fixture.table.startHand();
  await fixture.tap.waitFor(`status:${fixture.roomId}:playing`);
  await playOut(fixture, style);
  await fixture.tap.waitFor(`completed:${started.handId}`);
  await fixture.tap.waitFor(`status:${fixture.roomId}:open`);
  assert.deepEqual(fixture.tap.problems, [], 'no archive write may fail');
  return started.handId;
}

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

/** `HandRow.reveal` is `unknown` parsed jsonb, so every field is checked as it is read. */
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

describe('postgresArchive — a played hand is durable and faithful', dbOptions, () => {
  it('writes the deal, every action, the board and the settlement as the table reported them', async () => {
    await inRollback(async (tx) => {
      const fixture = await seatTwo(tx, ['Alice', 'Bob']);
      try {
        const handId = await playOneHand(fixture, 'passive');

        // Annotated because narrowing an inferred `const` through `assert.ok` is circular (TS7022).
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

        // The hand review replays from these rows.
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
          assert.equal(persisted.automatic_reason, action.automaticReason);
          const sized = action.action.type === 'bet' || action.action.type === 'raise';
          assert.equal(
            persisted.action_to,
            sized && 'to' in action.action ? action.action.to : null,
            'sizing is present exactly for bets and raises',
          );
        }

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

  // Migration 0009. Before it this fold was written `was_automatic = true` like a timeout.
  it('writes down that a fold for a player who stood up was a departure, not a timeout', async () => {
    await inRollback(async (tx) => {
      const fixture = await seatTwo(tx, ['Alice', 'Bob']);
      try {
        const started = await fixture.table.startHand();
        await fixture.tap.waitFor(`status:${fixture.roomId}:playing`);
        const next = toAct(fixture.table, fixture.alice.userId);
        assert.ok(next !== null, 'somebody is to act preflop');
        await fixture.registry.standFromTable(fixture.roomId, next.userId);
        await fixture.tap.waitFor(`completed:${started.handId}`);
        assert.deepEqual(fixture.tap.problems, [], 'no archive write may fail');

        const persisted = await handsRepository.actionsOf(tx, started.handId);
        assert.deepEqual(
          persisted.map((row) => [row.action_type, row.was_automatic, row.automatic_reason]),
          [['fold', true, 'departed']],
        );
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

        // A new registry over the same database. `hands_room_hand_number_key` is unique, so a
        // table that restarted numbering would fail its first deal.
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

        // 1. `HandState` carries `deck`, `deckCursor` and `deckSalts`, and no column may hold them.
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

        // 2. Nor may a jsonb key.
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
        // Nothing became public, so every salt is still sealed.
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

        const shown = await playOneHand(fixture, 'passive');
        const shownRow = await readHand(tx, shown);
        const reveal = readReveal(shownRow.reveal);
        const board = handsRepository.cardNotationArray(shownRow.board);
        const shownCards = await shownHoleCards(tx, shown);
        const public_ = new Set([...board, ...shownCards]);

        // Pinned so the equality below cannot pass as `0 === 0`. A passive hand shows 5 + 2 + 2 = 9 cards.
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
          // A published salt makes its leaf checkable, so a salt for an unseen card makes it brute-forceable.
          assert.match(card.saltHex, /^[0-9a-f]{64}$/, 'a published salt is the leaf salt, hex');
          assert.ok(card.proofLength > 0, 'a revealed card carries its Merkle path');
        }

        // The reveal is written to `hands.reveal` and inside `hands.result`, each with its own CHECK.
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
        // So the check below runs on a holding that genuinely stayed hidden.
        assert.equal((await shownHoleCards(tx, handId)).size, 0, 'a fold makes no card public');

        // Cards come back when the seat showed down or the viewer owns the seat.
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

        const anonymous = await handsRepository.seatsOf(tx, handId, null);
        for (const seat of anonymous) {
          assert.equal(seat.holeCards !== null, seat.showedDown, 'nobody sees an unshown holding');
        }

        // A sealed card is in no row a non-owner can reach.
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

        // Carol gets the same answer as a fictional id, so the endpoint does not confirm which ids are real.
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
