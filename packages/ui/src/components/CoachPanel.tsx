/**
 * The Coach panel. It renders a `CoachReport`, and every number a learner sees comes through here.
 *
 * Always visible, never collapsible: the equity with its method and interval, the pot odds and
 * break-even equity, the suggestion with its confidence, the assumptions and the uncertainty note.
 * An assumption one click away is an assumption nobody reads. Detail (the EV table, outs card by card,
 * explanatory prose, derivations, teaching notes, what would change the reading, every opponent's
 * share past the second) goes in `<details>`, which works without JavaScript.
 *
 * Rules:
 * 1. The method chip is unconditional, with an `=` or `≈` glyph so it survives without colour.
 * 2. A Monte Carlo figure always carries its interval, or a warning that it has none.
 * 3. The suggestion is never called "correct", "optimal", "best", "GTO" or "solved". Low confidence
 *    is shown as prominently as high, and the disclaimer under it is part of the component.
 * 4. Clean and dirty outs differ by swatch, count and words, never by colour alone.
 * 5. Every figure rendered as a percentage passes a range check (`../probability.ts`) before it reaches
 *    a formatter, independently of the producer, because a report arrives as plain JSON past caches and
 *    fixtures. Prose fields are the producer's job.
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
import { callIsAllIn, suggestedCandidate } from '@prl/poker-math';
import { type ReactElement, useId } from 'react';
import { parseCardText } from '../cards.ts';
import { cx } from '../cx.ts';
/**
 * `formatPercent` is deliberately not imported. Every percentage goes through `formatProbability`,
 * which returns `null` for a value that is not a probability (rule 5).
 */
import {
  describeSpr,
  formatChips,
  formatOdds,
  formatPoints,
  formatSignedUnits,
  formatUnits,
  pluralise,
} from '../format.ts';
import { withKeys } from '../keys.ts';
import {
  countsAsOuts,
  type NoOuts,
  noOutsBecause,
  type OutsWithheld,
  outsWithheldBecause,
} from '../outs-count.ts';
import {
  formatProbability,
  isProbabilityDifference,
  isProbabilityFraction,
  isProbabilityPoints,
  NOT_A_PROBABILITY,
} from '../probability.ts';
import { UI_TIPS } from '../tips.ts';
import { AssumptionList } from './AssumptionList.tsx';
import { Callout } from './Callout.tsx';
import { Chip } from './Chip.tsx';
import { CoachJumpBar } from './CoachJumpBar.tsx';
import { EquityBar } from './EquityBar.tsx';
import { Formula } from './Formula.tsx';
import { Metric } from './Metric.tsx';
import { PlayingCard } from './PlayingCard.tsx';
import { StatTile } from './StatTile.tsx';
import { Tip } from './Tip.tsx';
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

/**
 * Spelled out, because `pluralise` would produce "80,000 run sampleds". An exact count is opponent
 * hands times boards to come, so a complete river has a count and no boards.
 */
const TRIAL_NOUN: Readonly<Record<EquitySummary['method'], { readonly one: string; readonly many: string }>> =
  {
    'exact-enumeration': { one: 'showdown enumerated', many: 'showdowns enumerated' },
    'monte-carlo': { one: 'run sampled', many: 'runs sampled' },
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
  /** Decides whether this section has an outs count at all (`../outs-count.ts`), and what a zero means. */
  readonly equity: EquitySummary;
  readonly street: string;
  readonly opponents: number;
}

function outsWithheldProse(reason: OutsWithheld | null, opponents: number): string {
  switch (reason) {
    case 'no-board-yet':
      return 'Outs are counted against the board, and no board has been dealt yet.';
    case 'board-complete':
      return 'The board is complete, so no card is still to come that could be an out.';
    case 'several-opponents':
      return (
        `Outs are counted against a single opponent, and ${opponents} opponents are still in this hand. ` +
        'A card that puts you ahead of one of them can still leave you behind another.'
      );
    case null:
      return '';
  }
}

/** A zero read as a count is "Outs — 0 cards in total", which says nothing about why. */
const NO_OUTS_TEXT: Readonly<Record<NoOuts, { readonly heading: string; readonly lead: string }>> = {
  'drawing-dead': {
    heading: 'Outs — none, you are drawing dead',
    lead: 'No card that can still come wins or splits this pot for you against the range assumed below.',
  },
  'split-at-best': {
    heading: 'Outs — none, a split is the best you can make',
    lead:
      'No card that can still come puts you ahead of the range assumed below. ' +
      'The most you can win is a share of a split pot.',
  },
  'no-single-card': {
    heading: 'Outs — none, no single card puts you ahead',
    lead:
      'An out has to bring you to more than an even share of this pot on its own, and no card that can ' +
      'come next does that against the range assumed below.',
  },
};

