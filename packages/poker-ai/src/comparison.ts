/**
 * The post-hand comparison. Each learner decision beside the analysis and beside what the model did.
 *
 * `scoreDecisionQuality` has no parameter that can carry the run-out or chip result, so quality never
 * depends on outcome. The two meet only in `outcomeVersusQualityNote`.
 * Only the learner's own decisions are analysed. A model decision's `CoachReport` would list its outs and
 * leak its hole cards, so it carries `ModelReasoning` from public state and `analysis: null`.
 * Every recorded view must be the acting seat's own, on its turn, in this hand, with the action offered.
 * When nothing was scored, the aggregate is a zero with a note and the outcome note is suppressed.
 * Post-hand only. `actionProbabilities` is conditioned on the model's hole cards and would leak live.
 */

import type {
  ActionCandidate,
  CoachReport,
  ComparedDecision,
  DecisionQuality,
  HandComparison,
} from '@prl/contracts';
import { type Action, type Card, cardToString, type PlayerView } from '@prl/poker-engine';
import {
  bestCandidate,
  candidateForAction,
  commentOnDecision,
  explainModelDecision,
  outcomeVersusQualityNote,
  type PolicyDecisionSummary,
  publishCommentary,
} from './commentary.ts';
import type { ProfileDisclosure } from './labelling.ts';
import type { StrategyProfile } from './profiles.ts';

export class ComparisonError extends Error {
  override readonly name = 'ComparisonError';
}

/** `potBefore` and `toCall` are read from the view, so there is one source for each. */
export interface RecordedDecision {
  /** Ordering within the hand. Must strictly increase across the recorded list. */
  readonly sequence: number;
  readonly seat: number;
  readonly action: Action;
  /** The acting seat's own redacted view, as it was at the moment of the decision. */
  readonly view: PlayerView;
  /** The policy's decision for a model seat. Null for the learner, and for an unrecorded model decision. */
  readonly decision: PolicyDecisionSummary | null;
  /** The profile that played this seat. Defaults to the one passed to `buildHandComparison`. */
  readonly profile?: StrategyProfile;
  readonly disclosure?: ProfileDisclosure;
}

/**
 * Band edges in big blinds of EV given up. A modelling choice, not a measurement.
 * 0.5bb is inside the report's own resolution (its confidence drops to `low` under a 0.25bb gap).
 * 2bb is past the report's noise but still within what a different range assumption can move.
 * Each edge belongs to the tighter band, with an epsilon for floating-point drift.
 */
export const QUALITY_BANDS_IN_BIG_BLINDS = {
  consistentWithAnalysis: 0.5,
  slightlyOff: 2,
} as const;

const BAND_EPSILON = 1e-9;

/** The band for a shortfall already expressed in big blinds. Never negative input. */
export function bandForShortfall(shortfallInBigBlinds: number): DecisionQuality['band'] {
  if (!Number.isFinite(shortfallInBigBlinds) || shortfallInBigBlinds < 0) {
    throw new ComparisonError(
      `a shortfall must be a non-negative finite number of big blinds, received ${shortfallInBigBlinds}`,
    );
  }
  if (shortfallInBigBlinds <= QUALITY_BANDS_IN_BIG_BLINDS.consistentWithAnalysis + BAND_EPSILON) {
    return 'consistent-with-analysis';
  }
  if (shortfallInBigBlinds <= QUALITY_BANDS_IN_BIG_BLINDS.slightlyOff + BAND_EPSILON) return 'slightly-off';
  return 'materially-off';
}

function formatUnits(value: number): string {
  return value.toFixed(1);
}

/** With an explicit sign, because "3.0 units" and "-3.0 units" mean opposite things. */
function formatSignedUnits(value: number): string {
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  return `${rounded >= 0 ? '+' : '-'}${Math.abs(rounded).toFixed(1)}`;
}

