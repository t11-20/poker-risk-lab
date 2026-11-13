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
 * deliberately allowed into the browser is `lib/deck-proof.ts`, the client-side deck-proof check
 * behind `CommitmentVerifier`.
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
  // The bundled content, not `LAB_SCENARIO_SUMMARIES`: that is the six offline fixtures, whose ids
  // are not the API's, and looking the id up there titled all 36 real pages "Scenario".
  return scenarioPageMetadata(scenarioId);
}

/**
 * The next scenario in the Lab index's own order, so "next" is a stable route rather than a guess.
 *
 * `lib/lab-next.ts` has the defect this replaced. The list is asked for anonymously: the order is
 * the same for everybody and only the attempt marks are per-reader, so forwarding the session
 * cookie would buy nothing. ANY failure falls back to the bundle rather than to no button — the
 * scenario itself has already loaded, and a missing "next" is not worth an error page.
 *
 * A page rendered from the fixture walks the fixture: those six ids are the only ones that can be
 * staged while the API is away, so a "next" into the bundle would mostly lead to the unavailable
 * screen.
 */
async function nextHrefAfter(id: string, state: 'live' | 'sampled'): Promise<string | null> {
  if (state === 'sampled') return nextScenarioHref(id, LAB_SCENARIO_SUMMARIES);
  const list = await safeFetch<ScenarioListResponse>(() =>
    apiGet<ScenarioListResponse>(API_PATHS.scenarios()),
  );
  return nextScenarioHref(id, list.ok ? list.data.scenarios : null);
}

/**
 * The screen for "the scenario service is not answering and this one is not in the bundle".
 *
 * It names the scenario where it can. The bundled content (`bundledScenarioTitle`) carries every
 * scenario's title and question even though the analysis is the server's to compute, so for every
 * id this route can render the page can still say WHICH scenario the reader asked for even though
 * it cannot stage it. It used to read `LAB_SCENARIO_SUMMARIES`, which a comment here called "the
 * bundled index — thirty-six titles" and which is the six offline fixtures, under ids the API does
 * not use: it named none of them. That matters: "Rule of 4:
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
  // The ONLY route to the not-found screen: the API itself said there is no such scenario.
  if (data.state === 'missing') return <NotFoundBody />;
  if (data.state === 'unavailable') {
    return <ScenarioUnavailable scenarioId={scenarioId} detail={data.detail} />;
  }

  const { scenario, analysis, glossary } = data.response;
  const table = scenarioToPlayerView(scenario);
  // A scenario whose seats or cards will not parse cannot be staged. That is a content bug, and a
  // 404 is the honest outcome: the alternative is a question asked without the situation it needs.
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
          {/* The fallback is `src/fixtures/scenarios.ts`, built by `readSituation` and `buildCoachReport`
              — which is what this used to say, file path and function names included (UX audit at
              6b3886e, M5). The learner needs the consequence: same maths, worked out in advance. */}
          <span className="prl-label prl-label--accent">Bundled copy</span> This scenario could not be loaded
          live, so this is the copy that ships with the app. Its analysis was worked out by the same maths,
          ahead of time rather than for you just now, so the figures are the same ones the live Lab shows.
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
