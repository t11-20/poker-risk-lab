/**
 * The Legends "compare your hand" report, built from a hand that was actually played.
 *
 * ## The defect this closes
 *
 * `/legends/hand-review` rendered `HAND_COMPARISON_FIXTURE` — a bundled sample — for every hand id
 * anybody ever asked for. `loadHandComparison(_handId)` did not even take its argument seriously:
 * the parameter was underscored, there was no request behind it, and the page's own comment said
 * the API "has never registered" a per-hand comparison route. It had not. `buildHandComparison`
 * existed in `@prl/poker-ai`, complete and tested, with nothing in front of it.
 *
 * So the one screen in the product whose entire purpose is "here is how YOU played this hand"
 * showed the same worked example to everybody, under a banner saying so. The banner made it
 * honest; it did not make it the feature.
 *
 * ## Why this file exists rather than a few more exports from `build-review.ts`
 *
 * The replay lives there — `openReplay`, `situationBefore`, `applyReplayAction`, the pot
 * cross-check — and it is deliberately private, because it is a reconstruction whose every step
 * is only valid in the order that module walks it. Exporting the pieces would invite a second,
 * subtly different walk.
 *
 * So the walk stays there and this module asks for the ONE thing it needs from it: a
 * `RecordedDecision[]` with a faithful `PlayerView` per decision. `buildComparisonDecisions` is
 * exported from `build-review.ts` for exactly this caller and nothing else.
 *
 * ## What is reconstructed, and what is refused
 *
 * `buildHandComparison` checks every recorded decision against its own view: the view must belong
 * to this hand, have been built for the acting seat, have that seat to act, and have offered the
 * action type taken. Those checks are the reason the feature is worth having, so nothing here
 * weakens them — a hand the replay cannot reproduce is refused with a reason, and the page says
 * so. It never falls back to the sample.
 *
 * `ModelReasoning` is null for every model decision, and that is permanent rather than pending.
 * The distribution a policy sampled from is not persisted anywhere — `prl.hand_actions` records
 * what was done, not what was considered — so a review of a stored hand can state the model's
 * action and must claim nothing about why. `buildComparedDecision` already produces exactly that
 * shape when `decision` is null; inventing one by re-running the policy would be a different
 * hand's reasoning attached to this one's action.
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
  /** The learner. Only their own decisions are analysed — see `@prl/poker-ai`'s comparison module. */
  readonly viewerUserId: string;
  /**
   * `user_id -> strategy profile id`, from `room_members` for this hand's room.
   *
   * A map rather than a column on the seat, because `prl.hand_seats` records that a seat was a bot
   * and not which model it was. That is the right shape for the hand log — a seat is a seat — and
   * it means the profile has to be joined in from the roster, which migration 0003 made able to
   * name all twelve.
   */
  readonly botProfiles: ReadonlyMap<string, string>;
  readonly namingMode: NamingMode;
  /** Wall-clock budget for the analysis, in milliseconds. */
  readonly budgetMs: number;
  /**
   * Where each decision's Coach report is computed — a calculator thread, in the server.
   *
   * A comparison prices the actions that were NOT taken as well as the one that was, so it does
   * strictly more Monte Carlo work than a hand review, and a hand review was measured as the
   * single largest contributor to event-loop saturation in this process before the same change.
   * Passing the seam rather than defaulting it means no caller can accidentally get the version
   * that computes here.
   */
  readonly analyse: ReviewAnalyser;
  readonly onAnalysisSkipped?: (detail: { readonly sequence: number; readonly reason: string }) => void;
}

/**
 * Asynchronous because the analyses are.
 *
 * Everything else in here — the refusals, the profile lookup, `buildHandComparison` itself — is
 * the same synchronous work it always was. The `await` is the up-to-eight Coach reports being
 * computed somewhere that is not the event loop.
 */
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
    // The query that produced these rows already required the caller to hold a seat, so this is a
    // programming error rather than an authorisation one — refused all the same, because a
    // comparison with no learner in it has nobody to be about.
    return { ok: false, refusal: 'not-reproducible', detail: 'the caller holds no seat in this hand' };
  }

  // Which model played which seat. A hand with no nameable model is not a Legends comparison, and
  // saying so is better than producing one whose opponent column is blank.
  const profileBySeat = new Map<number, StrategyProfile>();
  for (const seat of input.seats) {
    if (!seat.is_bot || seat.user_id === null) continue;
    const profileId = input.botProfiles.get(seat.user_id);
    if (profileId === undefined) continue;
    const profile = PROFILES.find((candidate) => candidate.naming.id === profileId);
    // A profile id the roster carries and this build does not is a retired Legend. The seat is
    // left unnamed rather than mapped to the nearest surviving style — see `rooms/bot-profile.ts`,
    // which refuses the same substitution when it rehydrates a table.
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
        // Already computed during the replay, where the pot cross-check that validates it lives.
        // Passing a function that returns a stored value keeps `buildHandComparison` pure and keeps
        // the Monte Carlo work inside the one budget the route set.
        analyse: (decision) => built.analysisBySequence.get(decision.sequence) ?? null,
      }),
    };
  } catch (error) {
    if (error instanceof ComparisonError) {
      // The comparison refused its own inputs. That is the guard working: it means the replayed
      // view and the recorded action disagree, and a report built from a situation that never
      // existed would look perfectly reasonable while being wrong at every figure.
      return { ok: false, refusal: 'not-reproducible', detail: error.message };
    }
    throw error;
  }
}
