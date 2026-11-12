'use client';

/**
 * One scenario, staged: the situation on the real table, the decision, and the analysis afterwards.
 *
 * ============================================================================
 * THE ORDER OF THE PAGE IS THE PEDAGOGY
 * ============================================================================
 *
 * 1. **The assumptions, before the decision.** Not after it, not behind a disclosure, not in a
 *    tooltip. Every figure in the analysis rests on a stated range and a stated fold frequency, and
 *    asking somebody to decide without telling them the range is not a fair question — it is a
 *    guessing game with a scoring system attached. This is the one thing on the screen whose
 *    position is a product requirement rather than a layout choice.
 * 2. The question and the situation, on the same `PokerTable` a live hand uses.
 * 3. The decision, through the same `ActionBar` a live hand uses, with the cost printed on every
 *    button.
 * 4. Only then: the analysis, the reasoning, the named mistakes.
 *
 * ============================================================================
 * WHY THERE IS NO SCORE, AND WHAT REPLACES IT
 * ============================================================================
 *
 * No mark, no percentage, no streak, no progress bar, and the word "correct" appears nowhere. What
 * the reveal shows instead is a comparison the reader can check and argue with: the expected value
 * of the action they chose, the best expected value in the report's own candidate table, and the
 * tolerance between the two that this app is willing to call a real difference. All three come from
 * `judgeConsistency` in `src/lib/consistency.ts`, and all three are on screen.
 *
 * That framing is not a euphemism for a grade. It is a genuinely different claim: "this action is
 * worth 34.9 units and the best row is worth 107.2, under the assumed 35% fold frequency stated
 * above" is checkable and disputable. "You got it wrong" is neither. A reader who thinks the fold
 * assumption is too generous can look at the row it moves and disagree with the analysis, which is
 * the behaviour this whole product is trying to teach.
 *
 * ## The verdict the reader sees is the verdict the server recorded
 *
 * Committing posts the action to `POST /content/scenarios/:id/attempt` and the panel shows
 * `ScenarioAttemptResponse.consistentWithAnalysis` when it arrives. That is a correction, and the
 * defect it closes is worth stating: this component used to judge locally and never read the
 * server's answer at all, while the server's answer was the one written to
 * `scenario_attempts.matched_expected`. The two rules also disagreed — a flat five chips here
 * against one big blind there — so the product could tell somebody their decision was defensible
 * and record that it was not. The rule now lives once, in `@prl/poker-math/consistency`, and both
 * sides call it; showing the server's boolean is the second half, because "the same code, so the
 * same answer" stops being a guarantee the moment one side is deployed ahead of the other.
 *
 * The request is made from the browser, deliberately. It needs a CSRF token, the browser holds the
 * paired cookie, and a server render holds neither. When it cannot be made, the panel falls back to
 * the shared rule computed here and says so — it never presents a local verdict as the server's.
 *
 * The copy here never renders that boolean without the two numbers behind it.
 *
 * ## Choosing again is allowed, and framed as comparison
 *
 * "Choose again" resets the reveal. That is not a retry-until-correct loop, because there is nothing
 * to be correct about and nothing is recorded; it is how a reader tries the other line and reads the
 * other row of the EV table. The button says so.
 *
 * ## Focus, and why moving it here is right
 *
 * Committing moves focus to the revealed analysis. The rule against moving focus applies to *remote*
 * events — a table update, a live figure arriving — because those are not the reader's doing. This is
 * a button the reader pressed, and content appearing below the fold that the keyboard has to hunt for
 * is the worse failure. The target takes `tabIndex={-1}` so it is focusable programmatically without
 * becoming a tab stop.
 *
 * ## Why the table types come from `@prl/ui` and not from `@prl/poker-engine`
 *
 * They are the same types — `@prl/ui`'s `view-types.ts` projects them out of the WebSocket contract,
 * so `PlayerView` there IS the engine's `PlayerView`. Importing them from `@prl/ui` keeps this client
 * component's import graph to the two packages that are meant to reach a browser, and means nothing
 * in the engine is one careless autocomplete away from the bundle.
 */