function bandNote(input: {
  readonly band: DecisionQuality['band'];
  readonly shortfallUnits: number;
  readonly shortfallBigBlinds: number;
  readonly chosenLabel: string;
  readonly bestLabel: string;
  readonly sizeNote: string;
}): string {
  // A zero shortfall gets its own sentence rather than "0.0 units behind itself".
  const measured =
    input.shortfallUnits < 0.05
      ? `${input.chosenLabel} was the best-priced action in the analysis, giving up nothing against the ` +
        `alternatives it considered, on the range and fold-equity assumptions stated in that report.${input.sizeNote}`
      : `${input.chosenLabel} was priced ${formatUnits(input.shortfallUnits)} units behind ${input.bestLabel}, ` +
        `the best of the actions the analysis priced — ${input.shortfallBigBlinds.toFixed(2)} big blinds, on the ` +
        `range and fold-equity assumptions stated in that report.${input.sizeNote}`;
  switch (input.band) {
    case 'consistent-with-analysis':
      return (
        `${measured} That is inside the ${QUALITY_BANDS_IN_BIG_BLINDS.consistentWithAnalysis} big blinds this ` +
        'band allows, which is the analysis’s own resolution — the two are not distinguishable here.'
      );
    case 'slightly-off':
      return (
        `${measured} That is past the ${QUALITY_BANDS_IN_BIG_BLINDS.consistentWithAnalysis} big blinds the ` +
        `closest band allows and inside ${QUALITY_BANDS_IN_BIG_BLINDS.slightlyOff} — worth working through, and ` +
        'small enough that a different range assumption could account for it.'
      );
    default:
      return (
        `${measured} That is beyond the ${QUALITY_BANDS_IN_BIG_BLINDS.slightlyOff} big blinds the middle band ` +
        'allows. A gap this size usually survives a change of range assumption, so it is the part of the hand ' +
        'with the most to teach.'
      );
  }
}

/** One gerund ("raising to 140") for both an `Action` and a priced candidate. */
function nameAction(type: ActionCandidate['action'], to: number | null): string {
  switch (type) {
    case 'bet':
      return `betting ${to ?? 0}`;
    case 'raise':
      return `raising to ${to ?? 0}`;
    case 'call':
      return 'calling';
    case 'check':
      return 'checking';
    case 'fold':
      return 'folding';
    default:
      throw new ComparisonError(`unknown action type "${String(type)}"`);
  }
}

function nameChosen(action: Action): string {
  return nameAction(action.type, action.type === 'bet' || action.type === 'raise' ? action.to : null);
}

/** True when the report priced the action taken, so scoring it compares like with like. */
export function analysisEvaluatedAction(analysis: CoachReport, action: Action): boolean {
  return candidateForAction(analysis, action) !== null;
}

/**
 * Compares the chosen action with the best action the analysis priced. `evGivenUp` is
 * `chosenEv - bestAvailableEv`, so it is zero or negative.
 * `bigBlind` is a parameter because `CoachReport` does not carry one, and a guess would move every band.
 */
export function scoreDecisionQuality(input: {
  readonly analysis: CoachReport;
  readonly chosenAction: Action;
  readonly bigBlind: number;
}): DecisionQuality {
  const { analysis, chosenAction, bigBlind } = input;
  if (!Number.isFinite(bigBlind) || bigBlind <= 0) {
    throw new ComparisonError(`bigBlind must be a positive finite number, received ${bigBlind}`);
  }
  const best = bestCandidate(analysis);
  const chosen = candidateForAction(analysis, chosenAction);
  if (chosen === null) {
    throw new ComparisonError(
      `the analysis priced no "${chosenAction.type}" action, so this decision cannot be scored against it. ` +
        'Check analysisEvaluatedAction first and report the decision as unscored.',
    );
  }

  const evGivenUp = chosen.ev - best.ev;
  const shortfallUnits = Math.max(0, -evGivenUp);
  const shortfallBigBlinds = shortfallUnits / bigBlind;
  const band = bandForShortfall(shortfallBigBlinds);

  const chosenTotal = chosenAction.type === 'bet' || chosenAction.type === 'raise' ? chosenAction.to : null;
  const sizeNote =
    chosenTotal !== null && chosen.to !== undefined && chosen.to !== chosenTotal
      ? ` The analysis priced the sizes the table's sizing buttons offer rather than every size, and the nearest to the ${chosenTotal} taken was ${chosen.to}, so that is the figure used.`
      : '';

  return {
    bestAvailableEv: best.ev,
    chosenEv: chosen.ev,
    evGivenUp,
    band,
    note: bandNote({
      band,
      shortfallUnits,
      shortfallBigBlinds,
      chosenLabel: capitalise(nameChosen(chosenAction)),
      bestLabel: nameAction(best.action, best.to ?? null),
      sizeNote,
    }),
  };
}

