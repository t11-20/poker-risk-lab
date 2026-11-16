import type { CoachReport } from '@prl/contracts';
import { formatUnits } from '@prl/ui/format';

/** `potOdds.pot` is what hero could win, which is less than `potTotal` when hero is all-in short. */
export function decisionPotNote(
  report: Pick<CoachReport, 'potTotal' | 'toCall'> & { readonly potOdds: { readonly pot: number } },
): string {
  if (report.potTotal > report.potOdds.pot) {
    return `${formatUnits(report.toCall)} to call, with ${formatUnits(report.potTotal - report.potOdds.pot)} of the ${formatUnits(report.potTotal)} in the middle a side pot this seat was not in.`;
  }
  return report.toCall > 0 ? `${formatUnits(report.toCall)} to call.` : 'Nothing to call.';
}
