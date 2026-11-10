/**
 * The Scenario Lab index: a filterable grid of scenarios.
 *
 * ## Data, and why the fixture is a first-class path
 *
 * `GET /api/scenarios` does not exist yet. This page asks for it, and falls back to
 * `scenarioListFixture()` when the API is unreachable or has not shipped the route — the test being
 * `isApiUnavailable`, not a bare `catch`, so a `403` or a protocol mismatch still surfaces as an
 * error rather than being papered over with fixture data. When the fixture is used the page says so,
 * once, quietly: a reviewer looking at a number needs to know whether a server produced it.
 *
 * ## Filters live in the URL
 *
 * `topic`, `difficulty` and `street` are read from `searchParams` and passed straight to the
 * `<select>`s' `defaultValue`, so the URL is the single source of truth for what is shown and a
 * filtered view is linkable. `ScenarioFilters` is a plain GET form with no JavaScript — see its own
 * header for why.
 *
 * The option counts are computed against the *other two* filters, so "Turn (1)" means "one scenario
 * if you also keep the topic and level you have chosen". A count computed against the unfiltered set
 * would promise results that the combination does not deliver.
 *
 * ## …and the count of a filtered view lives in the document title
 *
 * Because that GET submit is a full document load, and a full document load is announced by its
 * title and by nothing else this page can reach. `generateMetadata` below has the measurement and
 * the reasoning; it is the fix for certification assertion 4.2, and `scripts/ax-assertions.mjs`
 * (`J4.2`) is what keeps it fixed.
 *
 * ## No progress anywhere
 *
 * A card says whether it has been attempted and nothing more. There is no completion count, no
 * percentage, no streak and no ordering by "next up". `ScenarioSummary` carries a boolean for exactly
 * this reason, and the design of this page is not allowed to reconstruct a score out of six booleans.
 */

import type { ScenarioListResponse, ScenarioSummary } from '@prl/contracts';
import { Chip, formatIndex, Reveal } from '@prl/ui';
import type { Metadata } from 'next';
import { cache, type ReactElement } from 'react';
import {
  FILTER_ANY,
  type FilterOption,
  isFilteredSelection,
  ScenarioFilters,
  scenarioCountPhrase,
} from '../../components/ScenarioFilters.tsx';
import { scenarioListFixture } from '../../fixtures/scenarios.ts';
import { API_PATHS, apiGet, isApiUnavailable } from '../../lib/api.ts';
import { difficultyLabel, streetLabel, topicLabel } from '../../lib/lab-labels.ts';
import { readerCallOptions } from '../../lib/server-session.ts';
import '../../styles/page.css';
import '../../styles/lab.css';

const DESCRIPTION =
  'Decision situations with the maths worked out: pot odds, outs, expected value and stack depth, each with its assumptions stated before you decide.';

/** The route the filter form submits back to. */
const ROUTE = '/lab';

interface Selection {
  readonly topic: string;
  readonly difficulty: string;
  readonly street: string;
}

/** One query value, or the "any" sentinel. Arrays (`?topic=a&topic=b`) take the first entry. */
function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? FILTER_ANY;
  return value ?? FILTER_ANY;
}

/** The three filters, read from the query string. One reading, shared by the title and the page. */
function readSelection(query: Record<string, string | string[] | undefined>): Selection {
  return {
    topic: readParam(query['topic']),
    difficulty: readParam(query['difficulty']),
    street: readParam(query['street']),
  };
}

function matches(scenario: ScenarioSummary, selection: Selection): boolean {
  if (selection.topic !== FILTER_ANY && scenario.topic !== selection.topic) return false;
  if (selection.difficulty !== FILTER_ANY && scenario.difficulty !== selection.difficulty) return false;
  if (selection.street !== FILTER_ANY && scenario.street !== selection.street) return false;
  return true;
}

/**
 * Options for one facet, counted against the other two.
 *
 * The facet being built is set to `any` inside its own count, which is what makes the number a
 * prediction of "if I pick this" rather than of "if I pick this and nothing else".
 */
function optionsFor(
  scenarios: readonly ScenarioSummary[],
  selection: Selection,
  facet: keyof Selection,
  label: (id: string) => string,
): readonly FilterOption[] {
  const relaxed: Selection = { ...selection, [facet]: FILTER_ANY };
  const counts = new Map<string, number>();
  for (const scenario of scenarios) {
    const value = scenario[facet];
    if (!counts.has(value)) counts.set(value, 0);
    if (matches(scenario, relaxed)) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: label(value), count }))
    .sort((a, b) => a.label.localeCompare(b.label, 'en'));
}

interface LabData {
  readonly response: ScenarioListResponse;
  readonly fromFixture: boolean;
}

