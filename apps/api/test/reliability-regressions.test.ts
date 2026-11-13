/**
 * Properties `pnpm run test:drills` proves by breaking a running server, pinned here so `pnpm test`
 * checks them too. They cover the chip ledger's settled-view convention, duplicate and stale submissions, and
 * that no recipient's view names a deck, salt, cursor or unshown opponent card. No process, socket
 * or database. The leak scanner mirrors `scripts/drills/invariants.mjs` because `rootDir` forbids
 * importing it, and `scripts/reliability-drills.test.mjs` owns the canonical key list.
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

/** The real CSPRNG, because every property here must hold for every legal deal. */
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

function actorOf(view: PlayerView): string {
  const actor = view.seats.find((seat) => seat.seat === view.toAct)?.playerId;
  assert.ok(actor !== undefined, `seat ${String(view.toAct)} is to act but holds no player`);
  return actor;
}

function chipsInPlay(view: PlayerView): number {
  const stacks = view.seats.reduce((total, seat) => total + seat.stack, 0);
  const committed = view.seats.reduce((total, seat) => total + seat.committedTotal, 0);
  // At `complete` the pot is paid into the stacks and commitments remain as the record, so adding
  // them would count the pot twice. The drills' `chipLedger` encodes the same.
  return view.street === 'complete' ? stacks : stacks + committed;
}

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

/** A revealed position carries its salt. A `saltHex` with no `index`/`card`/`proof` beside it is a leak. */
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

    // `chipLedger` asserts this on every frame, so a change of convention changes what it means.
    for (const view of samples) {
      const committed = view.seats.reduce((total, seat) => total + seat.committedTotal, 0);
      assert.equal(
        view.potTotal,
        committed,
        `potTotal and the seats' commitments disagree at ${view.street}`,
      );
    }

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

    // It is now the other seat's turn. The memo is consulted before turn order, so the retry gets
    // the original outcome rather than `not_your_turn`.
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
    // The first decision is at sequence 0, where "one behind" is not expressible.
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

describe('the leak scanner itself', () => {
  it('fires on a field a client must never receive', async () => {
    const table = await seatedTable();
    const view = viewOf(table, ADA) as unknown as Record<string, unknown>;
    // `DeckSecret` is `{ deck, salts }`, so this is the shape a redaction bug produces.
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
