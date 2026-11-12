/**
 * The one plain sentence above the Scenario Lab's verdict figures, saying what the verdict judges.
 *
 * ## Why the panel needs it
 *
 * The verdict asks whether an action does at least as well as FOLDING, give or take one big blind
 * (`isDefensible` in `@prl/poker-math`), and deliberately not whether it is the best row: in a spot
 * with two defensible lines, marking the call wrong because a raise scores more under an assumed
 * fold rate would present an invented parameter as a fact. The figures underneath are all correct.
 * Read without the rule, they contradict each other. Measured on "Flush draw facing a small bet" at
 * 6b3886e (UX audit, Minor 9): a call showed "consistent with the analysis" beside "Best row: +56.6
 * — Raise to 50", and "20.6 units ahead of it" beside "within the allowance of 10 units". The rule
 * appeared only as a row label, "Judged against: folding, worth 0".
 *
 * So the panel now says the rule once, in words, with this action's numbers in it, before the
 * figures. The logic is unchanged; only the presentation moved.
 *
 * Pure and here rather than inline in `ScenarioStage.tsx` so a test can read the sentences for each
 * case without rendering a component. The formatters are passed in, as `nearestPricedSentence`'s
 * is, because `@prl/ui`'s entry point carries JSX that `node:test` cannot load.
 */

import type { Consistency, ScenarioAction } from './consistency.ts';

const ACTION_NAME: Readonly<Record<ScenarioAction, string>> = {
  fold: 'folding',
  check: 'checking',
  call: 'calling',
  bet: 'betting',
  raise: 'raising',
};

const ROW_NAME: Readonly<Record<ScenarioAction, string>> = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise',
};

/** `formatUnits` and `formatSignedUnits` from `@prl/ui`, which the component hands in. */
export interface VerdictFormatters {
  readonly units: (units: number, options?: { readonly decimals?: number }) => string;
  readonly signedUnits: (delta: number, options?: { readonly decimals?: number }) => string;
}

/** Below this, a difference prints as 0.0 at the panel's precision, so it is "level". */
const LEVEL = 0.05;

/**
 * The sentence, or `null` for an action the analysis did not price — the panel already says so, and
 * "judged against folding" is not true of a decision nothing judged.
 *
 * `consistent` is passed rather than read off `judgement` because the panel shows the server's
 * verdict when there is one; the sentence must agree with the chip beside it.
 */
export function verdictRuleSentence(
  judgement: Consistency,
  action: ScenarioAction,
  consistent: boolean,
  format: VerdictFormatters,
): string | null {
  const { units: formatUnits, signedUnits: formatSignedUnits } = format;
  const behind = judgement.behindBenchmarkUnits;
  if (behind === null || judgement.chosenEv === null) return null;
  const allowance = formatUnits(judgement.toleranceUnits);
  const distance = formatUnits(Number(Math.abs(behind).toFixed(1)), { decimals: 1 });
  const level = Math.abs(behind) < LEVEL;

  if (action === 'fold') {
    const benchmark = formatSignedUnits(judgement.benchmarkEv, { decimals: 1 });
    const rule =
      'A fold is judged the other way round: against the best row that does not rely on an assumed ' +
      `fold rate, worth ${benchmark} here. It counts as consistent when nothing measured beats it by ` +
      `more than the allowance of ${allowance}`;
    return consistent
      ? `${rule}, and nothing does, so folding is consistent with this analysis.`
      : `${rule}. That row beats folding by ${distance}, more than the allowance, so folding is not the line the analysis leans towards.`;
  }

  const name = ACTION_NAME[action];
  const rule =
    `The verdict judges one thing: whether ${name} does at least as well as folding, which is worth 0, ` +
    `give or take an allowance of ${allowance}.`;
  const outcome = !consistent
    ? ` Yours is ${distance} behind folding, more than the allowance, so it is not the line the analysis leans towards.`
    : level
      ? ' Yours is level with folding, so it is consistent.'
      : behind < 0
        ? ` Yours is ${distance} ahead of folding, so it is consistent — the allowance is only there for actions that fall short.`
        : ` Yours is ${distance} behind folding, inside the allowance, so it is close enough to break-even to count as consistent.`;

  // The best row is context, not the bar. Said only when it is a different, better row: naming it
  // when the learner already chose it would be telling them their action is beaten by itself.
  const { bestAction, bestTo } = judgement;
  const best =
    bestAction === null || judgement.bestEv - judgement.chosenEv < LEVEL
      ? ''
      : ` The best row, ${ROW_NAME[bestAction]}${bestTo === null ? '' : ` to ${formatUnits(bestTo)}`}, is worth more; it is shown for comparison and does not change the verdict.`;
  return `${rule}${outcome}${best}`;
}
