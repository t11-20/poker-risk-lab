/**
 * Every scenario page the Lab can render is titled after its scenario, not looked up in the six
 * offline fixtures whose ids the API does not serve. The page imports CSS and cannot load here, so
 * the lookup lives in `src/lib/lab-scenario-titles.ts` and the page is held to calling it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { scenarios } from '@prl/content';
import { bundledScenarioTitle, scenarioPageMetadata } from '../src/lib/lab-scenario-titles.ts';

const PAGE = new URL('../src/app/lab/[scenarioId]/page.tsx', import.meta.url);

describe('a scenario page is titled after its scenario', () => {
  it('names every bundled scenario, which is every route the page renders (REGRESSION)', () => {
    const all = scenarios();
    assert.ok(all.length >= 36, `only ${all.length} scenario(s); a sweep of nothing is not a pass`);
    const untitled: string[] = [];
    for (const scenario of all) {
      const metadata = scenarioPageMetadata(scenario.id);
      if (metadata.title !== scenario.title || metadata.description !== scenario.question) {
        untitled.push(`${scenario.id}: "${metadata.title}"`);
      }
    }
    assert.deepEqual(untitled, [], `${untitled.length} page(s) not titled after their scenario`);
  });

  it('says "not found" for an id the bundle does not carry (REGRESSION)', () => {
    assert.deepEqual(scenarioPageMetadata('no-such-scenario'), { title: 'Scenario not found' });
    assert.equal(bundledScenarioTitle('no-such-scenario'), null);
  });

  it('is what the page uses, for its metadata and for the unavailable screen', () => {
    const page = readFileSync(PAGE, 'utf8');
    assert.match(page, /return scenarioPageMetadata\(scenarioId\);/u);
    assert.match(page, /const summary = bundledScenarioTitle\(scenarioId\);/u);
    assert.doesNotMatch(
      page,
      /LAB_SCENARIO_SUMMARIES\.find\(/u,
      'the six-fixture list is being used to name scenarios again',
    );
  });
});