/**
 * The list, with the reader's own attempt marks.
 *
 * ## The defect the `readerCallOptions()` is here for
 *
 * `ScenarioSummary.attempted` is a PER-READER fact — `content.ts` derives it from
 * `callerUserId(request)` and answers `false` for everybody when there is none. A server render
 * carries no cookie unless one is forwarded (see `lib/api.ts` on why), and this call forwarded
 * none, so the request was anonymous by construction and every one of the thirty-six cards read
 * "Not yet attempted" for every learner, for ever. `/record` on the same session says "Scenarios
 * tried: 7" and lists their ids. `/learn`, `/record` and `/review` all already forward it; this
 * page was the one that did not.
 *
 * ## Why it is wrapped in `cache()`
 *
 * `generateMetadata` below needs the same list the page body needs, because the title now carries
 * the filtered count and a title that disagreed with the page would be worse than no title at all.
 * Next memoises `fetch` across `generateMetadata` and the page for the same request, but this call
 * also reads the session cookie through `readerCallOptions()`, and relying on the framework's
 * memoisation of a call it cannot see the arguments of is a bet. `cache()` makes "one list per
 * request" a property of this file: two callers, one fetch, one answer, and no way for the title
 * and the body to be computed from different data.
 */
const loadScenarios = cache(async (): Promise<LabData> => {
  const reader = await readerCallOptions();
  try {
    return {
      response: await apiGet<ScenarioListResponse>(API_PATHS.scenarios(), reader),
      fromFixture: false,
    };
  } catch (error) {
    // Only an absent or broken API selects the fixture. Anything else — an auth failure, a protocol
    // mismatch, a 404 on this collection path — is a real condition the reader should see, so it is
    // rethrown for the error boundary. A 404 here would mean this client asked for a path the API
    // does not serve, which is how the whole app came to render six fixture scenarios in place of
    // the thirty-six the API ships.
    if (!isApiUnavailable(error)) throw error;
    // The bundled copy's attempt marks are somebody's idea of a plausible session and belong to
    // nobody: `ATTEMPTED` in `src/fixtures/scenarios.ts` hard-codes two ids to `true`, so a
    // first-time visitor arriving during an outage was told "You have worked through this one"
    // about two scenarios they have never opened. They are dropped rather than shown, and the
    // note below says so — the same answer `LESSONS_FALLBACK` gives for the read/unread marks.
    const bundled = scenarioListFixture();
    return {
      response: {
        ...bundled,
        scenarios: bundled.scenarios.map((scenario) => ({ ...scenario, attempted: false })),
      },
      fromFixture: true,
    };
  }
});

interface LabIndexProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * The title, and why the filtered count is in it.
 *
 * ## The defect this closes
 *
 * Certification assertion 4.2 asks that the count after a filter is announced. It was not, and it
 * could not be. `ScenarioFilters` is a plain GET form with no JavaScript on purpose, so a submit is
 * a FULL DOCUMENT LOAD: measured in Chrome 151 against a production build, a `window` marker set
 * before the submit was gone afterwards, `document.title` was byte-identical before and after
 * ("Scenario Lab — Poker Risk Lab", carrying nothing about the filter), and the summary region on
 * the new document took ZERO mutations because it arrived already holding "Showing 14 of 36
 * scenarios." A live region that arrives with its text announces nothing — the same fact assertion
 * 3.3 was fixed for. There the fix was to mount the region empty from first paint and write into it
 * later; here there is no "later", because the context that would do the writing has been thrown
 * away by the navigation.
 *
 * What a new document DOES announce is its title. That is assertion G1, it needs no JavaScript, and
 * it is announced on every load whether or not the string changed — unlike `RouteAnnouncer`, which
 * is deliberately silent on a full load and only speaks on a client navigation. So the count goes
 * here.
 *
 * ## Only a filtered view says it
 *
 * An unfiltered `/lab` keeps the plain "Scenario Lab — Poker Risk Lab" exactly as before: the count
 * is the answer to an action the reader took, and a permanent count in the tab title of the
 * landing view is noise on arrival. Assertion 4.1 quotes that unfiltered title, so this is also the
 * boundary that keeps it true.
 *
 * ## Failing in the safe direction
 *
 * A metadata failure must not be how the reader finds out the API is down. If the list cannot be
 * loaded this falls back to the bare title and lets the page body decide what to render — the
 * fixture notice, or the error boundary for a condition that is not an outage. The count is lost in
 * that case, which is the direction that loses the least: a reader gets the page, and the page says
 * what happened.
 */
