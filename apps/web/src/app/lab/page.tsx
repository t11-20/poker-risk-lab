/**
 * The Scenario Lab index. Filters live in the URL and `ScenarioFilters` is a plain GET form. Each
 * option count is computed against the other two filters, so it never promises an empty combination.
 * A card says only whether it was attempted: no completion count, percentage or streak.
 */

import type { ScenarioListResponse, ScenarioSummary } from '@prl/contracts';
import { Chip, formatIndex, Reveal } from '@prl/ui';
import type { Metadata } from 'next';
import { cache, type ReactElement } from 'react';
import {
  isFilteredSelection,
  ScenarioFilters,
  scenarioCountPhrase,
} from '../../components/ScenarioFilters.tsx';
import { scenarioListFixture } from '../../fixtures/scenarios.ts';
import { API_PATHS, apiGet, isApiUnavailable } from '../../lib/api.ts';
import {
  anyCountFor,
  FILTER_ANY,
  LAB_RESULTS_ID,
  type LabSelection,
  matchesSelection,
  optionsFor,
} from '../../lib/lab-filters.ts';
import { difficultyLabel, streetLabel, topicLabel } from '../../lib/lab-labels.ts';
import { readerCallOptions } from '../../lib/server-session.ts';
import '../../styles/page.css';
import '../../styles/lab.css';
import { SuitMark } from '@/components/SuitMark.tsx';

const DESCRIPTION =
  'Decision situations with the maths worked out: pot odds, outs, expected value and stack depth, each with its assumptions stated before you decide.';

const ROUTE = '/lab';

/** Arrays (`?topic=a&topic=b`) take the first entry. */
function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? FILTER_ANY;
  return value ?? FILTER_ANY;
}

function readSelection(query: Record<string, string | string[] | undefined>): LabSelection {
  return {
    topic: readParam(query['topic']),
    difficulty: readParam(query['difficulty']),
    street: readParam(query['street']),
  };
}

interface LabData {
  readonly response: ScenarioListResponse;
  readonly fromFixture: boolean;
}

/**
 * `attempted` is per reader, so the session cookie must be forwarded or every card reads unattempted.
 * `cache()` gives the title and the body one fetch per request, so they cannot disagree.
 */
const loadScenarios = cache(async (): Promise<LabData> => {
  const reader = await readerCallOptions();
  try {
    return {
      response: await apiGet<ScenarioListResponse>(API_PATHS.scenarios(), reader),
      fromFixture: false,
    };
  } catch (error) {
    // Only an absent API selects the fixture. A 404 or auth failure is rethrown, so a wrong path
    // cannot pass the fixture's few scenarios off as the real list.
    if (!isApiUnavailable(error)) throw error;
    // The fixture hard-codes attempt marks that belong to nobody, so they are dropped.
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
 * The filtered count goes in the title (ax-assertions J4.2). A GET submit is a full document load, and
 * a live region that arrives with its text announces nothing, but a new title is announced. An
 * unfiltered view keeps the plain title (assertion 4.1). If the list fails to load this falls back to
 * the bare title and lets the page body report the failure.
 */
export async function generateMetadata({ searchParams }: LabIndexProps): Promise<Metadata> {
  const selection = readSelection(await searchParams);
  if (!isFilteredSelection(selection)) return { title: 'Scenario Lab', description: DESCRIPTION };
  const counted = await loadScenarios().then(
    (data) => data.response.scenarios,
    () => null,
  );
  if (counted === null) return { title: 'Scenario Lab', description: DESCRIPTION };
  const matching = counted.filter((scenario) => matchesSelection(scenario, selection)).length;
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
              {/* Announced here, because the number above is decorative. */}
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
          {/* A glyph and a word, never a tick that means "passed". */}
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
  const shown = all.filter((scenario) => matchesSelection(scenario, selection));
  const introCount = all.filter((scenario) => scenario.difficulty === 'intro').length;

  return (
    <div className="prl-container prl-lab-page">
      <header className="prl-page-head">
        <p className="prl-eyebrow">
          <SuitMark area="lab" />
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
          <span className="prl-label prl-label--accent">Bundled copy</span> The full list could not be loaded,
          so this is the copy that ships with the app. The scenarios and their questions are real, and the
          analysis behind each one was worked out by the same maths — but it is a partial copy rather than the
          full set, and it does not know which of them you have attempted, so every card reads as unattempted
          whatever you have actually done.
        </p>
      ) : null}

      {/*
        A link rather than a re-sort, because the first Intro card is #14 (4,574px down at 360x640) and
        a re-sort would renumber every card and change "Next scenario". Unfiltered views only.
      */}
      {isFilteredSelection(selection) || introCount === 0 ? null : (
        <p className="prl-note">
          <a className="prl-lab-start-link" href={`${ROUTE}?difficulty=intro#${LAB_RESULTS_ID}`}>
            {`New here? Start with the ${introCount} Intro scenarios`}
          </a>
        </p>
      )}

      <ScenarioFilters
        topics={optionsFor(all, selection, 'topic', topicLabel)}
        difficulties={optionsFor(all, selection, 'difficulty', difficultyLabel)}
        streets={optionsFor(all, selection, 'street', streetLabel)}
        selected={selection}
        matching={shown.length}
        totalAvailable={all.length}
        anyCounts={{
          topic: anyCountFor(all, selection, 'topic'),
          difficulty: anyCountFor(all, selection, 'difficulty'),
          street: anyCountFor(all, selection, 'street'),
        }}
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
              // The place in the full list, so a filter does not renumber cards.
              position={all.findIndex((candidate) => candidate.id === scenario.id) + 1}
              stagger={position}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
