/**
 * The Lab must not offer an action the Coach refuses to price. Sizes are left out, because the Coach
 * prices discrete rungs and the ActionBar a range; the kind name is compared because rows match on it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { content, readSituation } from '@prl/content';
import type { Scenario } from '@prl/contracts';
import { deriveLegalActions } from '@prl/poker-math';
import { scenarioToPlayerView } from '../src/lib/scenario-view.ts';

const AGGRESSIVE = new Set(['bet', 'raise']);

/** Built as `coachTaskFor` does. `readSituation` lacks `heroCommittedThisStreet`, so `maximumTo` is NaN. */
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
    // A gate that removed every raise would pass the check above.
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
  // Hero posted the big blind (10), the cutoff limped for 10, nothing is owed. A live bet level makes
  // aggression a RAISE, floored where `minimumAggressiveTo` in `@prl/poker-math` puts it.
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
    // The bundle has exactly one spot with nothing owed, so the unopened case is this table moved to a flop.
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
