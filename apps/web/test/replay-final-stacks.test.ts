/**
 * The last frame of a replay shows the stacks the hand ACTUALLY ended on. A decision list records
 * what was paid and never what was won, so the walked stacks stop before the pot moves (on
 * `/review/hand-0042` both seats showed 245 after a +765 win). `HandReviewSeat.net` is the server's
 * settled figure, so the fix adds it rather than reconstructing an award.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REVIEW_HAND_FOLDED, REVIEW_HAND_SHOWDOWN } from '../src/fixtures/review.ts';
import { buildHandReplay, type ReplayStep } from '../src/lib/hand-replay.ts';

/** Annotated because TypeScript will not narrow a name inferred from the call that narrows it (TS7022). */
const terminalStepOf = (review: Parameters<typeof buildHandReplay>[0]): ReplayStep | undefined =>
  buildHandReplay(review).steps.at(-1);

const stacksBySeat = (step: ReplayStep): ReadonlyMap<number, number> =>
  new Map(step.view.seats.map((seat) => [seat.seat, seat.stack]));

describe('the terminal replay frame', () => {
  it('shows every seat the stack it finished the hand with, not the one it had before the pot moved', () => {
    const review = REVIEW_HAND_SHOWDOWN;
    const terminal: ReplayStep | undefined = terminalStepOf(review);
    assert.ok(terminal !== undefined, 'a replay has at least one step');
    assert.equal(terminal.view.street, 'complete');

    const drawn = stacksBySeat(terminal);
    for (const settled of review.seats) {
      assert.equal(
        drawn.get(settled.seat),
        settled.startingStack + settled.net,
        `seat ${String(settled.seat)} finished on ${String(settled.startingStack + settled.net)}`,
      );
    }
  });

  it('does not show the winner and the loser holding the same stack', () => {
    const review = REVIEW_HAND_SHOWDOWN;
    const terminal: ReplayStep | undefined = terminalStepOf(review);
    assert.ok(terminal !== undefined);
    const winner = review.seats.reduce((best, seat) => (seat.net > best.net ? seat : best));
    const loser = review.seats.reduce((worst, seat) => (seat.net < worst.net ? seat : worst));
    const drawn = stacksBySeat(terminal);
    const drawnWinner = drawn.get(winner.seat);
    const drawnLoser = drawn.get(loser.seat);
    assert.notEqual(
      drawnWinner,
      drawnLoser,
      'the seat that won the pot and the seat that paid for it cannot end on the same stack',
    );
    assert.ok(
      (drawnWinner ?? 0) > winner.startingStack,
      'a seat with a positive net finishes above where it started',
    );
  });

  it('does the same for a hand that ended on a fold', () => {
    const review = REVIEW_HAND_FOLDED;
    const terminal: ReplayStep | undefined = terminalStepOf(review);
    assert.ok(terminal !== undefined);
    const drawn = stacksBySeat(terminal);
    for (const settled of review.seats) {
      assert.equal(drawn.get(settled.seat), settled.startingStack + settled.net);
    }
  });

  it('leaves an unfinished hand alone, because there is no award to add', () => {
    // No `completedAt` means abandoned, so `net` describes a settlement that never happened.
    const review = {
      ...REVIEW_HAND_SHOWDOWN,
      hand: { ...REVIEW_HAND_SHOWDOWN.hand, completedAt: null },
    };
    const terminal: ReplayStep | undefined = terminalStepOf(review);
    assert.ok(terminal !== undefined);
    assert.notEqual(terminal.view.street, 'complete');
    const hero = REVIEW_HAND_SHOWDOWN.seats.reduce((best, seat) => (seat.net > best.net ? seat : best));
    assert.notEqual(stacksBySeat(terminal).get(hero.seat), hero.startingStack + hero.net);
  });
});
