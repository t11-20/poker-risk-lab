/**
 * A built-in scenario converted to a spot and priced again gives the report the Lab already shows for
 * it, byte for byte. Here against the six bundled with the app (`LAB_SCENARIO_ANALYSIS`, the page's
 * offline copy); `apps/api/test/lab-spot-conversion.test.ts` holds every scenario to the API's report.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scenarios } from '@prl/content';
import { parseCards } from '@prl/poker-engine';
import { LAB_SCENARIO_ANALYSIS, LAB_SCENARIOS } from '../src/fixtures/scenarios.ts';
import { cardsFromText } from '../src/lib/spot.ts';
import { reportForSpot } from '../src/lib/spot-analysis.ts';
import { draftFromScenario } from '../src/lib/spot-convert.ts';
import { validateDraft } from '../src/lib/spot-validate.ts';

describe('a built-in scenario, converted to a spot', () => {
  it('prices to the stored analysis of every scenario bundled with the app', () => {
    assert.ok(LAB_SCENARIOS.length >= 6, 'a sweep of nothing is not a pass');
    for (const scenario of LAB_SCENARIOS) {
      const draft = draftFromScenario(scenario);
      assert.ok(draft !== null, `${scenario.id} did not convert`);
      const checked = validateDraft(draft);
      assert.ok(
        checked.ok,
        `${scenario.id} failed validation: ${checked.ok ? '' : [...checked.errors.values()].join(' ')}`,
      );
      const priced = reportForSpot(checked.spot);
      assert.ok(priced.ok, `${scenario.id} was refused: ${priced.ok ? '' : priced.message}`);
      const stored = LAB_SCENARIO_ANALYSIS[scenario.id];
      assert.ok(stored !== undefined, `${scenario.id} has no stored analysis`);
      assert.equal(JSON.stringify(priced.report), JSON.stringify(stored), scenario.id);
    }
  });

  it('converts and validates every scenario in the content bundle', () => {
    const all = scenarios();
    assert.ok(all.length > 30, 'a sweep of nothing is not a pass');
    for (const scenario of all) {
      const draft = draftFromScenario(scenario);
      assert.ok(draft !== null, `${scenario.id} did not convert`);
      const checked = validateDraft(draft);
      assert.ok(checked.ok, `${scenario.id}: ${checked.ok ? '' : [...checked.errors.values()].join(' ')}`);
    }
  });

  it('reads card text exactly as the engine does', () => {
    const texts = scenarios().flatMap((scenario) => [
      scenario.board,
      ...scenario.seats.flatMap((seat) => (seat.holeCards === undefined ? [] : [seat.holeCards])),
      ...(scenario.opponentRange.kind === 'exact' ? [scenario.opponentRange.cards] : []),
    ]);
    assert.ok(texts.length > 60, 'a sweep of nothing is not a pass');
    for (const text of [...texts, 'AhKd', 'Ah Kd', '10h 9c', 'Ah,Kd']) {
      assert.deepEqual(cardsFromText(text), parseCards(text), text);
    }
    assert.equal(cardsFromText('Ah K'), null);
    assert.equal(cardsFromText('Zz'), null);
  });
});
