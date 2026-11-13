/**
 * The Legends "compare your hand" report, built from a hand that was actually played.
 * The replay stays private in `build-review.ts`, which exports `buildComparisonDecisions` for this
 * caller only, so there is one walk of the hand.
 * A hand the replay cannot reproduce is refused with a reason. It never falls back to the sample.
 * `ModelReasoning` is always null. The policy's distribution is not persisted, so a stored hand can
 * state the model's action but nothing about why.
 */

import type { HandComparison } from '@prl/contracts';
import {
  buildHandComparison,
  ComparisonError,
  type NamingMode,
  PROFILES,
  profileDisclosure,
  type RecordedDecision,
  type StrategyProfile,
} from '@prl/poker-ai';
import type { Card } from '@prl/poker-engine';
import {
  buildComparisonDecisions,
  type HandActionRow,
  type HandRow,
  type HandSeatRow,
  type ReviewAnalyser,
} from './build-review.ts';

/** Why a hand cannot be compared. Each becomes a distinct sentence on the page. */
export type ComparisonRefusal =
  /** The hand is still being played. A comparison of a live hand would leak a model's cards. */
  | 'hand-in-progress'
  /** No seat in this hand was a modelled opponent this build can name. */
  | 'no-legend-in-hand'
  /** The stored rows do not describe a hand this server can reproduce. */
  | 'not-reproducible';

export type ComparisonOutcome =
  | { readonly ok: true; readonly comparison: HandComparison }
  | { readonly ok: false; readonly refusal: ComparisonRefusal; readonly detail: string };

export interface BuildLegendComparisonInput {
  readonly hand: HandRow;
  readonly seats: readonly HandSeatRow[];
  readonly actions: readonly HandActionRow[];
  /** The learner. Only their own decisions are analysed. */
  readonly viewerUserId: string;
  /**
   * `user_id -> strategy profile id`, from `room_members` for this hand's room. `prl.hand_seats`
   * records that a seat was a bot, not which model, so the profile is joined from the roster.
   */
  readonly botProfiles: ReadonlyMap<string, string>;
  readonly namingMode: NamingMode;
  /** Wall-clock budget for the analysis, in milliseconds. */
  readonly budgetMs: number;
  /**
   * Required, not defaulted, so no caller runs the Monte Carlo work on the event loop. A comparison
   * evaluates the untaken actions too, so it costs more than a hand review.
   */
  readonly analyse: ReviewAnalyser;
  readonly onAnalysisSkipped?: (detail: { readonly sequence: number; readonly reason: string }) => void;
}

export async function buildLegendComparison(input: BuildLegendComparisonInput): Promise<ComparisonOutcome> {
  if (input.hand.completed_at === null || input.hand.street !== 'complete') {
    return {
      ok: false,
      refusal: 'hand-in-progress',
      detail: 'a comparison exposes what each seat could see, so it is post-hand only',
    };
  }

  const viewerSeat = input.seats.find((seat) => seat.user_id === input.viewerUserId) ?? null;
  if (viewerSeat === null) {
    // The query already required a seat, so this is a programming error. Refused all the same.
    return { ok: false, refusal: 'not-reproducible', detail: 'the caller holds no seat in this hand' };
  }

  const profileBySeat = new Map<number, StrategyProfile>();
  for (const seat of input.seats) {
    if (!seat.is_bot || seat.user_id === null) continue;
    const profileId = input.botProfiles.get(seat.user_id);
    if (profileId === undefined) continue;
    const profile = PROFILES.find((candidate) => candidate.naming.id === profileId);
    // An unknown id is a retired Legend. Leave the seat unnamed, never map it to a surviving style.
    if (profile !== undefined) profileBySeat.set(seat.seat, profile);
  }
  const headline = [...profileBySeat.values()][0];
  if (headline === undefined) {
    return {
      ok: false,
      refusal: 'no-legend-in-hand',
      detail: 'no seat in this hand was played by a strategy profile this build can name',
    };
  }

  const built = await buildComparisonDecisions({
    hand: input.hand,
    seats: input.seats,
    actions: input.actions,
    viewerUserId: input.viewerUserId,
    budgetMs: input.budgetMs,
    analyse: input.analyse,
    ...(input.onAnalysisSkipped === undefined ? {} : { onAnalysisSkipped: input.onAnalysisSkipped }),
  });
  if (built === null) {
    return {
      ok: false,
      refusal: 'not-reproducible',
      detail: 'the stored rows could not be replayed into the views each seat acted on',
    };
  }

  const decisions: RecordedDecision[] = built.decisions.map((decision) => {
    const profile = profileBySeat.get(decision.seat);
    return {
      ...decision,
      ...(profile === undefined
        ? {}
        : { profile, disclosure: profileDisclosure(profile.naming, input.namingMode) }),
    };
  });
  if (decisions.length === 0) {
    return { ok: false, refusal: 'not-reproducible', detail: 'the hand records no decisions' };
  }

  try {
    return {
      ok: true,
      comparison: buildHandComparison({
        handId: input.hand.id,
        handNumber: input.hand.hand_number,
        board: built.board as readonly Card[],
        decisions,
        userSeat: viewerSeat.seat,
        profile: headline,
        disclosure: profileDisclosure(headline.naming, input.namingMode),
        chipResult: viewerSeat.net_result ?? 0,
        // Computed during the replay, inside the route's one budget.
        analyse: (decision) => built.analysisBySequence.get(decision.sequence) ?? null,
      }),
    };
  } catch (error) {
    if (error instanceof ComparisonError) {
      // The replayed view and the recorded action disagree. Refuse rather than report a fiction.
      return { ok: false, refusal: 'not-reproducible', detail: error.message };
    }
    throw error;
  }
}
