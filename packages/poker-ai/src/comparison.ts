/**
 * The post-hand comparison: the learner's decisions beside the maths, and beside what the
 * model did.
 *
 * This is the "Compare" step, and its whole job is to show the *shape* of each decision
 * rather than a verdict on it. Every figure comes from the analysis that was computed for
 * that decision point, and the actions the learner did not take are listed with their
 * expected value, so a decision reads as a set of priced options rather than as a mark out
 * of ten.
 *
 * ## Quality is never outcome, and the separation is structural
 *
 * `scoreDecisionQuality` takes an analysis and an action. It has no parameter capable of
 * carrying the run-out, the winner, or the chip result, so it cannot be influenced by any of
 * them — scoring the same decision against two different endings is the same call twice.
 * `HandComparison.chipResult` and `HandComparison.decisionQuality` are assembled
 * independently here, and the only place they meet is
 * `outcomeVersusQualityNote`, which exists to say out loud that they disagree.
 *
 * ## Three traps this file is built around
 *
 * **A model's analysis would leak its cards.** `analyse` is only ever called for the
 * *learner's own* decisions. A `CoachReport` for a model's decision is computed from that
 * seat's hole cards: its `outs.cleanCards` literally lists cards, and its equity figure is
 * derived from a holding the learner may never have been shown. A hand that ends in a fold
 * reveals nothing at a real table, and a review that quietly printed the folder's outs would
 * hand over exactly the information the game is played over. So a model decision carries its
 * `ModelReasoning` — generated from public state and declared parameters — and
 * `analysis: null`.
 *
 * **The recorded view must be the acting seat's own.** Every `RecordedDecision` is checked:
 * the view was built for that seat (`viewerSeat === seat`), it was that seat's turn
 * (`toAct === seat`), it belongs to this hand, and the engine actually offered the action
 * type taken. A comparison assembled from someone else's view, or from a view taken at a
 * different moment, would be quietly describing a situation that never existed — and the
 * numbers would look perfectly reasonable while doing it.
 *
 * **"Nothing was scored" is not "played well".** When no decision in the hand could be
 * scored, the aggregate quality is a zero with a note saying so, and the
 * outcome-versus-quality note is suppressed. Firing "the analysis supported this line" over
 * an empty measurement would be exactly the false congratulation this feature exists to
 * avoid.
 *
 * ## Why this is post-hand only
 *
 * `ModelReasoning.actionProbabilities` exposes the distribution the model sampled from, and
 * that distribution is conditioned on the model's hole cards. It is safe in a review of a
 * finished hand and it is a live information leak in a hand still being played. Nothing in
 * the inputs can prove a hand is over, so this is stated rather than enforced: the caller is
 * the hand's settlement path, and there is no other legitimate caller.
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

/**
 * One decision as the hand recorded it: what was done, and what the actor could see.
 *
 * `potBefore` and `toCall` are deliberately absent — they are read from the view, which is
 * the picture the actor actually had. Recording them separately would create a second source
 * for the same number, and two sources for one number disagree eventually.
 */
export interface RecordedDecision {
  /** Ordering within the hand. Must strictly increase across the recorded list. */
  readonly sequence: number;
  readonly seat: number;
  readonly action: Action;
  /** The acting seat's own redacted view, as it was at the moment of the decision. */
  readonly view: PlayerView;
  /**
   * The policy's decision, for a model seat. Null for the learner's own decisions, and for
   * a model seat whose decision was not recorded — in which case the replay line states the
   * action and claims nothing about why.
   */
  readonly decision: PolicyDecisionSummary | null;
  /**
   * The profile that played this seat, when a table seats more than one. Defaults to the
   * profile passed to `buildHandComparison`, which is the heads-up case.
   */
  readonly profile?: StrategyProfile;
  readonly disclosure?: ProfileDisclosure;
}

// ---------------------------------------------------------------------------
// The bands
// ---------------------------------------------------------------------------

