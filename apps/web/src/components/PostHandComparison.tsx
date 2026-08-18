/**
 * The post-hand comparison: the learner's decisions, the maths behind each one, what the model did,
 * and why.
 *
 * ============================================================================================
 * THE RULE THIS COMPONENT EXISTS TO ENFORCE
 * ============================================================================================
 *
 * **The chip result and the decision quality are never presented as explaining each other.**
 *
 * `HandComparison` keeps them as separate, unrelated fields, and `DecisionQuality` is computed from
 * the maths before the run-out is known — `scoreDecisionQuality()` has no parameter capable of
 * carrying the winner. That separation is structural on the server, and this component is where a
 * layout could quietly undo it. So it is structural here too:
 *
 *  - the two figures sit in **two separate panels**, each with its own heading;
 *  - a labelled **wall** runs between them — a hairline plus a sentence saying that neither is
 *    evidence about the other — and `grid-template-areas` puts it between them at every viewport
 *    width, not underneath both on a phone;
 *  - they are **never in one metric row**, never adjacent figures, and neither one's tone, colour or
 *    glyph is derived from the other;
 *  - `chipResult` is rendered with a **neutral tone whatever its sign**. A green number on a won pot
 *    is the core casino reward pattern, and this product rewards the reasoning instead. There is no
 *    celebration here: no flourish, no particles, no "nice hand".
 *
 * When `outcomeVersusQualityNote` is present — a well-played hand that lost, or a badly-played hand
 * that won — it is rendered immediately after those panels as a `Callout` with tone `insight`,
 * because a line the maths supported that lost is the most valuable teaching moment in the product.
 *
 * ============================================================================================
 * What may be collapsed, and what may not
 * ============================================================================================
 *
 * Per the Coach panel's rules (§6.2), the equity figure with its method and interval, the pot odds,
 * **the assumptions** and the uncertainty are always visible. Only the per-action expected-value
 * table is behind a `<details>`. Hiding the assumptions while showing the number would let a
 * learner read a figure without its caveats, which is the exact failure this product exists to
 * prevent.
 *
 * ============================================================================================
 * Headings
 * ============================================================================================
 *
 * This component emits `h2` for its sections, `h3` per decision and `h4` inside a decision. It
 * expects to sit directly under the page's single `h1` and never emits one itself.
 *
 * Server-render safe: no state, no effects, no clock.
 */

import type {
  CoachReport,
  ComparedDecision,
  DecisionQuality,
  HandComparison,
  ModelReasoning,
} from '@prl/contracts';
import {
  AssumptionList,
  Callout,
  CardRow,
  Chip,
  cx,
  Formula,
  formatChips,
  formatIndex,
  formatPercent,
  formatPoints,
  formatSignedUnits,
  formatUnits,
  Metric,
  Panel,
  parseCardText,
  UncertaintyNote,
  withKeys,
} from '@prl/ui';
import type { ReactElement } from 'react';
import { ActionDistribution } from './ActionDistribution.tsx';
import { LegendSigil } from './LegendSigil.tsx';
import { ProfileDisclaimers } from './ProfileDisclaimers.tsx';

/**
 * One decimal on every expected-value figure.
 *
 * Chips are integers in the engine; expected value is not. At zero decimals a shortfall of 0.4
 * units renders as `0` — which is exactly the figure the band is measured on, reported as nothing.
 * The bands themselves are fractions of a big blind, so a whole-unit readout cannot express them.
 */
const EV_DECIMALS = 1;

const BAND_WORD: Readonly<Record<DecisionQuality['band'], string>> = {
  'consistent-with-analysis': 'Consistent with the analysis',
  'slightly-off': 'Slightly off the best-priced action',
  'materially-off': 'Materially off the best-priced action',
};

/**
 * Tones for the bands.
 *
 * `accent` marks the band where the analysis and the action agree, because the accent means
 * "computed data" in this system rather than "well done". Neither off band gets `adverse`: a
 * decision the maths priced lower is information to work through, not a failure, and the words
 * carry the distinction anyway.
 */
