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
 * Comparing whether AGGRESSION IS AVAILABLE, rather than sizes or exact kind names, is deliberate
 * on both counts. The sizes legitimately differ — the Coach prices discrete rungs, the ActionBar
 * exposes a continuous range. And "bet" versus "raise" is a vocabulary difference between the two:
 * the Lab names the action from what hero owes (`owed > 0 ? raise : bet`) while the Coach names it
 * from the bet level (`betLevelOf(spot) === 0 ? bet : raise`), so a limped pot at the big blind's
 * option is a "bet" to one and a "raise" to the other. `fl-big-blind-option-limped-pot` is that
 * spot, and a learner there does see a button reading Bet beside a Coach row reading "Raise to".
 * That is worth tidying and it is not what this guard is for: what must never differ is whether
 * hero can be aggressive AT ALL, which is the disagreement that shipped.
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
