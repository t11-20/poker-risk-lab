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
 * ## No progress anywhere
 *
 * A card says whether it has been attempted and nothing more. There is no completion count, no
 * percentage, no streak and no ordering by "next up". `ScenarioSummary` carries a boolean for exactly
 * this reason, and the design of this page is not allowed to reconstruct a score out of six booleans.
 */

import type { ScenarioListResponse, ScenarioSummary } from '@prl/contracts';
import { Chip, formatIndex, Reveal } from '@prl/ui';
import type { Metadata } from 'next';
import type { ReactElement } from 'react';
import { FILTER_ANY, type FilterOption, ScenarioFilters } from '../../components/ScenarioFilters.tsx';
import { scenarioListFixture } from '../../fixtures/scenarios.ts';
import { API_PATHS, apiGet, isApiUnavailable } from '../../lib/api.ts';
import { difficultyLabel, streetLabel, topicLabel } from '../../lib/lab-labels.ts';
import '../../styles/page.css';
import '../../styles/lab.css';

export const metadata: Metadata = {
  title: 'Scenario Lab',
  description:
    'Decision situations with the maths worked out: pot odds, outs, expected value and stack depth, each with its assumptions stated before you decide.',
};

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

async function loadScenarios(): Promise<LabData> {
  try {
    return { response: await apiGet<ScenarioListResponse>(API_PATHS.scenarios()), fromFixture: false };
  } catch (error) {
    // Only an absent or broken API selects the fixture. Anything else — an auth failure, a protocol
    // mismatch, a 404 on this collection path — is a real condition the reader should see, so it is
    // rethrown for the error boundary. A 404 here would mean this client asked for a path the API
    // does not serve, which is how the whole app came to render six fixture scenarios in place of
    // the thirty-six the API ships.
    if (!isApiUnavailable(error)) throw error;
    return { response: scenarioListFixture(), fromFixture: true };
  }
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

export default async function LabIndexPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactElement> {
  const query = await searchParams;
  const selection: Selection = {
    topic: readParam(query['topic']),
    difficulty: readParam(query['difficulty']),
    street: readParam(query['street']),
  };

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
          <code className="prl-mono">src/fixtures/scenarios.ts</code>. Every figure in it was computed by the
          real analysis functions, but no server was involved in this page.
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
