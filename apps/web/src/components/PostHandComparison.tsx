/**
 * The post-hand comparison. The chip result and the decision quality are never presented as
 * explaining each other. They sit in two panels with a labelled wall between them at every width,
 * neither one's tone derives from the other, and the chip result is always neutral in tone.
 * Only the per-action EV table may collapse (§6.2). Assumptions and uncertainty stay visible.
 * Emits `h2` sections, `h3` per decision and `h4` inside one. Never an `h1`. Server-render safe.
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
  formatPoints,
  formatProbability,
  formatSignedUnits,
  formatUnits,
  Metric,
  NOT_A_PROBABILITY,
  Panel,
  parseCardText,
  UncertaintyNote,
  withKeys,
} from '@prl/ui';
import type { ReactElement } from 'react';
import { ActionDistribution, mostLikelyAction } from './ActionDistribution.tsx';
import { LegendSigil } from './LegendSigil.tsx';
import { ProfileDisclaimers } from './ProfileDisclaimers.tsx';

/** The bands are fractions of a big blind, so at zero decimals a 0.4-unit shortfall reads `0`. */
const EV_DECIMALS = 1;

const BAND_WORD: Readonly<Record<DecisionQuality['band'], string>> = {
  'consistent-with-analysis': 'Consistent with the analysis',
  'slightly-off': 'Slightly off the best-priced action',
  'materially-off': 'Materially off the best-priced action',
};

/** The accent means "computed data", not "well done". An off band is information, so never `adverse`. */
const BAND_TONE: Readonly<Record<DecisionQuality['band'], 'accent' | 'caution'>> = {
  'consistent-with-analysis': 'accent',
  'slightly-off': 'caution',
  'materially-off': 'caution',
};

const ACTION_PAST: Readonly<Record<string, string>> = {
  fold: 'folded',
  check: 'checked',
  call: 'called',
  bet: 'bet',
  raise: 'raised to',
};

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

function boardCards(board: readonly string[]): readonly number[] {
  const cards: number[] = [];
  for (const text of board) {
    const card = parseCardText(text);
    if (card !== null) cards.push(card);
  }
  return cards;
}

/** `null` for an exact enumeration. A sampled figure with no half-width gets a sentence in `methodNote`. */
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
                  label: `against the ${formatProbability(report.potOdds.breakEvenEquity) ?? NOT_A_PROBABILITY} this price needs`,
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
        {/* `potOdds.pot` is what hero could win, which is less than `potTotal` when hero is all-in short. */}
        <Metric
          format="units"
          label="Pot the decision was for"
          note={
            report.potTotal > report.potOdds.pot
              ? `${formatUnits(report.toCall)} to call, with ${formatUnits(report.potTotal - report.potOdds.pot)} of the ${formatUnits(report.potTotal)} in the middle a side pot this seat was not in.`
              : priced
                ? `${formatUnits(report.toCall)} to call.`
                : 'Nothing to call.'
          }
          value={report.potOdds.pot}
        />
      </div>
      {priced ? (
        <Formula
          eyebrow="Pot odds"
          // Break-even equity is a probability, so it goes through the domain formatter.
          expression={`break-even equity = ${formatChips(report.toCall)} / (${formatChips(report.potOdds.pot)} + ${formatChips(report.toCall)}) = ${formatProbability(report.potOdds.breakEvenEquity) ?? NOT_A_PROBABILITY}`}
          explanation={report.potOdds.explanation}
        />
      ) : null}
      {report.equity.ruleOfThumb === null ? null : (
        <Callout tone="misconception" title="What the rule of 2 and 4 says here">
          <p>{report.equity.ruleOfThumb.note}</p>
        </Callout>
      )}
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
      {/* `h4`, not `h5`. A skipped level breaks heading navigation under the decision's `h3`. */}
      <AssumptionList headingLevel={4} items={report.assumptions} />
      <UncertaintyNote headingLevel={4} note={report.uncertainty} />
    </div>
  );
}

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
              <span className="prl-legend-action__none">Not your decision</span>
            ) : (
              capitalise(describeTaken(decision.userAction))
            )}
          </span>
        </div>
        <div className="prl-legend-action">
          <span className="prl-label">This model's action</span>
          <span className="prl-legend-action__value">
            {decision.modelAction === null ? (
              <span className="prl-legend-action__none">Not the model's decision</span>
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
        /*
          The marked row is chosen from the distribution, never described a second time. A rebuilt
          string grouped digits differently and never matched (action-distribution-marker.test.ts).
        */
        <ModelReasoningBlock
          modalAction={mostLikelyAction(decision.modelReasoning.actionProbabilities)}
          reasoning={decision.modelReasoning}
        />
      )}

      <p className="prl-note">{decision.commentary}</p>
    </li>
  );
}

export interface PostHandComparisonProps {
  readonly comparison: HandComparison;
  /** Absent rather than guessed. `HandComparison` carries no big blind, and a default would be invented. */
  readonly bigBlind?: number;
  readonly className?: string;
}

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

      <section className="prl-legend-outcome">
        <Panel
          className="prl-legend-outcome__result"
          eyebrow="What happened"
          headingLevel={2}
          index={1}
          title="Chip result"
          tone="raised"
        >
          {/* Neutral whatever the sign. A colour on a won pot would reward the outcome. */}
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
          Every decision in the hand, in order: what was done and what the analysis priced. Your decisions
          carry an accent edge and the word "you"; the model's do not. Sampled action weights appear only when
          the record actually has them — the demo hand does, a stored hand from play does not.
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
