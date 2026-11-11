/**
 * The Coach input the API builds for a Lab scenario, for the tests that need a real report.
 *
 * Mirrors `coachTaskFor` in `apps/api/src/routes/content.ts` field for field, as a `CoachInput`
 * rather than a wire task: the range is the one `readSituation` already expanded, where the API
 * sends a description for a worker to expand. `apps/web` cannot import the API, and the fixture
 * regenerator keeps its own copy for the reason its header gives. Sampling is cut to 2,000 by
 * default, which moves equity by sampling noise and nothing else; a caller comparing figures that
 * depend on equity passes the content seed and sample count instead.
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
