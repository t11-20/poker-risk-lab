/**
 * One scenario. The table view is projected here so the engine stays out of the client bundle.
 * Only the API's own 404 (`missing`) renders the not-found body. An unreachable API with no bundled
 * copy gets an explanation instead, because the bundle carries six of the thirty-six scenarios.
 */

import { scenarios } from '@prl/content';
import type { ScenarioListResponse, ScenarioResponse } from '@prl/contracts';
import type { Metadata } from 'next';
import type { ReactElement } from 'react';
import { ScenarioStage } from '../../../components/ScenarioStage.tsx';
import { LAB_SCENARIO_SUMMARIES, scenarioFixture } from '../../../fixtures/scenarios.ts';
import { API_PATHS, apiGet, isApiUnavailable, isMissingResource, safeFetch } from '../../../lib/api.ts';
import { difficultyLabel, topicLabel } from '../../../lib/lab-labels.ts';
import { nextScenarioHref } from '../../../lib/lab-next.ts';
import { bundledScenarioTitle, scenarioPageMetadata } from '../../../lib/lab-scenario-titles.ts';
import { scenarioSeatName, scenarioToPlayerView } from '../../../lib/scenario-view.ts';
import { NotFoundBody } from '../../not-found.tsx';
import '../../../styles/page.css';
import '../../../styles/lab.css';

interface RouteParams {
  readonly scenarioId: string;
}

export function generateStaticParams(): { scenarioId: string }[] {
  return scenarios().map((scenario) => ({ scenarioId: scenario.id }));
}

export const dynamicParams = false;

type ScenarioState =
  | { readonly state: 'live'; readonly response: ScenarioResponse }
  /** The bundled copy carries this scenario. Labelled on the page. */
  | { readonly state: 'sampled'; readonly response: ScenarioResponse; readonly detail: string }
  /** The API said 404. The only route to the not-found body. */
  | { readonly state: 'missing' }
  | { readonly state: 'unavailable'; readonly detail: string };

async function loadScenario(id: string): Promise<ScenarioState> {
  const result = await safeFetch<ScenarioResponse>(() => apiGet<ScenarioResponse>(API_PATHS.scenario(id)));
  if (result.ok) return { state: 'live', response: result.data };

  const error = result.error;
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
  // Not `LAB_SCENARIO_SUMMARIES`, whose six fixture ids are not the API's.
  return scenarioPageMetadata(scenarioId);
}

/**
 * The Lab index's order. Asked anonymously, because the order is the same for everybody. Any failure
 * falls back to the bundle. A fixture page walks the fixture, the only ids stageable offline.
 */
async function nextHrefAfter(id: string, state: 'live' | 'sampled'): Promise<string | null> {
  if (state === 'sampled') return nextScenarioHref(id, LAB_SCENARIO_SUMMARIES);
  const list = await safeFetch<ScenarioListResponse>(() =>
    apiGet<ScenarioListResponse>(API_PATHS.scenarios()),
  );
  return nextScenarioHref(id, list.ok ? list.data.scenarios : null);
}

/**
 * Names the scenario from the bundled content, which carries every title even without an analysis.
 * A 200, because a server component can set a status only through `notFound()` and the experimental
 * auth interrupts.
 */
function ScenarioUnavailable({
  scenarioId,
  detail,
}: {
  readonly scenarioId: string;
  readonly detail: string;
}): ReactElement {
  const summary = bundledScenarioTitle(scenarioId);
  return (
    <div className="prl-container prl-lab-page">
      <header className="prl-page-head">
        <p className="prl-eyebrow">
          <a className="prl-crumb" href="/lab">
            Scenario Lab
          </a>
        </p>
        <h1 className="prl-display-2 prl-page-head__title">
          {summary === null ? 'This scenario could not be loaded' : summary.title}
        </h1>
        <p className="prl-page-head__standfirst">
          This scenario could not be loaded, and it is not one of the six that ship with the app with an
          analysis already worked out — so there is no analysis here to show.{' '}
          {summary === null
            ? 'Nothing here has established whether this scenario exists.'
            : 'The scenario exists: its title above comes from the copy that ships with the app. What is missing is the analysis, which this page could not load. Try again in a moment.'}
        </p>
      </header>

      {summary === null ? null : (
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
  if (data.state === 'missing') return <NotFoundBody />;
  if (data.state === 'unavailable') {
    return <ScenarioUnavailable scenarioId={scenarioId} detail={data.detail} />;
  }

  const { scenario, analysis, glossary } = data.response;
  const table = scenarioToPlayerView(scenario);
  // Unparseable seats or cards get a 404, rather than a question without its situation.
  if (table === null) return <NotFoundBody />;

  const seatNames: Record<number, string> = {};
  for (const seat of scenario.seats) seatNames[seat.seat] = scenarioSeatName(seat);

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
          <span className="prl-label prl-label--accent">Bundled copy</span> This scenario could not be loaded
          live, so this is the copy that ships with the app. Its analysis was worked out by the same maths,
          ahead of time rather than for you just now, so the figures are the same ones the live Lab shows.
        </p>
      ) : null}

      <ScenarioStage
        scenario={scenario}
        analysis={analysis}
        // A required prop, because `judgeConsistency` measures its margin in big blinds and a
        // `CoachReport` carries no stakes. Do not attach the big blind to the report instead.
        bigBlind={scenario.bigBlind}
        view={table.view}
        legalActions={table.legalActions}
        seatNames={seatNames}
        glossary={glossary}
        nextHref={await nextHrefAfter(scenario.id, data.state)}
        compareHref={`/legends/compare?scenario=${encodeURIComponent(scenario.id)}`}
      />

      <nav className="prl-page-nav" aria-label="Scenario Lab">
        <a href="/lab">All scenarios</a>
        <a href="/legends">AI Legends</a>
        <a href="/review">Your hand history</a>
      </nav>
    </div>
  );
}
