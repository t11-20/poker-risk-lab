'use client';

/**
 * One scenario, staged: the assumptions, the situation, the decision, then the analysis.
 *
 * The assumptions come before the decision, never collapsed. That position is a product requirement.
 * There is no score and no "correct". The reveal shows the chosen action's EV, the benchmark and the
 * tolerance from `judgeConsistency`, so the reader can check and dispute the comparison.
 *
 * Committing posts to `POST /content/scenarios/:id/attempt` from the browser, which holds the CSRF
 * token, and the panel shows the server's `consistentWithAnalysis`, the verdict that was recorded.
 * When the request fails the shared rule runs locally and the panel says so.
 *
 * Committing moves focus to the reveal, because the reader pressed the button. Table types come from
 * `@prl/ui`, so no engine code is one autocomplete away from the browser bundle.
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
  nearestPricedSentence,
  type ScenarioAction,
} from '../lib/consistency.ts';
import { verdictRuleSentence } from '../lib/verdict-rule.ts';
import { FoldEquityControl } from './FoldEquityControl.tsx';

export interface ScenarioStageProps {
  readonly scenario: Scenario;
  readonly analysis: CoachReport;
  /**
   * Required, because `judgeConsistency` measures its margin in big blinds and a `CoachReport` does
   * not carry the stakes. Without it the verdict would use a one-chip margin while the server used 20.
   */
  readonly bigBlind: number;
  readonly view: PlayerView;
  readonly legalActions: readonly LegalAction[];
  readonly seatNames: Readonly<Record<number, string>>;
  readonly glossary: readonly GlossaryEntry[];
  /** Where "next scenario" goes, or null when this is the last one in the current filter. */
  readonly nextHref: string | null;
  readonly compareHref: string;
}

interface Committed {
  readonly action: ScenarioAction;
  readonly to: number | null;
}

/**
 * `'unavailable'` means the request could not be made. Not an error, because the shared rule gives
 * the same verdict locally and the panel says which one it shows.
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

function toCommitted(action: TableAction): Committed {
  if (action.type === 'bet' || action.type === 'raise') return { action: action.type, to: action.to };
  return { action: action.type, to: null };
}

/** Says "level with it" when the figure rounds to zero, so the panel never prints "0.0 units behind". */
function distanceText(behind: number): string {
  const shown = Number(Math.abs(behind).toFixed(1));
  if (shown === 0) return 'level with it';
  return `${formatUnits(shown, { decimals: 1 })} ${behind > 0 ? 'behind it' : 'ahead of it'}`;
}

/** The benchmark rows of the Verdict panel, or nothing for an unpriced action. See the call site. */
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
          {/* Keyed on the action. A fold is judged against the best no-fold row, which can be negative. */}
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

/** The rule in words with this action's numbers, so the figures do not read as contradictions. */
function VerdictRule(props: {
  readonly judgement: Consistency;
  readonly action: ScenarioAction;
}): ReactElement | null {
  const rule = verdictRuleSentence(props.judgement, props.action);
  return rule === null ? null : <p className="prl-prose prl-stage__verdict-rule">{rule}</p>;
}

/** The chip beside the three numbers behind it, so the verdict is an argument the reader can check. */
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
  // The server's answer wins when there is one, because it is the verdict that was recorded.
  const consistent = server.state === 'live' ? server.consistent : judgement.consistent;
  return (
    <>
      <div className="prl-stage__verdict">
        {/*
          Three states. An unpriced size or action gets an `info` chip, because the Coach prices
          discrete rungs and had no opinion about it. Not a caution, because the learner made no mistake.
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
                : 'This verdict is the one kept on your record.'
              : 'Nothing was recorded, because this browser has no guest session to keep it on.'
            : server.state === 'pending'
              ? 'Checking your action. The figures below are the same rule, worked out in your browser.'
              : 'Your decision could not be sent, so this verdict was worked out in your browser by the same rule, and nothing was recorded.'}
        </span>
      </div>

      <VerdictRule judgement={judgement} action={action} />

      {/* Points at the priced sizes. Only a typed or dragged total reaches this. */}
      {judgement.nearestPriced === null ? null : (
        <p className="prl-note">{nearestPricedSentence(action, judgement.nearestPriced, formatUnits)}</p>
      )}

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
          The rule asks whether the action beats folding, so the benchmark rows show it. The distance
          is `behindBenchmarkUnits`, not `shortfallUnits`, which is zero for a consistent action. None
          render for an unpriced action.
        */}
        <BenchmarkRows judgement={judgement} action={action} />
      </dl>
    </>
  );
}

