/**
 * The Lab must not offer an action the Coach refuses to price.
 *
 * ## The failure this is written against
 *
 * Two producers decide what hero may do, from the same scenario, and nothing joined them.
 * `heroLegalActions` in `src/lib/scenario-view.ts` fills the ActionBar; `deriveLegalActions` in
 * `@prl/poker-math` decides which candidates the Coach prices. They disagreed.
 *
 * The Lab's raise gate read `ceiling > heroCommitted + min(owed, hero.stack)` under a comment
 * saying "aggression needs chips behind the call" — which tests HERO's chips and says nothing about
 * the opponent's. So on a spot where every opponent was already all in, the Lab published a Raise
 * button (`eq-rule-of-four-big-draw-flop`: "raise to 260" against an opponent with 0 behind) while
 * the Coach's table listed only fold and call. A learner who pressed it received
 * `pricing: 'action-not-priced'` and was told their decision was not the line the analysis leans
 * towards — for taking an action the product had just offered them.
 *
 * The first two checks compare whether AGGRESSION IS AVAILABLE, and the sizes are left out on
 * purpose: the Coach prices discrete rungs and the ActionBar exposes a continuous range.
 *
 * ## The kind NAME is compared as well, because the difference was not vocabulary
 *
 * This header used to call "bet" against "raise" a vocabulary difference worth tidying. The Lab
 * named the action from what hero owes (`owed > 0 ? raise : bet`) and the Coach names it from the
 * bet level (`betLevelOf(spot) === 0 ? bet : raise`), so at the big blind's option in a limped pot
 * (`fl-big-blind-option-limped-pot`: hero posted 10, the cutoff limped 10, nothing owed) the Lab
 * offered "Bet to 10 · 0 units" — a button that put nothing in, floored at the blind hero had
 * already posted — and every size it accepted came back `pricing: 'action-not-priced'`, because the
 * Coach's rows for that spot are `raise 22`, `raise 28` and `raise 1000` (measured against the
 * running API) and `judgeConsistency` matches on the name. A name the grader cannot match is not a
 * label; it is a decision nothing will price.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { content, readSituation } from '@prl/content';
import type { Scenario } from '@prl/contracts';
import { deriveLegalActions } from '@prl/poker-math';
import { scenarioToPlayerView } from '../src/lib/scenario-view.ts';

const AGGRESSIVE = new Set(['bet', 'raise']);

/**
 * The four figures `deriveLegalActions` prices from, built the way `coachTaskFor` builds them.
 *
 * `readSituation` alone is NOT enough and passing it straight in is the trap: `ScenarioSituation`
 * has no `heroCommittedThisStreet`, so the spot arrives with that field undefined, `maximumTo`
 * comes out NaN, and every comparison against it is false — which reports the Coach as pricing
 * nothing but fold and call on every scenario in the bundle. The first version of this test did
 * exactly that and accused twenty-odd scenarios of a defect they did not have.
 */
function spotFor(scenario: Scenario) {
  const situation = readSituation(scenario);
  const heroSeat = scenario.seats.find((seat) => seat.isHero === true);
  return {
    toCall: situation.toCall,
    heroCommittedThisStreet: scenario.committedThisStreet?.[heroSeat?.seat ?? -1] ?? 0,
    heroStack: situation.heroStack,
    opponentStacks: situation.opponentStacks,
  };
}

