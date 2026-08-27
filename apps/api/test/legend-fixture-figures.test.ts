/**
 * The Legends fixture's expected values are the ones the shared model produces.
 *
 * ## The defect this closes
 *
 * `apps/web/src/fixtures/legends.ts` carried hand-authored EV figures with prose derivations
 * beside them and no generator anywhere. None of the raises reproduced. From the fixture's own
 * stated premises the two preflop raises are worth 28.7 and 34.7 units and the file said 12.4 and
 * 11.6; the flop bet table was out by roughly a factor of seven on every row; and the compare block
 * was not internally consistent under any single convention — its call row priced the pot at 210
 * while its raise row spoke of "the 390 already committed", which are the before-call and
 * after-call pots of the same spot.
 *
 * They erred conservatively, understating raises, which is the opposite direction from the Coach
 * defect this release fixed. That makes them not urgent and it does not make them teachable. A
 * worked example that does not survive its own arithmetic teaches a learner to stop checking, and
 * checking is the entire subject.
 *
 * The fixture now computes its figures from `evOfCall`, `evOfBet` and `evOfRaise`. This file is the
 * independent check on that: it re-derives every candidate from the pot, price, equity and assumed
 * fold frequency the fixture PUBLISHES — the numbers a reader can see on screen — rather than from
 * the constants the fixture happens to hold. A figure that agreed with the model but disagreed with
 * its own printed premises would still be untrustworthy, and this is the comparison that catches it.
 *
 * ## Why an API test reads web files
 *
 * `apps/web` is a separate TypeScript program that cannot be imported statically from here, so the
 * fixture is loaded by URL and narrowed explicitly — the same arrangement `web-fixture-figures.test.ts`
 * and `legends-naming-fallback.test.ts` use. `@prl/poker-ai` is available here and deliberately not
 * in `apps/web`, which is why the decision-quality bands are asserted from this side.
 */

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  ActionCandidate,
  CoachReport,
  CompareProfilesResponse,
  DecisionQuality,
  HandComparison,
  LegendProfileCardDto,
} from '@prl/contracts';
import { MAX_COMPARE_TRIALS } from '@prl/contracts';
import { bandForShortfall, outcomeVersusQualityNote, PROFILES } from '@prl/poker-ai';
import { evOfBet, evOfCall, evOfRaise } from '@prl/poker-math';

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'web',
  'src',
  'fixtures',
  'legends.ts',
);

const module: Record<string, unknown> = (await import(pathToFileURL(FIXTURE).href)) as Record<
  string,
  unknown
>;

function exported<T>(name: string): T {
  const value = module[name];
  assert.ok(value !== undefined, `${name} is not exported from the legends fixture`);
  return value as T;
}

const HAND = exported<HandComparison>('HAND_COMPARISON_FIXTURE');
const BIG_BLIND = exported<number>('HAND_COMPARISON_BIG_BLIND');
const COMPARE = exported<CompareProfilesResponse>('COMPARE_FIXTURE');
const PROFILE_CARDS = exported<readonly LegendProfileCardDto[]>('LEGEND_PROFILE_FIXTURES');
const learnFromFixture = exported<(id: string) => { readonly observed: unknown } | null>('learnFromFixture');

/**
 * The EV of one candidate, from the report's own published premises.
 *
 * The three conventions come from `@prl/poker-math/ev` and none of them is restated here. What IS
 * decided here is which of the three a candidate takes and what to feed it, and that mapping is the
 * part the old figures got wrong:
 *
 *  - **`pot` is `report.potTotal`**, the middle BEFORE the action, already including the bet being
 *    faced. It is what a fold wins. The compare block's raise row used the pot a CALL would have
 *    created, which is `potTotal + toCall` and a different number.
 *  - **A raise's increment is `cost - toCall`, not `to - toCall`.** `to` is the seat's total
 *    commitment for the street; `cost` is what leaves the stack now. They differ by whatever was
 *    already committed, which is zero in most spots and is the small blind preflop.
 *  - **The risk is `cost`**, so `evOfRaise` is charged `toCall + raiseBy`. A model that charges only
 *    the increment overstates every raise by `(1 - f) x toCall x (1 - e)`.
 */
