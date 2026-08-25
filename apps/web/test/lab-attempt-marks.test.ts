/**
 * The Scenario Lab's "You have worked through this one" mark is the READER's, or it is not shown.
 *
 * ## The two defects these exist for
 *
 * `ScenarioSummary.attempted` is a per-reader fact. `apps/api/src/routes/content.ts` derives it
 * from `callerUserId(request)` and answers `false` for every scenario when there is no caller, and
 * a server render carries no session cookie unless one is explicitly forwarded — which is what
 * `readerCallOptions()` in `lib/server-session.ts` exists for, and what `/learn`, `/record` and
 * `/review` all do.
 *
 * **`/lab` did not.** `loadScenarios` called `apiGet(API_PATHS.scenarios())` with no options at
 * all, so the request was anonymous by construction. Measured in Chrome 151 against the running
 * API: all thirty-six cards carried `data-attempted="false"` and read "Not yet attempted", for
 * every learner, permanently — while `/record` on the same session counts and lists the scenarios
 * they have tried. `/learn` had exactly this defect and fixed it; `/lab` was never carried across.
 *
 * **And on the fixture path it was worse than useless.** `ATTEMPTED` in `src/fixtures/scenarios.ts`
 * hard-codes two ids to `true`, so during an API outage a first-time visitor was told "You have
 * worked through this one" about two scenarios they had never opened. That is the same defect
 * `components/LessonRead.tsx` documents as fixed for the lesson header ("bundled sample data, two
 * entries of which are hard-coded `true`") — and `LESSONS_FALLBACK` says in as many words that the
 * bundled read/unread marks "are not yours". The Lab's own fixture note said nothing about them.
 *
 * ## Why these are source assertions
 *
 * A `page.tsx` is an async server component: there is no renderer in this repository (ADR 0008) and
 * `apiGet` is not injectable here, so the fact being held is "this call forwards the reader" and the
 * only place that fact exists is the call. The end-to-end half was measured in the browser and is
 * quoted above. The failure messages name what to restore rather than saying a regex did not match.
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
      /nothing here knows which of them you have attempted/u,
      'the "Fixture data" note has to name the per-reader claim it cannot make, the way ' +
        'LESSONS_FALLBACK does for the read/unread marks',
    );
  });

  it('is checking against a fixture that really does carry hard-coded marks', () => {
    // A sweep of nothing is not a pass: if `ATTEMPTED` ever empties, the two tests above are
    // guarding a hazard that no longer exists and this one says so rather than going quietly green.
    const bundled = scenarioListFixture().scenarios;
    assert.ok(bundled.length > 0, 'the bundled list is not empty');
    assert.ok(
      bundled.some((scenario) => scenario.attempted),
      'src/fixtures/scenarios.ts still hard-codes at least one `attempted: true`, which is the ' +
        'thing app/lab/page.tsx must not render as a reader’s own history',
    );
  });
});
