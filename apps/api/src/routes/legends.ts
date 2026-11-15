/**
 * Legends measurement. What a profile actually did, against what its card claims.
 *
 * A 4,000-hand run takes about three seconds of event-loop CPU, so runs are made offline and stored.
 * The figures come from `@prl/poker-ai` (`simulateHeadsUpAgainstReference`, `seatStats`,
 * `compareToDeclared`), never a second definition of a statistic. The run is deterministic, and
 * `apps/api/test/legend-profile-stats.test.ts` re-derives a row and holds the table to it.
 * Regenerate with the snippet in that test's header.
 * `LearnFromProfileResponse.observed` describes the reader's own session and is never served from here.
 */

import type {
  LegendDifficulty,
  LegendTraitKey,
  ProfileObservedStats,
  ProfileStatsResponse,
} from '@prl/contracts';
import { profileDisclosure, requireProfile, resolveNamingMode } from '@prl/poker-ai';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors.ts';

/**
 * Heads-up against one fixed reference, so a profile's style is not confounded with its table.
 * The same reference as `packages/poker-ai/test/simulation`. `realistic` because `educational`
 * mutes traits on purpose.
 */
export const PROFILE_SIMULATION = {
  referenceProfileId: 'reading-pressure-specialist',
  difficulty: 'realistic' satisfies LegendDifficulty as LegendDifficulty,
  hands: 4_000,
  seed: 20_260_818,
} as const;

/** One stored run: what the model did, and where that disagreed with its card. */
export interface StoredProfileRun {
  readonly simulated: ProfileObservedStats;
  readonly divergences: readonly {
    readonly key: LegendTraitKey;
    readonly declared: number;
    readonly observed: number;
    readonly note: string;
  }[];
}

/** An empty `divergences` array is a measured result at a 1.5-point interval, not a placeholder. */
export const STORED_RUNS: Readonly<Record<string, StoredProfileRun>> = {
  'vocal-aggressor': {
    simulated: {
      handsObserved: 4000,
      vpip: 0.3364988920544476,
      pfr: 0.249446027223805,
      threeBetFrequency: 0.3064971751412429,
      aggressionFrequency: 0.5394190871369294,
      bluffFrequency: 0.41812865497076024,
      wentToShowdown: 0.3243589743589744,
      foldToBetFrequency: 0.4789097988319273,
      averageBetSizeAsPotFraction: 0.7897933842031115,
      confidenceHalfWidth: 0.01549487582010615,
    },
    divergences: [],
  },
  'adaptive-exploiter': {
    simulated: {
      handsObserved: 4000,
      vpip: 0.3067426400759734,
      pfr: 0.26147515036403923,
      threeBetFrequency: 0.3114391143911439,
      aggressionFrequency: 0.5777488614183475,
      bluffFrequency: 0.48040313549832026,
      wentToShowdown: 0.3551829268292683,
      foldToBetFrequency: 0.5090529247910863,
      averageBetSizeAsPotFraction: 0.9204826785121234,
      confidenceHalfWidth: 0.01549487582010615,
    },
    divergences: [],
  },
  'patient-technician': {
    simulated: {
      handsObserved: 4000,
      vpip: 0.27635327635327633,
      pfr: 0.2503956948401393,
      threeBetFrequency: 0.27400468384074944,
      aggressionFrequency: 0.49164345403899723,
      bluffFrequency: 0.36041939711664484,
      wentToShowdown: 0.3011844331641286,
      foldToBetFrequency: 0.5593425187333817,
      averageBetSizeAsPotFraction: 0.846948320088234,
      confidenceHalfWidth: 0.01549487582010615,
    },
    divergences: [],
  },
  'reading-pressure-specialist': {
    simulated: {
      handsObserved: 4000,
      vpip: 0.4476100031655587,
      pfr: 0.3716365938588161,
      threeBetFrequency: 0.4250629722921914,
      aggressionFrequency: 0.6478479597540525,
      bluffFrequency: 0.5573308270676691,
      wentToShowdown: 0.4142692750287687,
      foldToBetFrequency: 0.38720468325318835,
      averageBetSizeAsPotFraction: 0.9904963353241358,
      confidenceHalfWidth: 0.01549487582010615,
    },
    divergences: [],
  },
  'old-school-pressure': {
    simulated: {
      handsObserved: 4000,
      vpip: 0.40424184868629315,
      pfr: 0.3225704336815448,
      threeBetFrequency: 0.38415841584158417,
      aggressionFrequency: 0.6100917431192661,
      bluffFrequency: 0.5044776119402985,
      wentToShowdown: 0.3894230769230769,
      foldToBetFrequency: 0.42829331602855286,
      averageBetSizeAsPotFraction: 1.0707983057549533,
      confidenceHalfWidth: 0.01549487582010615,
    },
    divergences: [],
  },
  'mixed-game-generalist': {
    simulated: {
      handsObserved: 4000,
      vpip: 0.3694207027540361,
      pfr: 0.26812282367837925,
      threeBetFrequency: 0.3124156545209177,
      aggressionFrequency: 0.5579377233282287,
      bluffFrequency: 0.4653658536585366,
      wentToShowdown: 0.33414337788578374,
      foldToBetFrequency: 0.44873949579831934,
      averageBetSizeAsPotFraction: 0.8666365211118927,
      confidenceHalfWidth: 0.01549487582010615,
    },
    divergences: [],
  },
  'volume-grinder': {
    simulated: {
      handsObserved: 4000,
      vpip: 0.3944286166508389,
      pfr: 0.343463121240899,
      threeBetFrequency: 0.40250329380764166,
      aggressionFrequency: 0.6027235050325637,
      bluffFrequency: 0.5163265306122449,
      wentToShowdown: 0.38823529411764707,
      foldToBetFrequency: 0.4288807101104135,
      averageBetSizeAsPotFraction: 0.8866487175310424,
      confidenceHalfWidth: 0.01549487582010615,
    },
    divergences: [],
  },
  'disciplined-specialist': {
    simulated: {
      handsObserved: 4000,
      vpip: 0.1671415004748338,
      pfr: 0.15384615384615385,
      threeBetFrequency: 0.15565610859728507,
      aggressionFrequency: 0.31988041853512705,
      bluffFrequency: 0.19213973799126638,
      wentToShowdown: 0.22199170124481327,
      foldToBetFrequency: 0.6932563631592757,
      averageBetSizeAsPotFraction: 0.7500438062434629,
      confidenceHalfWidth: 0.01549487582010615,
    },
    divergences: [],
  },
  'foundational-reader': {
    simulated: {
      handsObserved: 4000,
      vpip: 0.31275720164609055,
      pfr: 0.19848053181386516,
      threeBetFrequency: 0.2518248175182482,
      aggressionFrequency: 0.4960513326752221,
      bluffFrequency: 0.40921919096895576,
      wentToShowdown: 0.34096692111959287,
      foldToBetFrequency: 0.4930795847750865,
      averageBetSizeAsPotFraction: 0.904193158654088,
      confidenceHalfWidth: 0.01549487582010615,
    },
    divergences: [],
  },
  'range-narrator': {
    simulated: {
      handsObserved: 4000,
      vpip: 0.4324153213042102,
      pfr: 0.2924976258309592,
      threeBetFrequency: 0.29593810444874274,
      aggressionFrequency: 0.48777234326367275,
      bluffFrequency: 0.3806620209059233,
      wentToShowdown: 0.3505933117583603,
      foldToBetFrequency: 0.40702520341337567,
      averageBetSizeAsPotFraction: 0.7933779237070592,
      confidenceHalfWidth: 0.01549487582010615,
    },
    divergences: [],
  },
  'fundamentals-coach': {
    simulated: {
      handsObserved: 4000,
      vpip: 0.25102880658436216,
      pfr: 0.205761316872428,
      threeBetFrequency: 0.20454545454545456,
      aggressionFrequency: 0.3801546391752577,
      bluffFrequency: 0.2582697201017812,
      wentToShowdown: 0.26973684210526316,
      foldToBetFrequency: 0.5941432720232332,
      averageBetSizeAsPotFraction: 0.8582967468871112,
      confidenceHalfWidth: 0.01549487582010615,
    },
    divergences: [],
  },
  'calling-station': {
    simulated: {
      handsObserved: 4000,
      vpip: 0.5178854067742956,
      pfr: 0.08547008547008547,
      threeBetFrequency: 0.0711864406779661,
      aggressionFrequency: 0.12655737704918033,
      bluffFrequency: 0.08739189804278562,
      wentToShowdown: 0.41332470892626133,
      foldToBetFrequency: 0.3722267871815941,
      averageBetSizeAsPotFraction: 0.7592512887665209,
      confidenceHalfWidth: 0.01549487582010615,
    },
    divergences: [],
  },
};

