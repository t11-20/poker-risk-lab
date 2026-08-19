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
 * ## Three different kinds of "not found", and only two of them are 404s
 *
 *  - An id no scenario has: `notFound()`, a real 404. A learner who mistypes a URL should get the
 *    page that says so, not an empty analysis.
 *  - A scenario whose situation will not project into a table: also a 404, but for a different
 *    reason, and the comment at that branch says which. Rendering the question with no table would
 *    silently ask a different question from the one the scenario wrote.
 *  - **The scenario API could not be reached and the bundled copy does not carry this id.** This
 *    used to be a 404 as well, and it was a lie. The API serves thirty-six scenarios and
 *    `src/fixtures/scenarios.ts` carries six of them, so with the API down thirty perfectly real
 *    scenarios told a learner "there is nothing at this address" — including anybody who had
 *    bookmarked one, or who was reading one when the API went away and pressed reload. The `/lab`
 *    index degrades correctly in the same conditions and says what happened; this page said the
 *    scenario had never existed.
 *
 * `ScenarioState` below is what keeps those apart. Only `missing` may reach `notFound()`, and it is
 * reachable only from a 404 the API itself sent about an id the reader supplied.
 */

import type { ScenarioResponse } from '@prl/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';
import { ScenarioStage } from '../../../components/ScenarioStage.tsx';
import { LAB_SCENARIO_SUMMARIES, scenarioFixture } from '../../../fixtures/scenarios.ts';
import { API_PATHS, apiGet, isApiUnavailable, isMissingResource, safeFetch } from '../../../lib/api.ts';
import { difficultyLabel, topicLabel } from '../../../lib/lab-labels.ts';
import { scenarioToPlayerView } from '../../../lib/scenario-view.ts';
import '../../../styles/page.css';
import '../../../styles/lab.css';

interface RouteParams {
  readonly scenarioId: string;
}

type ScenarioState =
  /** The API answered. */
  | { readonly state: 'live'; readonly response: ScenarioResponse }
  /** The API did not, and the bundled copy carries this scenario. Labelled on the page. */
  | { readonly state: 'sampled'; readonly response: ScenarioResponse; readonly detail: string }
  /** The API said 404 about an id the reader supplied. The only route to `notFound()`. */
  | { readonly state: 'missing' }
  /** The API is unreachable and the bundled copy does not carry this one. Explained, not 404'd. */
  | { readonly state: 'unavailable'; readonly detail: string };

async function loadScenario(id: string): Promise<ScenarioState> {
  const result = await safeFetch<ScenarioResponse>(() => apiGet<ScenarioResponse>(API_PATHS.scenario(id)));
  if (result.ok) return { state: 'live', response: result.data };

  const error = result.error;
  // `id` came out of the URL, so a 404 is the API answering "no such scenario" — the one condition
  // that earns the not-found screen.
  if (isMissingResource(error)) return { state: 'missing' };
  if (!isApiUnavailable(error)) throw error;
  const fixture = scenarioFixture(id);
  if (fixture !== null) return { state: 'sampled', response: fixture, detail: error.message };
  return { state: 'unavailable', detail: error.message };
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

/**
 * The screen for "the scenario service is not answering and this one is not in the bundle".
 *
 * It names the scenario where it can. `LAB_SCENARIO_SUMMARIES` is the bundled index — thirty-six
 * titles, of which only six have a full fixture behind them — so for most ids this page can still
 * say WHICH scenario the reader asked for even though it cannot stage it. That matters: "Rule of 4:
 * a big draw on the flop could not be loaded" is a different message from "there is nothing at this
 * address", and the difference is the whole ticket.
 *
 * A 200 carrying an explanation rather than a 503: a server component can set a status only through
 * `notFound()` and the experimental auth interrupts. The status is the smaller of the two problems
 * and the false sentence was the larger one.
 */
function ScenarioUnavailable({
  scenarioId,
  detail,
}: {
  readonly scenarioId: string;
  readonly detail: string;
}): ReactElement {
  const summary = LAB_SCENARIO_SUMMARIES.find((candidate) => candidate.id === scenarioId);
  return (
    <div className="prl-container prl-lab-page">
      <header className="prl-page-head">
        <p className="prl-eyebrow">
          <a className="prl-crumb" href="/lab">
            Scenario Lab
          </a>
        </p>
        <h1 className="prl-display-2 prl-page-head__title">
          {summary === undefined ? 'This scenario could not be loaded' : summary.title}
        </h1>
        <p className="prl-page-head__standfirst">
          The scenario service is not reachable, and this scenario is not one of the six carried in the
          bundled copy — so there is nothing here to stage the situation from.{' '}
          {summary === undefined
            ? 'Nothing here has established whether this scenario exists.'
            : 'The scenario exists: its title above comes from the bundled index of all thirty-six. What is missing is the situation and the analysis, both of which are the server’s to compute.'}
        </p>
      </header>

      {summary === undefined ? null : (
        <p className="prl-note">
          <span className="prl-label">The question it asks</span> {summary.question}
        </p>
      )}
      <p className="prl-note">
        <span className="prl-label">Scenario</span> <code className="prl-mono">{scenarioId}</code>
      </p>
      <p className="prl-note">
        <span className="prl-label">What happened</span> <span className="prl-mono">{detail}</span>
      </p>
      <p className="prl-note">
        Nothing is shown in place of the analysis. Every figure in a scenario is computed from the situation
        when you open it, so an approximation drawn from somewhere else would be a different spot wearing this
        one&rsquo;s title.
      </p>

      <nav className="prl-page-nav" aria-label="Scenario Lab">
        <a href={`/lab/${encodeURIComponent(scenarioId)}`}>Try this scenario again</a>
        <a href="/lab">All scenarios</a>
        <a href="/learn">The curriculum</a>
      </nav>
    </div>
  );
}

export default async function ScenarioPage({
  params,
}: {
  readonly params: Promise<RouteParams>;
}): Promise<ReactElement> {
  const { scenarioId } = await params;
  const data = await loadScenario(scenarioId);
  // The ONLY route to the not-found screen: the API itself said there is no such scenario.
  if (data.state === 'missing') notFound();
  if (data.state === 'unavailable') {
    return <ScenarioUnavailable scenarioId={scenarioId} detail={data.detail} />;
  }

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

      {data.state === 'sampled' ? (
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
