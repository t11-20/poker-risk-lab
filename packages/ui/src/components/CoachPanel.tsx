/**
 * The Coach panel. It renders a `CoachReport`, and every number a learner sees comes through here.
 *
 * Always visible, never collapsible: the equity with its method and interval, the pot odds and
 * break-even equity, the suggestion with its confidence, the assumptions and the uncertainty note.
 * An assumption one click away is an assumption nobody reads. Detail (the EV table, outs card by card,
 * explanatory prose, derivations, teaching notes) goes in `<details>`, which works without JavaScript.
 *
 * Rules:
 * 1. The method chip is unconditional, with an `=` or `≈` glyph so it survives without colour.
 * 2. A Monte Carlo figure always carries its interval, or a warning that it has none.
 * 3. The suggestion is never called "correct", "optimal", "best", "GTO" or "solved". Low confidence
 *    is shown as prominently as high, and the disclaimer under it is part of the component.
 * 4. Clean and dirty outs differ by swatch, count and words, never by colour alone.
 * 5. Every figure rendered as a percentage passes a range check (`../probability.ts`) before it reaches
 *    a formatter, independently of the producer, because a report arrives as plain JSON past caches and
 *    fixtures. A stale `estimate: 1.6` once printed "160.0%". Prose fields are the producer's job.
 * 6. A count is called "outs" only where `countsAsOuts` (`../outs-count.ts`) says a card could be one.
 *
 * The panel emits `h2` and `h3`, never `h1`. The suggestion comes after the equity and the price, so a
 * reader meets the reasoning before the conclusion.
 */

import type {
  ActionCandidate,
  CoachReport,
  CoachSuggestion,
  EquitySummary,
  OutsBreakdown,
  PotOddsSummary,
  StackContext,
} from '@prl/contracts';
import type { ReactElement } from 'react';
import { parseCardText } from '../cards.ts';
import { cx } from '../cx.ts';
/**
 * `formatPercent` is deliberately not imported. Every percentage goes through `formatProbability`,
 * which returns `null` for a value that is not a probability (rule 5).
 */
import {
  describeSpr,
  formatOdds,
  formatPoints,
  formatSignedUnits,
  formatUnits,
  pluralise,
} from '../format.ts';
import { withKeys } from '../keys.ts';
import { countsAsOuts } from '../outs-count.ts';
import {
  formatProbability,
  isProbabilityDifference,
  isProbabilityFraction,
  isProbabilityPoints,
  NOT_A_PROBABILITY,
} from '../probability.ts';
import { AssumptionList } from './AssumptionList.tsx';
import { Callout } from './Callout.tsx';
import { Chip } from './Chip.tsx';
import { EquityBar } from './EquityBar.tsx';
import { Formula } from './Formula.tsx';
import { Metric } from './Metric.tsx';
import { PlayingCard } from './PlayingCard.tsx';
import { StatTile } from './StatTile.tsx';
import { UncertaintyNote } from './UncertaintyNote.tsx';

export interface CoachPanelProps {
  readonly report: CoachReport;
  readonly title?: string;
  readonly className?: string;
}

const ACTION_WORD: Readonly<Record<ActionCandidate['action'], string>> = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise',
};

const CONFIDENCE_WORD: Readonly<Record<CoachSuggestion['confidence'], string>> = {
  low: 'low confidence',
  moderate: 'moderate confidence',
  reasonable: 'reasonable confidence',
};

/** Rule 1. Never conditional. */
const METHOD_CHIP: Readonly<
  Record<EquitySummary['method'], { readonly label: string; readonly glyph: string }>
> = {
  'exact-enumeration': { label: 'exact', glyph: '=' },
  'monte-carlo': { label: 'monte carlo', glyph: '≈' },
};

/** Spelled out, because `pluralise` would produce "80,000 trial sampleds". */
const TRIAL_NOUN: Readonly<Record<EquitySummary['method'], { readonly one: string; readonly many: string }>> =
  {
    'exact-enumeration': { one: 'board enumerated', many: 'boards enumerated' },
    'monte-carlo': { one: 'trial sampled', many: 'trials sampled' },
  };