describe('the Lab and the Coach agree on what hero may do', () => {
  it('never offers an aggressive action the Coach will not price (REGRESSION)', () => {
    const scenarios = content().scenarios;
    assert.ok(scenarios.length > 0, 'a sweep of nothing is not a pass');

    const offered: string[] = [];
    let compared = 0;
    for (const scenario of scenarios) {
      const table = scenarioToPlayerView(scenario);
      if (table === null) continue;
      const priced = new Set(deriveLegalActions(spotFor(scenario)));
      compared += 1;
      const labAggression = table.legalActions.find((action) => AGGRESSIVE.has(action.type));
      const coachPricesAggression = [...priced].some((kind) => AGGRESSIVE.has(kind));
      if (labAggression !== undefined && !coachPricesAggression) {
        offered.push(
          `${scenario.id}: the Lab offers "${labAggression.type}" and the Coach prices only ` +
            `[${[...priced].join(', ')}]`,
        );
      }
    }
    assert.ok(compared >= 30, `only ${compared} scenario(s) compared; a sweep of nothing is not a pass`);
    assert.deepEqual(offered, [], offered.join('\n'));
  });

  it('names the aggressive action the way the Coach prices it (REGRESSION)', () => {
    // `judgeConsistency` finds the chosen row by action name, so a Lab "bet" against a Coach "raise"
    // is unpriced whatever size is chosen.
    const misnamed: string[] = [];
    let compared = 0;
    for (const scenario of content().scenarios) {
      const table = scenarioToPlayerView(scenario);
      if (table === null) continue;
      const labAggression = table.legalActions.find((action) => AGGRESSIVE.has(action.type));
      const coachAggression = deriveLegalActions(spotFor(scenario)).find((kind) => AGGRESSIVE.has(kind));
      if (labAggression === undefined || coachAggression === undefined) continue;
      compared += 1;
      if (labAggression.type !== coachAggression) {
        misnamed.push(
          `${scenario.id}: the Lab offers "${labAggression.type}", the Coach prices "${coachAggression}"`,
        );
      }
    }
    assert.ok(compared > 10, `only ${compared} scenario(s) compared; a sweep of nothing is not a pass`);
    assert.deepEqual(misnamed, [], misnamed.join('\n'));
  });

  it('offers aggression wherever the Coach prices it, so the fix did not just delete the button', () => {
    // The other direction. A gate that removed every raise would pass the check above and leave the
    // Lab unable to teach aggression at all, which is most of what risk and sizing is about.
    let withAggression = 0;
    for (const scenario of content().scenarios) {
      const table = scenarioToPlayerView(scenario);
      if (table === null) continue;
      const priced = new Set(deriveLegalActions(spotFor(scenario)));
      if ([...priced].some((kind) => AGGRESSIVE.has(kind))) {
        assert.ok(
          table.legalActions.some((action) => AGGRESSIVE.has(action.type)),
          `${scenario.id}: the Coach prices aggression and the Lab offers no bet or raise button`,
        );
        withAggression += 1;
      }
    }
    assert.ok(
      withAggression > 10,
      `only ${withAggression} scenario(s) offer aggression; expected most of them`,
    );
  });
});

describe("the big blind's option in a limped pot", () => {
  // Hero has posted the big blind (10), the cutoff limped for 10, and nothing is owed. There is a
  // live bet level, so aggression here is a RAISE, floored at the bet level plus one full increment —
  // the floor `minimumAggressiveTo` in `@prl/poker-math` derives for the same spot.
  const scenario = content().scenarios.find((candidate) => candidate.id === 'fl-big-blind-option-limped-pot');

  it('offers check and a raise to 20 that costs 10, not a bet to the blind already posted (REGRESSION)', () => {
    assert.ok(scenario !== undefined, 'fl-big-blind-option-limped-pot is no longer in the bundle');
    const table = scenarioToPlayerView(scenario);
    assert.ok(table !== null, 'the scenario did not project into a table');
    assert.deepEqual(
      table.legalActions.map((action) => action.type),
      ['check', 'raise'],
    );
    const raise = table.legalActions.find((action) => action.type === 'raise');
    assert.equal(raise?.minTo, 20, 'the raise floor is the bet level (10) plus one big blind');
    assert.equal(raise?.costAtMin, 10, 'a minimum raise adds 10 to the 10 already posted');
    assert.equal(raise?.maxTo, 1000, 'the ceiling is the 10 posted plus the 990 behind');
    assert.equal(
      table.view.minimumRaiseTo,
      raise?.minTo,
      'the view and the action bar disagree on the floor',
    );
  });

  it('keeps an unopened pot a bet floored at one big blind', () => {
    // The other side of the boundary. The bundle has exactly one spot with nothing owed — this one —
    // so the unopened case is the same table moved to a flop nobody has bet: no level, no raise.
    assert.ok(scenario !== undefined, 'fl-big-blind-option-limped-pot is no longer in the bundle');
    const unopened: Scenario = {
      ...scenario,
      street: 'flop',
      board: '2c7d9s',
      potBeforeStreet: 25,
      committedThisStreet: {},
    };
    const aggression = scenarioToPlayerView(unopened)?.legalActions.find((action) =>
      AGGRESSIVE.has(action.type),
    );
    assert.equal(aggression?.type, 'bet');
    assert.equal(aggression?.minTo, unopened.bigBlind);
    assert.equal(aggression?.costAtMin, unopened.bigBlind);
  });
});
