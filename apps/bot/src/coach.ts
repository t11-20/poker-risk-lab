/**
 * The Coach, in chat: one line under the table, and the fuller reading behind "Why?".
 *
 * ## Where the input comes from
 *
 * `coachReportFor` is `readCoachSituation` + `coachForView` from `apps/api/src/ws/router.ts`, and
 * `assumedRange` from `apps/api/src/rooms/bots.ts`, duplicated because an app may not import an
 * app. Every number is read off the reader's redacted view, the legal set is the engine's own, and
 * the contestable pot is asked of the engine's layering (`contestablePotFor`) rather than assumed
 * equal to the pot. Seed 1, 2,000 samples and a `top:40` range are the web's live-Coach values, so
 * the same spot gets the same figure in both clients.
 *
 * It runs on the calling thread. The API moved this off its event loop after measuring 3,034 ms
 * for the first analysis in a process (the preflop strength table `top:NN` needs) and 56-84 ms
 * warm. In this process that first reading stalls the poll loop once; ADR 0014 records the cost.
 *
 * ## The rules the text keeps, from `packages/ui/src/components/CoachPanel.tsx`
 *
 * 1. A percentage always names its method, and a sampled one always carries its interval.
 * 2. The suggestion is never called correct, optimal, best or GTO. It is "one reading".
 * 3. Wherever the suggestion appears, the disclaimer and the full assumptions list appear with it.
 *    The one-liner therefore does not carry the suggestion: a single line cannot also carry the
 *    assumptions, so it carries the figures and points at "Why?".
 * 4. Every probability is range-checked before it is formatted, and a value outside 0..1 is
 *    replaced by a refusal. That is `formatProbability` in `packages/ui/src/probability.ts`,
 *    duplicated as `probabilityText`: `@prl/ui` is React source and cannot be imported here.
 *
 * Only the fields those rules name are rendered. The teaching notes and the rule-of-thumb note
 * are left out, and `test/coach-text.test.ts` scans what is rendered for the banned words.
 */

import type { CoachReport } from '@prl/contracts';
import { type Card, contestablePotFor, type PlayerView } from '@prl/poker-engine';
import { buildCoachReport, type ParsedRange, parseRange, topPercentRange } from '@prl/poker-math';

const ASSUMED_RANGE_PERCENT = 40;
const COACH_SAMPLES = 2_000;
const COACH_SEED = 1;

/** One reading of one decision. `at` names the decision so a stale "Why?" is recognisable. */
export type CoachReading =
  | { readonly kind: 'report'; readonly at: string; readonly report: CoachReport }
  | { readonly kind: 'unavailable'; readonly at: string; readonly reason: string };

export type CoachFn = (view: PlayerView) => CoachReport;

/**
 * A Coach report for the reader's decision, or the reason there is none.
 *
 * A Coach failure must never stop the hand, so every refusal becomes `unavailable` and the table
 * still shows its buttons.
 */
