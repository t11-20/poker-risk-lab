/**
 * The Coach panel — the centrepiece of the app, and the most information-dense surface in it.
 *
 * It renders a `CoachReport`: equity, pot odds, outs, the candidate actions with their EVs, a
 * suggestion, the stack context, the teaching notes, the assumptions and the uncertainty. Every
 * number the app shows a learner comes through here, which is why this component has hard rules
 * rather than styling preferences.
 *
 * ============================================================================================
 * WHAT MAY BE COLLAPSED, AND WHAT MAY NEVER BE
 * ============================================================================================
 *
 * Progressive disclosure with a hard boundary, and the boundary is a product rule rather than a
 * layout choice.
 *
 * **Always visible, never collapsible:**
 *   - the equity figure *with its method and its interval*
 *   - the pot odds and the break-even equity
 *   - the suggestion with its confidence
 *   - **the assumptions** (`AssumptionList`, which has no toggle by design)
 *   - the uncertainty note (`UncertaintyNote`, likewise)
 *
 * Hiding the assumptions behind a control would let a learner read a number without its caveats,
 * which is the exact failure this product exists to prevent. An assumption one click away is an
 * assumption nobody reads.
 *
 * **Collapsible**, in `<details>`/`<summary>`:
 *   - the per-action EV table
 *   - the card-by-card outs breakdown (the *counts* stay visible)
 *   - the derivations — the formulas and the rule-of-2-and-4 comparison
 *   - the teaching notes
 *
 * `<details>` rather than a custom toggle: free keyboard support, free screen-reader semantics, and
 * it works with JavaScript disabled. Nothing in this panel needs JS to be readable.
 *
 * ============================================================================================
 * THE OTHER RULES. Do not "improve" these away.
 * ============================================================================================
 *
 * 1. **A bare percentage with no method is a bug, not a style choice.** The method chip is
 *    unconditional: `EXACT` for an enumeration, `MONTE CARLO` for a sample, each with a glyph
 *    (`=` / `≈`) so the distinction survives without colour.
 *
 * 2. **A Monte Carlo figure always carries its interval**, at `--prl-type-label` beside the value,
 *    via `Metric`'s `interval` slot: `41.2 % ± 0.35 points`. If the report arrives without a
 *    half-width, the panel says so *in a warning* and tells the reader to treat the figure as
 *    approximate — it never prints a bare sampled number as though it were exact.
 *
 * 3. **The suggestion is never called "correct", "optimal", "best", "GTO" or "solved".** It is a
 *    reading of the spot, with a confidence, a size range, a reason, and a list of what would
 *    change it. `CoachSuggestion.confidence` may be `'low'`, and low confidence is displayed as
 *    prominently as high. The disclaimer under it is part of the component, not decoration a page
 *    can drop.
 *
 * 4. **Clean and dirty outs are distinguished by shape, pattern AND words**, never by colour: a
 *    solid accent swatch against a 45-degree hatch, each with its own numeric count and a sentence
 *    spelling out the consequence. "Dirty" is a term of art hiding a real trap — a card that
 *    improves your hand and still loses — so the label says so rather than assuming the reader
 *    knows the jargon.
 *
 * 5. **A probability that is not a probability is never drawn.** Every figure this panel renders
 *    as a percentage passes `isProbabilityFraction` (or its sibling for differences and for
 *    already-scaled points) *before* it reaches a formatter, and a value outside the range is
 *    replaced by a refusal that says why. See `RefusedFigure` below and the long note in
 *    `../probability.ts`.
 *
 *    This is not redundant with the producer's check, and the distinction matters enough to
 *    write down. `@prl/poker-math` refuses an impossible figure where it is *computed*
 *    (`coach.ts` returns `already-ahead` / `no-clean-outs` / `not-a-probability`, and
 *    `assertProbabilityFraction` throws) — but a `CoachReport` arrives here as plain JSON, past a
 *    cache, a fixture file and a deserialiser. Fed the stale value `estimate: 1.6` this panel
 *    used to print "The rule of 2 and 4 estimates 160.0%": a 160% probability, in the app's own
 *    authoritative voice, in a product whose entire premise is never being confidently wrong
 *    about probability. The computation was right and the page was still wrong, because the
 *    presentation layer had no guard. It has one now, and it is deliberately independent of the
 *    producer's, so that a future regression upstream cannot reach a learner's eyes.
 *
 *    What this guard does NOT cover: prose the report supplies verbatim — `explanation`,
 *    `derivation`, `reason`, `note`, the teaching notes, the assumptions and the limitations. A
 *    sentence is not a figure and cannot be range-checked; those strings are the producer's
 *    responsibility. Every number the *panel itself* turns into text is checked here.
 *
 * 6. **A count is only called "outs" where a card could be one.** The same shape as rule 5, one
 *    level up: a figure can be a perfectly good number and still be the wrong ANSWER to the
 *    question its label asks. On a made hand every unseen card clears the equity bar that defines
 *    an out, so this panel headed a flopped two pair "OUTS — 47 CARDS IN TOTAL" — every card in
 *    the deck, from a section whose own lesson teaches that an out rescues a hand that is behind.
 *    `countsAsOuts` in `../outs-count.ts` decides, here, from hero's equity; the counts still
 *    show, the word and the sum do not. Read the long note in that file before changing this.
 *
 * ============================================================================================
 * Structure and reading order
 * ============================================================================================
 *
 * The panel emits an `h2` for its own title and `h3` for its sections. It never emits an `h1`: a
 * page owns its single `h1`, and this panel does not know whether it is the page's subject.
 *
 * Reading order is: what the situation is -> what the numbers are -> what follows from them -> what
 * they assumed. The suggestion deliberately comes *after* the equity and the price rather than at
 * the top. A learner who reads top to bottom meets the reasoning before the conclusion; a learner
 * who scrolls to the conclusion has passed the reasoning on the way.
 *
 * Two figures here count up on change — the equity and the EV of the suggested line — because "what
 * changed?" is one of the four questions the design system allows an animation to answer. The count-up's
 * accessibility contract lives in `Metric`: the true value is in the DOM from the first render, the
 * interpolating copy is `aria-hidden`, and the count is skipped entirely under
 * `prefers-reduced-motion`. Each counting figure also owns a small atomic live region, which is why
 * only the figures worth announcing get one — see the note above the break-even metric.
 *
 * Server-render safe: no state, no effects, no `window`. `Metric` marks its own client boundary.
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
 * `formatPercent` is deliberately NOT imported here any more, and that absence is load-bearing.
 * Every percentage this panel renders now goes through `formatProbability`, which returns `null`
 * for a value that is not a probability instead of a string. Reaching for `formatPercent` again
 * would silently re-open the hole described in rule 5 above; if you find yourself needing it,
 * the figure you are rendering is either not a probability or the guard is in the wrong place.
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

/**
 * The method chip. Rule 1: this is never conditional.
 *
 * The glyphs carry the distinction in shape alone — `=` for a figure that *is* this, `≈` for one
 * that is approximately this — so a reader who cannot separate the accent chip from the info chip
 * can still separate an enumeration from a sample.
 */