interface RefusedFigureProps {
  readonly label: string;
  /** The figure as the reader would name it, e.g. "your share of the pot". */
  readonly what: string;
}

/**
 * Stands where a figure that was not a probability would have been. The label stays. The offending
 * value is never printed, not even in an attribute (`test/coach-panel-render.test.ts` scans both).
 * It says "not a probability" rather than a dash, because the figure arrived and was rejected.
 */
function RefusedFigure({ label, what }: RefusedFigureProps): ReactElement {
  return (
    <StatTile
      label={label}
      value={NOT_A_PROBABILITY}
      note={`A probability has to sit between 0% and 100%. The value this report carried for ${what} does not, so this panel is not stating it — a figure that cannot be true is worse than one that is missing.`}
    />
  );
}

/** Sign class for an EV. Near-zero is its own case: `+0.0` reads as a win. */
function evSign(ev: number): 'positive' | 'negative' | 'neutral' {
  if (!Number.isFinite(ev) || Math.abs(ev) < 0.005) return 'neutral';
  return ev > 0 ? 'positive' : 'negative';
}

function evTone(ev: number): 'favourable' | 'adverse' | 'neutral' {
  const sign = evSign(ev);
  if (sign === 'positive') return 'favourable';
  if (sign === 'negative') return 'adverse';
  return 'neutral';
}

/**
 * Matched on the action, then narrowed by the size range. `null` rather than a guess, because an EV
 * attributed to the wrong line is worse than none.
 */
function candidateForSuggestion(
  candidates: readonly ActionCandidate[],
  suggestion: CoachSuggestion,
): ActionCandidate | null {
  const matches = candidates.filter((candidate) => candidate.action === suggestion.action);
  const range = suggestion.sizeRange;
  if (range !== undefined) {
    const inRange = matches.find(
      (candidate) => candidate.to !== undefined && candidate.to >= range.min && candidate.to <= range.max,
    );
    if (inRange !== undefined) return inRange;
  }
  return matches[0] ?? null;
}

function OutCard({ text }: { readonly text: string }): ReactElement {
  const card = parseCardText(text);
  if (card === null) return <Chip mono>{text}</Chip>;
  return <PlayingCard card={card} size="sm" />;
}

interface OutsBucketProps {
  readonly kind: 'clean' | 'dirty';
  readonly count: number;
  /**
   * False when hero is already in front. The consequence sentence changes with it, because a blank
   * does not improve two pair.
   */
  readonly areOuts: boolean;
}

/** Rule 4. The card faces are in the collapsible breakdown. The count is what a decision needs. */
function OutsBucket({ kind, count, areOuts }: OutsBucketProps): ReactElement {
  const meaning = areOuts
    ? kind === 'clean'
      ? 'These win the pot against the range assumed below if they arrive.'
      : 'These improve your hand but can still lose — the same card can complete a better hand for an opponent.'
    : kind === 'clean'
      ? 'These keep you in front of the range assumed below, with almost nothing left to go wrong.'
      : 'These leave you in front but not safe — the card still to come can take the pot back.';
  return (
    <div className={cx('prl-outs__bucket', `prl-outs__bucket--${kind}`)}>
      <div className="prl-outs__bucket-head">
        <span className="prl-outs__swatch" aria-hidden="true" />
        <span className="prl-outs__bucket-label">{kind === 'clean' ? 'Clean' : 'Dirty'}</span>
      </div>
      <p className="prl-outs__count">{pluralise(count, 'card')}</p>
      <p className="prl-outs__meaning">{meaning}</p>
    </div>
  );
}

interface OutsSectionProps {
  readonly outs: OutsBreakdown | null;
  /** Decides whether this section has an outs count at all (`../outs-count.ts`). */
  readonly heroEquity: number;
}

/**
 * Rule 6. `countsAsOuts` picks the heading at the render boundary, whatever the report's own prose
 * claims. The counts and card lists survive a refusal because they are true. Only the word and the sum
 * are withheld.
 */
