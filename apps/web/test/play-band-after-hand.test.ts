/**
 * What a phone reader needs at the two moments the follow scroll leaves them in the decision band: the
 * clock and the latest action while sizing a bet, and the next deal and the review once the hand is over.
 * Measured at 390x844 before this: the plate's clock at y -227..-143, the street line under the header,
 * "Deal the next hand" at y -1,174..-879, and "Review this hand" only inside the collapsed sheet.
 * Both components import `@prl/ui`, which this runner cannot load, so the wiring is read from source and
 * each predicate is run against the text it replaced, where it must fail.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type DealNextInput, dealNextState } from '../src/lib/deal-next.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');
const stage = (): string => read('components', 'TableStage.tsx');
const live = (): string => read('app', 'play', 'LiveTable.tsx');

const SEATED: DealNextInput = {
  live: true,
  dealingIn: false,
  seated: true,
  betweenHands: true,
  outOfUnits: false,
};

describe('dealNextState, shared by the card and the band', () => {
  it('offers an enabled deal to a seated reader between hands', () => {
    assert.deepEqual(dealNextState(SEATED), { disabled: false });
  });

  it('offers it disabled while a hand runs, or with no units to play', () => {
    assert.deepEqual(dealNextState({ ...SEATED, betweenHands: false }), { disabled: true });
    assert.deepEqual(dealNextState({ ...SEATED, outOfUnits: true }), { disabled: true });
  });

  it('offers nothing off the socket, standing, or while "Deal me in" deals', () => {
    assert.equal(dealNextState({ ...SEATED, live: false }), null);
    assert.equal(dealNextState({ ...SEATED, seated: false }), null);
    assert.equal(dealNextState({ ...SEATED, dealingIn: true }), null);
  });
});

const bandDeals = (source: string): boolean => {
  const band = /function DecisionBand\([\s\S]*?\n\}\n/u.exec(source)?.[0] ?? '';
  return (
    /const offeringDeal = status === 'complete' && dealNext !== undefined;/u.test(band) &&
    /idleAction: \(\s*<Button variant="primary" onClick=\{dealNext\.onDeal\} disabled=\{dealNext\.disabled\}>\s*Deal the next hand\s*<\/Button>/u.test(
      band,
    )
  );
};

const bothFromOneState = (source: string): boolean =>
  /\{deal === null \? null : \(\s*<Button variant="primary" onClick=\{live\.deal\} disabled=\{deal\.disabled\}>\s*Deal the next hand/u.test(
    source,
  ) &&
  /\{\.\.\.\(deal === null \? \{\} : \{ dealNext: \{ onDeal: live\.deal, disabled: deal\.disabled \} \}\)\}/u.test(
    source,
  );

const rescuesFocus = (source: string): boolean =>
  /const dealt = wasOfferingDeal\.current && !offeringDeal;/u.test(source) &&
  /querySelector<HTMLElement>\('\.prl-action-bar__idle'\)/u.test(source) &&
  /target\?\.focus\(\{ preventScroll: true \}\);/u.test(source);

describe('"Deal the next hand" is in the band once the hand is complete', () => {
  it('is drawn by the band, with the card’s action and disabled state', () => {
    assert.ok(bandDeals(stage()), 'DecisionBand does not draw the deal once the hand is complete');
  });

  it('takes both copies from one state, so the card and the band cannot disagree', () => {
    assert.ok(bothFromOneState(live()), 'LiveTable no longer derives both controls from dealNextOf');
  });

  it('puts the caret back in the band when the press deals and the control unmounts', () => {
    assert.ok(rescuesFocus(stage()), 'the band has no rescue for its own unmounting Deal');
  });
});

const reviewInCard = (source: string): boolean => {
  const card =
    /<Callout tone="insight" title="How the hand ended">([\s\S]*?)<\/Callout>/u.exec(source)?.[1] ?? '';
  return card.includes('<Link href={reviewHref}>Review this hand</Link>');
};

describe('the result card links to the review it recommends', () => {
  it('carries "Review this hand" when there is a review to open', () => {
    assert.ok(reviewInCard(stage()), 'the "How the hand ended" card has no review link');
    assert.match(stage(), /reviewHref=\{props\.reviewHref\}\s*\/>\s*<DecisionBand/u);
  });
});

const glanceHasNow = (source: string): boolean => {
  const body = /function handGlanceFor\([\s\S]*?\n\}\n/u.exec(source)?.[0] ?? '';
  return (
    /clock=\{hero\?\.isToAct === true \? turn : null\}/u.test(body) &&
    /latest=\{latestAction\(streetSummary\(view, seatNames\)\)\}/u.test(body)
  );
};

describe('the glance above the sizer carries the clock and the latest action', () => {
  it('hands the reader’s own clock and the newest phrase to HandGlance', () => {
    assert.ok(glanceHasNow(stage()), 'handGlanceFor draws the cards without the clock or the latest action');
    assert.match(stage(), /context=\{handGlanceFor\(view, turn, seatNames\)\}/u);
  });
});

describe('NEGATIVE CONTROLS: each predicate fails the code it replaced', () => {
  it('the band before, which drew no deal', () => {
    const old = `function DecisionBand(props: DecisionBandProps): ReactElement {
  const pending = submission !== null && SUBMISSION_IN_FLIGHT.has(submission.status);
  return (
    <div className="prl-play__decision">
      {props.notice}
    </div>
  );
}
`;
    assert.equal(bandDeals(old), false);
    assert.equal(rescuesFocus(old), false);
  });

  it('the card before, whose deal was gated inline', () => {
    const old = `        {manual && seated ? (
          <Button variant="primary" onClick={live.deal} disabled={!table.betweenHands || live.outOfUnits}>
            Deal the next hand
          </Button>
        ) : null}`;
    assert.equal(bothFromOneState(old), false);
  });

  it('the result card before, which named the review and did not link it', () => {
    const old = `        <Callout tone="insight" title="How the hand ended">
          <p className="prl-play__summary-note">
            The result of one hand says almost nothing about the decision that produced it. The hand’s review,
            which prices each decision in it, is where the useful feedback is.
          </p>
        </Callout>`;
    assert.equal(reviewInCard(old), false);
  });

  it('the glance before, which drew only the cards', () => {
    const old = `function handGlanceFor(view: PlayerView): ReactElement | null {
  const hole = view.seats.find((seat) => seat.isSelf)?.holeCards ?? null;
  if (hole === null) return null;
  return <HandGlance hole={hole} board={view.board} />;
}
`;
    assert.equal(glanceHasNow(old), false);
  });
});