const METHOD_CHIP: Readonly<
  Record<EquitySummary['method'], { readonly label: string; readonly glyph: string }>
> = {
  'exact-enumeration': { label: 'exact', glyph: '=' },
  'monte-carlo': { label: 'monte carlo', glyph: '≈' },
};

/**
 * What the trial count is counting: an enumeration counts boards, a sample counts trials.
 *
 * Both forms are spelled out rather than left to `pluralise`'s append-an-s rule, because the noun here
 * is a PHRASE and the plural belongs on its head word: `pluralise` given "trial sampled" produces
 * "80,000 trial sampleds".
 */
const TRIAL_NOUN: Readonly<Record<EquitySummary['method'], { readonly one: string; readonly many: string }>> =
  {
    'exact-enumeration': { one: 'board enumerated', many: 'boards enumerated' },
    'monte-carlo': { one: 'trial sampled', many: 'trials sampled' },
  };

interface RefusedFigureProps {
  readonly label: string;
  /** The figure, named as the reader would name it: "your share of the pot". */
  readonly what: string;
}

/**
 * What stands where a figure would have been, when the figure was not a probability.
 *
 * Three decisions in here, each of which is the difference between a useful refusal and a
 * confusing hole:
 *
 *  - **The label stays.** Removing the whole tile would leave the reader wondering whether the
 *    panel has an equity section at all. The question is still asked; only the answer is withheld.
 *  - **The offending value is not printed, in any form.** Not as "160.0%", not as "1.6", not in
 *    an `aria-label`. A wrong probability recited inside an apology is still a wrong probability
 *    on the page, and it is exactly what a screen-reader user — least able to notice the figure is
 *    absurd — would hear. `test/coach-panel-render.test.ts` scans attributes as well as text for
 *    precisely this reason.
 *  - **It says which kind of absence this is.** "not a probability" rather than "—" or "n/a":
 *    the figure was not missing, it arrived and was rejected, and a bug reporter needs to be able
 *    to tell those apart.
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

/** `Metric`'s tone from an EV's sign. Redundant with the sign in the text, which is the point. */
function evTone(ev: number): 'favourable' | 'adverse' | 'neutral' {
  const sign = evSign(ev);
  if (sign === 'positive') return 'favourable';
  if (sign === 'negative') return 'adverse';
  return 'neutral';
}