/** A known profile with no stored run is `internal_error`: STORED_RUNS was not regenerated. */
export function profileStats(profileId: string): ProfileStatsResponse {
  const profile = profileById(profileId);
  const run = STORED_RUNS[profile.naming.id];
  if (run === undefined) {
    throw new AppError('internal_error', {
      logDetail: `no stored simulation for profile "${profile.naming.id}" — regenerate STORED_RUNS`,
    });
  }
  return {
    profileId: profile.naming.id,
    disclosure: profileDisclosure(profile.naming, resolveNamingMode()),
    declaredTraits: profile.traits,
    simulated: run.simulated,
    simulationHands: run.simulated.handsObserved,
    simulationSeed: PROFILE_SIMULATION.seed,
    simulationDifficulty: PROFILE_SIMULATION.difficulty,
    referenceProfileId: PROFILE_SIMULATION.referenceProfileId,
    referenceName: requireProfile(PROFILE_SIMULATION.referenceProfileId).naming.archetypeName,
    divergences: run.divergences,
  };
}

/** An unknown id is a bad link, so `content_not_found`. */
function profileById(profileId: string) {
  try {
    return requireProfile(profileId);
  } catch {
    throw new AppError('content_not_found', { logDetail: `unknown profile "${profileId}"` });
  }
}

/**
 * `GET /legends/profiles/:profileId/stats`. Registered from `routes/rooms.ts` beside the other
 * Legends routes. No session required, and a table lookup rather than a run.
 */
export function registerLegendStatsRoute(app: FastifyInstance, schema: object): void {
  app.get<{ Params: { profileId: string } }>(
    '/legends/profiles/:profileId/stats',
    { schema: { params: schema } },
    (request): ProfileStatsResponse => profileStats(request.params.profileId),
  );
}