function recompute(report: CoachReport, candidate: ActionCandidate): number {
  const pot = report.potTotal;
  const equity = candidate.potShareIfCalled ?? report.equity.heroEquity;
  switch (candidate.action) {
    case 'fold':
      return 0;
    case 'check':
      // A check is a call of nothing: `e x pot`, a free showdown.
      return evOfCall({ pot, toCall: 0, equity }).ev;
    case 'call':
      return evOfCall({ pot, toCall: report.toCall, equity }).ev;
    case 'bet': {
      assert.equal(report.toCall, 0, 'a bet is only legal with nothing to call');
      const fold = candidate.foldEquityAssumed;
      assert.ok(fold !== undefined, 'a bet without a stated fold frequency cannot be priced');
      return evOfBet({ pot, betSize: candidate.cost, foldProbability: fold, equityWhenCalled: equity }).ev;
    }
    case 'raise': {
      const fold = candidate.foldEquityAssumed;
      assert.ok(fold !== undefined, 'a raise without a stated fold frequency cannot be priced');
      return evOfRaise({
        pot,
        toCall: report.toCall,
        raiseBy: candidate.cost - report.toCall,
        foldProbability: fold,
        equityWhenCalled: equity,
      }).ev;
    }
    default:
      throw new Error(`no pricing convention for "${candidate.action}"`);
  }
}

/** Every analysis the fixture publishes, named so a failure says which block is wrong. */
function analyses(): readonly { readonly name: string; readonly report: CoachReport }[] {
  const found: { name: string; report: CoachReport }[] = [];
  for (const decision of HAND.decisions) {
    if (decision.analysis !== null) {
      found.push({
        name: `hand decision ${decision.sequence} (${decision.street})`,
        report: decision.analysis,
      });
    }
  }
  found.push({ name: 'the compare spot', report: COMPARE.analysis });
  return found;
}

describe('the Legends fixture prices every action the way @prl/poker-math does', () => {
  for (const { name, report } of analyses()) {
    it(`${name} reproduces from its own published premises`, () => {
      assert.ok(report.candidates.length > 0);
      for (const candidate of report.candidates) {
        const expected = recompute(report, candidate);
        assert.ok(
          Math.abs(candidate.ev - expected) < 1e-9,
          `${name}: ${candidate.action}${candidate.to === undefined ? '' : ` to ${candidate.to}`} ` +
            `stores ${candidate.ev.toFixed(4)} and prices at ${expected.toFixed(4)}`,
        );
      }
    });

    it(`${name} quotes its own figures in its derivations`, () => {
      // Every derivation states the figure it derived. A prose block that names a different number
      // from the row it sits in is what this whole rewrite is correcting, and it is the half a
      // numeric assertion cannot see.
      for (const candidate of report.candidates) {
        if (candidate.action === 'fold') continue;
        const stated = candidate.ev.toFixed(1).replace('-', '');
        assert.ok(
          candidate.derivation.includes(stated),
          `${name}: the ${candidate.action} derivation does not quote ${stated}: ${candidate.derivation}`,
        );
      }
    });
  }

  it('the suggested size range contains the best-priced action', () => {
    for (const { name, report } of analyses()) {
      const range = report.suggestion.sizeRange;
      if (range === undefined) continue;
      const best = [...report.candidates].sort((left, right) => right.ev - left.ev)[0];
      assert.ok(best !== undefined);
      if (best.to === undefined) continue;
      assert.ok(
        best.to >= range.min && best.to <= range.max,
        `${name}: the range ${range.min}–${range.max} excludes ${best.to}, which is the best-priced size`,
      );
    }
  });
});

describe('the Legends fixture bands its decisions the way @prl/poker-ai does', () => {
  it('scores each decision against the best row the analysis priced', () => {
    for (const decision of HAND.decisions) {
      const quality: DecisionQuality | null = decision.userDecisionQuality;
      if (quality === null || decision.analysis === null) continue;
      const best = Math.max(...decision.analysis.candidates.map((candidate) => candidate.ev));
      assert.ok(
        Math.abs(quality.bestAvailableEv - best) < 1e-9,
        `decision ${decision.sequence}: best available is ${best}, stored ${quality.bestAvailableEv}`,
      );
      assert.ok(Math.abs(quality.evGivenUp - (quality.chosenEv - quality.bestAvailableEv)) < 1e-9);
      assert.equal(
        quality.band,
        bandForShortfall(Math.max(0, -quality.evGivenUp) / BIG_BLIND),
        `decision ${decision.sequence} is in the wrong band for its own shortfall`,
      );
    }
  });

  it('bands the hand, and lets that decide whether the outcome note exists', () => {
    const quality = HAND.decisionQuality;
    assert.equal(quality.band, bandForShortfall(Math.max(0, -quality.evGivenUp) / BIG_BLIND));
    // The note is reserved for a result and a quality in CLEAR disagreement — `slightly-off` returns
    // null on purpose, so the paragraph does not become wallpaper. Keeping an authored note over a
    // band that no longer earns it would be teaching text contradicting the table above it, which is
    // exactly the failure this file exists to prevent.
    assert.equal(
      HAND.outcomeVersusQualityNote,
      outcomeVersusQualityNote({ chipResult: HAND.chipResult, quality }),
    );
  });

  it('sums the per-decision figures into the hand-level ones', () => {
    let best = 0;
    let chosen = 0;
    for (const decision of HAND.decisions) {
      const quality = decision.userDecisionQuality;
      if (quality === null) continue;
      best += quality.bestAvailableEv;
      chosen += quality.chosenEv;
    }
    assert.ok(Math.abs(HAND.decisionQuality.bestAvailableEv - best) < 1e-9);
    assert.ok(Math.abs(HAND.decisionQuality.chosenEv - chosen) < 1e-9);
  });
});

