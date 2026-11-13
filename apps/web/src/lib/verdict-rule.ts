/**
 * The plain sentence above the Lab's verdict figures, saying what the verdict judges. Without it the
 * correct figures read as contradictory, a call "consistent" beside a better raise row.
 * Pure, with formatters passed in, because `@prl/ui` carries JSX that `node:test` cannot load.
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

/** `null` for an unpriced action. States the rule and the best row, never the outcome the chip says. */
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

  // Named only when it is a different, better row, or the action would be "beaten" by itself.
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
