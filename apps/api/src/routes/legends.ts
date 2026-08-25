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
      aggressionFrequency: 0.5395010395010394,
      bluffFrequency: 0.41674780915287246,
      wentToShowdown: 0.3217948717948718,
      foldToBetFrequency: 0.4797575232734358,
      averageBetSizeAsPotFraction: 0.7892898940813208,
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
      aggressionFrequency: 0.5803921568627451,
      bluffFrequency: 0.48536036036036034,
      wentToShowdown: 0.35365853658536583,
      foldToBetFrequency: 0.5095260223048327,
      averageBetSizeAsPotFraction: 0.920401086771754,
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
      aggressionFrequency: 0.49231843575418993,
      bluffFrequency: 0.36089238845144356,
      wentToShowdown: 0.29780033840947545,
      foldToBetFrequency: 0.5600967351874244,
      averageBetSizeAsPotFraction: 0.8483480951183097,
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
      aggressionFrequency: 0.6498316498316499,
      bluffFrequency: 0.5589066918001885,
      wentToShowdown: 0.41196777905638665,
      foldToBetFrequency: 0.3876569037656904,
      averageBetSizeAsPotFraction: 0.9893203790562385,
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
      aggressionFrequency: 0.6124209315698678,
      bluffFrequency: 0.5044776119402985,
      wentToShowdown: 0.3870192307692308,
      foldToBetFrequency: 0.4292207792207792,
      averageBetSizeAsPotFraction: 1.0685421252321186,
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
      aggressionFrequency: 0.5548189699133096,
      bluffFrequency: 0.4616132167152575,
      wentToShowdown: 0.33171324422843257,
      foldToBetFrequency: 0.44831932773109245,
      averageBetSizeAsPotFraction: 0.8665029801726952,
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
      aggressionFrequency: 0.604982206405694,
      bluffFrequency: 0.5173469387755102,
      wentToShowdown: 0.3908496732026144,
      foldToBetFrequency: 0.4294385432473445,
      averageBetSizeAsPotFraction: 0.8865976957312383,
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
      aggressionFrequency: 0.31981981981981983,
      bluffFrequency: 0.19416058394160585,
      wentToShowdown: 0.22614107883817428,
      foldToBetFrequency: 0.6939043615344194,
      averageBetSizeAsPotFraction: 0.7485957452465462,
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
      aggressionFrequency: 0.49777117384843983,
      bluffFrequency: 0.4105461393596987,
      wentToShowdown: 0.33290816326530615,
      foldToBetFrequency: 0.49415077989601386,
      averageBetSizeAsPotFraction: 0.9025464919592842,
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
      aggressionFrequency: 0.4874888293118856,
      bluffFrequency: 0.38132635253054104,
      wentToShowdown: 0.3448275862068966,
      foldToBetFrequency: 0.40779014308426076,
      averageBetSizeAsPotFraction: 0.7928037947227561,
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
      aggressionFrequency: 0.12617537721408265,
      bluffFrequency: 0.08743169398907104,
      wentToShowdown: 0.40815006468305304,
      foldToBetFrequency: 0.3734583127775037,
      averageBetSizeAsPotFraction: 0.7575221334935218,
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
