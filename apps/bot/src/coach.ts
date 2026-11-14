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
  type SeatNamer,
} from '@prl/poker-math';
import { cardNotationText } from './cards.ts';
import { READER_SEAT, type Table, who } from './table.ts';

/** One reading of one decision. `at` names the decision so a stale "Why?" is recognisable. */
export type CoachReading =
  | { readonly kind: 'report'; readonly at: string; readonly report: CoachReport }
  | { readonly kind: 'unavailable'; readonly at: string; readonly reason: string };

export type CoachFn = (view: PlayerView, names?: SeatNamer) => CoachReport;

/** A Coach failure must never stop the hand, so every refusal becomes `unavailable`. */
export function readCoach(view: PlayerView, at: string, coach: CoachFn, names?: SeatNamer): CoachReading {
  try {
    return { kind: 'report', at, report: coach(view, names) };
  } catch (error) {
    return { kind: 'unavailable', at, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Without it the Coach says "Seat 3", which the table never shows. */
export function coachNamer(table: Table, view: PlayerView): SeatNamer {
  return (seat) => (seat === READER_SEAT ? undefined : who(table, view, seat));
}

export function coachReportFor(view: PlayerView, names?: SeatNamer): CoachReport {
  const reading = coachSpotForView(view, LIVE_COACH_POLICY, names);
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

const STREET_WORDS: Readonly<Record<string, string>> = {
  preflop: 'Preflop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
};

/**
 * Sentences `@prl/poker-math` writes for every client, in this client's words: play money is "units",
 * and the bot has no Scenario Lab. `test/coach-text.test.ts` fails if the shared wording moves.
 */
const CHAT_WORDING: readonly (readonly [string, string])[] = [
  [
    ': the Scenario Lab lets you change it and watch these figures move.',
    '. /learn has a lesson on fold equity, which works through what this does to a bet.',
  ],
  ['Chips already in the pot', 'Units already in the pot'],
];

function chatText(text: string): string {
  let out = cardNotationText(text);
  for (const [shared, ours] of CHAT_WORDING) out = out.replaceAll(shared, ours);
  return out;
}

/** What `assumptionsFor` in `equity.ts` says about each opponent's range. */
const RANGE_ASSUMPTION = /^(.+) holds (any of \d+ combinations from ".*", each equally likely\.)$/;

/**
 * The assumptions as Why? lists them. Opponents on one policy share one range, and five copies of it
 * pushed a preflop Why? over Telegram's limit, so an identical range is stated once with every name.
 */
export function coachAssumptions(report: CoachReport): string[] {
  const ranges = report.assumptions.flatMap((line) => {
    const match = RANGE_ASSUMPTION.exec(line);
    return match === null ? [] : [{ line, label: match[1] ?? '', range: match[2] ?? '' }];
  });
  const [first] = ranges;
  const shared =
    first !== undefined && ranges.length > 1 && ranges.every((entry) => entry.range === first.range);
  const lines = shared
    ? report.assumptions.flatMap((line) => {
        if (line === first.line) {
          return [`Each opponent (${ranges.map((entry) => entry.label).join(', ')}) holds ${first.range}`];
        }
        return ranges.some((entry) => entry.line === line) ? [] : [line];
      })
    : report.assumptions;
  return lines.map(chatText);
}

/** Only a bet or raise has a size. A call costs what its button says, and the size is the call's total. */
function actionText(report: CoachReport): string {
  const { action, sizeRange } = report.suggestion;
  const words = ACTION_WORDS[action];
  if (action === 'call') return `${words} ${units(report.toCall)}`;
  if ((action !== 'bet' && action !== 'raise') || sizeRange === undefined) return words;
  return sizeRange.min === sizeRange.max
    ? `${words} to ${units(sizeRange.min)}`
    : `${words} to between ${units(sizeRange.min)} and ${units(sizeRange.max)}`;
}

/** The message "Why?" sends. Suggestion, disclaimer and assumptions are one block, never split. */
export function coachWhy(reading: CoachReading): string {
  if (reading.kind === 'unavailable') {
    return `The Coach has no reading for this spot: ${reading.reason}.`;
  }
  const { report } = reading;
  const { suggestion } = report;
  const lines = [
    `Coach, ${STREET_WORDS[report.street] ?? report.street}`,
    '',
    `Equity: ${equityText(report)}, against ${RANGE_WORDS}.`,
    `Price: ${priceText(report)}.`,
    '',
    `One reading: ${actionText(report)} (${CONFIDENCE_WORDS[suggestion.confidence]}).`,
    chatText(suggestion.reason),
  ];
  if (suggestion.whatWouldChangeIt.length > 0) {
    lines.push(
      'What would change it:',
      ...suggestion.whatWouldChangeIt.map((entry) => `- ${chatText(entry)}`),
    );
  }
  lines.push(
    '',
    COACH_DISCLAIMER,
    '',
    'Assumptions:',
    ...coachAssumptions(report).map((entry) => `- ${entry}`),
  );
  lines.push(
    '',
    'Limits of this analysis:',
    ...report.uncertainty.limitations.map((entry) => `- ${chatText(entry)}`),
  );
  return lines.join('\n');
}

export function units(value: number): string {
  return `${value.toLocaleString('en-US')} units`;
}