export async function generateMetadata({ searchParams }: LabIndexProps): Promise<Metadata> {
  const selection = readSelection(await searchParams);
  if (!isFilteredSelection(selection)) return { title: 'Scenario Lab', description: DESCRIPTION };
  const counted = await loadScenarios().then(
    (data) => data.response.scenarios,
    () => null,
  );
  if (counted === null) return { title: 'Scenario Lab', description: DESCRIPTION };
  const matching = counted.filter((scenario) => matches(scenario, selection)).length;
  return {
    title: `Scenario Lab — ${scenarioCountPhrase(matching, counted.length)} scenarios`,
    description: DESCRIPTION,
  };
}

function ScenarioCard({
  scenario,
  position,
  stagger,
}: {
  readonly scenario: ScenarioSummary;
  readonly position: number;
  readonly stagger: number;
}): ReactElement {
  return (
    <li className="prl-span-4 prl-lab-grid__cell">
      <Reveal stagger={stagger} className="prl-lab-card-wrap">
        <article className="prl-lab-card">
          <p className="prl-lab-card__index prl-index" aria-hidden="true">
            {formatIndex(position)}
          </p>
          <h2 className="prl-lab-card__title">
            <a className="prl-lab-card__link" href={`${ROUTE}/${scenario.id}`}>
              {/* The index is announced here rather than on the decorative number above, so a screen
                  reader gets "scenario 3, Is a small pair worth a call?" and not a bare ordinal. */}
              <span className="prl-visually-hidden">{`Scenario ${position}: `}</span>
              {scenario.title}
            </a>
          </h2>
          <p className="prl-lab-card__question">{scenario.question}</p>
          <ul className="prl-lab-card__chips">
            <li>
              <Chip tone="neutral">{topicLabel(scenario.topic)}</Chip>
            </li>
            <li>
              <Chip tone="accent">{difficultyLabel(scenario.difficulty)}</Chip>
            </li>
            <li>
              <Chip tone="info" glyph="▸">
                {streetLabel(scenario.street)}
              </Chip>
            </li>
          </ul>
          {/* Attempted, stated as a fact with a glyph and a word — never a tick that means "passed". */}
          <p className="prl-lab-card__state" data-attempted={scenario.attempted ? 'true' : 'false'}>
            <span aria-hidden="true">{scenario.attempted ? '◍ ' : '○ '}</span>
            {scenario.attempted ? 'You have worked through this one' : 'Not yet attempted'}
          </p>
        </article>
      </Reveal>
    </li>
  );
}

export default async function LabIndexPage({ searchParams }: LabIndexProps): Promise<ReactElement> {
  const selection = readSelection(await searchParams);

  const { response, fromFixture } = await loadScenarios();
  const all = response.scenarios;
  const shown = all.filter((scenario) => matches(scenario, selection));

  return (
    <div className="prl-container prl-lab-page">
      <header className="prl-page-head">
        <p className="prl-eyebrow">
          <span className="prl-index" aria-hidden="true">
            03
          </span>{' '}
          Lab
        </p>
        <h1 className="prl-display-2 prl-page-head__title">Scenario Lab</h1>
        <p className="prl-page-head__standfirst">
          Situations with the arithmetic already done. Each one states its assumptions before it asks you
          anything, and the analysis afterwards shows what every action on the table is worth rather than
          telling you which one was right.
        </p>
      </header>

      {fromFixture ? (
        <p className="prl-source-note prl-note">
          <span className="prl-label prl-label--accent">Fixture data</span> The scenario API is not reachable,
          so this list comes from the typed fixture in{' '}
          <code className="prl-mono">src/fixtures/scenarios.ts</code>. The scenarios and their questions are
          real, and the analysis behind each one was produced by the real functions — but this is a partial
          copy rather than the full set, and nothing here knows which of them you have attempted, so every
          card reads as unattempted whatever you have actually done.
        </p>
      ) : null}

      <ScenarioFilters
        topics={optionsFor(all, selection, 'topic', topicLabel)}
        difficulties={optionsFor(all, selection, 'difficulty', difficultyLabel)}
        streets={optionsFor(all, selection, 'street', streetLabel)}
        selected={selection}
        matching={shown.length}
        totalAvailable={all.length}
        action={ROUTE}
      />

      {shown.length === 0 ? (
        <div className="prl-empty">
          <p>
            No scenario matches that combination. The counts in each dropdown are calculated against your
            other two choices, so widening the one with a zero beside it is the quickest way back to a result.
          </p>
          <a className="prl-btn prl-btn--secondary" href={ROUTE}>
            Clear all filters
          </a>
        </div>
      ) : (
        <ul className="prl-grid prl-lab-grid">
          {shown.map((scenario, position) => (
            <ScenarioCard
              key={scenario.id}
              scenario={scenario}
              // The card's number is its place in the full list, not in the filtered one: a scenario
              // that is `03` unfiltered must not become `01` because a filter is on.
              position={all.findIndex((candidate) => candidate.id === scenario.id) + 1}
              stagger={position}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
