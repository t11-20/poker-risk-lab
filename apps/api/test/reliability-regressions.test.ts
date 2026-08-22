/**
 * The properties `pnpm run test:drills` proves by breaking a running server, pinned here so they
 * are checked by `pnpm test` as well.
 *
 * ## Why this file exists
 *
 * `scripts/reliability-drills.mjs` kills processes, freezes containers and drops sockets. It is
 * the only way to find out what happens to a hand when the process holding it goes away, and it
 * is far too slow and far too infrastructural to run on every commit. So it will be run rarely —
 * which means every property it establishes that a unit test COULD hold needs to be held by one,
 * or the next regression is found by whoever runs the drills next, months later.
 *
 * Each suite below names the drill it belongs to. Between them they cover the three things the
 * drills assert about state, and they cover them against the same objects the server uses:
 *
 *   - **chip conservation, including the settled view's asymmetry.** `sigterm-mid-hand`,
 *     `ws-disconnect-mid-hand` and every protocol drill run `chipLedger` over the frames a client
 *     received, and that function has to know that `committedTotal` is NOT zeroed at settlement:
 *     stacks plus commitments is 404 for a hand at a 400-unit table in which nothing went wrong.
 *     The first version of the checker did not, and reported chip creation on every hand that
 *     finished. If the engine ever changes that convention, the drill's checker becomes wrong in
 *     silence — so the convention is pinned here, in both directions.
 *
 *   - **a duplicate submission applies once, and a stale one applies never.** `duplicate-actions`
 *     and `out-of-order-actions` check this over a socket. The ordering that makes it work —
 *     `actionId` is looked up BEFORE whose turn it is — is the part that is easy to lose in a
 *     refactor, and losing it turns a retry after a dropped response into `not_your_turn`, which
 *     is precisely the failure `actionId` exists to prevent.
 *
 *   - **nothing a recipient is sent names a deck, a salt or a cursor, and no opponent's cards
 *     appear before a showdown.** Every drill scans its whole transcript for this. The scan is
 *     run here against `LiveTable.viewFor` directly, at every decision of a real hand.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Checked by breaking each one while writing it:
 *
 *   - the ledger assertions were run with `chipsInPlay` returning one unit more than it should,
 *     which is what a hand that created a chip looks like: three of the eight tests fail;
 *   - the deduplication assertions were run with the retry carrying a FRESH `actionId`, which is
 *     the shape a broken memo produces — the submission is no longer recognised as a retry and
 *     the test fails;
 *   - the leak scan carries its own negative controls in `the leak scanner itself` below: a view
 *     with `salts` spliced in, and one with an opponent's cards exposed mid-hand. Both fire. It
 *     also asserts it scanned a non-empty set of views, so a scan that stopped finding views
 *     would fail rather than pass vacuously.
 *
 * ## What this file deliberately does NOT do
 *
 * It does not spawn a process, open a socket or touch a database — all three belong to the drills
 * and to `test/shutdown.test.ts`. It therefore proves nothing about draining, readiness, restart
 * recovery or the pool; those are only ever established by running the drills.
 *
 * The leak scanner below deliberately mirrors `scripts/drills/invariants.mjs` rather than
 * importing it. `apps/api/tsconfig.json` has its own `rootDir`, so importing a file from
 * `scripts/` would pull a file from outside it into the build. The duplication is a real cost and
 * is worth naming: if the forbidden-key list changes in one place it must change in the other,
 * and `scripts/reliability-drills.test.mjs` owns the canonical list.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSecureRandom, type PlayerView } from '@prl/poker-engine';
import { isAppError } from '../src/errors.ts';
import { LiveTable } from '../src/rooms/table.ts';
import { systemClock } from '../src/rooms/timers.ts';

const CONFIG = { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 2, actionTimeoutSeconds: 30 } as const;
const BUY_IN = 1_000;
const ADA = 'usr_rr_ada';
const BO = 'usr_rr_bo';

let tableCount = 0;

/**
 * A real table dealt from the real CSPRNG.
 *
 * Deliberately NOT a scripted deck. Every assertion in this file is a property that must hold for
 * every legal deal — chips are conserved whatever the cards are, a duplicate applies once
 * whatever the cards are — so scripting the deck would narrow the coverage to one hand for no
 * gain. `test/z1-settled-hand-invariants.test.ts` scripts its deck because it asserts something
 * about a specific outcome (a chop); nothing here does.
 */