const BAND_TONE: Readonly<Record<DecisionQuality['band'], 'accent' | 'caution'>> = {
  'consistent-with-analysis': 'accent',
  'slightly-off': 'caution',
  'materially-off': 'caution',
};

/** Past tense, for a replay line. `bet` takes no "to"; `raise` does. */
const ACTION_PAST: Readonly<Record<string, string>> = {
  fold: 'folded',
  check: 'checked',
  call: 'called',
  bet: 'bet',
  raise: 'raised to',
};

/** Present tense, for a table row. */
const ACTION_PRESENT: Readonly<Record<string, string>> = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise to',
};

function capitalise(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function describeTaken(action: { readonly action: string; readonly to: number | null }): string {
  const verb = ACTION_PAST[action.action] ?? action.action;
  return action.to === null ? verb : `${verb} ${formatUnits(action.to)}`;
}

function describePriced(action: string, to: number | null): string {
  const verb = ACTION_PRESENT[action] ?? capitalise(action);
  return to === null ? verb : `${verb} ${formatChips(to)}`;
}

/** Engine card integers for the board, dropping anything that does not parse. */
function boardCards(board: readonly string[]): readonly number[] {
  const cards: number[] = [];
  for (const text of board) {
    const card = parseCardText(text);
    if (card !== null) cards.push(card);
  }
  return cards;
}

/**
 * The interval to show beside a sampled figure, pre-formatted.
 *
 * `null` for an exact enumeration, which has no interval to show. A **sampled** figure with no
 * half-width gets a sentence saying so rather than a bare percentage: printing a Monte Carlo number
 * as though it were exact is the single most misleading thing this UI could do.
 */
function intervalFor(report: CoachReport): string | null {
  const half = report.equity.confidenceHalfWidthPoints;
  if (half === null) return null;
  return `± ${formatPoints(Math.abs(half))}`;
}

function methodNote(report: CoachReport): string {
  const { method, trials } = report.equity;
  if (method === 'exact-enumeration') {
    return `Exact enumeration over ${formatChips(trials)} run-outs. No sampling error.`;
  }
  if (report.equity.confidenceHalfWidthPoints === null) {
    return `Sampled over ${formatChips(trials)} run-outs, and the interval was not reported — treat this figure as approximate.`;
  }
  return `Monte Carlo over ${formatChips(trials)} sampled run-outs, so the figure carries the interval beside it.`;
}

// ---------------------------------------------------------------------------
// The maths for one decision
// ---------------------------------------------------------------------------

function DecisionMaths({ report }: { readonly report: CoachReport }): ReactElement {
  const interval = intervalFor(report);
  const priced = report.toCall > 0;
  const surplus = report.potOdds.equitySurplus;
  const direction = surplus > 0 ? 'up' : surplus < 0 ? 'down' : 'flat';

  return (
    <div className="prl-stack">
      <div className="prl-legend-maths">
        <Metric
          delta={
            priced
              ? {
                  value: surplus,
                  label: `against the ${formatPercent(report.potOdds.breakEvenEquity)} this price needs`,
                  direction,
                }
              : {
                  value: 0,
                  label: 'there is no price to clear on this street',
                  direction: 'flat',
                }
          }
          format="percent"
          label="Equity"
          note={methodNote(report)}
          {...(interval === null ? {} : { interval })}
          value={report.equity.heroEquity}
        />
        <Metric
          format="percent"
          label="Break-even equity"
          note={
            priced
              ? 'What a call has to win to pay for itself, from the price alone.'
              : 'Nothing to call, so there is no break-even point on this street.'
          }
          value={report.potOdds.breakEvenEquity}
        />
        <Metric
          format="units"
          label="Pot before the decision"
          note={priced ? `${formatUnits(report.toCall)} to call.` : 'Nothing to call.'}
          value={report.potOdds.pot}
        />
      </div>
      {priced ? (
        <Formula
          eyebrow="Pot odds"
          expression={`break-even equity = ${formatChips(report.toCall)} / (${formatChips(report.potOdds.pot)} + ${formatChips(report.toCall)}) = ${formatPercent(report.potOdds.breakEvenEquity)}`}
          explanation={report.potOdds.explanation}
        />
      ) : null}
      {report.equity.ruleOfThumb === null ? null : (
        <Callout tone="misconception" title="What the rule of 2 and 4 says here">
          <p>{report.equity.ruleOfThumb.note}</p>
        </Callout>
      )}
      {/*
        The per-action expected-value table is the one thing §6.2 permits collapsing. The
        assumptions and the uncertainty below it are not, and they are not inside this element.
      */}
      <details className="prl-disclose">
        <summary className="prl-disclose__summary">Every action the analysis priced</summary>
        <div className="prl-disclose__body">
          <div className="prl-legend-table-wrap">
            <table className="prl-legend-table">
              <caption>Expected value per action, in units, measured against folding at zero</caption>
              <thead>
                <tr>
                  <th scope="col">Action</th>
                  <th className="prl-legend-table__figure" scope="col">
                    Cost
                  </th>
                  <th className="prl-legend-table__figure" scope="col">
                    Expected value
                  </th>
                  <th scope="col">How that figure was reached</th>
                </tr>
              </thead>
              <tbody>
                {report.candidates.map((candidate) => (
                  <tr key={`${candidate.action}:${candidate.to ?? 'none'}`}>
                    <th scope="row">{describePriced(candidate.action, candidate.to ?? null)}</th>
                    <td className="prl-legend-table__figure">{formatUnits(candidate.cost)}</td>
                    <td className="prl-legend-table__figure">{formatSignedUnits(candidate.ev)}</td>
                    <td>{candidate.derivation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>
      {/*
        Both are `h4`, the same level as every other subsection inside a decision's `h3`. An `h5`
        here would be a level skipped from the decision heading, which is a real navigation failure
        rather than a lint detail: a screen-reader user moving by heading would lose the outline.
      */}
      <AssumptionList headingLevel={4} items={report.assumptions} />
      <UncertaintyNote headingLevel={4} note={report.uncertainty} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Why the model did what it did
// ---------------------------------------------------------------------------

function ModelReasoningBlock({
  reasoning,
  modalAction,
}: {
  readonly reasoning: ModelReasoning;
  readonly modalAction: string | undefined;
}): ReactElement {
  return (
    <section className="prl-stack">
      <h4>Why this model preferred that</h4>
      <p>{reasoning.modelPreference}</p>
      <div className="prl-legend-maths">
        {reasoning.drivingTraits.map((trait) => (
          <Metric
            decimals={2}
            key={trait.key}
            label={trait.label}
            size="sm"
            unit="of 1"
            value={trait.value}
          />
        ))}
      </div>
      <div className="prl-stack prl-stack--tight">
        <span className="prl-label">What would have changed it</span>
        <ul>
          {withKeys(reasoning.whatChangedIt, 'changed').map((entry) => (
            <li key={entry.key}>{entry.value}</li>
          ))}
        </ul>
      </div>
      <ActionDistribution
        entries={reasoning.actionProbabilities}
        label="The weights this action was sampled from"
        {...(modalAction === undefined ? {} : { modalAction })}
      />
      <p className="prl-note">
        These weights are the policy's own, before it sampled. The same spot can come out differently next
        time, which is what makes this a style rather than a script.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// One decision
// ---------------------------------------------------------------------------

function DecisionBlock({ decision }: { readonly decision: ComparedDecision }): ReactElement {
  const actor = decision.userAction !== null ? 'you' : 'model';
  const taken =
    decision.userAction !== null
      ? describeTaken(decision.userAction)
      : decision.modelAction !== null
        ? describeTaken(decision.modelAction)
        : 'no action recorded';
  const quality = decision.userDecisionQuality;

  return (
    <li className="prl-legend-decision" data-actor={actor}>
      <div className="prl-legend-decision__head">
        <span aria-hidden="true" className="prl-index">
          {formatIndex(decision.sequence)}
        </span>
        <h3 className="prl-legend-decision__title">
          {`${capitalise(decision.street)} — ${actor === 'you' ? 'you' : 'this model'} ${taken}`}
        </h3>
        <Chip>{`Pot ${formatUnits(decision.potBefore)}`}</Chip>
        <Chip>{decision.toCall > 0 ? `${formatUnits(decision.toCall)} to call` : 'Nothing to call'}</Chip>
      </div>

      <div className="prl-legend-actions">
        <div className="prl-legend-action">
          <span className="prl-label">Your action</span>
          <span className="prl-legend-action__value">
            {decision.userAction === null ? (
              <>
                <span aria-hidden="true">—</span>
                <span className="prl-visually-hidden">not your decision</span>
              </>
            ) : (
              capitalise(describeTaken(decision.userAction))
            )}
          </span>
        </div>
        <div className="prl-legend-action">
          <span className="prl-label">This model's action</span>
          <span className="prl-legend-action__value">
            {decision.modelAction === null ? (
              <>
                <span aria-hidden="true">—</span>
                <span className="prl-visually-hidden">not the model's decision</span>
              </>
            ) : (
              capitalise(describeTaken(decision.modelAction))
            )}
          </span>
        </div>
      </div>

      {decision.analysis === null ? (
        <p className="prl-note">
          No analysis is computed for a model's decision. Building one would need that seat's hole cards, and
          a review that printed them would hand over the information the hand was played over.
        </p>
      ) : (
        <DecisionMaths report={decision.analysis} />
      )}

      {quality === null ? null : (
        <section className="prl-stack prl-stack--tight">
          <h4>How this decision looked on the maths</h4>
          <div className="prl-legend-head__meta">
            <Chip tone={BAND_TONE[quality.band]}>{BAND_WORD[quality.band]}</Chip>
          </div>
          <Metric
            decimals={EV_DECIMALS}
            delta={{
              value: quality.evGivenUp,
              label: 'against the best action the analysis priced',
              direction: quality.evGivenUp < 0 ? 'down' : 'flat',
            }}
            format="units"
            label="Expected value given up"
            note="Computed from the analysis above, before the run-out was known. It cannot move when the cards do."
            size="sm"
            value={quality.evGivenUp}
          />
          <p>{quality.note}</p>
        </section>
      )}

      {decision.alternatives.length === 0 ? null : (
        <details className="prl-disclose">
          <summary className="prl-disclose__summary">The actions not taken, and what they were worth</summary>
          <div className="prl-disclose__body">
            <ul className="prl-stack prl-stack--tight">
              {decision.alternatives.map((alternative) => (
                <li key={`${alternative.action}:${alternative.to ?? 'none'}`}>{alternative.note}</li>
              ))}
            </ul>
          </div>
        </details>
      )}

      {decision.modelReasoning === null ? null : (
        <ModelReasoningBlock
          modalAction={
            decision.modelAction === null
              ? undefined
              : decision.modelAction.to === null
                ? decision.modelAction.action
                : `${decision.modelAction.action}${decision.modelAction.action === 'raise' ? ' to' : ''} ${formatChips(decision.modelAction.to)}`
          }
          reasoning={decision.modelReasoning}
        />
      )}

      <p className="prl-note">{decision.commentary}</p>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The whole comparison
// ---------------------------------------------------------------------------

export interface PostHandComparisonProps {
  readonly comparison: HandComparison;
  /**
   * The blind level the quality bands were scaled by.
   *
   * Optional, and absent rather than guessed. `HandComparison` does not carry a big blind, and the
   * bands are defined in big blinds — so a component that defaulted to 20 would print a sentence
   * claiming a scale it had invented. Where the caller knows the blind level it says so; where it
   * does not, the note simply omits the claim.
   */
  readonly bigBlind?: number;
  readonly className?: string;
}

/** The scale sentence, or the honest absence of one. */
function bandScaleNote(bigBlind: number | undefined): string {
  const measured = 'Computed from the analysis at each decision, with no reference to the result.';
  if (bigBlind === undefined || !Number.isFinite(bigBlind) || bigBlind <= 0) {
    return `${measured} The blind level these bands are scaled by was not supplied with this hand, so it is not stated here.`;
  }
  return `Bands are scaled by the ${formatUnits(bigBlind)} big blind. ${measured}`;
}

export function PostHandComparison(props: PostHandComparisonProps): ReactElement {
  const { comparison, bigBlind, className } = props;
  const { disclosure, decisionQuality } = comparison;
  const result = comparison.chipResult;
  const resultWord = result < 0 ? 'A loss of' : result > 0 ? 'A gain of' : 'Flat:';

  return (
    <div className={cx('prl-legend-review', className)}>
      <div className="prl-legend-identity">
        <LegendSigil profileId={comparison.profileId} size="lg" />
        <div className="prl-legend-identity__names">
          <h2 className="prl-legend-identity__archetype">
            {`Hand ${formatChips(comparison.handNumber)} against the ${disclosure.archetypeName}`}
          </h2>
          {disclosure.attributed ? (
            <span className="prl-legend-identity__attributed prl-label">{disclosure.displayName}</span>
          ) : null}
          <p className="prl-legend-identity__tagline">{disclosure.tagline}</p>
        </div>
      </div>

      <CardRow cards={boardCards(comparison.board)} label="Community cards" size="sm" />

      <ProfileDisclaimers disclosure={disclosure} />

      {/*
        The separation. Two panels, a labelled wall between them, and nothing in either panel
        derived from the other. See the module comment: this is the point of the component.
      */}
      <section className="prl-legend-outcome">
        <Panel
          className="prl-legend-outcome__result"
          eyebrow="What happened"
          headingLevel={2}
          index={1}
          title="Chip result"
          tone="raised"
        >
          {/*
            Neutral tone whatever the sign. A colour that rewarded a won pot would be rewarding the
            outcome, which is the one thing this product does not do.
          */}
          <Metric format="units" label="Net for this hand" size="lg" tone="neutral" value={result} />
          <p>
            {`${resultWord} ${formatUnits(Math.abs(result))} in free practice units. Units are resettable and have no value, and this figure is the run-out only — it says nothing about the decisions that produced it.`}
          </p>
        </Panel>

        <div className="prl-legend-outcome__wall">
          <p>
            These two figures are not connected. One is what the cards did; the other is what the analysis
            priced before the cards were known. Neither is used here to explain the other.
          </p>
        </div>

        <Panel
          className="prl-legend-outcome__quality"
          eyebrow="What the maths said"
          headingLevel={2}
          index={2}
          title="Decision quality"
          tone="raised"
        >
          <div className="prl-legend-head__meta">
            <Chip tone={BAND_TONE[decisionQuality.band]}>{BAND_WORD[decisionQuality.band]}</Chip>
          </div>
          <Metric
            decimals={EV_DECIMALS}
            delta={{
              value: decisionQuality.evGivenUp,
              label: 'against the best the analysis priced at each point',
              direction: decisionQuality.evGivenUp < 0 ? 'down' : 'flat',
            }}
            format="units"
            label="Expected value given up"
            note={bandScaleNote(bigBlind)}
            size="lg"
            value={decisionQuality.evGivenUp}
          />
          <p>{decisionQuality.note}</p>
        </Panel>
      </section>

      {comparison.outcomeVersusQualityNote === null ? null : (
        <Callout tone="insight" title="The result and the reasoning point in opposite directions">
          <p>{comparison.outcomeVersusQualityNote}</p>
        </Callout>
      )}

      <section className="prl-legend-section">
        <h2>Decision by decision</h2>
        <p className="prl-prose">
          Every decision in the hand, in order: what was done, what the analysis priced, and — for the model's
          decisions — the weights it sampled its action from. Your decisions carry an accent edge and the word
          "you"; the model's do not.
        </p>
        <ol className="prl-legend-decisions">
          {comparison.decisions.map((decision) => (
            <DecisionBlock decision={decision} key={decision.sequence} />
          ))}
        </ol>
      </section>
    </div>
  );
}
