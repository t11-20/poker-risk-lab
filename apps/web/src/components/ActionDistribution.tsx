/**
 * The distribution a policy sampled its action from, as a small bar plus a printed legend.
 *
 * ## Why a learner has to see this
 *
 * These styles are **probabilistic, not scripted**. The same spot does not always produce the same
 * action, and a learner who thinks "this style folds here" has learned something false about the
 * opponent and something worse about poker. `ModelReasoning.actionProbabilities` and
 * `ProfileComparisonEntry.actionDistribution` are on the wire for exactly this reason, so the job
 * of this component is to make the spread visible rather than to summarise it as its mode.
 *
 * ## Two rules it is built around
 *
 * 1. **Every probability is printed as text.** The bar is a secondary encoding. A stacked bar
 *    cannot satisfy "never convey a value by length or colour alone", so if the legend were
 *    dropped to save space the layout would be wrong.
 * 2. **An action keeps the same colour AND the same fill pattern in every column.** The series is
 *    chosen from the action's verb, not from its position in the list, so `raise` looks the same in
 *    all four columns of the compare page — which is the only thing that makes those columns
 *    comparable at a glance. The colour-plus-pattern pairs come from `[data-series]` in
 *    `components.css`, so a reader with any form of colour-vision deficiency, and a reader in
 *    forced-colors mode, still tells the segments apart.
 *
 * If the probabilities do not sum to 1 the component says so instead of normalising them. A
 * distribution that does not add up is a defect in whatever produced it, and hiding it behind a
 * rescale hides the defect.
 *
 * Server-render safe: no state, no effects.
 */

import {
  cx,
  formatPercent,
  formatProbability,
  NOT_A_PROBABILITY,
  type StyleWithVars,
  withKeys,
} from '@prl/ui';
import type { ReactElement } from 'react';

/** One action and the weight the policy gave it before sampling. */
export interface ActionShare {
  /** The action as the model names it: `fold`, `check`, `call`, `bet 90`, `raise to 520`. */
  readonly action: string;
  /** A fraction in 0..1. */
  readonly probability: number;
  /** Median size as a fraction of the pot, for a sized action. Absent or null otherwise. */
  readonly medianSizeToPotFraction?: number | null;
}

export interface ActionDistributionProps {
  /** Names the group, e.g. "Action mix over 400 trials". Required: an unlabelled bar is a shape. */
  readonly label: string;
  readonly entries: readonly ActionShare[];
  /**
   * The most likely action, marked with a word as well as by its position.
   *
   * **It has to be one of `entries[].action`, taken from that list rather than rebuilt** — this is
   * matched with `===` and there is no normalisation to fall back on. `ProfileComparisonEntry`
   * satisfies this by construction: the API sets `modalAction: distribution[0].action`, out of the
   * very array it is sending. A caller that formats a number of its own has to agree with a
   * formatter in another package, and `mostLikelyAction` below exists so that nobody has to.
   *
   * ## The defect that rule is written for
   *
   * `PostHandComparison` used to build this string itself, with `@prl/ui`'s grouping `formatChips`
   * — `"raise to 1,200"`. The entries come from `@prl/poker-ai`'s `describeAction`, which formats
   * with a private `String(value)` — `"raise to 1200"`. So for any sizing of a thousand or more the
   * two never matched, no row was marked, and nothing said so. Starting stacks are 1,000, so it was
   * reachable in ordinary play and silent whenever it happened.
   */
  readonly modalAction?: string;
  readonly className?: string;
}

/**
 * Re-exported from `lib/action-distribution.ts` rather than defined here.
 *
 * It moved to a leaf module so it could be tested: this file is a `.tsx`, and `node --test` in
 * this repository cannot load one. Same shape and same reason as `lib/quiz-tolerance.ts`. That
 * file's header carries the measurement and the rule.
 */
export { mostLikelyAction } from '@/lib/action-distribution.ts';

/**
 * Series letter per action verb, fixed so the mapping is stable across every column and screen.
 *
 * `d` is the fallback for an action this map does not know, which keeps an unexpected verb visible
 * rather than silently sharing a colour with something else.
 */