function OutsSection({ outs, heroEquity }: OutsSectionProps): ReactElement {
  if (outs === null) {
    return (
      <section className="prl-coach__section">
        <h3 className="prl-coach__section-heading">Outs</h3>
        <p className="prl-coach__prose">
          No outs breakdown for this spot. Outs are counted when there are cards still to come and the hand
          needs one of them to improve; with the board complete, or before any board is dealt, the count has
          nothing to enumerate.
        </p>
      </section>
    );
  }
  const areOuts = countsAsOuts(heroEquity);
  return (
    <section className="prl-coach__section">
      <h3 className="prl-coach__section-heading">
        {areOuts ? `Outs — ${pluralise(outs.total, 'card')} in total` : 'Outs — no outs count for this spot'}
      </h3>
      <div className="prl-outs__buckets">
        <OutsBucket kind="clean" count={outs.clean} areOuts={areOuts} />
        <OutsBucket kind="dirty" count={outs.dirty} areOuts={areOuts} />
      </div>
      <Disclose summary={areOuts ? 'Which cards, and why' : 'Why there is no outs count'}>
        {areOuts ? (
          <p className="prl-coach__prose">{outs.explanation}</p>
        ) : (
          <>
            <p className="prl-coach__prose">
              An out is a card that rescues a hand that is behind, and you are not behind — your equity is
              already past the share a card would have to reach to count as one. So there is no outs count
              here. The two figures above are real, and they are cards that keep you in front rather than the
              size of a draw.
            </p>
            <p className="prl-coach__prose">{outs.explanation}</p>
          </>
        )}
      </Disclose>
    </section>
  );
}

interface EquitySectionProps {
  readonly equity: EquitySummary;
  /** Pre-formatted `± 0.35 points`, or `null` when the report carried no half-width. */
  readonly interval: string | null;
  /** Equity minus break-even, as a fraction (§6.5). */
  readonly surplus: number;
}

/**
 * The delta's preposition. It was always "over", so a call not priced in read "▼ −27.0 points over".
 * Decided at `Metric`'s one-decimal precision, so a margin that rounds to 0.0 reads "at".
 */
function surplusPreposition(surplus: number): 'over' | 'under' | 'at' {
  if (Number((Math.abs(surplus) * 100).toFixed(1)) === 0) return 'at';
  return surplus > 0 ? 'over' : 'under';
}

function EquitySection({ equity, interval, surplus }: EquitySectionProps): ReactElement {
  const method = METHOD_CHIP[equity.method];
  const intervalProps = interval === null ? {} : { interval };

  /**
   * Rule 5 for the delta. A difference of probabilities is legitimately negative, so it uses
   * `isProbabilityDifference`. Checked apart from the equity, so one bad delta keeps the headline.
   */
  const deltaProps = isProbabilityDifference(surplus)
    ? { delta: { value: surplus, label: `${surplusPreposition(surplus)} the break-even equity` } }
    : {};

  return (
    <section className="prl-coach__section prl-coach__section--equity">
      <div className="prl-coach__section-head">
        <h3 className="prl-coach__section-heading">Equity</h3>
        <Chip
          className="prl-coach__method"
          tone={equity.method === 'exact-enumeration' ? 'accent' : 'info'}
          glyph={method.glyph}
        >
          {method.label}
        </Chip>
      </div>

      {/* Rule 5. `Metric` formats internally, so the check happens before it gets the value. */}
      {isProbabilityFraction(equity.heroEquity) ? (
        <Metric
          label="Your share of the pot"
          value={equity.heroEquity}
          format="percent"
          size="lg"
          countUp
          {...intervalProps}
          {...deltaProps}
          note={`${pluralise(equity.trials, TRIAL_NOUN[equity.method].one, TRIAL_NOUN[equity.method].many)}.`}
        />
      ) : (
        <RefusedFigure label="Your share of the pot" what="your share of the pot" />
      )}

      <EquityBar players={equity.perPlayer} label="Equity by player" />
    </section>
  );
}

/**
 * `potOdds.pot` is the pot hero can win, below `potTotal` when hero is all-in for less than the bet.
 * The tile names both, so the panel never shows two pot sizes that seem to contradict.
 */
