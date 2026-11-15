import { type CoachInput, opponentsAtBetLevel } from '../src/coach.ts';

/** A heads-up spot written with chips behind alone. */
export type BehindSpot = Omit<CoachInput, 'opponentStacks'> & { readonly opponentStacks: readonly number[] };

/** The one opponent made or matched the bet hero faces, the only reading a heads-up spot has. */
export function atBetLevel(spot: BehindSpot): CoachInput {
  return { ...spot, opponentStacks: opponentsAtBetLevel(spot, spot.opponentStacks) };
}
