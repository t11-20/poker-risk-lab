/**
 * A built-in scenario converted to a spot and priced again gives the report the Lab already shows for
 * it, byte for byte. Here against the six bundled with the app (`LAB_SCENARIO_ANALYSIS`, the page's
 * offline copy); `apps/api/test/lab-spot-conversion.test.ts` holds every scenario to the API's report.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scenarios } from '@prl/content';
import type { Scenario } from '@prl/contracts';
import { parseCards } from '@prl/poker-engine';
import { LAB_SCENARIO_ANALYSIS, LAB_SCENARIOS } from '../src/fixtures/scenarios.ts';
import { cardsFromText, type SpotDraft } from '../src/lib/spot.ts';
import { coachInputForSpot, reportForSpot } from '../src/lib/spot-analysis.ts';
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

  it('names each opponent by seat in a few words, and keeps the range in the range field', () => {
    const all = scenarios();
    const names = all.flatMap((scenario) => draftFromScenario(scenario)?.opponents.map((o) => o.name) ?? []);
    assert.ok(names.length > 40, 'a sweep of nothing is not a pass');
    for (const name of names) assert.ok(name.length <= 16, `"${name}" is too long for a legend at 390px`);
    const copy = draftFromScenario(all.find((s) => s.id === 'eq-flush-draw-turn-small-bet') as Scenario);
    assert.equal(copy?.opponents[0]?.name, 'Button');
    assert.match(copy?.opponents[0]?.range ?? '', /\S/u);
  });

  it("the analysis keeps the built-in's own name for a range until the range is changed", () => {
    const scenario = scenarios().find((s) => s.id === 'eq-flush-draw-turn-small-bet') as Scenario;
    const label = scenario.opponentRange.kind === 'exact' ? '' : scenario.opponentRange.label;
    const copy = draftFromScenario(scenario);
    assert.ok(copy !== null);
    const labelOf = (draft: SpotDraft): string | undefined => {
      const checked = validateDraft(draft);
      assert.ok(checked.ok);
      return coachInputForSpot(checked.spot).opponents[0]?.label;
    };
    assert.equal(labelOf(copy), label);
    const renamed = { ...copy, opponents: copy.opponents.map((o) => ({ ...o, name: 'Bea' })) };
    assert.equal(labelOf(renamed), label, 'a new name for the seat does not rename its range');
    const edited = { ...copy, opponents: copy.opponents.map((o) => ({ ...o, range: 'QQ+' })) };
    assert.equal(labelOf(edited), 'Button', 'a changed range is no longer the one the label names');
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
