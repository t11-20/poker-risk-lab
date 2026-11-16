import type { CoachReport } from '@prl/contracts';
import { formatUnits } from '@prl/ui/format';

/** `potOdds.pot` is what hero could win, which is less than `potTotal` when hero is all-in short. */
export function decisionPotNote(
  report: Pick<CoachReport, 'potTotal' | 'toCall' | 'outOfReach'> & {
    readonly potOdds: { readonly pot: number };
  },
): string {
  if (report.potTotal > report.potOdds.pot) {
    const what =
      report.outOfReach === 'uncalled'
        ? 'the part of the bet this seat could not match, which goes back to the bettor uncalled'
        : 'a side pot this seat was not in';
    return `${formatUnits(report.toCall)} to call, with ${formatUnits(report.potTotal - report.potOdds.pot)} of the ${formatUnits(report.potTotal)} in the middle ${what}.`;
  }
  return report.toCall > 0 ? `${formatUnits(report.toCall)} to call.` : 'Nothing to call.';
}
