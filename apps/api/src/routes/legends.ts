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
      aggressionFrequency: 0.5413846954711088,
      bluffFrequency: 0.4175609756097561,
      wentToShowdown: 0.32051282051282054,
      foldToBetFrequency: 0.47954102619614636,
      averageBetSizeAsPotFraction: 0.7895304234814804,
      confidenceHalfWidth: 0.01549487582010615,
    },
    divergences: [],
  },
  'adaptive-exploiter': {
    simulated: {
      handsObserved: 4000,
      vpip: 0.3067426400759734,
      pfr: 0.26147515036403923,
      threeBetFrequency: 0.3121771217712177,
      aggressionFrequency: 0.5796344647519582,
      bluffFrequency: 0.484814398200225,
      wentToShowdown: 0.3551829268292683,
      foldToBetFrequency: 0.509289363678588,
      averageBetSizeAsPotFraction: 0.9205504054367302,
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
      aggressionFrequency: 0.4933705512909979,
      bluffFrequency: 0.36089238845144356,
      wentToShowdown: 0.29949238578680204,
      foldToBetFrequency: 0.559477756286267,
      averageBetSizeAsPotFraction: 0.8478808339162964,
      confidenceHalfWidth: 0.01549487582010615,
    },
    divergences: [],
  },
  'reading-pressure-specialist': {
    simulated: {
      handsObserved: 4000,
      vpip: 0.4476100031655587,
      pfr: 0.3716365938588161,
      threeBetFrequency: 0.4256926952141058,
      aggressionFrequency: 0.65,
      bluffFrequency: 0.559433962264151,
      wentToShowdown: 0.4131185270425777,
      foldToBetFrequency: 0.3875287717095627,
      averageBetSizeAsPotFraction: 0.9900676482494224,
      confidenceHalfWidth: 0.01549487582010615,
    },
    divergences: [],
  },
  'old-school-pressure': {
    simulated: {
      handsObserved: 4000,
      vpip: 0.40424184868629315,
      pfr: 0.3225704336815448,
      threeBetFrequency: 0.38481848184818485,
      aggressionFrequency: 0.6125503742084053,
      bluffFrequency: 0.5044955044955045,
      wentToShowdown: 0.3870192307692308,
      foldToBetFrequency: 0.429004329004329,
      averageBetSizeAsPotFraction: 1.0695243480845813,
      confidenceHalfWidth: 0.01549487582010615,
    },
    divergences: [],
  },
  'mixed-game-generalist': {
    simulated: {
      handsObserved: 4000,
      vpip: 0.3694207027540361,
      pfr: 0.2684393795504907,
      threeBetFrequency: 0.31376518218623484,
      aggressionFrequency: 0.5564063297600816,
      bluffFrequency: 0.4624390243902439,
      wentToShowdown: 0.33414337788578374,
      foldToBetFrequency: 0.44843520268851084,
      averageBetSizeAsPotFraction: 0.8680153352038439,
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
      aggressionFrequency: 0.6044997039668443,
      bluffFrequency: 0.5168195718654435,
      wentToShowdown: 0.3908496732026144,
      foldToBetFrequency: 0.4292830842538445,
      averageBetSizeAsPotFraction: 0.8865731947405097,
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
      aggressionFrequency: 0.32134831460674157,
      bluffFrequency: 0.19416058394160585,
      wentToShowdown: 0.22614107883817428,
      foldToBetFrequency: 0.6932773109243697,
      averageBetSizeAsPotFraction: 0.7501111050845289,
      confidenceHalfWidth: 0.01549487582010615,
    },
    divergences: [],
  },
  'foundational-reader': {
    simulated: {
      handsObserved: 4000,
      vpip: 0.31275720164609055,
      pfr: 0.19848053181386516,
      threeBetFrequency: 0.25255474452554744,
      aggressionFrequency: 0.4970326409495549,
      bluffFrequency: 0.4096045197740113,
      wentToShowdown: 0.3414012738853503,
      foldToBetFrequency: 0.49286023366508,
      averageBetSizeAsPotFraction: 0.9045497761912545,
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
      aggressionFrequency: 0.487957181088314,
      bluffFrequency: 0.3806620209059233,
      wentToShowdown: 0.3484358144552319,
      foldToBetFrequency: 0.40726767275615566,
      averageBetSizeAsPotFraction: 0.7933403664356465,
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
      aggressionFrequency: 0.38233397807865893,
      bluffFrequency: 0.2595419847328244,
      wentToShowdown: 0.2746710526315789,
      foldToBetFrequency: 0.5938029532800775,
      averageBetSizeAsPotFraction: 0.8564206727700375,
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
      aggressionFrequency: 0.12664041994750655,
      bluffFrequency: 0.08747152619589978,
      wentToShowdown: 0.4113842173350582,
      foldToBetFrequency: 0.37284234752589185,
      averageBetSizeAsPotFraction: 0.7592209669426333,
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