/**
 * The candidate the suggestion is talking about, so its EV can be shown beside it.
 *
 * Matched on the action, then narrowed by the size range when the suggestion has one — a report may
 * carry three different raise sizes as separate candidates. Returns `null` rather than guessing
 * when nothing matches: an EV attributed to the wrong line is worse than no EV at all.
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

/** Renders an out card as a real card where the string parses, a text chip where it does not. */
function OutCard({ text }: { readonly text: string }): ReactElement {
  const card = parseCardText(text);
  if (card === null) return <Chip mono>{text}</Chip>;
  return <PlayingCard card={card} size="sm" />;
}

interface OutsBucketProps {
  readonly kind: 'clean' | 'dirty';
  readonly count: number;
  /**
   * False when hero is already in front, so these cards are not outs.
   *
   * The consequence sentence has to change with it, and this is not a wording preference.
   * "These improve your hand but can still lose" is simply FALSE of most of the 37 cards a
   * flopped two pair sees: a blank does not improve two pair, it just fails to beat it. The
   * bucket still means something real — the card leaves hero in front but not safe — and that
   * is what it says instead.
   */
  readonly areOuts: boolean;
}

/**
 * One bucket's headline: swatch, word, count, consequence. Rule 4.
 *
 * The card faces are NOT here — they are in the collapsible breakdown. The count is the part a
 * decision needs; the identity of each card is the part a review wants.
 */
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
        {/* Solid swatch for clean, 45-degree hatch for dirty. The swatch is the redundant cue; the
            label and the count are the information. */}
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
  /**
   * Hero's equity before any card arrives — the figure that decides whether this section has an
   * outs count at all. See `../outs-count.ts`.
   */
  readonly heroEquity: number;
}

/**
 * The outs section, or the reason there is not an outs count in it.
 *
 * **The headline number must never contradict the lesson that names it.** `countsAsOuts` decides
 * which of the two headings this is, at the render boundary and independently of what the report's
 * own prose claims — a stale fixture whose `explanation` still reads "which is 47 outs in total"
 * gets a heading that refuses anyway, and the reader can see the two disagree.
 *
 * The counts and the card lists survive the refusal, deliberately. They are true — 10 cards leave
 * hero comfortably in front, 37 leave hero in front and beatable — and dropping them would trade a
 * misleading number for a missing one. What is withheld is the word "outs" and the sum.
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
      {areOuts ? null : (
        <p className="prl-coach__prose">
          An out is a card that rescues a hand that is behind, and you are not behind — your equity is already
          past the share a card would have to reach to count as one. So there is no outs count here. The two
          figures below are real, and they are cards that keep you in front rather than the size of a draw.
        </p>
      )}
      <div className="prl-outs__buckets">
        <OutsBucket kind="clean" count={outs.clean} areOuts={areOuts} />
        <OutsBucket kind="dirty" count={outs.dirty} areOuts={areOuts} />
      </div>
      <p className="prl-coach__prose">{outs.explanation}</p>
    </section>
  );
}

interface EquitySectionProps {
  readonly equity: EquitySummary;
  /** Pre-formatted `± 0.35 points`, or `null` when the report carried no half-width. */
  readonly interval: string | null;
  /** Equity minus break-even, as a fraction. Rendered as the metric's delta (§6.5). */
  readonly surplus: number;
}