const SERIES_BY_VERB: Readonly<Record<string, string>> = {
  fold: 'f',
  check: 'e',
  call: 'a',
  bet: 'b',
  raise: 'c',
};

const UNKNOWN_SERIES = 'd';

/** How far a distribution may drift from 1 before it is worth saying so on screen. */
const SUM_TOLERANCE = 0.005;

const SHARE_DECIMALS = 1;

export function seriesForAction(action: string): string {
  const verb = action.trim().toLowerCase().split(' ')[0] ?? '';
  return SERIES_BY_VERB[verb] ?? UNKNOWN_SERIES;
}

export function ActionDistribution(props: ActionDistributionProps): ReactElement {
  const { label, entries, modalAction, className } = props;

  if (entries.length === 0) {
    return (
      <div className={cx('prl-legend-dist', className)}>
        <span className="prl-label">{label}</span>
        <p className="prl-legend-dist__size">
          No action distribution was reported for this decision, so there is nothing to show about how the
          action was chosen.
        </p>
      </div>
    );
  }

  let total = 0;
  for (const entry of entries) {
    if (Number.isFinite(entry.probability)) total += entry.probability;
  }
  const sumIsOff = Math.abs(total - 1) > SUM_TOLERANCE;
  const keyed = withKeys(
    entries.map((entry) => entry.action),
    'action',
  );

  return (
    <div className={cx('prl-legend-dist', className)}>
      <span className="prl-label">{label}</span>
      {/*
        Decorative. Every segment's probability is printed in the legend below, which is the
        encoding that actually carries the data.
      */}
      <div aria-hidden="true" className="prl-bar">
        {entries.map((entry, index) => {
          const style: StyleWithVars = {
            '--prl-segment-share': formatPercent(
              Number.isFinite(entry.probability) ? Math.max(0, entry.probability) : 0,
              { decimals: SHARE_DECIMALS },
            ),
          };
          return (
            <span
              className="prl-bar__segment prl-fill"
              data-series={seriesForAction(entry.action)}
              key={keyed[index]?.key ?? entry.action}
              style={style}
            />
          );
        })}
      </div>
      <ul className="prl-legend-dist__legend">
        {entries.map((entry, index) => (
          <li
            className="prl-legend-dist__row"
            data-modal={modalAction !== undefined && modalAction === entry.action ? 'true' : undefined}
            key={keyed[index]?.key ?? entry.action}
          >
            <span
              aria-hidden="true"
              className="prl-legend-dist__swatch prl-fill"
              data-series={seriesForAction(entry.action)}
            />
            <span className="prl-legend-dist__action">
              {entry.action}
              {modalAction !== undefined && modalAction === entry.action ? (
                <span className="prl-legend-dist__most-likely"> — most likely</span>
              ) : null}
            </span>
            <span className="prl-legend-dist__probability">
              {/*
                A weight the model sampled from IS a probability, so it goes through the domain
                rather than through the formatter. An entry outside 0..1 is named as such instead
                of being printed as an impossible percentage — `formatPercent` would render 1.6 as
                "160.0%", in the app's own authoritative voice, on the page that teaches how much
                confidence a number deserves.
              */}
              {formatProbability(entry.probability, { decimals: SHARE_DECIMALS }) ?? NOT_A_PROBABILITY}
            </span>
            {entry.medianSizeToPotFraction === undefined || entry.medianSizeToPotFraction === null ? null : (
              <span className="prl-legend-dist__size">
                {/*
                  NOT a probability, and deliberately still `formatPercent`: a bet of one and a half
                  times the pot is 150% of it and is an ordinary size. Sending this through the
                  probability domain would refuse a correct figure, which is the same conflation as
                  the one above, in reverse.
                */}
                {`Median size ${formatPercent(entry.medianSizeToPotFraction, { decimals: 0 })} of the pot`}
              </span>
            )}
          </li>
        ))}
      </ul>
      {sumIsOff ? (
        <p className="prl-legend-dist__size">
          {`These weights sum to ${formatPercent(total, { decimals: SHARE_DECIMALS })} rather than 100%. That is a defect in the data rather than a rounding choice here, and the figures are shown unaltered so it is visible.`}
        </p>
      ) : null}
    </div>
  );
}
