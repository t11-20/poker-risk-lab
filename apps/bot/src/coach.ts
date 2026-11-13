/**
 * The Coach in chat: one line under the table and the full reading behind "Why?". Input is
 * `coachSpotForView` under `LIVE_COACH_POLICY`, as on the web, so both clients show the same figure.
 * It runs on the calling thread, so the first reading (3,034 ms cold) stalls the poll loop once
 * (ADR 0014).
 * Rules from `packages/ui/src/components/CoachPanel.tsx`:
 * 1. A percentage names its method, and a sampled one carries its interval.
 * 2. The suggestion is never called correct, optimal, best or GTO. It is "one reading".
 * 3. The suggestion always appears with the disclaimer and all assumptions, so the one-liner omits it.
 * 4. A probability outside 0..1 becomes a refusal. `probabilityText` copies `formatProbability`
 *    from `packages/ui/src/probability.ts`, because `@prl/ui` is React.
 * `test/coach-text.test.ts` scans the rendered text for banned words.
 */

import type { CoachReport } from '@prl/contracts';
import type { PlayerView } from '@prl/poker-engine';
import {
  buildCoachReport,
  type CoachRefusal,
  coachInputFor,
  coachSpotForView,
  LIVE_COACH_POLICY,
} from '@prl/poker-math';

/** One reading of one decision. `at` names the decision so a stale "Why?" is recognisable. */
export type CoachReading =
  | { readonly kind: 'report'; readonly at: string; readonly report: CoachReport }
  | { readonly kind: 'unavailable'; readonly at: string; readonly reason: string };

export type CoachFn = (view: PlayerView) => CoachReport;

/** A Coach failure must never stop the hand, so every refusal becomes `unavailable`. */
export function readCoach(view: PlayerView, at: string, coach: CoachFn): CoachReading {
  try {
    return { kind: 'report', at, report: coach(view) };
  } catch (error) {
    return { kind: 'unavailable', at, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function coachReportFor(view: PlayerView): CoachReport {
  const reading = coachSpotForView(view, LIVE_COACH_POLICY);
  if (reading.kind === 'refused') throw new Error(refusalWords(reading.refusal));
  return buildCoachReport(coachInputFor(reading.spot));
}

function refusalWords(refusal: CoachRefusal): string {
  switch (refusal.kind) {
    case 'not-seated':
      return 'the reader holds no cards';
    case 'hand-over':
      return `no decision during ${refusal.street}`;
    case 'no-opponent':
      return 'no live opponent to analyse against';
    case 'betting-closed':
    case 'not-to-act':
      return 'it is not the reader’s turn';
  }
}

/** Rule 4. */
export function probabilityText(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction < -1e-9 || fraction > 1 + 1e-9) return '(not a probability)';
  const clamped = Math.min(1, Math.max(0, fraction));
  return `${(clamped * 100).toFixed(1)}%`;
}

function equityText(report: CoachReport): string {
  const { equity } = report;
  const figure = probabilityText(equity.heroEquity);
  // Not "every runout", because on the river the enumeration is over opponent holdings.
  if (equity.method === 'exact-enumeration') return `${figure} (exact enumeration, no sampling)`;
  const interval = report.uncertainty.confidenceInterval;
  const samples = equity.trials.toLocaleString('en-US');
  // Rule 1. A sampled figure without an interval says so.
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
  // The price is against the pot the reader can win. Name the side pot so the two totals reconcile.
  const sidePot = report.potTotal - potOdds.pot;
  return sidePot > 0 ? `${price} (the other ${units(sidePot)} are a side pot you cannot win)` : price;
}

const RANGE_WORDS = `an assumed top-${LIVE_COACH_POLICY.range.percent}% range for each opponent`;

/** Figures only. The suggestion lives behind "Why?" with its caveats. */
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