import type {
  CoachReport,
  GlossaryEntry,
  Scenario,
  ScenarioAttemptRequest,
  ScenarioAttemptResponse,
} from '@prl/contracts';
import {
  ActionBar,
  AssumptionList,
  Button,
  Callout,
  Chip,
  CoachPanel,
  formatSignedUnits,
  formatUnits,
  type LegalAction,
  Panel,
  type PlayerView,
  PokerTable,
  type TableAction,
} from '@prl/ui';
import { type ReactElement, useEffect, useId, useRef, useState } from 'react';
import { API_PATHS, apiSend, fetchSession, safeFetch } from '../lib/api.ts';
import {
  type Consistency,
  foldAssumingActions,
  judgeConsistency,
  type ScenarioAction,
} from '../lib/consistency.ts';

export interface ScenarioStageProps {
  readonly scenario: Scenario;
  readonly analysis: CoachReport;
  /**
   * The stakes the analysis is denominated in.
   *
   * Passed explicitly rather than smuggled in on the report. `judgeConsistency` measures its
   * indifference margin in big blinds — one big blind is what the API grades with — and a
   * `CoachReport` carries expected values in chips and nothing that says what a chip is worth. The
   * lab page used to work around that by attaching the big blind to the report itself, so that the
   * margin travelled inside the data. (That helper has since been removed; do not reintroduce it.)
   * It worked, and it made the dependency invisible: nothing in this component's signature said it
   * needed the stakes, so nothing would have failed if a caller stopped attaching them — the
   * verdict would quietly have been judged against a one-chip margin while the server recorded a
   * twenty-chip one. A required prop cannot be forgotten.
   */
  readonly bigBlind: number;
  readonly view: PlayerView;
  readonly legalActions: readonly LegalAction[];
  readonly seatNames: Readonly<Record<number, string>>;
  readonly glossary: readonly GlossaryEntry[];
  /** Where "next scenario" goes, or null when this is the last one in the current filter. */
  readonly nextHref: string | null;
  /** The Legends compare page, pre-pointed at this scenario. */
  readonly compareHref: string;
}

interface Committed {
  readonly action: ScenarioAction;
  readonly to: number | null;
}

/**
 * What the server said about the action the reader committed.
 *
 * `'pending'` while the request is in flight, `'unavailable'` when it could not be made — an outage,
 * or a reader with scripting on and no network. Neither is an error state for this screen: the
 * shared rule in `@prl/poker-math` produces the same verdict locally, and the panel says which of
 * the two it is showing rather than pretending they are interchangeable.
 */
type ServerVerdict =
  | { readonly state: 'pending' }
  | { readonly state: 'unavailable' }
  | {
      readonly state: 'live';
      readonly consistent: boolean;
      readonly reasoning: string;
      readonly recorded: boolean;
    };

const ACTION_WORD: Readonly<Record<ScenarioAction, string>> = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise',
};

/** A `TableAction` from the action bar, reduced to what the analysis is keyed on. */
function toCommitted(action: TableAction): Committed {
  if (action.type === 'bet' || action.type === 'raise') return { action: action.type, to: action.to };
  return { action: action.type, to: null };
}

/**
 * How far behind the benchmark, in words that carry the direction: "2.9 units behind it", "4.1 units
 * ahead of it", or "level with it" when the figure rounds to nothing at the precision shown — so the
 * panel never prints "0.0 units behind" beside a nonzero EV.
 */
function distanceText(behind: number): string {
  const shown = Number(Math.abs(behind).toFixed(1));
  if (shown === 0) return 'level with it';
  return `${formatUnits(shown, { decimals: 1 })} ${behind > 0 ? 'behind it' : 'ahead of it'}`;
}

/** The benchmark rows of the Verdict panel, or nothing for an unpriced action. See the comment at the call. */
function BenchmarkRows({
  judgement,
  action,
}: {
  readonly judgement: Consistency;
  readonly action: ScenarioAction;
}): ReactElement | null {
  const { behindBenchmarkUnits: behind, withinAllowance: within } = judgement;
  if (behind === null || within === null) return null;
  return (
    <>
      <div className="prl-stage__ev-row">
        <dt className="prl-label">Judged against</dt>
        <dd className="prl-stage__ev-value">
          {/* Keyed on the ACTION, not on the benchmark's value. A fold is judged against the best
              row that assumes no folds, which is floored at 0 — so keying on `benchmarkEv === 0`
              printed "folding, worth 0" under a fold whose best no-fold row was negative, measured
              on the fixture's river-bluff-catch-range: a fold judged against folding. */}
          {action === 'fold'
            ? `the best row that assumes no folds, worth ${formatSignedUnits(judgement.benchmarkEv, { decimals: 1 })}`
            : 'folding, worth 0'}
        </dd>
      </div>
      <div className="prl-stage__ev-row">
        <dt className="prl-label">Distance from that</dt>
        <dd className="prl-stage__ev-value">{distanceText(behind)}</dd>
      </div>
      <div className="prl-stage__ev-row">
        <dt className="prl-label">Allowance</dt>
        <dd className="prl-stage__ev-value">
          {`${within ? 'within' : 'outside'} the allowance of ${formatUnits(judgement.toleranceUnits)}`}
        </dd>
      </div>
    </>
  );
}

