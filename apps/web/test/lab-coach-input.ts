/**
 * The Coach input the API builds for a Lab scenario, mirroring `coachTaskFor` in
 * `apps/api/src/routes/content.ts` field for field, because `apps/web` cannot import the API.
 * Sampling defaults to 2,000, which moves equity by noise only; a caller comparing equity-dependent
 * figures passes the content seed and sample count.
 */

import { readSituation } from '@prl/content';
import type { Scenario } from '@prl/contracts';
import { type CoachInput, deriveContestablePot, deriveLegalActions } from '@prl/poker-math';

export function coachInputFor(scenario: Scenario, sampling = { samples: 2_000, seed: 1 }): CoachInput {
  const situation = readSituation(scenario);
  const heroSeat = scenario.seats.find((seat) => seat.isHero === true);
  const heroCommittedThisStreet = scenario.committedThisStreet?.[heroSeat?.seat ?? -1] ?? 0;
  const spot = {
    pot: situation.pot,
    toCall: situation.toCall,
    heroCommittedThisStreet,
    heroStack: situation.heroStack,
    opponentStacks: situation.opponentStacks,
  };
  return {
    heroCards: situation.heroCards,
    board: situation.board,
    street: scenario.street,
    opponents: [{ label: 'the opponent', range: situation.opponentRange }],
    ...spot,
    contestablePot: deriveContestablePot(spot),
    bigBlind: scenario.bigBlind,
    legalActions: deriveLegalActions(spot),
    ...sampling,
  };
}
