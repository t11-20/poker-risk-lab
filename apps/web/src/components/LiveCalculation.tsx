'use client';

/**
 * A figure computed in the browser, with the method, the working and the assumptions attached.
 *
 * ADR 0006 says no lesson stores a computed number. The figure comes from `@prl/poker-math` every time,
 * so it cannot go stale against the engine. A cheap calculation runs during render, so it is in the
 * server HTML. A preflop equity spot (about 1.7 million run-outs, ~260ms) shows sized skeletons and
 * computes in a `setTimeout(…, 0)`, not `requestAnimationFrame`, which never fires in a background tab.
 *
 * Only the derivation, the EV term table and the card-by-card outs notes may sit behind a `<details>`
 * (§6.2). Everything else is always shown.
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
  formatProbability,
  formatUnits,
  Metric,
  type MetricProps,
  NOT_A_PROBABILITY,
  Panel,
  pluralise,
} from '@prl/ui';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { type Definition, shownAbove } from '@/lib/definition-repeats.ts';
import {
  type CalculationDetail,
  type CalculationFigure,
  type CalculationInput,
  type CalculationOutcome,
  computeCalculation,
  figureFormat,
  figureValue,
  isDeferred,
} from '@/lib/learn-calculations.ts';

type HeadingLevel = 2 | 3 | 4 | 5 | 6;

const NO_EARLIER: readonly LiveCalculationSpec[] = [];

/** Whether an earlier calculation already showed this exact definition. Deferred kinds have none. */
function definedAbove(definition: Definition, earlier: readonly LiveCalculationSpec[]): boolean {
  return shownAbove(
    definition,
    earlier.map((spec) => {
      if (isDeferred(spec)) return null;
      const outcome = computeCalculation(spec);
      return outcome.ok ? outcome.result.formula : null;
    }),
  );
}

/** A lookup rather than `headingLevel + 1`, which would type as `number` and need a cast. */
const NESTED_LEVEL: Readonly<Record<HeadingLevel, 3 | 4 | 5 | 6>> = { 2: 3, 3: 4, 4: 5, 5: 6, 6: 6 };

export interface LiveCalculationProps {
  readonly calculation: LiveCalculationSpec;
  /** The content's own sentence about why this calculation is here. Always shown. */
  readonly caption: string;
  /** Position within the lesson, for the `01 02 03` motif. */
  readonly index?: number;
  readonly headingLevel?: HeadingLevel;
  /** The lesson's name for this instance, so three calculators of one kind do not share a heading. */
  readonly title?: string;
  /**
   * Earlier calculations of the same kind. The definition box is left out when one showed an
   * identical one. Identical, not same kind, because risk of ruin writes the example's numbers into it.
   */
  readonly earlier?: readonly LiveCalculationSpec[];
}

/** Exported for `QuizRunner`, so a numeric question's target is computed by the same deferred path. */
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
 * Props are assembled rather than spread, because `exactOptionalPropertyTypes` rejects
 * `{ unit: undefined }`, and `unit: null` means "render no unit".
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

/** The stored parameters. Cards are drawn as cards and named by the `dt` beside them. */
function Inputs(props: { readonly inputs: readonly CalculationInput[] }): ReactElement | null {
  if (props.inputs.length === 0) return null;
  return (
    <dl className="prl-learn-calc__inputs">
      {props.inputs.map((input) => (
        <div className="prl-learn-calc__input" key={input.label}>
          <dt className="prl-label">{input.label}</dt>
          {input.cards === undefined ? (
            <dd className="prl-mono">{input.text}</dd>
          ) : (
            <dd className="prl-learn-calc__input-cards">
              {input.cards.map((group, position) => (
                <CardRow
                  // No two holdings share a card, so the cards are a unique key without an index.
                  key={group.join(' ')}
                  cards={group}
                  label={
                    input.cards?.length === 1
                      ? input.label
                      : `${input.label}, holding ${String(position + 1)}`
                  }
                  showLabel={false}
                  size="sm"
                  tight
                />
              ))}
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}

/**
 * The clean/dirty split, with a solid or hatched swatch, the word and a count, because hue cannot be
 * relied on (§6.2). Mirrors `CoachPanel`'s internal outs bucket.
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
          A scroll container, because `display: block` on table cells strips the table role. `tabIndex`
          makes the scroll keyboard-reachable (WCAG 2.1.1). The name is on the `<caption>`, because
          ARIA on a roleless `<div>` is ignored.
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
                  {/* Through the domain, so a weight outside 0..1 is named rather than printed. */}
                  <td className="prl-number">{formatProbability(term.probability) ?? NOT_A_PROBABILITY}</td>
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

/** Skeletons sized to the one deferred shape (equity), so nothing jumps when the number lands (§8). */
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
  const { calculation, caption, index, headingLevel = 3, earlier = NO_EARLIER } = props;
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
        {result.formula === null || definedAbove(result.formula, earlier) ? null : (
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

  const title = props.title ?? (outcome?.ok === true ? outcome.result.title : 'Computed live');

  return (
    /*
      `prl-panel--inset` as a class, because `components.css` selects on that modifier and the `tone`
      prop only sets `data-tone`, so `tone="inset"` paints nothing.
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