function EquitySection({ equity, interval, surplus }: EquitySectionProps): ReactElement {
  const method = METHOD_CHIP[equity.method];
  // `exactOptionalPropertyTypes`: an absent `interval` and `interval: undefined` are different
  // types, so the property is added only when there is one.
  const intervalProps = interval === null ? {} : { interval };

  /**
   * Rule 5, on the delta specifically.
   *
   * The surplus is a DIFFERENCE of two probabilities, so its range is -1..1 and it is
   * legitimately negative — a call that is not priced in. `isProbabilityFraction` would reject
   * every one of those, which is how a guard gets a reputation for false alarms and then gets
   * deleted. Checked separately from the equity too, so one bad delta does not take a perfectly
   * good headline figure down with it.
   */
  const deltaProps = isProbabilityDifference(surplus)
    ? { delta: { value: surplus, label: 'over the break-even equity' } }
    : {};

  return (
    <section className="prl-coach__section prl-coach__section--equity">
      <div className="prl-coach__section-head">
        <h3 className="prl-coach__section-heading">Equity</h3>
        {/* Rule 1: unconditional. */}
        <Chip
          className="prl-coach__method"
          tone={equity.method === 'exact-enumeration' ? 'accent' : 'info'}
          glyph={method.glyph}
        >
          {method.label}
        </Chip>
      </div>

      {/* Rule 5. `Metric` formats internally, so the check has to happen before it is handed
          the value — there is no point at which a `Metric` could decline on the panel's behalf. */}
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
 * The price, and the pot it is a price into.
 *
 * `potOdds.pot` is the pot hero can actually WIN, which is below `potTotal` exactly when hero is
 * all-in for less than the bet in front of them: the excess of that bet is a side pot hero is not
 * eligible for. `potTotal` is taken separately rather than subtracted out of a single figure,
 * because a reader looking at 320 chips in the middle and a tile saying "50 in the middle" has been
 * handed two numbers that cannot both be right and no way to tell which is.
 *
 * So the tile names both, and says which is which. The Coach's own prose underneath explains why
 * the side pot is out of reach; this is the figure that stops the two contradicting each other on
 * the face of the panel.
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
    <section className="prl-coach__section">
      <h3 className="prl-coach__section-heading">The price</h3>

      {/*
        No `countUp` here, and that is a decision rather than an omission. Three figures on this screen
        count up — the pot, the equity, and the EV of the suggested line — and each one owns a small
        atomic live region so that its SETTLED value is announced exactly once and a mid-count value
        never is. Break-even moves whenever the price moves, so counting it too would announce the same
        event a fourth time. Four polite announcements for one change is not more accessible than one.
      */}
      {/* Rule 5. This is the figure the whole "should I call?" question turns on, so a wrong one
          here would misprice every decision the reader makes from this panel. */}
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
        Two shapes for one member, because `oddsRatio` is `number | null` and the two cases are
        different *kinds* of thing rather than two values of one kind.

        With a price, it is a figure: `Metric` with `format="odds"` and no `unit`, because
        `formatOdds` already renders "2.9 to 1" and a unit of "to 1" would print it twice.

        With nothing to call there is no figure at all — no "X to 1" exists — so it is a
        sentence, in a `StatTile`, which takes text. Passing "no cost to continue" to `Metric`
        is not possible: its `value` is a number, and that is the type doing its job. What must
        never appear here is "0 to 1" (a real price, and the worst one) or "null".
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
  // Rule 5. `formatProbability` returns `null` rather than a string for a value that is not a
  // probability, which is what makes the second branch impossible to forget: a `string | null`
  // will not go into `StatTile`'s `value` without the caller saying what happens instead.
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
      <p className="prl-coach__prose">{stack.explanation}</p>
    </section>
  );
}

