/**
 * The Scenario Lab's "You have worked through this one" mark is the READER's, or it is not shown.
 * `attempted` is per-reader and `false` for an anonymous request, so `/lab` must forward the session
 * with `readerCallOptions()`, as `/learn`, `/record` and `/review` do. The bundled fixture hard-codes
 * two marks that belong to nobody. Source assertions, because a server component has no renderer
 * here (ADR 0008) and `apiGet` is not injectable.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scenarioListFixture } from '../src/fixtures/scenarios.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

describe('the Scenario Lab index', () => {
  it('forwards the reader’s session, or every attempt mark is false for everybody', () => {
    const source = read('app', 'lab', 'page.tsx');
    assert.match(
      source,
      /readerCallOptions\(\)/u,
      'app/lab/page.tsx must call readerCallOptions(): without it the scenario list is fetched ' +
        'anonymously on the server and `attempted` comes back false for every card, for every reader',
    );
    assert.match(
      source,
      /apiGet<ScenarioListResponse>\(API_PATHS\.scenarios\(\), reader\)/u,
      'the options readerCallOptions() returned have to reach the call. Building them and not ' +
        'passing them is the same anonymous request with more code in front of it',
    );
  });

  it('shows no attempt mark at all when the list is the bundled copy', () => {
    const source = read('app', 'lab', 'page.tsx');
    assert.match(
      source,
      /scenarios: bundled\.scenarios\.map\(\(scenario\) => \(\{ \.\.\.scenario, attempted: false \}\)\)/u,
      'the bundled list carries hard-coded attempt marks that belong to nobody. They must be ' +
        'dropped on the fixture path, not rendered as the reader’s own',
    );
  });

  it('says, on the fixture path, that it does not know what the reader has attempted', () => {
    const source = read('app', 'lab', 'page.tsx');
    assert.match(
      source,
      /it does not know which of them you have attempted/u,
      'the "Bundled copy" note has to name the per-reader claim it cannot make, the way ' +
        'LESSONS_FALLBACK does for the read/unread marks',
    );
  });

  it('is checking against a fixture that really does carry hard-coded marks', () => {
    // If `ATTEMPTED` ever empties, the two tests above guard nothing, and this one says so.
    const bundled = scenarioListFixture().scenarios;
    assert.ok(bundled.length > 0, 'the bundled list is not empty');
    assert.ok(
      bundled.some((scenario) => scenario.attempted),
      'src/fixtures/scenarios.ts still hard-codes at least one `attempted: true`, which is the ' +
        'thing app/lab/page.tsx must not render as a reader’s own history',
    );
  });
});