function capitalise(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Excludes the chosen candidate by identity, so other sizes of the same action stay listed. */
function buildAlternatives(
  analysis: CoachReport,
  chosenAction: Action,
  where: string,
): ComparedDecision['alternatives'] {
  const chosen = candidateForAction(analysis, chosenAction);
  const chosenEv = chosen?.ev ?? null;
  return analysis.candidates
    .filter((candidate) => candidate !== chosen)
    .map((candidate, index) => {
      const gap = chosenEv === null ? null : candidate.ev - chosenEv;
      const comparison =
        gap === null
          ? 'The action taken was not priced here, so there is nothing to compare it against.'
          : Math.abs(gap) < 0.05
            ? 'Level with the action taken on these assumptions.'
            : `${Math.abs(gap).toFixed(1)} units ${gap > 0 ? 'ahead of' : 'behind'} the action taken, on the same assumptions.`;
      const zeroPoint =
        candidate.action === 'fold'
          ? ' Folding is the zero point every other figure here is measured against.'
          : '';
      return {
        action: candidate.action,
        to: candidate.to ?? null,
        ev: candidate.ev,
        note: publishCommentary(
          `${capitalise(nameAction(candidate.action, candidate.to ?? null))}: ${formatSignedUnits(candidate.ev)} units. ${comparison}${zeroPoint}`,
          `${where}.alternatives[${index}]`,
        ),
      };
    });
}

function validateRecorded(decision: RecordedDecision, handId: string, previousSequence: number): void {
  const where = `recorded decision at sequence ${decision.sequence}`;
  if (!Number.isFinite(decision.sequence)) throw new ComparisonError(`${where}: sequence must be finite`);
  if (decision.sequence <= previousSequence) {
    throw new ComparisonError(
      `${where}: sequences must strictly increase (previous was ${previousSequence}); a replay out of order describes a hand that never happened`,
    );
  }
  const view = decision.view;
  if (view.handId !== handId) {
    throw new ComparisonError(`${where}: the view belongs to hand ${view.handId}, not ${handId}`);
  }
  if (view.viewerSeat !== decision.seat) {
    throw new ComparisonError(
      `${where}: the view was built for seat ${String(view.viewerSeat)} but the action is seat ${decision.seat}'s — ` +
        'a comparison must only ever read the acting seat’s own view',
    );
  }
  if (view.toAct !== decision.seat) {
    throw new ComparisonError(
      `${where}: the view has seat ${String(view.toAct)} to act, so it is not the view that seat ${decision.seat} acted on`,
    );
  }
  if (!view.legalActions.some((legal) => legal.type === decision.action.type)) {
    throw new ComparisonError(
      `${where}: the engine did not offer "${decision.action.type}" in that view. The engine decides legality; a comparison cannot invent one.`,
    );
  }
}

function actionDto(action: Action): { readonly action: string; readonly to: number | null } {
  return {
    action: action.type,
    to: action.type === 'bet' || action.type === 'raise' ? action.to : null,
  };
}

interface ScoredTotals {
  readonly count: number;
  readonly bestAvailableEv: number;
  readonly chosenEv: number;
}

/** Summed, not averaged, because half a big blind lost on three streets costs one and a half. */
function aggregateQuality(totals: ScoredTotals, bigBlind: number): DecisionQuality {
  if (totals.count === 0) {
    return {
      bestAvailableEv: 0,
      chosenEv: 0,
      evGivenUp: 0,
      band: 'consistent-with-analysis',
      note: publishCommentary(
        'No decision in this hand could be scored: either no analysis was available for it, or the analysis did ' +
          'not price the action taken. This figure therefore carries no information about the hand, and nothing ' +
          'here should be read as a judgement on how it was played.',
        'aggregateQuality.unscored',
      ),
    };
  }
  const evGivenUp = totals.chosenEv - totals.bestAvailableEv;
  const shortfallUnits = Math.max(0, -evGivenUp);
  const shortfallBigBlinds = shortfallUnits / bigBlind;
  const band = bandForShortfall(shortfallBigBlinds);
  const plural = totals.count === 1 ? 'decision' : 'decisions';
  return {
    bestAvailableEv: totals.bestAvailableEv,
    chosenEv: totals.chosenEv,
    evGivenUp,
    band,
    note: publishCommentary(
      `Across ${totals.count} scored ${plural} this hand, the actions taken were ${formatUnits(shortfallUnits)} ` +
        `units behind the best the analysis priced at each point — ${shortfallBigBlinds.toFixed(2)} big blinds in ` +
        'total, summed rather than averaged, because a cost paid on three streets is paid three times. Every ' +
        'figure here comes from the analysis at each decision and none of it comes from how the hand ended.',
      'aggregateQuality.scored',
    ),
  };
}

function buildComparedDecision(input: {
  readonly recorded: RecordedDecision;
  readonly isUser: boolean;
  readonly profile: StrategyProfile;
  readonly disclosure: ProfileDisclosure;
  readonly analysis: CoachReport | null;
  readonly quality: DecisionQuality | null;
}): ComparedDecision {
  const { recorded, isUser, analysis } = input;
  const view = recorded.view;
  const where = `comparedDecision[${recorded.sequence}]`;
  const label = isUser ? 'you' : input.disclosure.shortLabel;

  return {
    sequence: recorded.sequence,
    street: view.street,
    potBefore: view.potTotal,
    toCall: view.amountToCall,
    userAction: isUser ? actionDto(recorded.action) : null,
    modelAction: isUser ? null : actionDto(recorded.action),
    modelReasoning:
      isUser || recorded.decision === null
        ? null
        : explainModelDecision({
            decision: recorded.decision,
            profile: input.profile,
            disclosure: input.disclosure,
            view,
          }),
    analysis,
    alternatives: analysis === null ? [] : buildAlternatives(analysis, recorded.action, where),
    userDecisionQuality: input.quality,
    commentary: commentOnDecision({
      street: view.street,
      potBefore: view.potTotal,
      toCall: view.amountToCall,
      actorLabel: label,
      action: recorded.action,
      isUser,
      analysis,
      decision: recorded.decision,
    }),
  };
}

/** `analyse` is injected so this stays pure and testable without running a Monte Carlo. */
export function buildHandComparison(input: {
  readonly handId: string;
  readonly handNumber: number;
  readonly board: readonly Card[];
  readonly decisions: readonly RecordedDecision[];
  readonly userSeat: number;
  readonly profile: StrategyProfile;
  readonly disclosure: ProfileDisclosure;
  readonly chipResult: number;
  readonly analyse: (decision: RecordedDecision) => CoachReport | null;
}): HandComparison {
  if (input.decisions.length === 0) {
    throw new ComparisonError('a hand comparison needs at least one recorded decision');
  }
  if (![0, 3, 4, 5].includes(input.board.length)) {
    throw new ComparisonError(`a board has 0, 3, 4 or 5 cards, received ${input.board.length}`);
  }
  if (!Number.isFinite(input.chipResult)) {
    throw new ComparisonError(`chipResult must be finite, received ${input.chipResult}`);
  }

  const first = input.decisions[0];
  if (first === undefined)
    throw new ComparisonError('a hand comparison needs at least one recorded decision');
  const bigBlind = first.view.config.bigBlind;
  if (!Number.isFinite(bigBlind) || bigBlind <= 0) {
    throw new ComparisonError(
      `the recorded views carry a big blind of ${bigBlind}, which cannot scale a band`,
    );
  }

  const compared: ComparedDecision[] = [];
  let previousSequence = Number.NEGATIVE_INFINITY;
  let count = 0;
  let bestTotal = 0;
  let chosenTotal = 0;

  for (const recorded of input.decisions) {
    validateRecorded(recorded, input.handId, previousSequence);
    previousSequence = recorded.sequence;
    if (recorded.view.config.bigBlind !== bigBlind) {
      throw new ComparisonError(
        `the recorded views disagree on the big blind (${bigBlind} then ${recorded.view.config.bigBlind}); ` +
          'one hand has one blind level',
      );
    }
    const isUser = recorded.seat === input.userSeat;
    // A model's analysis would leak its hole cards.
    const analysis = isUser ? input.analyse(recorded) : null;
    let quality: DecisionQuality | null = null;
    if (analysis !== null && analysisEvaluatedAction(analysis, recorded.action)) {
      quality = scoreDecisionQuality({ analysis, chosenAction: recorded.action, bigBlind });
      count += 1;
      bestTotal += quality.bestAvailableEv;
      chosenTotal += quality.chosenEv;
    }
    compared.push(
      buildComparedDecision({
        recorded,
        isUser,
        profile: recorded.profile ?? input.profile,
        disclosure: recorded.disclosure ?? input.disclosure,
        analysis,
        quality,
      }),
    );
  }

  const decisionQuality = aggregateQuality(
    { count, bestAvailableEv: bestTotal, chosenEv: chosenTotal },
    bigBlind,
  );

  return {
    handId: input.handId,
    handNumber: input.handNumber,
    board: input.board.map(cardToString),
    decisions: compared,
    chipResult: input.chipResult,
    decisionQuality,
    // Suppressed when nothing was scored, so an empty measurement never reads as a well-played hand.
    outcomeVersusQualityNote:
      count === 0
        ? null
        : outcomeVersusQualityNote({ chipResult: input.chipResult, quality: decisionQuality }),
    profileId: input.profile.naming.id,
    disclosure: input.disclosure,
  };
}
