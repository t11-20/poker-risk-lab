/**
 * Every scenario page the Lab can render is titled after its scenario.
 *
 * `generateMetadata` on `/lab/[scenarioId]` looked the id up in `LAB_SCENARIO_SUMMARIES` — the six
 * offline fixtures, under ids the API does not serve — so all 36 pages `generateStaticParams`
 * builds from `scenarios()` were titled "Scenario", and the "could not be loaded" screen could name
 * none of them. The page file imports CSS and cannot be loaded here, so the lookup lives in
 * `src/lib/lab-scenario-titles.ts` and the page is held to calling it.
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

  it('falls back to a plain title for an id the bundle does not carry', () => {
    assert.deepEqual(scenarioPageMetadata('no-such-scenario'), { title: 'Scenario' });
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