function tableWith(): LiveTable {
  tableCount += 1;
  let hands = 0;
  return new LiveTable({
    roomId: `room_rr_${tableCount}`,
    config: CONFIG,
    clock: systemClock,
    random: createSecureRandom(),
    nextHandId: () => {
      hands += 1;
      return `hand_rr_${tableCount}_${hands}`;
    },
    onProblem: (message, detail) => {
      assert.fail(`the table logged a problem: ${message} ${JSON.stringify(detail ?? {})}`);
    },
  });
}

async function seatedTable(): Promise<LiveTable> {
  const table = tableWith();
  await table.sit({ userId: ADA, displayName: 'Ada', seat: 0, stack: BUY_IN });
  await table.sit({ userId: BO, displayName: 'Bo', seat: 1, stack: BUY_IN });
  await table.startHand();
  return table;
}

function viewOf(table: LiveTable, userId: string): PlayerView {
  const view = table.viewFor(userId);
  assert.ok(view !== null, `${userId} sees no hand`);
  return view;
}

/** Whoever the table says is to act, as a user id. */
function actorOf(view: PlayerView): string {
  const actor = view.seats.find((seat) => seat.seat === view.toAct)?.playerId;
  assert.ok(actor !== undefined, `seat ${String(view.toAct)} is to act but holds no player`);
  return actor;
}

/** Chips in front of the players plus chips in the pot, from one recipient's view. */
function chipsInPlay(view: PlayerView): number {
  const stacks = view.seats.reduce((total, seat) => total + seat.stack, 0);
  const committed = view.seats.reduce((total, seat) => total + seat.committedTotal, 0);
  // The asymmetry the drills' `chipLedger` encodes: at `complete` the pot has been paid into the
  // stacks and the commitments are left standing as the record of what was put in, so adding them
  // would count the pot twice.
  return view.street === 'complete' ? stacks : stacks + committed;
}

// ---------------------------------------------------------------------------
// The scanner, mirroring scripts/drills/invariants.mjs. See the file header.
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'deck',
  'deckorder',
  'decksecret',
  'salt',
  'salts',
  'saltbytes',
  'holecardsalt',
  'cursor',
  'deckcursor',
  'shufflecursor',
  'secret',
  'sessionsecret',
  'sessiontoken',
  'csrfsecret',
  'password',
  'passphrase',
  'privatekey',
]);

function normaliseKey(key: string): string {
  return key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
}

/**
 * `saltHex` is published for a card that is ALREADY public, and only as part of its proof.
 *
 * A proof nobody can check is not a proof, so the salt of a revealed position travels with it.
 * The salt of an unrevealed position has no column, no field and no path to a client, and a bare
 * `saltHex` with no `index`/`card`/`proof` beside it is exactly what that leak would look like.
 */
function isRevealedCard(node: Record<string, unknown>): boolean {
  const card = node['card'];
  return (
    typeof node['index'] === 'number' &&
    (typeof card === 'string' || typeof card === 'number') &&
    Array.isArray(node['proof'])
  );
}

function scanForSecrets(value: unknown, label: string): string[] {
  const findings: string[] = [];
  const seen = new Set<object>();

  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > 40 || node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const [index, entry] of node.entries()) walk(entry, `${path}[${index}]`, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record)) {
      const here = path === '' ? key : `${path}.${key}`;
      const normalised = normaliseKey(key);
      if (FORBIDDEN_KEYS.has(normalised)) {
        findings.push(`${label}: forbidden field "${key}" at ${here}`);
      } else if (normalised === 'salthex' && !isRevealedCard(record)) {
        findings.push(`${label}: "saltHex" at ${here} is not part of a RevealedCard proof`);
      }
      walk(entry, here, depth + 1);
    }
  };

  walk(value, '', 0);
  return findings;
}