/**
 * Where the bands sit, in big blinds of expected value given up.
 *
 * **These are a modelling choice, not a measurement, and the reasoning is:**
 *
 * * **0.5 big blinds — `consistent-with-analysis`.** Inside the analysis's own resolution.
 *   `buildCoachReport` already downgrades its suggestion confidence to `low` when the gap
 *   between its best two actions is under 0.25 big blinds and to `moderate` under a full
 *   one, and its equity figure is frequently sampled with an interval of its own. A decision
 *   inside half a big blind of the best priced action is not distinguishable from it, and
 *   presenting it as worse would be reading precision the report does not have.
 * * **2 big blinds — `slightly-off`.** Larger than the report's noise and smaller than the
 *   edge a whole hand usually turns on. Worth reviewing; not worth a strong claim, because a
 *   different range assumption can move a figure this far on its own.
 * * **Beyond 2 — `materially-off`.** A gap this size normally survives a change of
 *   assumption, so it is where the analysis is saying something a learner can act on.
 *
 * Both boundaries are **inclusive** of the tighter band: exactly 0.5 is
 * `consistent-with-analysis`, exactly 2 is `slightly-off`. A comparison epsilon absorbs
 * floating-point drift, so a shortfall that arithmetic renders as 0.5000000000000001 does
 * not fall through to the next band on a rounding artefact.
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

// ---------------------------------------------------------------------------
// scoreDecisionQuality
// ---------------------------------------------------------------------------

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
  // When the action taken *was* the best-priced one, saying it was "0.0 units behind itself"
  // is true and unreadable. The two cases are different sentences, not one with a zero in it.
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

/**
 * One naming of an action for a note, used for both an `Action` and a priced candidate.
 *
 * A gerund ("raising to 140") rather than a bare verb, because every note below reads as
 * "<action> was priced at ...", and one formatter for both shapes is one fewer place for the
 * two to disagree.
 */
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
 * How the chosen action compares with the best action the analysis priced.
 *
 * Computable at the moment of the decision: the inputs are one report and one action, and
 * the report is built from the cards and the price, never from the run-out. `evGivenUp` is
 * `chosenEv - bestAvailableEv`, so it is zero when the chosen action *was* the best priced
 * one and negative otherwise — never positive, because the chosen action is one of the
 * candidates the maximum was taken over.
 *
 * `bigBlind` is a parameter because `CoachReport` does not carry one. Guessing it would
 * silently move every band boundary, and a band that quietly means something different from
 * what it says is worse than a parameter.
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
      ? ` The analysis priced three representative sizes rather than every size, and the nearest to the ${chosenTotal} taken was ${chosen.to}, so that is the figure used.`
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

// ---------------------------------------------------------------------------
// Alternatives
// ---------------------------------------------------------------------------

/**
 * The other priced actions, so the learner sees the decision rather than a verdict.
 *
 * The chosen candidate is excluded by identity, which means the other *sizes* of the same
 * action stay in the list. That is deliberate: for a bet or a raise, "the same action at a
 * different price" is usually the most interesting comparison on the board.
 */
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

// ---------------------------------------------------------------------------
// buildHandComparison
// ---------------------------------------------------------------------------

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

/**
 * The hand-level quality: the scored decisions summed, not averaged.
 *
 * Summed because giving up half a big blind on each of three streets costs one and a half
 * big blinds, and an average would report it as half of one. The same band thresholds are
 * then applied to the total, which is the honest reading of "what did this hand cost".
 */
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

/**
 * Assembles the whole comparison for one finished hand.
 *
 * `analyse` is injected so this function stays pure and cheap: the equity work belongs to
 * `@prl/poker-math` and to the caller's budget, and a comparison that computed it inline
 * could not be tested without running a Monte Carlo.
 */
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
    // Only the learner's own decisions are analysed — see the module comment on why a
    // model's analysis would leak its hole cards into the learner's review.
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
    // Suppressed when nothing was scored: "consistent with the analysis" over an empty
    // measurement is the absence of evidence, and dressing it as a well-played hand that
    // lost would be the exact false congratulation this feature exists to avoid. The note
    // itself lives in commentary.ts with the rest of the learner-facing prose, so there is
    // one wording rather than two that drift.
    outcomeVersusQualityNote:
      count === 0
        ? null
        : outcomeVersusQualityNote({ chipResult: input.chipResult, quality: decisionQuality }),
    profileId: input.profile.naming.id,
    disclosure: input.disclosure,
  };
}
