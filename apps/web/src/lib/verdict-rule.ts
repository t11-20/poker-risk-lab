/**
 * The plain sentence above the Lab's verdict figures, saying what the verdict judges. Without it the
 * correct figures read as contradictory, a call "consistent" beside a better raise row.
 */

import { formatSignedUnits, formatUnits } from '@prl/ui/format';
import type { Consistency, ScenarioAction } from './consistency.ts';

const ACTION_NAME: Readonly<Record<ScenarioAction, string>> = {
  fold: 'folding',
  check: 'checking',
  call: 'calling',
  bet: 'betting',
  raise: 'raising',
};

/** Below this, two figures print the same at the panel's precision. */
const LEVEL = 0.05;

/** `null` for an unpriced action. States the rule and the reading, never the outcome the chip says. */
export function verdictRuleSentence(judgement: Consistency, action: ScenarioAction): string | null {
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

  // Named only when its figure differs, or the action would be "beaten" by itself. Only a row the
  // reading set aside can read higher than it, so that case points at the Coach's reason.
  const { reading } = judgement;
  const gap = reading === null ? 0 : reading.ev - judgement.chosenEv;
  const named =
    reading === null || Math.abs(gap) < LEVEL
      ? ''
      : gap > 0
        ? `; the Coach's reading, ${reading.name}, is there for comparison and does not have to be matched`
        : `; it shows a higher figure than the Coach's reading, ${reading.name}, which sets aside the rows that read higher and says why`;
  return (
    `The verdict asks one thing: whether ${ACTION_NAME[action]} does at least as well as folding, ` +
    `which is worth 0, allowing it to fall up to ${allowance} short${named}.`
  );
}
