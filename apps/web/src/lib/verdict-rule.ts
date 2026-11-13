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

/** Below this, two figures print the same at the panel's precision. */
const LEVEL = 0.05;

/**
 * The sentence, or `null` for an action the analysis did not price — the panel already says so, and
 * "judged against folding" is not true of a decision nothing judged.
 *
 * It states the rule and where the best row stands against it, and deliberately not the outcome:
 * the chip says that, and "Distance from that" says by how much. A first version restated both in
 * two more sentences, which made the panel's explanation longer than the figures it explained.
 */
export function verdictRuleSentence(
  judgement: Consistency,
  action: ScenarioAction,
  format: VerdictFormatters,
): string | null {
  const { units: formatUnits, signedUnits: formatSignedUnits } = format;
  if (judgement.behindBenchmarkUnits === null || judgement.chosenEv === null) return null;
  const allowance = formatUnits(judgement.toleranceUnits);

  if (action === 'fold') {
    const benchmark = formatSignedUnits(judgement.benchmarkEv, { decimals: 1 });
    return (
      'A fold is judged the other way round: it counts as consistent unless something the analysis ' +
      `measured — leaving out rows that rely on an assumed fold rate — beats it by more than ${allowance}, ` +
      `and the best such row here is worth ${benchmark}.`
    );
  }

  // The best row is context, not the bar. Named only when it is a different, better row: naming it
  // when the learner already chose it would be telling them their action is beaten by itself.
  const { bestAction, bestTo } = judgement;
  const best =
    bestAction === null || judgement.bestEv - judgement.chosenEv < LEVEL
      ? ''
      : `; the best row, ${ROW_NAME[bestAction]}${bestTo === null ? '' : ` to ${formatUnits(bestTo)}`}, is there for comparison and does not have to be matched`;
  return (
    `The verdict asks one thing: whether ${ACTION_NAME[action]} does at least as well as folding, ` +
    `which is worth 0, allowing it to fall up to ${allowance} short${best}.`
  );
}