/**
 * The comparison, and the three numbers behind it.
 *
 * All three are on screen together on purpose. A chip on its own would be a verdict; a chip beside
 * "your action is worth X, the best row is worth Y, and this app calls anything within Z the same
 * decision" is an argument the reader can take apart. The tolerance is displayed rather than hidden
 * for the same reason — a threshold nobody can see is a threshold nobody can dispute.
 */
function Verdict({
  judgement,
  action,
  server,
}: {
  readonly judgement: Consistency;
  readonly action: ScenarioAction;
  readonly server: ServerVerdict;
}): ReactElement {
  const best =
    judgement.bestAction === null
      ? ''
      : ` — ${ACTION_WORD[judgement.bestAction]}${judgement.bestTo === null ? '' : ` to ${formatUnits(judgement.bestTo)}`}`;
  // The server's answer wins when there is one: it is the verdict that was recorded, and showing
  // the reader a different one is the defect this component was fixed for.
  const consistent = server.state === 'live' ? server.consistent : judgement.consistent;
  return (
    <>
      <div className="prl-stage__verdict">
        {/*
          Three states, not two.

          `@prl/poker-math` states the hazard outright: "A caller that renders the boolean without
          reading `pricing` will tell somebody their decision disagreed with an analysis that never
          looked at it." This component did exactly that. The Coach prices discrete rungs while the
          ActionBar exposes a continuous range, so a learner shown "Raise — 51 to 95 units" who
          picks 70 was told their decision was not the line the analysis leans towards, when the
          analysis had no opinion about 70 at all.

          The unpriced case is `info`, deliberately, and not `caution`: nothing is wrong with the
          decision. Chip.tsx notes there is no "danger" tone because nothing here escalates, and a
          learner who sized outside the priced rungs has not made a mistake to be cautioned about.
        */}
        {judgement.pricing !== 'priced' ? (
          <Chip tone="info" glyph="?">
            {judgement.pricing === 'sizing-not-priced'
              ? 'this analysis did not price that size'
              : 'this analysis did not price that action'}
          </Chip>
        ) : (
          <Chip tone={consistent ? 'favourable' : 'caution'} glyph={consistent ? '=' : '≠'}>
            {consistent ? 'consistent with the analysis' : 'not the line the analysis leans towards'}
          </Chip>
        )}
        <span className="prl-note">
          {server.state === 'live'
            ? server.recorded
              ? judgement.pricing !== 'priced'
                ? 'The analysis covers particular sizes rather than every one, and yours is not among them. That is not a judgement on your decision — there is nothing here to compare it with.'
                : 'This is the server’s own verdict on your action — the same one it recorded.'
              : 'This is the server’s own verdict on your action. Nothing was recorded, because there is no session to attach it to.'
            : server.state === 'pending'
              ? 'Asking the server for its verdict. The figures below are the shared rule applied here, and the two agree.'
              : 'The server could not be reached, so this verdict is the shared rule applied in your browser. It is the same rule the server grades with.'}
        </span>
      </div>

      <dl className="prl-stage__ev">
        <div className="prl-stage__ev-row">
          <dt className="prl-label">Your action is worth</dt>
          <dd className="prl-stage__ev-value">
            {judgement.chosenEv === null
              ? 'the analysis did not price this action'
              : formatSignedUnits(judgement.chosenEv, { decimals: 1 })}
          </dd>
        </div>
        <div className="prl-stage__ev-row">
          <dt className="prl-label">Best row on the table</dt>
          <dd className="prl-stage__ev-value">
            {`${formatSignedUnits(judgement.bestEv, { decimals: 1 })}${best}`}
          </dd>
        </div>
        {/*
          The benchmark, the distance from it, and whether that distance fits the allowance.

          Without the benchmark rows the panel showed the chosen EV, the best row and the tolerance —
          three numbers whose only natural reading is "consistent when the best row minus mine fits
          inside the tolerance". That is not the rule. The rule asks whether the action beats
          FOLDING, so a learner could see +20.6 against a best row of +51.4, a tolerance of 10, and
          the words "consistent with the analysis", with no way to tell that the panel was right.

          The distance and the allowance are two rows because they are two facts. They used to be one
          — "Shortfall against that: 0.0 units, against an allowance of 10 units" — printing
          `shortfallUnits`, which the shared rule zeroes for a consistent action on purpose. Measured
          at commit 308fadf, a call worth −2.9 against folding worth 0 read "0.0" there: a figure
          that is right for "how far outside the allowance" printed under a label that says "how far
          behind". `behindBenchmarkUnits` is the distance; `withinAllowance` is the verdict restated.

          None of the three render for an action the analysis did not price: "judged against
          folding" is not true of a decision nothing judged, and a distance from a figure the action
          has none of is not a number.
        */}
        <BenchmarkRows judgement={judgement} action={action} />
      </dl>
    </>
  );
}

