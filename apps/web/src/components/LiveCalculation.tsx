'use client';

/**
 * A figure computed in the browser, with the method, the working and the assumptions attached.
 *
 * ## Why this component exists at all
 *
 * ADR 0006: no lesson stores a computed number. A `liveCalculation` block carries the
 * *situation* — "the pot is 120 and it costs 60 to call" — and the figure is worked out here,
 * every time, by `@prl/poker-math`. So a lesson cannot go stale against the engine, and the
 * number a learner reads is produced by exactly the code that runs at the table.
 *
 * There is no hard-coded percentage in this file. Every digit on screen came out of
 * `src/lib/learn-calculations.ts`.
 *
 * ## How it computes without blocking paint
 *
 * Two paths, chosen by `isDeferred`, which asks the library for a work estimate rather than
 * guessing from the calculation's kind:
 *
 *  - **Cheap (everything except a deep equity spot).** Computed with `useMemo` during render.
 *    A flop match-up is 990 run-outs and takes under a millisecond, so deferring it would cost
 *    a skeleton flash and buy nothing. Rendering during render also means the figure is in the
 *    server-rendered HTML, so it is present on first paint and readable with JavaScript off.
 *  - **Expensive (a preflop equity spot: 1.7 million run-outs, ~260ms).** The first render —
 *    on the server and on the client — draws skeleton blocks at the real figure's dimensions.
 *    An effect then yields to a fresh task and computes there. Nothing about the layout moves
 *    when the number lands, because the skeletons are the size of what replaces them.
 *
 * `setTimeout(…, 0)` inside the effect, and specifically NOT `requestAnimationFrame`. Two
 * reasons, in order of importance:
 *
 *  1. **A frame callback does not run in a background tab.** Chrome pauses `requestAnimationFrame`
 *    entirely when a tab is hidden, so a lesson opened in a background tab — middle-click from the
 *    curriculum, which is exactly how someone queues up reading — would sit on a skeleton until it
 *    was brought to the front. A timer is throttled in a hidden tab but it still fires.
 *  2. A passive effect already runs after the browser has painted, so the frame callback bought
 *    nothing that the timeout does not: the timeout runs in the next macrotask, by which point the
 *    skeleton is on screen.
 *
 * ## What is never hidden
 *
 * The figures, the method, the confidence interval, the formula, the caveat and the
 * assumptions. §6.2 permits collapsing the derivation string, the EV term table and the
 * card-by-card outs notes, and those three are the only things behind a `<details>` here.
 * Everything a reader needs in order to know how far to trust the number is in front of them.
 */

import type { LiveCalculation as LiveCalculationSpec } from '@prl/contracts';
import {
  AssumptionList,
  Callout,
  CardRow,
  Chip,
  EquityBar,
  Formula,
  formatChips,
  formatPercent,
  formatUnits,
  Metric,
  type MetricProps,
  Panel,
  pluralise,
} from '@prl/ui';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import {
  type CalculationDetail,
  type CalculationFigure,
  type CalculationOutcome,
  computeCalculation,
  figureFormat,
  figureValue,
  isDeferred,
} from '@/lib/learn-calculations.ts';

type HeadingLevel = 2 | 3 | 4 | 5 | 6;

/**
 * One step down the outline, as a table rather than arithmetic on the level.
 *
 * `headingLevel + 1` would be `number` as far as the type system is concerned, and the only way
 * to hand that to `AssumptionList` would be a cast. A five-entry lookup is the same information
 * with nothing asserted.
 */
const NESTED_LEVEL: Readonly<Record<HeadingLevel, 3 | 4 | 5 | 6>> = { 2: 3, 3: 4, 4: 5, 5: 6, 6: 6 };

export interface LiveCalculationProps {
  readonly calculation: LiveCalculationSpec;
  /** The content's own sentence about why this calculation is here. Always shown. */
  readonly caption: string;
  /** Position within the lesson, for the `01 02 03` motif. */
  readonly index?: number;
  readonly headingLevel?: HeadingLevel;
}

