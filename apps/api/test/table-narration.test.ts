import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSecureRandom, type LoggedAction, type PotAward } from '@prl/poker-engine';
import {
  actionSentence,
  awardSentence,
  forcedBetsSentence,
  namesFrom,
  showdownSentence,
} from '../src/rooms/narration.ts';
import { LiveTable, type TableEvent } from '../src/rooms/table.ts';
import { systemClock } from '../src/rooms/timers.ts';

const nameOf = namesFrom(
  new Map([
    [0, 'Ada'],
    [3, 'Nit bot'],
  ]),
);

function logged(seat: number, action: LoggedAction['action'], amountPaid = 0): LoggedAction {
  return {
    sequence: 1,
    street: 'preflop',
    seat,
    playerId: `usr_${seat}`,
    action,
    amountPaid,
    betLevelAfter: 0,
    potAfter: 0,
    wasAutomatic: false,
  } as LoggedAction;
}

function award(seat: number, potIndex: number, amount: number, wasSplit = false): PotAward {
  return { potIndex, amount, seat, playerId: `usr_${seat}`, wasSplit, oddChips: 0 };
}

describe('the narration names who did it', () => {
  it('puts the player in front of every action (REGRESSION: a bare "folds")', () => {
    assert.equal(actionSentence(logged(3, { type: 'fold' }), nameOf), 'Nit bot folds');
    assert.equal(actionSentence(logged(0, { type: 'call' }, 10), nameOf), 'Ada calls 10');
    assert.equal(actionSentence(logged(0, { type: 'raise', to: 40 }), nameOf), 'Ada raises to 40');
  });

  it('counts an unnamed seat from one, never from zero', () => {
    assert.equal(actionSentence(logged(1, { type: 'check' }), nameOf), 'Seat 2 checks');
  });

  it('says the blinds in words, with who posted them', () => {
    assert.equal(
      forcedBetsSentence(
        [
          { kind: 'smallBlind', seat: 3, amount: 5, wasShort: false },
          { kind: 'bigBlind', seat: 0, amount: 8, wasShort: true },
        ],
        nameOf,
      ),
      'Nit bot posts the small blind, 5. Ada posts the big blind, 8, which is all they had.',
    );
    assert.equal(forcedBetsSentence([], nameOf), 'No forced bets.');
  });

  it('names a pot by what it is, not by its index (REGRESSION: "from pot 0")', () => {
    assert.equal(awardSentence(award(3, 0, 35), 1, nameOf), 'Nit bot wins 35 from the pot.');
    assert.equal(awardSentence(award(0, 0, 905), 2, nameOf), 'Ada wins 905 from the main pot.');
    assert.equal(
      awardSentence(award(3, 1, 600, true), 2, nameOf),
      'Nit bot wins 600 from side pot 1, split.',
    );
  });

  // Audit at 308fadf, from the socket log: "Patient Technician 1 wins 1529 from the pot." and
  // "Disciplined Specialist wins 1975 from the main pot." under a table whose plates say "1,529".
  it('groups an amount of four figures or more, in every sentence that carries one (REGRESSION)', () => {
    assert.equal(awardSentence(award(3, 0, 1_529), 1, nameOf), 'Nit bot wins 1,529 from the pot.');
    assert.equal(awardSentence(award(0, 0, 1_975), 2, nameOf), 'Ada wins 1,975 from the main pot.');
    assert.equal(actionSentence(logged(0, { type: 'call' }, 1_200), nameOf), 'Ada calls 1,200');
    assert.equal(actionSentence(logged(0, { type: 'bet', to: 2_500 }), nameOf), 'Ada bets to 2,500');
    assert.equal(
      actionSentence(logged(3, { type: 'raise', to: 10_000 }), nameOf),
      'Nit bot raises to 10,000',
    );
    assert.equal(
      forcedBetsSentence([{ kind: 'bigBlind', seat: 0, amount: 1_000, wasShort: false }], nameOf),
      'Ada posts the big blind, 1,000.',
    );
  });

  it('names who showed down', () => {
    const shown = { seat: 0, playerId: 'usr_0', description: 'a flush, ace high' };
    assert.equal(
      showdownSentence(shown as Parameters<typeof showdownSentence>[0], nameOf),
      'Ada shows a flush, ace high.',
    );
  });
});

describe('a live table narrates with the names it dealt in', () => {
  it('names the blinds, every action and the winner, and no zero-based seat', async () => {
    const table = new LiveTable({
      roomId: 'room_narration',
      config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 },
      clock: systemClock,
      random: createSecureRandom(),
      nextHandId: () => 'hand_narration',
    });
    const events: TableEvent[] = [];
    table.subscribe((notice) => events.push(...notice.events));
    // Seats 0 and 3: a gap, so a zero-based number and a one-based one cannot coincide.
    await table.sit({ userId: 'usr_ada', displayName: 'Ada', seat: 0, stack: 1_000 });
    await table.sit({ userId: 'usr_bo', displayName: 'Bo', seat: 3, stack: 1_000 });
    await table.startHand();

    for (let step = 0; step < 8; step += 1) {
      const view = table.viewFor('usr_ada');
      if (view === null || view.toAct === null) break;
      const actor = view.seats.find((seat) => seat.seat === view.toAct)?.playerId;
      assert.ok(actor !== undefined);
      await table.submitAction(actor, {
        action: { type: 'fold' },
        actionId: `act_${String(step)}`,
        expectedSequence: view.actionSequence,
      });
    }
    table.close();

    const sentences = events.flatMap((event) => {
      if (event.kind === 'forcedBets') return [event.detail];
      if (event.kind === 'action') return [event.description];
      if (event.kind === 'handComplete' || event.kind === 'showdown') return [...event.summaries];
      return [];
    });
    assert.ok(sentences.length >= 3, `a sweep of nothing is not a pass: ${JSON.stringify(sentences)}`);
    for (const sentence of sentences) {
      assert.match(sentence, /^(Ada|Bo) /, `"${sentence}" says who`);
      assert.doesNotMatch(sentence, /seat \d|pot \d/i, `"${sentence}" numbers a seat or a pot`);
    }
    assert.ok(
      events.some((event) => event.kind === 'action'),
      'the hand was played, so it narrated at least one action',
    );
  });
});