/**
 * The EV table, in a focusable scroll container.
 *
 * That container is two accessibility rules disagreeing, and this is the resolution.
 *
 * A table's columns cannot wrap, so on a narrow screen this scrolls sideways. axe's
 * `scrollable-region-focusable` (WCAG 2.1.1 Keyboard) requires a scrollable region to be reachable
 * by keyboard, and for a region with no focusable content inside, that means `tabindex="0"` on the
 * container — without it a keyboard user simply cannot bring the right-hand columns into view.
 *
 * Biome's `noNoninteractiveTabindex` objects to tab stops on non-interactive elements. That is a
 * good general heuristic with a documented exception for exactly this case, so the WCAG-mapped rule
 * wins and the suppression is annotated at the line. The container is a `<section>` with an
 * `aria-label` so the tab stop announces what it is instead of being a silent one.
 *
 * The alternative — `display: block` on the rows at narrow widths, the usual "responsive table"
 * trick — was rejected: it strips the table role from the accessibility tree in every current
 * browser, trading a sighted-user layout problem for a screen-reader comprehension problem.
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
            // Rule 5. Both extras are assumptions stated as probabilities, and an assumption the
            // reader cannot check is exactly the kind of figure that must not be invented.
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
  /** The candidate the suggestion refers to, when one could be matched to it. */
  readonly candidate: ActionCandidate | null;
}

