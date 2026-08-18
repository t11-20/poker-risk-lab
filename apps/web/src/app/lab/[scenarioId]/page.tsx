/**
 * One scenario.
 *
 * The page's job is data and landmarks; `ScenarioStage` owns the reading order and the reveal, and
 * its header explains why the assumptions come before the decision.
 *
 * ## Why the table view is built here and not in the component
 *
 * `scenarioToPlayerView` needs `@prl/poker-engine` for card parsing and position labels, and the
 * engine's module graph contains the shuffler and the deck commitment. Doing the projection in this
 * server component means the finished `PlayerView` crosses to the client as plain data and the client
 * bundle links against none of it. Same reasoning as the hand replay; the only place the engine is
 * deliberately allowed into the browser is `CommitmentVerifier`.
 *
 * ## Two different kinds of "not found"
 *
 *  - An id no scenario has: `notFound()`, a real 404. A learner who mistypes a URL should get the
 *    page that says so, not an empty analysis.
 *  - A scenario whose situation will not project into a table: also a 404, but for a different
 *    reason, and the comment at that branch says which. Rendering the question with no table would
 *    silently ask a different question from the one the scenario wrote.
 */

import type { ScenarioResponse } from '@prl/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';
import { ScenarioStage } from '../../../components/ScenarioStage.tsx';
import { LAB_SCENARIO_SUMMARIES, scenarioFixture } from '../../../fixtures/scenarios.ts';
import { API_PATHS, apiGet, isApiUnavailable, isMissingResource } from '../../../lib/api.ts';
import { difficultyLabel, topicLabel } from '../../../lib/lab-labels.ts';
import { scenarioToPlayerView } from '../../../lib/scenario-view.ts';
import '../../../styles/page.css';
import '../../../styles/lab.css';

interface RouteParams {
  readonly scenarioId: string;
}

interface ScenarioData {
  readonly response: ScenarioResponse;
  readonly fromFixture: boolean;
}

async function loadScenario(id: string): Promise<ScenarioData | null> {
  try {
    const response = await apiGet<ScenarioResponse>(API_PATHS.scenario(id));
    return { response, fromFixture: false };
  } catch (error) {
    // `id` came out of the URL, so a 404 is the API answering "no such scenario". `null` is what the
    // page turns into its not-found screen; the fixture is only for a genuine outage.
    if (isMissingResource(error)) return null;
    if (!isApiUnavailable(error)) throw error;
    const fixture = scenarioFixture(id);
    return fixture === null ? null : { response: fixture, fromFixture: true };
  }
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { scenarioId } = await params;
  const summary = LAB_SCENARIO_SUMMARIES.find((candidate) => candidate.id === scenarioId);
  if (summary === undefined) return { title: 'Scenario' };
  return {
    title: summary.title,
    description: summary.question,
  };
}

/** The next scenario in list order, so "next" is a stable route rather than a guess. */
function nextHrefAfter(id: string): string | null {
  const at = LAB_SCENARIO_SUMMARIES.findIndex((candidate) => candidate.id === id);
  if (at < 0) return null;
  const next = LAB_SCENARIO_SUMMARIES[at + 1];
  return next === undefined ? null : `/lab/${next.id}`;
}

export default async function ScenarioPage({
  params,
}: {
  readonly params: Promise<RouteParams>;
}): Promise<ReactElement> {
  const { scenarioId } = await params;
  const data = await loadScenario(scenarioId);
  if (data === null) notFound();

  const { scenario, analysis, glossary } = data.response;
  const table = scenarioToPlayerView(scenario);
  // A scenario whose seats or cards will not parse cannot be staged. That is a content bug, and a
  // 404 is the honest outcome: the alternative is a question asked without the situation it needs.
  if (table === null) notFound();

  const seatNames: Record<number, string> = {};
  for (const seat of scenario.seats) seatNames[seat.seat] = seat.label;

  return (
    <div className="prl-container prl-lab-page">
      <header className="prl-page-head">
        <p className="prl-eyebrow">
          <a className="prl-crumb" href="/lab">
            Scenario Lab
          </a>
          {' · '}
          {topicLabel(scenario.topic)}
          {' · '}
          {difficultyLabel(scenario.difficulty)}
        </p>
        <h1 className="prl-display-2 prl-page-head__title">{scenario.title}</h1>
        <p className="prl-page-head__standfirst">{scenario.question}</p>
      </header>

      {data.fromFixture ? (
        <p className="prl-source-note prl-note">
          <span className="prl-label prl-label--accent">Fixture data</span> The scenario API is not reachable,
          so this page is rendered from <code className="prl-mono">src/fixtures/scenarios.ts</code>. The
          analysis in it was produced by the same functions the endpoint will call —{' '}
          <code className="prl-mono">readSituation</code> and{' '}
          <code className="prl-mono">buildCoachReport</code> — so the figures are the engine&rsquo;s, but they
          were computed ahead of time rather than for this request.
        </p>
      ) : null}

      <ScenarioStage
        scenario={scenario}
        analysis={analysis}
        // The stakes, beside the analysis rather than smuggled inside it. `judgeConsistency`
        // denominates its indifference margin in big blinds and a `CoachReport` carries no
        // stakes, so an earlier version attached the big blind to the report itself — an extra
        // field, so the denominator travelled with the figures. (That helper is gone; do not
        // reintroduce it.) It worked, and it hid the dependency: nothing in `ScenarioStage`'s
        // signature said it needed the stakes, so a caller could stop attaching them and the
        // verdict would quietly be judged against a one-chip margin while the server recorded a
        // twenty-chip one. A required prop is the version of that arrangement the compiler checks.
        bigBlind={scenario.bigBlind}
        view={table.view}
        legalActions={table.legalActions}
        seatNames={seatNames}
        glossary={glossary}
        nextHref={nextHrefAfter(scenario.id)}
        compareHref={`/legends/compare?scenario=${encodeURIComponent(scenario.id)}`}
      />

      <nav className="prl-page-nav" aria-label="Scenario Lab">
        <a href="/lab">All scenarios</a>
        <a href="/legends">AI opponent profiles</a>
        <a href="/review">Your hand history</a>
      </nav>
    </div>
  );
}