/**
 * The callout's sentence about the fold assumption, naming the rows it actually moves.
 *
 * It used to say "the row it moves is the raise row" on every scenario — wrong on a table of bet
 * rows, and wrong on a table with no fold assumption at all. `foldAssumingActions` reads the rows.
 */
function foldAssumptionSentence(actions: readonly ScenarioAction[]): string {
  const opening =
    'Both figures come from the candidate table further down, and both rest on the assumptions you read at the top';
  if (actions.length === 0) {
    return `${opening}. No row in this table assumes the opponent folds, so its figures move with the range and the price: if you think either is wrong, disagreeing with them on those grounds is exactly the reasoning this scenario is for.`;
  }
  const rows = actions.map((action) => ACTION_WORD[action].toLowerCase()).join(' and ');
  return `${opening} — including the assumed fold frequency, which somebody chose. If you think that fold assumption is too generous, the rows it moves are the ${rows} rows, and disagreeing with it on those grounds is exactly the reasoning this scenario is for.`;
}

/** One glossary term, with its formula beneath the definition where it has one. */
function GlossaryRow({ entry }: { readonly entry: GlossaryEntry }): ReactElement {
  return (
    <div className="prl-stage__glossary-row">
      <dt>{entry.term}</dt>
      <dd>
        {entry.definition}
        {entry.formula === undefined ? null : (
          <span className="prl-mono prl-stage__glossary-formula">{entry.formula}</span>
        )}
      </dd>
    </div>
  );
}