function PriceSection({
  potOdds,
  potTotal,
}: {
  readonly potOdds: PotOddsSummary;
  readonly potTotal: number;
}): ReactElement {
  const beyondReach = potTotal - potOdds.pot;
  return (
    <section className="prl-coach__section prl-coach__section--price">
      <h3 className="prl-coach__section-heading">The price</h3>

      {/*
        No `countUp`. The pot, the equity and the suggested EV already announce a change, and break-even
        moves with the price, so counting it would announce the same event a fourth time.
      */}
      {isProbabilityFraction(potOdds.breakEvenEquity) ? (
        <Metric
          label="Break-even equity"
          value={potOdds.breakEvenEquity}
          format="percent"
          size="md"
          note="The share of the pot a call has to win, on average, just to break even."
        />
      ) : (
        <RefusedFigure label="Break-even equity" what="the break-even equity" />
      )}

      {/*
        `oddsRatio` is `number | null`. A price is a `Metric` with no unit, since `formatOdds` already
        says "to 1". With nothing to call it is a sentence in a `StatTile`. Never "0 to 1" or "null".
      */}
      {potOdds.oddsRatio === null ? (
        <StatTile
          label="Price offered"
          value={formatOdds(potOdds.oddsRatio)}
          note="There is nothing to call, so no price is being laid. Any chance of winning is enough to see the next card."
        />
      ) : (
        <Metric label="Price offered" value={potOdds.oddsRatio} format="odds" size="sm" />
      )}

      <StatTile
        label="Pot and price"
        value={
          beyondReach > 0
            ? `${formatUnits(potOdds.pot)} of the ${formatUnits(potTotal)} in the middle, ${formatUnits(potOdds.toCall)} to call`
            : `${formatUnits(potOdds.pot)} in the middle, ${formatUnits(potOdds.toCall)} to call`
        }
        {...(beyondReach > 0
          ? {
              note: `You are all-in for less than the bet, so ${formatUnits(beyondReach)} is a side pot you are not in. Every figure on this panel is against the ${formatUnits(potOdds.pot)} you can win.`,
            }
          : {})}
      />

      <p className="prl-coach__prose">{potOdds.explanation}</p>
    </section>
  );
}

function StackSection({ stack }: { readonly stack: StackContext }): ReactElement {
  const spr = describeSpr(stack.spr);
  // Rule 5. `formatProbability` returns `null`, so the refusal branch cannot be forgotten.
  const potSizedBetPrice = formatProbability(stack.potOddsOfferedByPotSizedBet);
  return (
    <section className="prl-coach__section">
      <h3 className="prl-coach__section-heading">Stack context</h3>
      <Metric label="Effective stack" value={stack.effectiveStack} format="units" size="md" />
      <StatTile label="Stack-to-pot ratio" value={spr.label} note={spr.meaning} />
      {potSizedBetPrice === null ? (
        <RefusedFigure
          label="Price a pot-sized bet would offer"
          what="the equity a pot-sized bet would demand"
        />
      ) : (
        <StatTile
          label="Price a pot-sized bet would offer"
          value={potSizedBetPrice}
          note="The equity a caller would need if the next bet were the size of the pot."
        />
      )}
      <Disclose summary="What this depth means for the decision">
        <p className="prl-coach__prose">{stack.explanation}</p>
      </Disclose>
    </section>
  );
}

/**
 * The EV table scrolls sideways on a narrow screen, so its container is a tab stop. axe
 * `scrollable-region-focusable` (WCAG 2.1.1) requires that, and it outranks `noNoninteractiveTabindex`.
 * The `aria-label` names the stop. Block-display rows were rejected, because they drop the table role.
 */
const EV_TABLE_LABEL = 'Expected value of each action. Scrolls sideways on a narrow screen.';