/**
 * The result, and whether it is still coming.
 *
 * Exported because `QuizRunner` needs the identical computation for a numeric question's
 * expected answer, and for the identical reason: a preflop equity figure takes a quarter of a
 * second, and a click handler that blocks for that long feels broken. A second implementation
 * of "compute this, but later" would be a second thing that can disagree about the answer.
 */
export function useCalculationOutcome(calculation: LiveCalculationSpec): {
  readonly outcome: CalculationOutcome | null;
  readonly pending: boolean;
} {
  const deferred = useMemo(() => isDeferred(calculation), [calculation]);
  const inline = useMemo(() => (deferred ? null : computeCalculation(calculation)), [calculation, deferred]);
  const [computed, setComputed] = useState<CalculationOutcome | null>(null);

  useEffect(() => {
    if (!deferred) return undefined;
    let cancelled = false;
    const task = window.setTimeout(() => {
      if (!cancelled) setComputed(computeCalculation(calculation));
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(task);
    };
  }, [calculation, deferred]);

  if (!deferred) return { outcome: inline, pending: false };
  return { outcome: computed, pending: computed === null };
}

/**
 * A figure as a `Metric`.
 *
 * Props are assembled rather than spread, because `exactOptionalPropertyTypes` rejects
 * `{ unit: undefined }` and `unit: null` is a *different instruction* to `Metric` — it means
 * "render no unit at all", which is what an SPR wants and what a percentage does not.
 */
function FigureMetric(props: {
  readonly figure: CalculationFigure;
  readonly size: 'lg' | 'sm';
}): ReactElement {
  const { figure, size } = props;
  const metric: MetricProps = {
    label: figure.label,
    value: figureValue(figure),
    format: figureFormat(figure),
    size,
    ...(figure.unit === undefined ? {} : { unit: figure.unit }),
    ...(figure.decimals === undefined ? {} : { decimals: figure.decimals }),
    ...(figure.interval === undefined ? {} : { interval: figure.interval }),
    ...(figure.note === undefined ? {} : { note: figure.note }),
  };
  return <Metric {...metric} />;
}

/** The parameters the content stored, so the reader can see the situation and not only the answer. */
function Inputs(props: { readonly inputs: readonly { label: string; text: string }[] }): ReactElement | null {
  if (props.inputs.length === 0) return null;
  return (
    <dl className="prl-learn-calc__inputs">
      {props.inputs.map((input) => (
        <div className="prl-learn-calc__input" key={input.label}>
          <dt className="prl-label">{input.label}</dt>
          <dd className="prl-mono">{input.text}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The clean/dirty split.
 *
 * Reuses the `.prl-outs__*` classes the design system already defines: a SOLID swatch for clean,
 * a 45° HATCHED swatch for dirty, each with the word and a count. Three redundant cues, because
 * this is the distinction a learner most needs to get right and hue is the one channel that
 * cannot be relied on (§6.2).
 *
 * The markup deliberately mirrors `CoachPanel`'s internal outs bucket. Promoting that to an
 * exported `@prl/ui` component is the right follow-up, and it is not done here because
 * `CoachPanel.tsx` is being rewritten in parallel.
 */
function OutsDetail(props: { readonly detail: Extract<CalculationDetail, { kind: 'outs' }> }): ReactElement {
  const { detail } = props;
  const buckets = [
    {
      kind: 'clean' as const,
      cards: detail.clean,
      word: 'Clean',
      meaning: 'These win the pot against the holding assumed below if they arrive.',
    },
    {
      kind: 'dirty' as const,
      cards: detail.dirty,
      word: 'Dirty',
      meaning: 'These improve your hand and can still lose — the same card can complete something better.',
    },
  ];
  const notes = [...detail.clean, ...detail.dirty];

  return (
    <div className="prl-outs">
      <div className="prl-outs__buckets">
        {buckets.map((bucket) => (
          <div className={`prl-outs__bucket prl-outs__bucket--${bucket.kind}`} key={bucket.kind}>
            <div className="prl-outs__bucket-head">
              <span className="prl-outs__swatch" aria-hidden="true" />
              <span className="prl-outs__bucket-label">{bucket.word}</span>
            </div>
            <p className="prl-outs__count">{pluralise(bucket.cards.length, 'card')}</p>
            <p className="prl-outs__meaning">{bucket.meaning}</p>
            <CardRow
              cards={bucket.cards.map((outcome) => outcome.card)}
              label={`${bucket.word.toLowerCase()} outs`}
              showLabel={false}
              size="sm"
              tight
              emptyText="none"
            />
          </div>
        ))}
      </div>
      {notes.length === 0 ? null : (
        <details className="prl-disclose">
          <summary className="prl-disclose__summary">Card by card</summary>
          <div className="prl-disclose__body">
            <dl className="prl-learn-calc__cards">
              {notes.map((outcome) => (
                <div className="prl-learn-calc__card" key={outcome.label}>
                  <dt className="prl-mono">{`${outcome.label} — ${outcome.classification}`}</dt>
                  <dd>{outcome.note}</dd>
                </div>
              ))}
            </dl>
          </div>
        </details>
      )}
    </div>
  );
}

function EvTermsDetail(props: {
  readonly detail: Extract<CalculationDetail, { kind: 'evTerms' }>;
}): ReactElement {
  return (
    <details className="prl-disclose">
      <summary className="prl-disclose__summary">Every outcome, weighted</summary>
      <div className="prl-disclose__body">
        {/*
          A scroll container rather than a table that reflows to blocks at narrow widths:
          `display: block` on `tr`/`td` strips the table role from the accessibility tree in
          every current browser, trading the row and column relationships for a prettier phone
          layout. `tabIndex` is what makes the scroll reachable from the keyboard (WCAG 2.1.1),
          which is why the wrapper is focusable despite not being interactive.

          The name lives on the table's own `<caption>` rather than as an `aria-label` on this
          wrapper: a plain `<div>` has no role, and ARIA attributes on a roleless element are
          ignored — so the label would have looked correct and named nothing.
        */}
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-reachable */}
        <div className="prl-learn-table" tabIndex={0}>
          <table className="prl-learn-table__table">
            <caption>
              Every outcome of this decision, weighted by how often it happens. The contributions sum to the
              EV above.
            </caption>
            <thead>
              <tr>
                <th scope="col">Outcome</th>
                <th scope="col">How often</th>
                <th scope="col">Worth</th>
                <th scope="col">Contribution</th>
              </tr>
            </thead>
            <tbody>
              {props.detail.terms.map((term) => (
                <tr key={term.label}>
                  <th scope="row">{term.label}</th>
                  <td className="prl-number">{formatPercent(term.probability)}</td>
                  <td className="prl-number">{formatUnits(term.value, { decimals: 1 })}</td>
                  <td className="prl-number">{formatUnits(term.contribution, { decimals: 1 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

function Detail(props: { readonly detail: CalculationDetail | null }): ReactElement | null {
  const { detail } = props;
  if (detail === null) return null;
  if (detail.kind === 'outs') return <OutsDetail detail={detail} />;
  if (detail.kind === 'evTerms') return <EvTermsDetail detail={detail} />;
  if (detail.kind === 'equity') {
    return <EquityBar players={detail.players} label="Share of the pot, by player" />;
  }
  return (
    <p className="prl-note">
      {`${detail.label}: ${formatChips(detail.lower)} to ${formatChips(detail.upper)} ${detail.unit}.`}
    </p>
  );
}

/**
 * Skeleton blocks at the real figure's dimensions.
 *
 * Only an `equity` calculation is ever deferred, so the shape is known in advance: one large
 * figure, two supporting ones and a bar. Sizing them to the content is the whole point — a
 * layout that jumps when the number arrives is worse than one that was briefly blank, because
 * the reader has already started reading around it (§8).
 */
function CalculationSkeleton(): ReactElement {
  return (
    <div className="prl-learn-calc__skeleton">
      <p className="prl-visually-hidden" aria-live="polite">
        Working out this figure.
      </p>
      <div className="prl-skeleton prl-skeleton--metric" />
      <div className="prl-metric-row">
        <div className="prl-skeleton prl-skeleton--line" />
        <div className="prl-skeleton prl-skeleton--line" />
      </div>
      <div className="prl-skeleton prl-skeleton--line" />
    </div>
  );
}

export function LiveCalculation(props: LiveCalculationProps): ReactElement {
  const { calculation, caption, index, headingLevel = 3 } = props;
  const { outcome, pending } = useCalculationOutcome(calculation);

  const body = (): ReactElement => {
    if (pending || outcome === null) return <CalculationSkeleton />;
    if (!outcome.ok) {
      return (
        <div className="prl-error">
          <p className="prl-error__title">
            <span aria-hidden="true">▲ </span>
            This figure could not be computed
          </p>
          <p>{outcome.reason}</p>
          <p>
            Nothing is being hidden from you: the lesson stores the situation and not the answer, so when the
            situation cannot be solved there is no number to fall back on.
          </p>
        </div>
      );
    }

    const result = outcome.result;
    const lead = result.figures.filter((figure) => figure.emphasis !== 'support');
    const support = result.figures.filter((figure) => figure.emphasis === 'support');

    return (
      <>
        <div className="prl-metric-row">
          {lead.map((figure) => (
            <FigureMetric figure={figure} key={figure.key} size="lg" />
          ))}
        </div>
        {support.length === 0 ? null : (
          <div className="prl-metric-row">
            {support.map((figure) => (
              <FigureMetric figure={figure} key={figure.key} size="sm" />
            ))}
          </div>
        )}
        <Detail detail={result.detail} />
        <p className="prl-learn-calc__method">
          <Chip glyph={result.method.glyph}>{result.method.label}</Chip>
          <span className="prl-note">{result.method.note}</span>
        </p>
        {result.formula === null ? null : (
          <Formula
            eyebrow="How it is defined"
            expression={result.formula.expression}
            explanation={result.formula.explanation}
          />
        )}
        {result.caveat === null ? null : (
          <Callout tone="warning" title="What this figure does not say">
            {result.caveat}
          </Callout>
        )}
        {result.derivation === null ? null : (
          <details className="prl-disclose">
            <summary className="prl-disclose__summary">The arithmetic, written out</summary>
            <div className="prl-disclose__body">
              <p className="prl-learn-calc__derivation">{result.derivation}</p>
            </div>
          </details>
        )}
        {result.assumptions.length === 0 ? null : (
          <AssumptionList
            items={result.assumptions}
            headingLevel={NESTED_LEVEL[headingLevel]}
            title="What this figure assumes"
            intro="Change any of these and the number above changes with it. They are listed rather than summarised because a figure whose assumptions you cannot read is a figure you cannot check."
          />
        )}
      </>
    );
  };

  const title = outcome?.ok === true ? outcome.result.title : 'Computed live';

  return (
    /*
      `prl-panel--inset` is passed as a class rather than through Panel's `tone` prop: the
      component publishes the tone as `data-tone`, and `components.css` selects on the
      `.prl-panel--inset` modifier instead, so `tone="inset"` currently paints nothing. Raised as
      a defect in the report rather than patched here, because `packages/ui` is being edited by
      several people at once.
    */
    <Panel
      className="prl-learn-calc prl-panel--inset"
      eyebrow="Computed in your browser"
      title={title}
      headingLevel={headingLevel}
      {...(index === undefined ? {} : { index })}
    >
      <p className="prl-learn-calc__caption">{caption}</p>
      <Inputs inputs={outcome?.ok === true ? outcome.result.inputs : []} />
      {body()}
    </Panel>
  );
}