/** The fold-assumption sentence, naming the rows it moves (`foldAssumingActions`). */
function foldAssumptionSentence(actions: readonly ScenarioAction[]): string {
  const opening =
    'Both figures come from the candidate table further down, and both rest on the assumptions you read at the top';
  if (actions.length === 0) {
    return `${opening}. No row in this table assumes the opponent folds, so its figures move with the range and the price: if you think either is wrong, disagreeing with them on those grounds is exactly the reasoning this scenario is for.`;
  }
  const rows = actions.map((action) => ACTION_WORD[action].toLowerCase()).join(' and ');
  return `${opening} — including the assumed fold frequency, which somebody chose. If you think that fold assumption is too generous, the rows it moves are the ${rows} rows: change it in the next panel and watch them move. Disagreeing with it on those grounds is exactly the reasoning this scenario is for.`;
}

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
    // Only the reader's own commit makes `committed` non-null.
    if (committed !== null) {
      // Focus without scrolling, then align the reveal's start. A bare focus call left the heading
      // under the sticky bar (360x640), and the root `scroll-padding` from `--prl-pillbar-h` clears it.
      const reveal = revealRef.current;
      reveal?.focus({ preventScroll: true });
      reveal?.scrollIntoView({ block: 'start' });
      return;
    }
    // "Choose again" unmounts the focused button, dropping focus to `<body>`. Focus goes to the first
    // action instead.
    if (!choseAgain.current) return;
    choseAgain.current = false;
    const decision = document.getElementById(decisionId);
    const first =
      decision?.querySelector<HTMLElement>('.prl-action-bar__actions button:not(:disabled)') ??
      decision?.querySelector<HTMLElement>('button:not(:disabled)');
    first?.focus();
  }, [committed, decisionId]);

  /**
   * Grades the committed action on the server, aborting on unmount or a second commit. Sent from the
   * browser, because only it holds the CSRF token and cookie. Every failure is `'unavailable'`.
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
        {/* The intro is stated because this list comes before every figure on the page. */}
        <AssumptionList
          items={scenario.assumptions}
          headingLevel={3}
          intro="Change any of these and the figures in the analysis below change with it."
        />
      </Panel>

      {/* 2. The situation. The question and title are already the page's standfirst and heading. */}
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
              is what lets the analysis tell you something about your own reasoning. Once this browser has a
              guest session, a scenario you decide is marked as attempted on your record; there is no mark,
              total or streak.
            </p>
            <ActionBar
              legalActions={legalActions}
              onAct={(action) => setCommitted(toCommitted(action))}
              pot={view.potTotal}
              toCall={view.amountToCall}
              committedThisStreet={hero?.committedThisStreet ?? 0}
              idleText="This scenario offers no decision to make. That is a fault in the scenario, not something you did."
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
          `aria-label`, not `aria-labelledby` on the Panel. `Panel` puts the id on its `<section>`, so
          the name was the whole panel's text, read on every entry to the landmark.
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
              {/* Only when a row was written, which `recorded` says. */}
              {server.state === 'live' && server.recorded ? (
                <>
                  {' '}
                  There is no score. This scenario is now on your record as one you have attempted, along with
                  the action you chose and — only where the analysis actually supports a single action —
                  whether yours was one of them. Where it supports several, which is common, nothing is
                  recorded about which you picked, because there would be nothing true to record.
                </>
              ) : null}
            </Callout>
          </Panel>

          {/* After the verdict, so the decision is judged first, and before the reasoning. */}
          <FoldEquityControl report={analysis} />

          <Panel title="The reasoning" eyebrow="Why" index={6} headingLevel={2}>
            {scenario.reasoning.split('\n\n').map((paragraph) => (
              <p className="prl-prose" key={paragraph.slice(0, 48)}>
                {paragraph}
              </p>
            ))}
          </Panel>

          <Panel title="Ways this spot is commonly misread" eyebrow="Mistakes" index={7} headingLevel={2}>
            <ul className="prl-stage__mistakes">
              {scenario.commonMistakes.map((mistake) => (
                <li key={mistake.slice(0, 48)}>{mistake}</li>
              ))}
            </ul>
          </Panel>

          <CoachPanel report={analysis} title="The analysis in full" />

          {glossary.length === 0 ? null : (
            <Panel title="Terms used here" eyebrow="Glossary" index={8} headingLevel={2}>
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