/** Hole cards belong to the viewer, or to a seat that showed down after the hand ended. */
function visibleCardCheck(view: PlayerView, label: string): string[] {
  const findings: string[] = [];
  const complete = view.street === 'complete';
  for (const seat of view.seats) {
    if (seat.holeCards === null) continue;
    if (seat.isSelf) {
      if (seat.seat !== view.viewerSeat) {
        findings.push(`${label}: seat ${seat.seat} is isSelf but viewerSeat is ${String(view.viewerSeat)}`);
      }
      continue;
    }
    if (!complete) {
      findings.push(`${label}: seat ${seat.seat} exposed hole cards on street "${view.street}"`);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// chipLedger, as `sigterm-mid-hand` and `ws-disconnect-mid-hand` use it
// ---------------------------------------------------------------------------

describe('chip conservation across a whole hand, as the drills measure it', () => {
  it('keeps stacks plus commitments constant, and pays the pot back into the stacks', async () => {
    const table = await seatedTable();
    const samples: PlayerView[] = [];

    for (let guard = 0; guard <= 64; guard += 1) {
      const view = viewOf(table, ADA);
      samples.push(view);
      if (view.toAct === null) break;
      const actor = actorOf(view);
      const legal = new Set(viewOf(table, actor).legalActions.map((action) => action.type));
      const type = legal.has('check') ? 'check' : 'call';
      assert.ok(legal.has(type), `seat ${String(view.toAct)} may neither check nor call`);
      await table.submitAction(actor, {
        action: { type },
        actionId: `rr_${guard}_${String(view.actionSequence)}`,
        expectedSequence: view.actionSequence,
      });
    }

    assert.ok(samples.length > 4, `a checked-down hand produced only ${samples.length} views`);
    const final = samples.at(-1);
    assert.ok(final !== undefined && final.street === 'complete', 'the hand must reach a settled state');

    for (const view of samples) {
      assert.equal(
        chipsInPlay(view),
        BUY_IN * 2,
        `chips in play moved at ${view.street}/${view.actionSequence}: no hand may create or ` +
          'destroy a unit',
      );
    }

    // The pot the seats are playing for is exactly what they have committed, in EVERY view
    // including the settled one — where the commitments stand as the record of the pot that was
    // played for. `chipLedger` in `scripts/drills/invariants.mjs` asserts this on every frame a
    // client receives, so a change of convention here silently changes what that checker means.
    for (const view of samples) {
      const committed = view.seats.reduce((total, seat) => total + seat.committedTotal, 0);
      assert.equal(
        view.potTotal,
        committed,
        `potTotal and the seats' commitments disagree at ${view.street}`,
      );
    }

    // The asymmetry itself, stated so it cannot change without this failing: at settlement the
    // stacks alone hold every chip, and the commitments are still non-zero.
    const settledStacks = final.seats.reduce((total, seat) => total + seat.stack, 0);
    const settledCommitted = final.seats.reduce((total, seat) => total + seat.committedTotal, 0);
    assert.equal(settledStacks, BUY_IN * 2, 'a settled hand holds every chip in the stacks');
    assert.ok(
      settledCommitted > 0,
      'a settled hand still reports what each seat committed; the drills`` chipLedger depends on ' +
        'on this and would double-count the pot if it ever became zero',
    );

    const result = final.result;
    assert.ok(result !== null, 'a completed hand carries a result');
    const awarded = result.awards.reduce((total, award) => total + award.amount, 0);
    const potted = result.pots.reduce((total, pot) => total + pot.amount, 0);
    assert.equal(awarded, potted, 'every chip in every pot is awarded to somebody');
    const nets = final.seats.reduce((total, seat) => total + (result.netBySeat[seat.seat] ?? 0), 0);
    assert.equal(nets, 0, 'the nets of a settled hand sum to zero');
  });
});

// ---------------------------------------------------------------------------
// duplicate-actions and out-of-order-actions
// ---------------------------------------------------------------------------

describe('a duplicate submission, as `duplicate-actions` submits one', () => {
  it('applies once, answers deduplicated, and moves no chips the second time', async () => {
    const table = await seatedTable();
    const first = viewOf(table, ADA);
    const actor = actorOf(first);
    const before = viewOf(table, actor).seats.find((seat) => seat.playerId === actor)?.stack;
    assert.ok(before !== undefined);

    const submission = {
      action: { type: 'call' } as const,
      actionId: 'rr_duplicate_once',
      expectedSequence: first.actionSequence,
    };
    const applied = await table.submitAction(actor, submission);
    assert.equal(applied.deduplicated, false, 'the first submission is not a duplicate of anything');

    const afterFirst = viewOf(table, actor);
    const paidOnce = before - (afterFirst.seats.find((seat) => seat.playerId === actor)?.stack ?? 0);
    assert.ok(paidOnce > 0, 'a call at this table costs something, or this test proves nothing');

    // The retry, byte for byte. By now it is the other seat's turn, which is the whole point: the
    // memo is consulted BEFORE whose turn it is, so a client retrying after a dropped response
    // gets the original outcome rather than `not_your_turn`.
    const retry = await table.submitAction(actor, submission);
    assert.equal(retry.deduplicated, true, 'a repeated actionId must report itself as a duplicate');
    assert.equal(
      retry.appliedSequence,
      applied.appliedSequence,
      'the retry must report the sequence the original was applied at',
    );

    const afterRetry = viewOf(table, actor);
    const paidTwice = before - (afterRetry.seats.find((seat) => seat.playerId === actor)?.stack ?? 0);
    assert.equal(paidTwice, paidOnce, 'the retry moved chips, so the action was applied twice');
    assert.equal(chipsInPlay(afterRetry), BUY_IN * 2, 'a duplicate submission created or destroyed chips');
  });
});

describe('an out-of-order submission, as `out-of-order-actions` submits one', () => {
  it('is refused stale_action_sequence while it is still that seat`s turn, and changes nothing', async () => {
    const table = await seatedTable();
    // Act once so there is a sequence to be behind. The first decision of a hand is at sequence 0
    // and "one behind" is not expressible there.
    const opening = viewOf(table, ADA);
    await table.submitAction(actorOf(opening), {
      action: { type: 'call' },
      actionId: 'rr_stale_setup',
      expectedSequence: opening.actionSequence,
    });

    const current = viewOf(table, ADA);
    assert.ok(current.toAct !== null, 'the hand must still be live for this to mean anything');
    assert.ok(current.actionSequence > 0, 'the hand must have moved past its first decision');
    const actor = actorOf(current);
    const committedBefore = current.seats.reduce((total, seat) => total + seat.committedTotal, 0);

    for (const [label, sequence] of [
      ['a sequence the hand has left behind', current.actionSequence - 1],
      ['a sequence the hand has not reached', current.actionSequence + 3],
    ] as const) {
      await assert.rejects(
        table.submitAction(actor, {
          action: { type: 'fold' },
          actionId: `rr_stale_${sequence}`,
          expectedSequence: sequence,
        }),
        (error: unknown) => isAppError(error) && error.code === 'stale_action_sequence',
        `${label} must be refused stale_action_sequence, not applied and not mislabelled`,
      );
    }

    const after = viewOf(table, ADA);
    assert.equal(after.actionSequence, current.actionSequence, 'a refused submission advanced the hand');
    assert.notEqual(after.street, 'complete', 'a stale fold ended the hand');
    assert.equal(
      after.seats.reduce((total, seat) => total + seat.committedTotal, 0),
      committedBefore,
      'a refused submission moved chips into the pot',
    );
    assert.equal(chipsInPlay(after), BUY_IN * 2, 'a refused submission created or destroyed chips');
  });
});

// ---------------------------------------------------------------------------
// The hidden-information scan every drill runs over its transcript
// ---------------------------------------------------------------------------

describe('what each recipient may see, scanned the way the drills scan it', () => {
  it('never names a deck, a salt or a cursor, and shows no opponent cards before a showdown', async () => {
    const table = await seatedTable();
    const findings: string[] = [];
    let scanned = 0;

    for (let guard = 0; guard <= 64; guard += 1) {
      const view = viewOf(table, ADA);
      for (const [userId, name] of [
        [ADA, 'Ada'],
        [BO, 'Bo'],
      ] as const) {
        const recipient = viewOf(table, userId);
        scanned += 1;
        findings.push(...scanForSecrets(recipient, `${name} at ${recipient.street}`));
        findings.push(...visibleCardCheck(recipient, `${name} at ${recipient.street}`));
        // Each recipient sees exactly one pair of hole cards while the hand is live: their own.
        if (recipient.street !== 'complete') {
          const pairs = recipient.seats.filter((seat) => seat.holeCards !== null).length;
          assert.equal(pairs, 1, `${name} was shown ${pairs} pairs of hole cards mid-hand`);
        }
      }
      if (view.toAct === null) break;
      const actor = actorOf(view);
      const legal = new Set(viewOf(table, actor).legalActions.map((action) => action.type));
      const type = legal.has('check') ? 'check' : 'call';
      await table.submitAction(actor, {
        action: { type },
        actionId: `rr_leak_${guard}_${String(view.actionSequence)}`,
        expectedSequence: view.actionSequence,
      });
    }

    assert.ok(scanned > 12, `only ${scanned} views were scanned; this must not pass vacuously`);
    assert.deepEqual(findings, [], 'a recipient was sent something they must never receive');
  });

  it('publishes proofs only for cards that actually became public', async () => {
    const table = await seatedTable();
    for (let guard = 0; guard <= 64; guard += 1) {
      const view = viewOf(table, ADA);
      if (view.toAct === null) break;
      const actor = actorOf(view);
      const legal = new Set(viewOf(table, actor).legalActions.map((action) => action.type));
      await table.submitAction(actor, {
        action: { type: legal.has('check') ? 'check' : 'call' },
        actionId: `rr_reveal_${guard}_${String(view.actionSequence)}`,
        expectedSequence: view.actionSequence,
      });
    }

    const final = viewOf(table, ADA);
    const result = final.result;
    assert.ok(result !== null, 'a completed hand carries a result');
    const reveal = (result as unknown as { reveal?: { complete?: boolean; cards?: unknown[] } }).reveal;
    assert.ok(reveal !== undefined, 'a settled hand publishes a reveal for the cards that became public');
    assert.equal(reveal.complete, false, 'no ordinary hand may publish a COMPLETE deck reveal');

    const cards = reveal.cards ?? [];
    const permitted = final.board.length + result.showdowns.length * 2;
    assert.ok(
      cards.length <= permitted,
      `the reveal carries ${cards.length} proofs for ${permitted} public cards ` +
        `(${final.board.length} board + ${result.showdowns.length} showdown seats)`,
    );
    for (const entry of cards) {
      assert.ok(
        isRevealedCard(entry as Record<string, unknown>),
        'every published salt must travel inside a complete, checkable proof',
      );
    }
    assert.deepEqual(scanForSecrets(final, 'the settled view'), []);
  });
});

// ---------------------------------------------------------------------------
// The negative controls for the scanner above
// ---------------------------------------------------------------------------

describe('the leak scanner itself', () => {
  it('fires on a field a client must never receive', async () => {
    const table = await seatedTable();
    const view = viewOf(table, ADA) as unknown as Record<string, unknown>;
    // The real view with the engine's own secret spliced in — the exact shape a redaction bug
    // produces, since `DeckSecret` is `{ deck, salts }`.
    const leaked = { ...view, secretState: { deck: [1, 2, 3], salts: 'ff'.repeat(32) } };
    const findings = scanForSecrets(leaked, 'leaked view');
    assert.equal(findings.length, 2, `expected the deck and the salts to be found: ${findings.join(' | ')}`);
    assert.ok(findings.some((entry) => /"deck"/.test(entry)));
    assert.ok(findings.some((entry) => /"salts"/.test(entry)));
  });

  it('fires on a bare salt that is not part of a proof', () => {
    const findings = scanForSecrets({ result: { saltHex: 'ab'.repeat(32) } }, 'frame');
    assert.equal(findings.length, 1);
    assert.match(findings[0] ?? '', /RevealedCard/);
  });

  it('fires when an opponent`s cards appear mid-hand', async () => {
    const table = await seatedTable();
    const view = viewOf(table, ADA);
    const exposed: PlayerView = {
      ...view,
      street: 'flop',
      seats: view.seats.map((seat) =>
        seat.isSelf ? seat : { ...seat, holeCards: [0, 1] as unknown as (typeof seat)['holeCards'] },
      ),
    };
    const findings = visibleCardCheck(exposed, 'exposed view');
    assert.equal(findings.length, 1, `expected one exposure: ${findings.join(' | ')}`);
    assert.match(findings[0] ?? '', /exposed hole cards on street "flop"/);
  });
});
