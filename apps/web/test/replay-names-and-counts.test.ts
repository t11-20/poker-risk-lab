/**
 * A hand replay says one thing about the reader, one count of decisions, and a result in words. The
 * fixtures already name the reader "You", so the cases give the reader the API's guest name, as a live
 * hand does. The components cannot load under `node --test`, so their wiring is held to source.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { HandReviewResponse } from '@prl/contracts';
import { REVIEW_HAND_FOLDED, REVIEW_HAND_SHOWDOWN } from '../src/fixtures/review.ts';
import { buildHandReplay } from '../src/lib/hand-replay.ts';
import { netWord } from '../src/lib/net-words.ts';
import { decisionCount, stepCounter } from '../src/lib/replay-steps.ts';

const read = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

/** A fixture hand as the API serves a live one: the reader under a guest name, not "You". */
function asLive(review: HandReviewResponse): HandReviewResponse {
  return {
    ...review,
    seats: review.seats.map((seat) =>
      seat.displayName === 'You' ? { ...seat, displayName: 'Guest 7E37B1' } : seat,
    ),
  };
}

describe('the reader is "You" everywhere in a replay', () => {
  it('names the reader’s own seat "You", whatever the API called it (REGRESSION)', () => {
    for (const review of [REVIEW_HAND_SHOWDOWN, REVIEW_HAND_FOLDED]) {
      const live = asLive(review);
      assert.ok(
        live.seats.some((seat) => seat.displayName === 'Guest 7E37B1'),
        'the fixture no longer names its reader "You"; this case needs a new way to find the reader',
      );
      const replay = buildHandReplay(live);
      assert.notEqual(replay.viewerSeat, null);
      assert.equal(replay.seatNames[replay.viewerSeat ?? -1], 'You');
      for (const seat of live.seats) {
        if (seat.seat !== replay.viewerSeat) assert.equal(replay.seatNames[seat.seat], seat.displayName);
      }
    }
  });

  it('takes the result panel’s names from the replay, not from the payload', () => {
    const replay = read('components/HandReplay.tsx');
    assert.match(replay, /name=\{replay\.seatNames\[seat\.seat\] \?\? seat\.displayName\}/u);
    assert.doesNotMatch(replay, /<ResultRow[^>]*name=\{seat\.displayName\}/u);
  });
});

describe('the summary and the transport count decisions the same way', () => {
  for (const [name, review] of [
    ['showdown', REVIEW_HAND_SHOWDOWN],
    ['folded', REVIEW_HAND_FOLDED],
  ] as const) {
    it(`agree on the ${name} fixture, and the terminal frame is not numbered (REGRESSION)`, () => {
      const replay = buildHandReplay(review);
      const count = decisionCount(replay);
      assert.ok(count > 1, `only ${count} decision(s); a sweep of nothing is not a pass`);
      assert.equal(count, review.decisions.length);
      const last = replay.steps.at(-1);
      assert.ok(
        last !== undefined && last.decision === null,
        'the replay no longer ends on a terminal frame',
      );
      assert.deepEqual(stepCounter(last, replay), { label: 'Result', value: 'Settled' });
      for (const step of replay.steps.slice(0, -1)) {
        assert.deepEqual(stepCounter(step, replay), {
          label: 'Decision',
          value: `${step.index + 1} / ${count}`,
        });
      }
    });
  }

  it('is what the page and the transport print', () => {
    const page = read('app/review/[handId]/page.tsx');
    assert.match(page, /\{String\(decisionCount\(replay\)\)\}/u);
    assert.doesNotMatch(page, /String\(review\.decisions\.length\)/u);
    const component = read('components/HandReplay.tsx');
    assert.match(component, /const counter = stepCounter\(step, replay\);/u);
    assert.match(component, /\{counter\.label\}[\s\S]{0,120}\{counter\.value\}/u);
    // The announced sentence is unchanged on purpose: J6 in scripts/ax-assertions.mjs holds it.
    assert.match(component, /`Step \$\{step\.index \+ 1\} of \$\{total\}\. /u);
  });
});

describe('a net of zero is said in words', () => {
  it('reads "broke even", and the other two signs are unchanged (REGRESSION)', () => {
    assert.equal(netWord(0), 'broke even');
    assert.equal(netWord(120), 'gained');
    assert.equal(netWord(-40), 'lost');
  });

  it('is the one definition the hand list, the summary and the result panel use', () => {
    for (const path of ['app/review/page.tsx', 'app/review/[handId]/page.tsx', 'components/HandReplay.tsx']) {
      const source = read(path);
      assert.match(source, /\{netWord\(net\)\}/u, path);
      assert.doesNotMatch(source, /: 'level'/u, `${path} still writes its own word for zero`);
    }
  });
});