function CandidateTable({ candidates }: { readonly candidates: readonly ActionCandidate[] }): ReactElement {
  const keyed = withKeys(
    candidates.map((candidate) => `${candidate.action}-${candidate.to ?? 'na'}`),
    'candidate',
  );

  if (candidates.length === 0) {
    return <p className="prl-coach__prose">No candidate actions were reported for this spot.</p>;
  }

  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: axe scrollable-region-focusable (WCAG 2.1.1) requires it; see this function's comment
    <section className="prl-candidates" tabIndex={0} aria-label={EV_TABLE_LABEL}>
      <table className="prl-candidates__table">
        <caption>
          Expected value in units, measured against folding. Every figure depends on the assumptions listed at
          the bottom of this panel.
        </caption>
        <thead>
          <tr>
            <th scope="col">Action</th>
            <th scope="col">Costs</th>
            <th scope="col">EV</th>
            <th scope="col">How that number was reached</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((candidate, position) => {
            const key = keyed[position]?.key ?? candidate.action;
            // Rule 5. Both extras are assumptions stated as probabilities.
            const extras: string[] = [];
            if (candidate.foldEquityAssumed !== undefined) {
              const folds = formatProbability(candidate.foldEquityAssumed);
              extras.push(
                folds === null
                  ? 'the fold-equity this line assumes is not a probability, so it is not stated'
                  : `assumes opponents fold ${folds} of the time`,
              );
            }
            if (candidate.potShareIfCalled !== undefined) {
              const share = formatProbability(candidate.potShareIfCalled);
              extras.push(
                share === null
                  ? 'the pot share this line assumes when called is not a probability, so it is not stated'
                  : `wins ${share} of the pot when called`,
              );
            }
            return (
              <tr key={key}>
                <th className="prl-candidates__action" scope="row">
                  {ACTION_WORD[candidate.action]}
                  {candidate.to === undefined ? '' : ` to ${formatUnits(candidate.to)}`}
                </th>
                <td className="prl-candidates__cost">{formatUnits(candidate.cost)}</td>
                <td className="prl-candidates__ev" data-sign={evSign(candidate.ev)}>
                  {formatSignedUnits(candidate.ev, { decimals: 1 })}
                </td>
                <td className="prl-candidates__derivation">
                  {candidate.derivation}
                  {extras.length === 0 ? '' : ` (${extras.join('; ')})`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

interface SuggestionBlockProps {
  readonly suggestion: CoachSuggestion;
  readonly candidate: ActionCandidate | null;
}

function SuggestionBlock({ suggestion, candidate }: SuggestionBlockProps): ReactElement {
  const changes = withKeys(suggestion.whatWouldChangeIt, 'change');
  const range = suggestion.sizeRange;

  return (
    <div className="prl-suggestion">
      <div className="prl-suggestion__head">
        {/* Never "the correct play". This wording is a product requirement. */}
        <span className="prl-suggestion__label">One reading of this spot</span>
        <p className="prl-suggestion__action">
          {ACTION_WORD[suggestion.action]}
          {/* A range, because one figure claims false precision. Equal ends (often all-in) print once. */}
          {range === undefined
            ? ''
            : range.min === range.max
              ? ` — ${formatUnits(range.min)}`
              : ` — ${formatUnits(range.min)} to ${formatUnits(range.max)}`}
        </p>
        <span className="prl-suggestion__confidence" data-confidence={suggestion.confidence}>
          {CONFIDENCE_WORD[suggestion.confidence]}
        </span>
      </div>

      {candidate === null ? null : (
        <Metric
          className="prl-suggestion__ev"
          label="Expected value of that line"
          value={candidate.ev}
          format="units"
          decimals={1}
          size="md"
          tone={evTone(candidate.ev)}
          countUp
          note={`${formatSignedUnits(candidate.ev, { decimals: 1 })} compared with folding, and ${formatUnits(candidate.cost)} to take it.`}
        />
      )}

      <p className="prl-suggestion__reason">{suggestion.reason}</p>

      {changes.length === 0 ? null : (
        <>
          <p className="prl-suggestion__reason">What would change this:</p>
          <ul className="prl-suggestion__changes">
            {changes.map((entry) => (
              <li key={entry.key}>{entry.value}</li>
            ))}
          </ul>
        </>
      )}

      <p className="prl-suggestion__disclaimer">
        A suggestion that follows from the assumptions listed below — not a claim about the best play. Poker
        has no single correct action in a spot like this, and different assumptions about the opponent give
        different answers.
      </p>
    </div>
  );
}

interface DiscloseProps {
  readonly summary: string;
  readonly children: ReactElement | readonly ReactElement[];
}

function Disclose({ summary, children }: DiscloseProps): ReactElement {
  return (
    <details className="prl-disclose">
      <summary className="prl-disclose__summary">{summary}</summary>
      <div className="prl-disclose__body">{children}</div>
    </details>
  );
}

/**
 * The rule-of-2-and-4 line. `rule.estimate` is a fraction and `errorPoints` is already in points, so
 * swapping their formatters is the bug in either direction ("3,600.0%" once).
 * Three cases that must not share a sentence: `null` (the engine declined the shortcut), a figure that
 * is not a probability (the panel withholds it), and a real figure. `rule.note` is left out of the
 * second case, because it could restate the impossible percentage.
 */
function RuleOfThumbLine({ rule }: { readonly rule: EquitySummary['ruleOfThumb'] }): ReactElement {
  if (rule === null) {
    return (
      <p className="prl-coach__prose">
        No rule-of-thumb comparison for this spot. The rule of 2 and 4 is a shortcut for a draw with clean
        outs still to come, and it is only shown where all three of those hold — the notes below say which one
        does not.
      </p>
    );
  }

  const estimate = formatProbability(rule.estimate);
  const error = isProbabilityPoints(rule.errorPoints) ? formatPoints(Math.abs(rule.errorPoints)) : null;

  if (estimate === null || error === null) {
    return (
      <p className="prl-coach__prose">
        The rule-of-thumb comparison is being withheld for this spot. A figure arrived for it, but it is not a
        probability — the shortcut cannot estimate a chance below 0% or above 100%, and it cannot be wrong by
        more than the whole range — so this panel is not repeating it. Every figure in this panel is checked
        the same way; this is one that did not pass.
      </p>
    );
  }

  return (
    <p className="prl-coach__prose">
      {`The rule of 2 and 4 estimates ${estimate}, which is off by ${error}. ${rule.note}`}
    </p>
  );
}

export function CoachPanel(props: CoachPanelProps): ReactElement {
  const { report, title = 'Coach analysis', className } = props;
  const equity = report.equity;
  const interval = report.uncertainty.confidenceInterval;
  const reportedHalfWidth = equity.confidenceHalfWidthPoints ?? interval?.halfWidthPoints ?? null;
  const isSampled = equity.method === 'monte-carlo';

  /**
   * Rule 5 for the error bar. A half-width is in points, so beyond ±100 it describes nothing. A refused
   * interval becomes `null` and takes the no-error-bar path, and the callout says which absence it is.
   */
  const halfWidth =
    reportedHalfWidth !== null && isProbabilityPoints(reportedHalfWidth) ? reportedHalfWidth : null;
  const intervalWasRefused = reportedHalfWidth !== null && halfWidth === null;

  /** Rule 2. Two decimals, because rounding `± 0.35` to `± 0.4` misstates the uncertainty. */
  const intervalText = halfWidth === null ? null : `± ${formatPoints(Math.abs(halfWidth), { decimals: 2 })}`;

  const outs = report.outs;
  const notes = withKeys(report.teachingNotes, 'teaching-note');
  const rule = equity.ruleOfThumb;
  const suggested = candidateForSuggestion(report.candidates, report.suggestion);

  return (
    <div className={cx('prl-coach', className)}>
      {/*
        A `<div>`, not a `<header>`, which outside a sectioning element maps to a second `banner`
        landmark (axe `landmark-unique`). Pages own landmarks.
      */}
      <div className="prl-coach__header">
        <span className="prl-eyebrow">Coach</span>
        <h2 className="prl-coach__title">{title}</h2>
        <p className="prl-coach__summary">
          {`${report.street} · ${formatUnits(report.potTotal)} in the pot · ${
            report.toCall > 0 ? `${formatUnits(report.toCall)} to call` : 'nothing to call'
          }`}
        </p>
      </div>

      {isSampled && halfWidth === null ? (
        <Callout tone="warning" title="This equity was sampled without an error bar">
          {intervalWasRefused
            ? 'The figure below came from Monte Carlo sampling, and an interval did arrive with it — but it is wider than the whole range a probability can occupy, so it is not being shown. Read the figure as approximate: an error bar that cannot be true tells you nothing about how far from the truth the figure might be.'
            : 'The figure below came from Monte Carlo sampling, but no confidence interval was reported with it. Read it as approximate: a sampled number without an interval cannot tell you how far from the truth it might be.'}
        </Callout>
      ) : null}

      {/*
        The two figures a decision turns on, then the reading, then the detail. Leading with the reading
        pushed the equity 1,480px down the rail (measured in Chrome).
      */}
      <div className="prl-coach__grid">
        <EquitySection equity={equity} interval={intervalText} surplus={report.potOdds.equitySurplus} />
        <PriceSection potOdds={report.potOdds} potTotal={report.potTotal} />
      </div>

      <SuggestionBlock suggestion={report.suggestion} candidate={suggested} />

      <div className="prl-coach__grid">
        <OutsSection outs={outs} heroEquity={equity.heroEquity} />
        <StackSection stack={report.stackContext} />
      </div>

      <div className="prl-coach__disclosures">
        <Disclose summary={`What each action is worth (${pluralise(report.candidates.length, 'line')})`}>
          <CandidateTable candidates={report.candidates} />
        </Disclose>

        {/* Rule 6 again. This summary also puts a number next to the word "outs". */}
        {outs === null ? null : (
          <Disclose
            summary={
              countsAsOuts(equity.heroEquity)
                ? `Outs, card by card (${pluralise(outs.total, 'card')})`
                : `Every card that can come, one by one (${pluralise(outs.total, 'card')})`
            }
          >
            <div className="prl-outs__lists">
              <div className="prl-outs__list">
                <span className="prl-label">{`Clean — ${pluralise(outs.clean, 'card')}`}</span>
                <ul className="prl-outs__cards">
                  {withKeys(outs.cleanCards, 'outs-clean').map((entry) => (
                    <li key={entry.key}>
                      <OutCard text={entry.value} />
                    </li>
                  ))}
                </ul>
              </div>
              <div className="prl-outs__list">
                <span className="prl-label">{`Dirty — ${pluralise(outs.dirty, 'card')}`}</span>
                <ul className="prl-outs__cards">
                  {withKeys(outs.dirtyCards, 'outs-dirty').map((entry) => (
                    <li key={entry.key}>
                      <OutCard text={entry.value} />
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Disclose>
        )}

        <Disclose summary="How these figures are derived">
          <Formula
            expression="break-even equity = call / (pot + call)"
            explanation="Calling costs the call and wins the pot plus the call. Break even is where those balance, which is why a bigger bet demands more equity."
          />
          <Formula
            expression="stack-to-pot ratio = effective stack / pot"
            explanation="How much room is left relative to what is already in the middle. It is the number that decides whether a commitment decision arrives on this street or a later one."
          />
          <RuleOfThumbLine rule={rule} />
          <p className="prl-coach__prose">
            {`Equity came from ${
              isSampled ? 'Monte Carlo sampling' : 'exact enumeration'
            } over ${pluralise(equity.trials, 'run')}. ${
              intervalText === null
                ? 'No interval was reported with it.'
                : `The interval beside the figure, ${intervalText}, is the sampling error at the level stated below.`
            }`}
          </p>
        </Disclose>

        {notes.length === 0 ? null : (
          <Disclose summary={`Worth noticing here (${pluralise(notes.length, 'note')})`}>
            <ul className="prl-coach__list">
              {notes.map((entry) => (
                <li key={entry.key}>{entry.value}</li>
              ))}
            </ul>
          </Disclose>
        )}
      </div>

      {/* Neither can be collapsed. See the top of this file. */}
      <AssumptionList items={report.assumptions} headingLevel={3} />
      <UncertaintyNote note={report.uncertainty} headingLevel={3} />
    </div>
  );
}
