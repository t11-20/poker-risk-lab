/**
 * The Legends measurement endpoints: what a profile ACTUALLY did, against what its card claims.
 *
 * ## Why this is a stored table and not a computation
 *
 * `ProfileStatsResponse` was a dead contract — a wire type with no producer anywhere — and the
 * producer it needed already existed in `@prl/poker-ai`: `simulateHeadsUpAgainstReference` plays
 * the model, `seatStats` counts what it did, `toObservedStats` puts the counts on the wire shape,
 * and `compareToDeclared` says where the behaviour and the card disagree. Nothing here reimplements
 * any of that, deliberately: a second definition of "VPIP" is how a statistic quietly starts
 * measuring something other than its name, and `stats.ts` documents at length which denominator
 * each rate takes and why.
 *
 * What this file adds is the one thing the package cannot decide: WHEN to run it. A run of 4,000
 * hands takes roughly three seconds of solid CPU, on the event loop, in a server that is also
 * dealing live tables with action timers. Twelve of those reachable from an unauthenticated GET is
 * a denial of service anybody can trigger with a `for` loop. So the runs are performed offline,
 * once, and the results are stored below.
 *
 * ## What "stored" means here, and why it is not the fabrication this review is full of
 *
 * Every number in `STORED_RUNS` was produced by running the code named in `PROFILE_SIMULATION`
 * against the profiles as they stand, and every input that determines it is recorded next to it:
 * the reference opponent, the difficulty, the hand count and the seed. The run is deterministic, so
 * the table is a cache of a pure function rather than a set of figures somebody chose —
 * `apps/api/test/legend-profile-stats.test.ts` re-derives a profile from those inputs and asserts
 * the stored row matches, so a policy change in `@prl/poker-ai` makes this table fail a test
 * instead of quietly becoming a lie. Regenerate with the snippet in that test's header.
 *
 * ## What is NOT here
 *
 * `LearnFromProfileResponse.observed` — frequencies from the reader's own session — is not served
 * from this table, and putting it there would be the exact defect this review raised. The prose
 * `learnFromSummary` generates from that field reads "across N hands you have seen", which is a
 * true sentence about a session and a false one about a simulation. Three things block a real
 * measurement today and all three are producer-side rather than contract-side; they are listed on
 * `LearnFromProfileResponse.observed` in `@prl/contracts`.
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
 * The inputs that determine every figure in `STORED_RUNS`.
 *
 * Heads-up against one fixed reference, not at a full table: at a six-handed table a profile's
 * observed entry rate is partly a function of who opened in front of it, so measuring twelve
 * profiles in different company would confound the style with the table. `reading-pressure-
 * specialist` is the same reference `packages/poker-ai/test/simulation` uses, so the figures here
 * and the ones the differentiation suite asserts are comparable. That profile is measured against
 * itself; self-play is a legitimate heads-up match and is stated rather than special-cased.
 *
 * `realistic` because it is the setting at which a profile's traits are expressed as declared.
 * `educational` mutes every trait towards the baseline on purpose, so a divergence measured there
 * would be the feature working rather than a defect.
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

/**
 * The runs, keyed by profile id.
 *
 * An empty `divergences` array is a real result and the one every profile currently produces: it
 * is the claim "this model behaves the way its card says", measured, at a 1.5-point sampling
 * interval. It is not a placeholder, and a screen must say what it means rather than hiding it.
 */
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

/**
 * The measurement for one profile, or `content_not_found`.
 *
 * A profile the server knows but has no stored run for is an `internal_error` rather than a 404:
 * the table is generated from `PROFILES`, so a gap means somebody added a profile without
 * regenerating, and answering "no such thing" would hide that behind a plausible 404.
 */
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

/** The profile, or `content_not_found`: an unknown id is a bad link, not a bad request. */
function profileById(profileId: string) {
  try {
    return requireProfile(profileId);
  } catch {
    throw new AppError('content_not_found', { logDetail: `unknown profile "${profileId}"` });
  }
}

/**
 * `GET /legends/profiles/:profileId/stats`.
 *
 * Registered from `routes/rooms.ts`, beside the other Legends routes, rather than as its own
 * module: `registerApiRoutes` gives each module an encapsulated instance, and a second Legends
 * plugin would be a second place to look for a Legends path.
 *
 * No session required, like the rest of this surface — it is teaching material about a model, not
 * anything about a reader. The handler is a table lookup, which is the whole reason the runs are
 * stored: an endpoint that measured on demand would be three seconds of blocked event loop per
 * call.
 */
export function registerLegendStatsRoute(app: FastifyInstance, schema: object): void {
  app.get<{ Params: { profileId: string } }>(
    '/legends/profiles/:profileId/stats',
    { schema: { params: schema } },
    (request): ProfileStatsResponse => profileStats(request.params.profileId),
  );
}