/**
 * Rule 6. `countsAsOuts` picks the heading at the render boundary, whatever the report's own prose
 * claims. The counts and card lists survive a refusal because they are true. Only the word and the sum
 * are withheld.
 */
function OutsSection({ outs, equity, street, opponents }: OutsSectionProps): ReactElement {
  if (outs === null) {
    const why = outsWithheldProse(outsWithheldBecause(street, opponents), opponents);
    return (
      <section className="prl-coach__section">
        <h3 className="prl-coach__section-heading">Outs</h3>
        <p className="prl-coach__prose">{`No outs breakdown for this spot. ${why}`.trim()}</p>
      </section>
    );
  }
  const areOuts = countsAsOuts(equity.heroEquity);
  const none = areOuts && outs.total === 0 ? NO_OUTS_TEXT[noOutsBecause(equity)] : null;
  let heading = 'Outs — no outs count for this spot';
  if (none !== null) heading = none.heading;
  else if (areOuts) heading = `Outs — ${pluralise(outs.total, 'card')} in total`;
  return (
    <section className="prl-coach__section">
      <h3 className="prl-coach__section-heading">{heading}</h3>
      {none === null ? null : <p className="prl-coach__prose">{none.lead}</p>}
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
  readonly id: string;
  readonly equity: EquitySummary;
  /** Pre-formatted `± 0.35 points`, or `null` when the report carried no half-width. */
  readonly interval: string | null;
  /** Equity minus break-even, as a fraction (§6.5). */
  readonly surplus: number;
}

/**
 * The delta's preposition, so a call not priced in never reads "▼ −27.0 points over". Decided at
 * `Metric`'s one-decimal precision, so a margin that rounds to 0.0 reads "at".
 */
function surplusPreposition(surplus: number): 'over' | 'under' | 'at' {
  if (Number((Math.abs(surplus) * 100).toFixed(1)) === 0) return 'at';
  return surplus > 0 ? 'over' : 'under';
}

function EquitySection({ id, equity, interval, surplus }: EquitySectionProps): ReactElement {
  const method = METHOD_CHIP[equity.method];
  const intervalProps = interval === null ? {} : { interval };

  /**
   * Rule 5 for the delta. A difference of probabilities is legitimately negative, so it uses
   * `isProbabilityDifference`. Checked apart from the equity, so one bad delta keeps the headline.
   */
  const deltaProps = isProbabilityDifference(surplus)
    ? { delta: { value: surplus, label: `${surplusPreposition(surplus)} break-even` } }
    : {};

  return (
    // Both tips in the head explain the share below it, so the whole section is their subject.
    <section
      id={id}
      tabIndex={-1}
      className="prl-coach__section prl-coach__section--equity"
      data-tip-subject=""
    >
      {/* Each tip shares a row with its subject, so the head keeps two items for `space-between`. */}
      <div className="prl-coach__section-head">
        <div className="prl-tip-row">
          <h3 className="prl-coach__section-heading">Equity</h3>
          <Tip tip={UI_TIPS.equity} />
        </div>
        <div className="prl-tip-row">
          <Chip
            className="prl-coach__method"
            tone={equity.method === 'exact-enumeration' ? 'accent' : 'info'}
            glyph={method.glyph}
          >
            {method.label}
          </Chip>
          <Tip tip={UI_TIPS.method} />
        </div>
      </div>

      {/* Rule 5. `Metric` formats internally, so the check happens before it gets the value. */}
      {isProbabilityFraction(equity.heroEquity) ? (
        <Metric
          label="Your share of the pot"
          tip={UI_TIPS.heroShare}
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
  id,
  potOdds,
  potTotal,
  outOfReach,
}: {
  readonly id: string;
  readonly potOdds: PotOddsSummary;
  readonly potTotal: number;
  readonly outOfReach: CoachReport['outOfReach'];
}): ReactElement {
  const beyondReach = potTotal - potOdds.pot;
  return (
    <section id={id} tabIndex={-1} className="prl-coach__section prl-coach__section--price">
      <h3 className="prl-coach__section-heading">The price</h3>

      {/* Side by side when they fit. A tile (a refusal, or nothing to call) takes the whole row. */}
      <div className="prl-price__figures">
        {/*
          No `countUp`. The pot, the equity and the suggested EV already announce a change, and break-even
          moves with the price, so counting it would announce the same event a fourth time. No note: its
          tip and the explanation under this section already say what break-even means.
        */}
        {isProbabilityFraction(potOdds.breakEvenEquity) ? (
          <Metric
            label="Break-even equity"
            tip={UI_TIPS.breakEven}
            value={potOdds.breakEvenEquity}
            format="percent"
            size="md"
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
            label="Pot odds"
            tip={UI_TIPS.potOdds}
            value={formatOdds(potOdds.oddsRatio)}
            note="Nothing to call, so any chance of winning is enough to see the next card."
          />
        ) : (
          <Metric label="Pot odds" tip={UI_TIPS.potOdds} value={potOdds.oddsRatio} format="odds" size="sm" />
        )}
      </div>

      <StatTile
        label="Pot and price"
        value={
          beyondReach > 0
            ? `${formatChips(potOdds.pot)} of the ${formatChips(potTotal)} in the pot, ${formatChips(potOdds.toCall)} to call`
            : `${formatChips(potOdds.pot)} in the pot, ${formatChips(potOdds.toCall)} to call`
        }
        {...(beyondReach > 0
          ? {
              note: `You are all-in for less than the bet, so ${formatUnits(beyondReach)} is ${outOfReach === 'uncalled' ? 'the part of the bet you cannot match, which goes back to the bettor uncalled' : 'a side pot you are not in'}. Every figure on this panel is against the ${formatUnits(potOdds.pot)} you can win.`,
            }
          : {})}
      />

      <p className="prl-coach__prose">{potOdds.explanation}</p>
    </section>
  );
}

/** A depth band is untrue once no bet can follow: every opponent is all in, or hero's own call is. */
const NO_MORE_BETTING: Readonly<Record<'opponents' | 'hero', string>> = {
  opponents:
    'Every opponent is all in, so no bet can follow this one: there is no depth to measure and no pot-sized bet to price.',
  hero: 'Calling puts in the rest of your stack, so you can bet no more after it: there is no depth to measure and no pot-sized bet to price.',
};

function StackSection({
  stack,
  callIsAllIn,
}: {
  readonly stack: StackContext;
  readonly callIsAllIn: boolean;
}): ReactElement {
  const spr = describeSpr(stack.spr);
  const noMoreBetting = stack.effectiveStack === 0 ? 'opponents' : callIsAllIn ? 'hero' : null;
  // Rule 5. `formatProbability` returns `null`, so the refusal branch cannot be forgotten.
  const potSizedBetPrice = formatProbability(stack.potOddsOfferedByPotSizedBet);
  return (
    <section className="prl-coach__section">
      <h3 className="prl-coach__section-heading">Stack context</h3>
      <Metric
        label="Effective stack"
        tip={UI_TIPS.effectiveStack}
        value={stack.effectiveStack}
        format="units"
        size="md"
      />
      {noMoreBetting !== null ? (
        <StatTile
          label="Stack-to-pot ratio"
          tip={UI_TIPS.stackToPot}
          value="No more betting"
          note={NO_MORE_BETTING[noMoreBetting]}
        />
      ) : (
        <>
          <StatTile
            label="Stack-to-pot ratio"
            tip={UI_TIPS.stackToPot}
            value={spr.label}
            note={spr.meaning}
          />
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
        </>
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
                  {/* A call's `to` is the street total; Costs says what it takes, as its button does. */}
                  {candidate.action === 'call'
                    ? allInWords(candidate, ' all in')
                    : candidate.to === undefined
                      ? ''
                      : ` to ${formatUnits(candidate.to)}${allInWords(candidate, ', all in')}`}
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

/** Names an all-in reading as all in, as the table's button does on its second line. */
function allInWords(candidate: ActionCandidate | null, words: string): string {
  return candidate?.allIn === true ? words : '';
}

interface SuggestionBlockProps {
  readonly id: string;
  readonly suggestion: CoachSuggestion;
  readonly candidate: ActionCandidate | null;
}

function SuggestionBlock({ id, suggestion, candidate }: SuggestionBlockProps): ReactElement {
  const changes = withKeys(suggestion.whatWouldChangeIt, 'change');
  const range = suggestion.sizeRange;
  // A bet or raise range is street totals, so "to"; a bare span reads as a raise from one figure to the other.
  const sized = range !== undefined && (suggestion.action === 'bet' || suggestion.action === 'raise');

  return (
    <div id={id} tabIndex={-1} className="prl-suggestion">
      <div className="prl-suggestion__head">
        {/* Never "the correct play". This wording is a product requirement. */}
        <span className="prl-suggestion__label">One reading of this spot</span>
        <p className="prl-suggestion__action">
          {ACTION_WORD[suggestion.action]}
          {/* A range, because one figure claims false precision. Equal ends (often all-in) print once. */}
          {/* A call reads its cost, as its button does: its range is the street total it reaches. */}
          {suggestion.action === 'call'
            ? candidate === null
              ? ''
              : `${allInWords(candidate, ' all in')} — ${formatUnits(candidate.cost)}`
            : !sized
              ? ''
              : range.min === range.max
                ? ` to ${formatUnits(range.min)}${allInWords(candidate, ', all in')}`
                : ` to ${formatChips(range.min)}–${formatUnits(range.max)}`}
        </p>
        <span className="prl-suggestion__confidence" data-confidence={suggestion.confidence}>
          {CONFIDENCE_WORD[suggestion.confidence]}
        </span>
      </div>

      {sized && range.min !== range.max && candidate?.to !== undefined ? (
        <p className="prl-suggestion__reason">
          {`Of the ${suggestion.action} sizes the Coach priced from ${formatChips(range.min)} to ${formatUnits(range.max)}, ${suggestion.action === 'bet' ? 'betting' : 'raising to'} ${formatChips(candidate.to)} has the highest expected value, and each of the others is within one big blind of it.`}
        </p>
      ) : null}

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
        <Disclose summary={`What would change this (${pluralise(changes.length, 'factor')})`}>
          <ul className="prl-suggestion__changes">
            {changes.map((entry) => (
              <li key={entry.key}>{entry.value}</li>
            ))}
          </ul>
        </Disclose>
      )}

      <p className="prl-suggestion__disclaimer">
        Based on the assumptions below — not a claim about the best play.
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
 * swapping their formatters is the bug in either direction.
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
  const suggested = suggestedCandidate(report);
  // Per instance, because `/legends/compare` and a review can hold more than one panel.
  const idPrefix = `coach-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const ids = {
    equity: `${idPrefix}-equity`,
    price: `${idPrefix}-price`,
    reading: `${idPrefix}-reading`,
    depth: `${idPrefix}-depth`,
    details: `${idPrefix}-details`,
  };

  return (
    <div className={cx('prl-coach', className)}>
      {/*
        A `<div>`, not a `<header>`, which outside a sectioning element maps to a second `banner`
        landmark (axe `landmark-unique`). Pages own landmarks.
      */}
      <div className="prl-coach__header">
        <h2 className="prl-coach__title">{title}</h2>
        {/* The street only: the pot and the price are on the table, the action bar and in The price. */}
        <p className="prl-coach__summary">
          {report.street === 'preflop' ? 'Before the flop' : `On the ${report.street}`}
        </p>
      </div>

      <CoachJumpBar
        items={[
          { id: ids.equity, label: 'Equity' },
          { id: ids.price, label: 'Price' },
          { id: ids.reading, label: 'Reading' },
          { id: ids.depth, label: 'Depth' },
          { id: ids.details, label: 'Details' },
        ]}
      />

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
        <EquitySection
          id={ids.equity}
          equity={equity}
          interval={intervalText}
          surplus={report.potOdds.equitySurplus}
        />
        <PriceSection
          id={ids.price}
          potOdds={report.potOdds}
          potTotal={report.potTotal}
          outOfReach={report.outOfReach}
        />
      </div>

      <SuggestionBlock id={ids.reading} suggestion={report.suggestion} candidate={suggested} />

      <div id={ids.depth} tabIndex={-1} className="prl-coach__grid">
        <OutsSection
          outs={outs}
          equity={equity}
          street={report.street}
          opponents={equity.perPlayer.length - 1}
        />
        <StackSection stack={report.stackContext} callIsAllIn={callIsAllIn(report.candidates)} />
      </div>

      <div id={ids.details} tabIndex={-1} className="prl-coach__disclosures">
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
              isSampled
                ? `Monte Carlo sampling of ${pluralise(equity.trials, 'run')}`
                : `exact enumeration of ${pluralise(equity.trials, 'showdown')}`
            }. ${
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