export function ScenarioStage(props: ScenarioStageProps): ReactElement {
  const { scenario, analysis, bigBlind, view, legalActions, seatNames, glossary, nextHref, compareHref } =
    props;
  const [committed, setCommitted] = useState<Committed | null>(null);
  const [server, setServer] = useState<ServerVerdict>({ state: 'pending' });
  const revealRef = useRef<HTMLDivElement>(null);
  const revealId = useId();

  const decisionId = useId();
  /** Set by "Choose again" and nothing else, so a first render never moves focus. */
  const choseAgain = useRef(false);

  useEffect(() => {
    // Only ever after the reader's own commit — `committed` cannot become non-null any other way.
    if (committed !== null) {
      // Focus without the browser's own scroll, then align the START of the reveal.
      //
      // A bare `focus()` scrolls only when the target is out of view, and the reveal never is: it
      // mounts directly under the decision the reader just made, so its top edge was already on
      // screen, under the sticky bar. Measured at 360x640 on the production build: reveal top 60px
      // against a bar whose bottom is 77px. The audit saw the panel's heading at -1..51px on a live
      // scenario. A `scroll-margin-block-start` on the reveal was measured too, and it does not
      // help: at 360 it changed nothing, because nothing scrolled, and at 1440 it stacked on the
      // root's `scroll-padding` and pushed the reveal to 172px. `scrollIntoView({ block: 'start' })`
      // always aligns, and alignment honours the root `scroll-padding-block-start` that nav.css
      // derives from `--prl-pillbar-h`. So the clearance comes from the bar's own token, not from
      // a literal here. Measured after: reveal top 132px at 360x640 and 80px at 1440x900, both
      // clear of the 77px bar. The root's `scroll-behavior` still decides whether the scroll is
      // smooth, so reduced motion is respected.
      const reveal = revealRef.current;
      reveal?.focus({ preventScroll: true });
      reveal?.scrollIntoView({ block: 'start' });
      return;
    }
    // "Choose again" unmounts the button that was just pressed, along with the whole reveal, and a
    // focused element that leaves the DOM drops focus to <body> — measured at 308fadf,
    // `document.activeElement` was BODY after pressing it, so a keyboard reader's next Tab started
    // from the top of the page, several screens above the decision they had asked to retake. Focus
    // goes to the first action the ActionBar offers instead: the control the button promised.
    if (!choseAgain.current) return;
    choseAgain.current = false;
    const decision = document.getElementById(decisionId);
    const first =
      decision?.querySelector<HTMLElement>('.prl-action-bar__actions button:not(:disabled)') ??
      decision?.querySelector<HTMLElement>('button:not(:disabled)');
    first?.focus();
  }, [committed, decisionId]);

  /**
   * Asks the server to grade the committed action, and abandons the request on unmount or on a
   * second commit.
   *
   * Sent from the browser rather than from the render, because this is the one path that
   * legitimately holds a CSRF token: the session endpoint issues one to the page and the browser
   * has the paired cookie. A server render has neither.
   *
   * Every failure lands on `'unavailable'` and nothing throws. The verdict is not the point of this
   * screen — the three figures under it are — and replacing a working analysis with an error page
   * because a POST timed out would be the wrong trade twice over.
   */
  useEffect(() => {
    if (committed === null) return;
    const controller = new AbortController();
    setServer({ state: 'pending' });
    void (async () => {
      const session = await fetchSession({ signal: controller.signal });
      const token = session.ok ? session.data.csrfToken : null;
      if (token === null) {
        setServer({ state: 'unavailable' });
        return;
      }
      const attempt = await safeFetch<ScenarioAttemptResponse>(() =>
        apiSend<ScenarioAttemptResponse>(
          'POST',
          API_PATHS.scenarioAttempt(scenario.id),
          {
            action: committed.action,
            ...(committed.to === null ? {} : { to: committed.to }),
          } satisfies ScenarioAttemptRequest,
          { csrfToken: token, signal: controller.signal },
        ),
      );
      if (controller.signal.aborted) return;
      setServer(
        attempt.ok
          ? {
              state: 'live',
              consistent: attempt.data.consistentWithAnalysis,
              reasoning: attempt.data.reasoning,
              recorded: attempt.data.recorded,
            }
          : { state: 'unavailable' },
      );
    })();
    return () => controller.abort();
  }, [committed, scenario.id]);

  const hero = view.seats.find((seat) => seat.isSelf);
  // The big blind is passed on every call. It used to arrive attached to the report, which meant a
  // caller could omit it and the margin would silently fall back to one chip.
  const judgement =
    committed === null
      ? null
      : judgeConsistency(
          analysis,
          committed.action,
          committed.to === null ? undefined : committed.to,
          bigBlind,
        );

  return (
    <div className="prl-stage">
      {/* 1. The assumptions. Before the decision, unconditionally, never collapsed. */}
      <Panel title="What this analysis assumes" eyebrow="Read first" index={1} tone="inset" headingLevel={2}>
        <p className="prl-prose">
          Every number in this scenario depends on the statements below, so they come before the decision: a
          figure whose assumptions you have not read is one you cannot disagree with.
        </p>
        {/* The intro is stated because the list's default — "the figures above" — is written for a list
            that follows its figures, and this one comes before every figure on the page. */}
        <AssumptionList
          items={scenario.assumptions}
          headingLevel={3}
          intro="Change any of these and the figures in the analysis below change with it."
        />
      </Panel>

      {/* 2. The situation. The question is the page's standfirst and the title its heading, and
          both were printed again here, the question in a larger face than the heading above it: at
          390 that was about 250px of repetition before the table. */}
      <Panel title="The situation" eyebrow="Scenario" index={2} headingLevel={2}>
        <p className="prl-note">{scenario.facingAction}</p>
        <PokerTable view={view} seatNames={seatNames} title={`The table, ${scenario.street}`} />
        <p className="prl-note">
          This table is read-only and the cards are fixed: a scenario is a stated situation, not a dealt hand,
          so there is no deck behind it and nothing to prove about one.
        </p>
      </Panel>

      {/* 3. The decision. */}
      <Panel title="Your decision" eyebrow="Decide" index={3} headingLevel={2} id={decisionId}>
        {committed === null ? (
          <>
            <p className="prl-prose">
              {scenario.question} Choose before you read the analysis: nothing is scored, and deciding first
              is what lets the analysis tell you something about your own reasoning. Signed in, the scenario
              is marked as attempted; there is no mark, total or streak.
            </p>
            <ActionBar
              legalActions={legalActions}
              onAct={(action) => setCommitted(toCommitted(action))}
              pot={view.potTotal}
              toCall={view.amountToCall}
              committedThisStreet={hero?.committedThisStreet ?? 0}
              idleText="This scenario offers no decision, which is a content bug rather than your turn ending."
            />
          </>
        ) : (
          <div className="prl-stage__chosen">
            <p className="prl-stage__chosen-line">
              <span className="prl-label">You chose</span>
              <span className="prl-stage__chosen-action">
                {ACTION_WORD[committed.action]}
                {committed.to === null ? '' : ` to ${formatUnits(committed.to)}`}
              </span>
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                choseAgain.current = true;
                setCommitted(null);
              }}
            >
              Choose again and compare the other line
            </Button>
          </div>
        )}
      </Panel>

      {/* 4. The reveal. */}
      {committed === null || judgement === null ? null : (
        /*
          `aria-label`, not `aria-labelledby` pointing at the first Panel.

          `Panel` puts the `id` it is given on its own root `<section>`, not on its heading — so
          `aria-labelledby` resolved the name from that element's whole SUBTREE. The region's accessible
          name was the entire consistency panel read as one string: the eyebrow, the title, three EV
          figures and the four-sentence callout, announced on arrival and again every time the reader
          re-entered the landmark. A name that long is worse than none, because it buries the one phrase
          that says where you are.

          A short literal is the fix. It is what the region IS, it cannot go stale against a heading it
          does not own, and `Panel` keeps its own heading in the document outline either way.
        */
        <section
          className="prl-stage__reveal"
          id={revealId}
          ref={revealRef}
          tabIndex={-1}
          aria-label="The analysis of your decision"
        >
          <div className="prl-live-region" role="status" aria-live="polite">
            {`The analysis for ${scenario.title} is now shown below your decision.`}
          </div>

          <Panel
            title="How your action compares with the analysis"
            eyebrow="Consistency"
            index={4}
            headingLevel={2}
          >
            <Verdict judgement={judgement} action={committed.action} server={server} />

            <Callout tone="insight" title="This is a comparison, not a mark">
              {foldAssumptionSentence(foldAssumingActions(analysis))}
              {server.state === 'live' ? (
                <>
                  {' '}
                  There is no score. If you are signed in, this scenario is now marked as one you have
                  attempted, along with the action you chose and — only where the analysis actually supports a
                  single action — whether yours was one of them. Where it supports several, which is common,
                  nothing is recorded about which you picked, because there would be nothing true to record.
                </>
              ) : null}
            </Callout>
          </Panel>

          <Panel title="The reasoning" eyebrow="Why" index={5} headingLevel={2}>
            {scenario.reasoning.split('\n\n').map((paragraph) => (
              <p className="prl-prose" key={paragraph.slice(0, 48)}>
                {paragraph}
              </p>
            ))}
          </Panel>

          <Panel title="Ways this spot is commonly misread" eyebrow="Mistakes" index={6} headingLevel={2}>
            <ul className="prl-stage__mistakes">
              {scenario.commonMistakes.map((mistake) => (
                <li key={mistake.slice(0, 48)}>{mistake}</li>
              ))}
            </ul>
          </Panel>

          <CoachPanel report={analysis} title="The analysis in full" />

          {glossary.length === 0 ? null : (
            <Panel title="Terms used here" eyebrow="Glossary" index={7} headingLevel={2}>
              <dl className="prl-stage__glossary">
                {glossary.map((entry) => (
                  <GlossaryRow key={entry.id} entry={entry} />
                ))}
              </dl>
            </Panel>
          )}

          <div className="prl-stage__onward">
            <a className="prl-btn prl-btn--secondary" href={compareHref}>
              Compare this spot against the AI profiles
            </a>
            {nextHref === null ? null : (
              <a className="prl-btn prl-btn--primary" href={nextHref}>
                Next scenario
              </a>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