function SuggestionBlock({ suggestion, candidate }: SuggestionBlockProps): ReactElement {
  const changes = withKeys(suggestion.whatWouldChangeIt, 'change');
  const range = suggestion.sizeRange;

  return (
    <div className="prl-suggestion">
      <div className="prl-suggestion__head">
        {/* Never "the correct play". This wording is a product requirement, not a preference. */}
        <span className="prl-suggestion__label">One reading of this spot</span>
        <p className="prl-suggestion__action">
          {ACTION_WORD[suggestion.action]}
          {/* A RANGE, not a single number: sizing is not that precise, and printing one figure
              would claim a precision the analysis does not have. */}
          {range === undefined ? '' : ` — ${formatUnits(range.min)} to ${formatUnits(range.max)}`}
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

/** One collapsible block. `<details>` gives the keyboard and screen-reader behaviour for free. */
function Disclose({ summary, children }: DiscloseProps): ReactElement {
  return (
    <details className="prl-disclose">
      <summary className="prl-disclose__summary">{summary}</summary>
      <div className="prl-disclose__body">{children}</div>
    </details>
  );
}

/**
 * The rule-of-2-and-4 comparison, or the reason there is not one. **This is the line the P0 was
 * found on**, so it is spelled out rather than inlined as a ternary in the JSX.
 *
 * ## The units, which have been wrong in both directions
 *
 * `rule.estimate` is a FRACTION, like every other probability on this contract, so `formatPercent`
 * is the right renderer and the multiplication happens exactly once. `@prl/poker-math` used to
 * publish it in percentage points instead — 36 rather than 0.36 — and this line rendered a
 * nine-out flush draw as "3,600.0%". `errorPoints` beside it is already scaled, which is what its
 * name says, so it goes through `formatPoints` and is NOT multiplied. Swapping the two formatters
 * is the whole bug, in both directions.
 *
 * ## Three answers, not two, and they are genuinely different things
 *
 *  1. `rule === null` — **the engine withheld it.** The Coach declines the shortcut where it
 *     cannot mean anything: a made hand, no clean outs, or an out count whose multiple would
 *     exceed 100%. That is a considered answer and the reason lands in the teaching notes below.
 *  2. A figure arrived that is **not a probability** — the *panel* withholds it. This is the case
 *     the audit found: fed the stale fixture value `estimate: 1.6`, this line printed "The rule of
 *     2 and 4 estimates 160.0%", unconditionally, because it formatted whatever it was handed.
 *  3. A figure arrived and it is a probability — state it, with its error.
 *
 * Cases 1 and 2 must not share a sentence. "The engine decided this shortcut does not apply" and
 * "something upstream sent a number that cannot be true" are different facts, and the second is a
 * defect the reader is entitled to recognise as one.
 *
 * `rule.note` is deliberately absent from case 2. It is prose written to explain a figure that is
 * not being shown, and a note reading "9 outs times 4 is roughly 180%" would put the impossible
 * percentage straight back on the page through the one channel this guard cannot range-check.
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
   * Rule 5, on the error bar.
   *
   * A half-width is in percentage POINTS, so its own impossible range is ±100: an error bar wider
   * than the whole 0..100 span it is drawn on describes nothing, and "41.2 % ± 4,000.00 points"
   * is the same class of untruth as a 160% probability — it just does not carry a `%` sign, which
   * is precisely why it would have survived a scan that only looks for percentages.
   *
   * A refused interval collapses to `null`, which routes it into the existing "sampled without an
   * error bar" path rather than inventing a new one. The callout below then says *which* absence
   * it is, because "none was reported" and "one was reported and could not be true" are different
   * problems for whoever has to fix it.
   */
  const halfWidth =
    reportedHalfWidth !== null && isProbabilityPoints(reportedHalfWidth) ? reportedHalfWidth : null;
  const intervalWasRefused = reportedHalfWidth !== null && halfWidth === null;

  /**
   * Rule 2. Two decimals rather than one: the interval is often a fraction of a point, and rounding
   * `± 0.35` to `± 0.4` overstates the uncertainty of a long run and understates a short one.
   */
  const intervalText = halfWidth === null ? null : `± ${formatPoints(Math.abs(halfWidth), { decimals: 2 })}`;

  const outs = report.outs;
  const notes = withKeys(report.teachingNotes, 'teaching-note');
  const rule = equity.ruleOfThumb;
  const suggested = candidateForSuggestion(report.candidates, report.suggestion);

  return (
    <div className={cx('prl-coach', className)}>
      {/*
        A `<div>`, not a `<header>`. This panel's root is a `<div>`, and HTML-AAM maps a `<header>`
        that is not inside `article`, `aside`, `main`, `nav` or `section` to the `banner` role — so a
        `<header>` here would put a SECOND unnamed banner landmark on every page that renders the
        Coach, next to the site header (axe `landmark-unique`). Pages own landmarks in this codebase;
        components do not create them. The heading below is what carries the outline.
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

      {/* ---- always visible ------------------------------------------------------------- */}
      <div className="prl-coach__grid">
        <EquitySection equity={equity} interval={intervalText} surplus={report.potOdds.equitySurplus} />
        <PriceSection potOdds={report.potOdds} potTotal={report.potTotal} />
        <OutsSection outs={outs} heroEquity={equity.heroEquity} />
        <StackSection stack={report.stackContext} />
      </div>

      <SuggestionBlock suggestion={report.suggestion} candidate={suggested} />

      {/* ---- collapsible: detail, never caveats ----------------------------------------- */}
      <div className="prl-coach__disclosures">
        <Disclose summary={`What each action is worth (${pluralise(report.candidates.length, 'line')})`}>
          <CandidateTable candidates={report.candidates} />
        </Disclose>

        {/* The same refusal as the section heading, for the same reason: this summary is the other
            place the panel puts a number next to the word "outs". */}
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

      {/* Neither of these can be collapsed. See the boundary at the top of this file. */}
      <AssumptionList items={report.assumptions} headingLevel={3} />
      <UncertaintyNote note={report.uncertainty} headingLevel={3} />
    </div>
  );
}
