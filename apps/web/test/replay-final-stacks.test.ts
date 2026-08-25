/**
 * The last frame of a replay shows the stacks the hand ACTUALLY ended on.
 *
 * ## The defect these exist for
 *
 * `buildHandReplay` walks the decision list and subtracts what each seat paid. That is the only
 * thing that ever touches `Tally.stack`, because a decision list records what was *paid* and never
 * what was *won* — so the terminal frame drew every seat at the moment before the pot moved. The
 * comment sitting directly above that frame said, and says, that it "is the only place the reader
 * sees the final stacks".
 *
 * ## Observed
 *
 * `/review/hand-0042`, walked to Step 11 of 11 in Chrome 151 through the page's own "Next decision"
 * button, with the API up:
 *
 *   - seat plate, the reader:    `You (you) STACK 245`
 *   - seat plate, the opponent:  `Quartile STACK 245`
 *   - `StepMetrics`:             `YOUR STACK 245 UNITS`
 *   - the same screen's head:    `NET TO YOU +765 units GAINED`
 *   - the same screen's result:  `You +765 units GAINED`
 *
 * The reader started the hand with 1,000 and won 765, and the frame whose job is to show what the
 * hand cost showed them 245 — the identical figure to the seat they had just beaten, because 245 is
 * what both of them had left after paying in and before either was paid out.
 *
 * `HandReviewSeat.net` is the server's own settled figure and is already on the wire (`ResultRow`
 * prints it), so the fix adds it rather than reconstructing an award. These assertions fail against
 * the code as it was: the first one read 245.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REVIEW_HAND_FOLDED, REVIEW_HAND_SHOWDOWN } from '../src/fixtures/review.ts';
import { buildHandReplay, type ReplayStep } from '../src/lib/hand-replay.ts';

/**
 * Explicitly annotated, and it has to be: `assert.ok` is an assertion function, and TypeScript
 * refuses to narrow a name it has to infer from the very call that narrows it (TS7022).
 */
const terminalStepOf = (review: Parameters<typeof buildHandReplay>[0]): ReplayStep | undefined =>
  buildHandReplay(review).steps.at(-1);

/** The stacks the frame actually draws, by seat. */
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
    // A hand with no `completedAt` was abandoned: nothing was settled, so `net` describes a
    // settlement that never happened and the walked stacks are the honest ones.
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