describe('the Legends fixture is a fixture, not a measurement', () => {
  it('offers every profile the server offers', () => {
    assert.deepEqual(
      PROFILE_CARDS.map((card) => card.id),
      PROFILES.map((profile) => profile.naming.id),
      'the offline roster and the served roster are the same set, in the same order',
    );
  });

  it('carries the SAME trait numbers the served profiles do (REGRESSION)', () => {
    // The fixture does not derive these — it copies them. `OLD_SCHOOL_PRESSURE_TRAITS` in
    // `apps/web/src/fixtures/legends.ts` is `old-school-pressure`'s trait block from
    // `packages/poker-ai/src/profiles.ts`, digit for digit, and eleven more like it: measured
    // 2026-08-27, 110 twelve-line blocks are byte-identical between the two files.
    //
    // Nothing joined the numbers. The check above pairs the two rosters by `id` and stops there, so
    // tuning a profile — raising `pressureTendency` from 0.8, widening a `vpip` — left `/legends`
    // describing the old one. A learner would read a radar chart and a trait description for a
    // style the bot no longer plays, which is the same defect as the Coach sentence that priced a
    // threshold that did not exist: the page teaches something the product does not do.
    //
    // Compared over the keys the FIXTURE declares rather than the profile's full set: `makeTraits`
    // fills unspecified axes from `DEFAULT_TRAITS`, so a profile always has every key and the
    // fixture is the side that can silently omit one. The count is asserted so that a fixture which
    // stopped declaring traits could not pass this by comparing nothing.
    let compared = 0;
    for (const card of PROFILE_CARDS) {
      const profile = PROFILES.find((candidate) => candidate.naming.id === card.id);
      assert.ok(profile !== undefined, `${card.id} is in the fixture and not in PROFILES`);
      const keys = Object.keys(card.traits) as (keyof typeof profile.traits)[];
      assert.ok(keys.length >= 12, `${card.id} declares only ${keys.length} traits in the fixture`);
      for (const key of keys) {
        assert.equal(
          card.traits[key as keyof typeof card.traits],
          profile.traits[key],
          `${card.id}.${String(key)}: the fixture says ` +
            `${String(card.traits[key as keyof typeof card.traits])} and @prl/poker-ai says ` +
            `${String(profile.traits[key])}`,
        );
        compared += 1;
      }
    }
    assert.ok(
      compared >= 150,
      `only ${compared} trait value(s) were compared across ${PROFILE_CARDS.length} profile(s); ` +
        'a pass over an empty comparison is the failure this assertion rules out',
    );
  });

  it('never claims to have observed anything', () => {
    // A fixture has observed nothing by definition. This shipped as a `ProfileObservedStats` of 128
    // invented hands under the caption "Measured over 128 hands of your own play".
    for (const card of PROFILE_CARDS) {
      const learn = learnFromFixture(card.id);
      assert.ok(learn !== null, `${card.id} has a card but no learn-from payload`);
      assert.equal(learn.observed, null, `${card.id} offers observed statistics it cannot have`);
    }
  });

  it('asks for a trial count the endpoint will actually run', () => {
    assert.equal(COMPARE.trials, MAX_COMPARE_TRIALS);
    for (const entry of COMPARE.entries) {
      const total = entry.actionDistribution.reduce((sum, row) => sum + row.probability, 0);
      assert.ok(Math.abs(total - 1) < 1e-9, `${entry.profileId}'s weights do not sum to 1`);
      for (const row of entry.actionDistribution) {
        // A frequency measured over N trials is a multiple of 1/N. A weight that is not one is
        // claiming a resolution the sample does not have.
        const trials = row.probability * COMPARE.trials;
        assert.ok(
          Math.abs(trials - Math.round(trials)) < 1e-9,
          `${entry.profileId}: ${row.action} at ${row.probability} is not a whole number of ${COMPARE.trials} trials`,
        );
      }
    }
  });
});

describe('the web client and the API agree on the compare limit', () => {
  it('publishes the same maximum the endpoint enforces', async () => {
    // `apps/api/src/rooms/bots.ts` is the authority: the schema and the clamp are built from it.
    // The contract carries a copy so a client can compile against it, and the compare screen asked
    // for 400 against a cap of 40 — every request it could have made was rejected before it reached
    // a handler, behind a CSRF failure that hid it.
    const bots: Record<string, unknown> = await import('../src/rooms/bots.ts');
    assert.equal(bots['MAX_COMPARE_TRIALS'], MAX_COMPARE_TRIALS);
  });
});