export function readCoach(view: PlayerView, at: string, coach: CoachFn): CoachReading {
  try {
    return { kind: 'report', at, report: coach(view) };
  } catch (error) {
    return { kind: 'unavailable', at, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function coachReportFor(view: PlayerView): CoachReport {
  const own = view.seats.find((seat) => seat.isSelf);
  const heroCards = own?.holeCards ?? null;
  if (own === undefined || heroCards === null) throw new Error('the reader holds no cards');
  const street = view.street;
  if (street === 'showdown' || street === 'complete') throw new Error(`no decision during ${street}`);
  const opponents = view.seats.filter(
    (seat) => !seat.isSelf && (seat.status === 'active' || seat.status === 'allIn'),
  );
  if (opponents.length === 0) throw new Error('no live opponent to analyse against');
  const legalActions = view.legalActions.map((entry) => entry.type);
  if (legalActions.length === 0) throw new Error('it is not the reader’s turn');
  const { contestable } = contestablePotFor({
    seats: view.seats,
    heroSeat: own.seat,
    callAmount: view.amountToCall,
    potTotal: view.potTotal,
  });
  const dead = [...heroCards, ...view.board];
  return buildCoachReport({
    heroCards,
    board: view.board,
    street,
    // Five is `buildCoachReport`'s ceiling; a six-handed table cannot exceed it.
    opponents: opponents
      .slice(0, 5)
      .map((seat) => ({ label: `seat ${seat.seat + 1}`, range: assumedRange(dead) })),
    pot: view.potTotal,
    contestablePot: contestable,
    toCall: view.amountToCall,
    heroCommittedThisStreet: own.committedThisStreet,
    heroStack: own.stack,
    opponentStacks: opponents.map((seat) => seat.stack),
    bigBlind: view.config.bigBlind,
    minimumRaiseTo: view.minimumRaiseTo,
    legalActions,
    samples: COACH_SAMPLES,
    seed: COACH_SEED,
  });
}

function assumedRange(dead: readonly Card[]): ParsedRange {
  return parseRange(topPercentRange(ASSUMED_RANGE_PERCENT).notation, dead);
}

/** A probability as a percentage, or a refusal that says why. See rule 4 in the file comment. */
export function probabilityText(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction < -1e-9 || fraction > 1 + 1e-9) return '(not a probability)';
  const clamped = Math.min(1, Math.max(0, fraction));
  return `${(clamped * 100).toFixed(1)}%`;
}

function equityText(report: CoachReport): string {
  const { equity } = report;
  const figure = probabilityText(equity.heroEquity);
  // "Every runout" would be wrong on the river, where no card is left to come and what is
  // enumerated is the opponents' holdings.
  if (equity.method === 'exact-enumeration') return `${figure} (exact enumeration, no sampling)`;
  const interval = report.uncertainty.confidenceInterval;
  const samples = equity.trials.toLocaleString('en-US');
  // Rule 1: a sampled figure never travels without its interval. If one arrives without it, the
  // text says so rather than printing the bare number as though it were exact.
  if (interval === null || !Number.isFinite(interval.halfWidthPoints) || !Number.isFinite(interval.level)) {
    return `about ${figure} (Monte Carlo, ${samples} samples, no interval reported: treat as approximate)`;
  }
  const level = probabilityText(interval.level).replace('.0%', '%');
  return `about ${figure} ± ${interval.halfWidthPoints.toFixed(2)} pts (Monte Carlo, ${samples} samples, ${level} interval)`;
}

function priceText(report: CoachReport): string {
  if (report.toCall === 0) return 'checking is free, so there is no price to beat';
  const { potOdds } = report;
  const price = `${probabilityText(potOdds.breakEvenEquity)} needed to call ${units(potOdds.toCall)} into ${units(potOdds.pot)}`;
  // The table shows the whole middle and the price is against the part the reader can win. They
  // differ only when the reader is all-in for less than the bet, and measured in a played hand the
  // two lines read "314 to call into 1,674" and "into 1,652" with nothing to say why. CoachPanel
  // names the side pot for the same reason.
  const sidePot = report.potTotal - potOdds.pot;
  return sidePot > 0 ? `${price} (the other ${units(sidePot)} are a side pot you cannot win)` : price;
}

const RANGE_WORDS = `an assumed top-${ASSUMED_RANGE_PERCENT}% range for each opponent`;

/** The line under the table. Figures only: the suggestion lives behind "Why?" with its caveats. */
export function coachLine(reading: CoachReading): string {
  if (reading.kind === 'unavailable') return 'Coach: no reading for this spot.';
  const { report } = reading;
  return `Coach: equity ${equityText(report)} against ${RANGE_WORDS}; ${priceText(report)}. Tap Why? for one reading of the spot and its assumptions.`;
}

const ACTION_WORDS: Readonly<Record<CoachReport['suggestion']['action'], string>> = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise',
};

const CONFIDENCE_WORDS: Readonly<Record<CoachReport['suggestion']['confidence'], string>> = {
  low: 'low confidence',
  moderate: 'moderate confidence',
  reasonable: 'reasonable confidence',
};

/**
 * Original wording. The web panel's own disclaimer says what this says, but in words this client
 * may not print: rule 2 bans them even inside a denial.
 */
export const COACH_DISCLAIMER =
  'This is one reading that follows from the assumptions below. It is not a verdict on the hand: ' +
  'different assumptions about the opponents give different answers, and a sound decision can still lose.';

/** The message "Why?" sends. Suggestion, disclaimer and assumptions are one block, never split. */
export function coachWhy(reading: CoachReading): string {
  if (reading.kind === 'unavailable') {
    return `The Coach has no reading for this spot: ${reading.reason}.`;
  }
  const { report } = reading;
  const { suggestion } = report;
  const size =
    suggestion.sizeRange === undefined
      ? ''
      : suggestion.sizeRange.min === suggestion.sizeRange.max
        ? ` to ${units(suggestion.sizeRange.min)}`
        : ` to between ${units(suggestion.sizeRange.min)} and ${units(suggestion.sizeRange.max)}`;
  const lines = [
    `Coach, ${report.street}`,
    '',
    `Equity: ${equityText(report)}, against ${RANGE_WORDS}.`,
    `Price: ${priceText(report)}.`,
    '',
    `One reading: ${ACTION_WORDS[suggestion.action]}${size} (${CONFIDENCE_WORDS[suggestion.confidence]}).`,
    suggestion.reason,
  ];
  if (suggestion.whatWouldChangeIt.length > 0) {
    lines.push('What would change it:', ...suggestion.whatWouldChangeIt.map((entry) => `- ${entry}`));
  }
  lines.push('', COACH_DISCLAIMER, '', 'Assumptions:', ...report.assumptions.map((entry) => `- ${entry}`));
  lines.push('', 'Limits of this analysis:', ...report.uncertainty.limitations.map((entry) => `- ${entry}`));
  return lines.join('\n');
}

export function units(value: number): string {
  return `${value.toLocaleString('en-US')} units`;
}
