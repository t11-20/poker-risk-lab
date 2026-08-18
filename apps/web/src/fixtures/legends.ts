/**
 * Typed fixtures for the AI Legends screens.
 *
 * ## Why these exist
 *
 * The API routes for this mode are being built in parallel with these screens. Fixtures are
 * how the screens get built, reviewed and render-checked in CI without a database — not
 * mock-driven development for its own sake. Every value below is typed against
 * `@prl/contracts`, so the day the endpoints land, the only thing that changes is where the
 * data comes from: if a wire type moves, this file stops compiling, which is the point.
 *
 * ## Three rules this file follows, because the screens cannot fix them later
 *
 * 1. **`namingMode` is `archetype` here, and no attributed name exists in this file at all.**
 *    This used to be the opposite, on the argument that attributed mode is the harder case to
 *    render and therefore the better fixture. That argument was wrong, and the way it was wrong
 *    is worth keeping written down: the naming mode is a *deployment* decision with legal
 *    consequences (`PRL_LEGEND_NAMING`, default `archetype` in `@prl/poker-ai/labelling` —
 *    "the safe mode is the one you get by not thinking about it"). A fixture that hard-codes
 *    the permissive mode overrides that decision on every screen it renders, and because these
 *    screens fall back to the fixture whenever the profile service is unreachable, an operator
 *    who never set the variable was shipping six real people's names as profile identities.
 *    The render-check was not worth defeating the one guardrail the naming design exists to
 *    enforce, so the attributed builder is gone rather than merely unused: the attributed path
 *    is exercised where it is actually decided, on the server, in `apps/api`'s own tests.
 * 2. **`disclaimers` is written out per profile, in full, never referenced by index.** The
 *    strings are copied verbatim from `@prl/poker-ai/labelling` (`UNIVERSAL_DISCLAIMER`,
 *    `COURSE_PROFILE_DISCLAIMER`). That package is not a dependency of `apps/web`, and it must
 *    not become one: these are wire strings that the API serialises, so the honest fixture is a
 *    copy of the payload, not an import of the source.
 * 3. **No figure is invented where it can be derived.** Pot odds, break-even equity and
 *    equity surplus are computed by `potOdds()` from the pot and the price, so the numbers on
 *    screen are arithmetically consistent with each other. A fixture whose break-even figure
 *    disagreed with its own pot would teach the reader something false.
 *
 * ## Provenance of the trait text
 *
 * `TRAIT_LABELS` and `TRAIT_DESCRIPTIONS` are copied from `packages/poker-ai/src/traits.ts`,
 * which is what the API folds into `LegendTraitAxis.label` / `.description`. Each description
 * is written so a HIGH value never reads as "better" — that is a property of the text, so the
 * screens must not add a ranking, a star rating or a "score" on top of it.
 *
 * The trait vectors are copied from `packages/poker-ai/src/profiles.ts`. They are **design
 * parameters chosen to produce contrasting teaching styles, not measurements of anyone.**
 */

import {
  type ActionCandidate,
  type CoachReport,
  type ComparedDecision,
  type CompareProfilesRequest,
  type CompareProfilesResponse,
  type DecisionQuality,
  type HandComparison,
  LEGEND_TRAIT_KEYS,
  type LearnFromProfileResponse,
  type LegendDifficultyDto,
  type LegendProfileCardDto,
  type LegendProfilesResponse,
  type LegendTraitAxis,
  type LegendTraitKey,
  type LegendTraits,
  MAX_COMPARE_TRIALS,
  type PotOddsSummary,
  type ProfileComparisonEntry,
  type ProfileDisclosureDto,
} from '@prl/contracts';
import { evOfBet, evOfCall, evOfRaise } from '@prl/poker-math';

// ---------------------------------------------------------------------------
// The disclaimers, verbatim from @prl/poker-ai/labelling
// ---------------------------------------------------------------------------

export const UNIVERSAL_DISCLAIMER =
  'These opponents are educational strategy simulations. Each one is a configurable set of ' +
  'tendencies — how often it enters a pot, how aggressively it bets, how much it adjusts to ' +
  'position and stack depth — chosen to contrast with the others so you can feel the difference ' +
  'between styles. They are not real people, not digital copies of anyone, and not endorsed by ' +
  'anyone.';

/**
 * `ATTRIBUTION_DISCLAIMER` is deliberately absent.
 *
 * The API sends it only in attributed naming mode, alongside an attributed display name. Nothing
 * this file can render is in attributed mode any more (rule 1 in the header), so a copy of that
 * string here would be a disclaimer with nothing to disclaim — and, worse, the raw material for
 * putting the attributed path back.
 */
const COURSE_PROFILE_DISCLAIMER =
  'This profile represents general educational concepts about disciplined, fundamentals-first play. ' +
  'It does not reproduce, summarise or substitute for any particular course, book or its proprietary ' +
  'material, and is not affiliated with any course provider.';

// ---------------------------------------------------------------------------
// Trait labels and descriptions
// ---------------------------------------------------------------------------

const TRAIT_LABELS: Readonly<Record<LegendTraitKey, string>> = {
  vpip: 'Hands played',
  pfrShareOfVpip: 'Raises rather than calls',
  aggressionFrequency: 'Aggression',
  bluffFrequency: 'Bluffing',
  positionSensitivity: 'Position awareness',
  threeBetTendency: 'Re-raises preflop',
  betSizingPreference: 'Bet size',
  sizingVariance: 'Varies bet size',
  valueBluffBalance: 'Value-heavy vs bluff-heavy',
  pressureTendency: 'Applies pressure',
  stackDepthAdjustment: 'Adjusts to stack depth',
  tournamentOrientation: 'Tournament instincts',
  riskTolerance: 'Risk appetite',
  exploitativeAdaptation: 'Adapts to opponents',
  foldToPressure: 'Folds under pressure',
  barrelPersistence: 'Keeps betting',
};

const TRAIT_DESCRIPTIONS: Readonly<Record<LegendTraitKey, string>> = {
  vpip: 'How many hands it plays. Playing more hands wins more small pots and loses more big ones.',
  pfrShareOfVpip:
    'When it plays a hand, how often it raises rather than calls. Raising takes the initiative but ' +
    'commits more chips.',
  aggressionFrequency:
    'How often it bets and raises. Aggression wins pots nobody contests, and loses more when it runs ' +
    'into a real hand.',
  bluffFrequency:
    'How often it bets with a hand that cannot win at showdown. Bluffing too little is readable; too ' +
    'much is expensive.',
  positionSensitivity:
    'How much it cares about acting last. Acting last is a genuine edge, and ignoring it is one of the ' +
    'most common leaks.',
  threeBetTendency:
    'How often it re-raises someone who opened. Re-raising isolates and takes control, at the cost of a ' +
    'bigger pot with less information.',
  betSizingPreference:
    'How big it likes to bet. Bigger bets charge draws more but risk more to win the same pot.',
  sizingVariance:
    'Whether it uses one size for everything or changes it. One size is simple and readable; varying it ' +
    'hides information.',
  valueBluffBalance:
    'Whether its bets are mostly strong hands or mostly bluffs. Knowing which tells you whether to call ' +
    'or fold more.',
  pressureTendency:
    'How willing it is to make you decide for a lot of chips. Pressure creates mistakes, including its own.',
  stackDepthAdjustment:
    'How much it changes when stacks get short. Short stacks make implied odds vanish, and a profile that ' +
    'ignores that is beatable.',
  tournamentOrientation:
    'How much it values survival over chips. In a tournament, busting costs more than the chips say — but ' +
    'over-folding gives the edge away.',
  riskTolerance:
    'Whether it takes thin edges. Taking every small edge is correct for chips and brutal for the swings.',
  exploitativeAdaptation:
    'How much it targets what it has seen you do. Adapting wins more against a predictable opponent and ' +
    'can be turned against it.',
  foldToPressure:
    'How easily it gives up a made hand. Folding too little pays off every bluff; folding too much invites them.',
  barrelPersistence:
    'Whether it keeps betting on later streets after taking the lead. Following through wins more pots and ' +
    'costs more when called.',
};

/**
 * The ready-to-render axes for a trait vector, in the contract's own key order.
 *
 * The order matters twice over: it is the order the radar draws its spokes in, and it is the
 * order the numbered markers `01…16` key into. Deriving both from `LEGEND_TRAIT_KEYS` means a
 * chart and its legend cannot disagree.
 */
export function axesFor(traits: LegendTraits): readonly LegendTraitAxis[] {
  return LEGEND_TRAIT_KEYS.map((key) => ({
    key,
    label: TRAIT_LABELS[key],
    value: traits[key],
    description: TRAIT_DESCRIPTIONS[key],
  }));
}

// ---------------------------------------------------------------------------
// Disclosures
// ---------------------------------------------------------------------------

/**
 * `modelBasis` for a profile whose parameters were informed by publicly discussed tendencies.
 *
 * Copied from the server, where it is a property of the *profile* and not of the naming mode: the
 * API returns this same sentence in archetype mode, because how the parameters were arrived at does
 * not change when the label does. It names no one, which is what makes it safe to ship by default.
 */
const LOOSELY_INFORMED_BASIS =
  'Design parameters chosen to produce a recognisable style, loosely informed by tendencies widely ' +
  'discussed in public poker commentary. Not measured from anyone’s hand histories, and not a ' +
  'reproduction of any individual’s play.';

const ARCHETYPE_BASIS =
  'Design parameters chosen to produce a specific, contrasting teaching style. Not modelled on any ' +
  'individual.';

/**
 * Builds a disclosure the way `profileDisclosure()` does on the server, in archetype mode.
 *
 * There is deliberately no attributed counterpart in this file. See rule 1 in the file header: a
 * disclosure builder that can emit a real person's name is a disclosure builder that will emit one
 * the next time a screen falls back, whatever `PRL_LEGEND_NAMING` says.
 */
function archetypeDisclosure(input: {
  readonly archetypeName: string;
  readonly tagline: string;
  readonly courseDerived?: boolean;
}): ProfileDisclosureDto {
  return {
    displayName: input.archetypeName,
    archetypeName: input.archetypeName,
    tagline: input.tagline,
    attributed: false,
    disclaimers:
      input.courseDerived === true
        ? [UNIVERSAL_DISCLAIMER, COURSE_PROFILE_DISCLAIMER]
        : [UNIVERSAL_DISCLAIMER],
    shortLabel: input.archetypeName,
  };
}

// ---------------------------------------------------------------------------
// The profiles
// ---------------------------------------------------------------------------

const VOCAL_AGGRESSOR_TRAITS: LegendTraits = {
  vpip: 0.32,
  pfrShareOfVpip: 0.72,
  aggressionFrequency: 0.66,
  bluffFrequency: 0.34,
  positionSensitivity: 0.52,
  threeBetTendency: 0.48,
  betSizingPreference: 0.42,
  sizingVariance: 0.35,
  valueBluffBalance: 0.62,
  pressureTendency: 0.6,
  stackDepthAdjustment: 0.55,
  tournamentOrientation: 0.78,
  riskTolerance: 0.4,
  exploitativeAdaptation: 0.62,
  foldToPressure: 0.3,
  barrelPersistence: 0.58,
};

const ADAPTIVE_EXPLOITER_TRAITS: LegendTraits = {
  vpip: 0.28,
  pfrShareOfVpip: 0.82,
  aggressionFrequency: 0.68,
  bluffFrequency: 0.42,
  positionSensitivity: 0.88,
  threeBetTendency: 0.66,
  betSizingPreference: 0.58,
  sizingVariance: 0.86,
  valueBluffBalance: 0.52,
  pressureTendency: 0.78,
  stackDepthAdjustment: 0.82,
  tournamentOrientation: 0.42,
  riskTolerance: 0.72,
  exploitativeAdaptation: 0.95,
  foldToPressure: 0.48,
  barrelPersistence: 0.76,
};

const PATIENT_TECHNICIAN_TRAITS: LegendTraits = {
  vpip: 0.25,
  pfrShareOfVpip: 0.86,
  aggressionFrequency: 0.64,
  bluffFrequency: 0.36,
  positionSensitivity: 0.92,
  threeBetTendency: 0.56,
  betSizingPreference: 0.5,
  sizingVariance: 0.62,
  valueBluffBalance: 0.6,
  pressureTendency: 0.66,
  stackDepthAdjustment: 0.78,
  tournamentOrientation: 0.84,
  riskTolerance: 0.46,
  exploitativeAdaptation: 0.64,
  foldToPressure: 0.62,
  barrelPersistence: 0.58,
};

const PRESSURE_EXPERT_TRAITS: LegendTraits = {
  vpip: 0.42,
  pfrShareOfVpip: 0.8,
  aggressionFrequency: 0.74,
  bluffFrequency: 0.46,
  positionSensitivity: 0.7,
  threeBetTendency: 0.7,
  betSizingPreference: 0.62,
  sizingVariance: 0.66,
  valueBluffBalance: 0.5,
  pressureTendency: 0.84,
  stackDepthAdjustment: 0.66,
  tournamentOrientation: 0.5,
  riskTolerance: 0.7,
  exploitativeAdaptation: 0.72,
  foldToPressure: 0.42,
  barrelPersistence: 0.82,
};

const VOLUME_GRINDER_TRAITS: LegendTraits = {
  vpip: 0.36,
  pfrShareOfVpip: 0.84,
  aggressionFrequency: 0.7,
  bluffFrequency: 0.48,
  positionSensitivity: 0.8,
  threeBetTendency: 0.78,
  betSizingPreference: 0.54,
  sizingVariance: 0.72,
  valueBluffBalance: 0.5,
  pressureTendency: 0.72,
  stackDepthAdjustment: 0.85,
  tournamentOrientation: 0.7,
  riskTolerance: 0.9,
  exploitativeAdaptation: 0.78,
  foldToPressure: 0.55,
  barrelPersistence: 0.7,
};

const DISCIPLINED_SPECIALIST_TRAITS: LegendTraits = {
  vpip: 0.15,
  pfrShareOfVpip: 0.9,
  aggressionFrequency: 0.52,
  bluffFrequency: 0.18,
  positionSensitivity: 0.8,
  threeBetTendency: 0.44,
  betSizingPreference: 0.4,
  sizingVariance: 0.74,
  valueBluffBalance: 0.84,
  pressureTendency: 0.38,
  stackDepthAdjustment: 0.72,
  tournamentOrientation: 0.48,
  riskTolerance: 0.2,
  exploitativeAdaptation: 0.5,
  foldToPressure: 0.76,
  barrelPersistence: 0.38,
};

const FUNDAMENTALS_COACH_TRAITS: LegendTraits = {
  vpip: 0.23,
  pfrShareOfVpip: 0.8,
  aggressionFrequency: 0.55,
  bluffFrequency: 0.28,
  positionSensitivity: 0.78,
  threeBetTendency: 0.45,
  betSizingPreference: 0.5,
  sizingVariance: 0.25,
  valueBluffBalance: 0.62,
  pressureTendency: 0.48,
  stackDepthAdjustment: 0.7,
  tournamentOrientation: 0.5,
  riskTolerance: 0.35,
  exploitativeAdaptation: 0.3,
  foldToPressure: 0.62,
  barrelPersistence: 0.45,
};

const OLD_SCHOOL_PRESSURE_TRAITS: LegendTraits = {
  vpip: 0.38,
  pfrShareOfVpip: 0.78,
  aggressionFrequency: 0.72,
  bluffFrequency: 0.4,
  positionSensitivity: 0.6,
  threeBetTendency: 0.55,
  betSizingPreference: 0.68,
  sizingVariance: 0.3,
  valueBluffBalance: 0.55,
  pressureTendency: 0.8,
  stackDepthAdjustment: 0.45,
  tournamentOrientation: 0.45,
  riskTolerance: 0.68,
  exploitativeAdaptation: 0.5,
  foldToPressure: 0.38,
  barrelPersistence: 0.7,
};

const MIXED_GAME_GENERALIST_TRAITS: LegendTraits = {
  vpip: 0.34,
  pfrShareOfVpip: 0.7,
  aggressionFrequency: 0.62,
  bluffFrequency: 0.44,
  positionSensitivity: 0.76,
  threeBetTendency: 0.58,
  betSizingPreference: 0.5,
  sizingVariance: 0.78,
  valueBluffBalance: 0.5,
  pressureTendency: 0.66,
  stackDepthAdjustment: 0.9,
  tournamentOrientation: 0.62,
  riskTolerance: 0.62,
  exploitativeAdaptation: 0.7,
  foldToPressure: 0.5,
  barrelPersistence: 0.62,
};

const FOUNDATIONAL_READER_TRAITS: LegendTraits = {
  vpip: 0.3,
  pfrShareOfVpip: 0.62,
  aggressionFrequency: 0.56,
  bluffFrequency: 0.36,
  positionSensitivity: 0.45,
  threeBetTendency: 0.4,
  betSizingPreference: 0.55,
  sizingVariance: 0.28,
  valueBluffBalance: 0.58,
  pressureTendency: 0.6,
  stackDepthAdjustment: 0.35,
  tournamentOrientation: 0.4,
  riskTolerance: 0.55,
  exploitativeAdaptation: 0.8,
  foldToPressure: 0.35,
  barrelPersistence: 0.55,
};

const RANGE_NARRATOR_TRAITS: LegendTraits = {
  vpip: 0.4,
  pfrShareOfVpip: 0.66,
  aggressionFrequency: 0.6,
  bluffFrequency: 0.38,
  positionSensitivity: 0.82,
  threeBetTendency: 0.5,
  betSizingPreference: 0.4,
  sizingVariance: 0.6,
  valueBluffBalance: 0.56,
  pressureTendency: 0.54,
  stackDepthAdjustment: 0.7,
  tournamentOrientation: 0.68,
  riskTolerance: 0.5,
  exploitativeAdaptation: 0.88,
  foldToPressure: 0.6,
  barrelPersistence: 0.52,
};

const CALLING_STATION_TRAITS: LegendTraits = {
  vpip: 0.52,
  pfrShareOfVpip: 0.14,
  aggressionFrequency: 0.16,
  bluffFrequency: 0.08,
  positionSensitivity: 0.12,
  threeBetTendency: 0.08,
  betSizingPreference: 0.35,
  sizingVariance: 0.15,
  valueBluffBalance: 0.85,
  pressureTendency: 0.15,
  stackDepthAdjustment: 0.15,
  tournamentOrientation: 0.3,
  riskTolerance: 0.35,
  exploitativeAdaptation: 0.1,
  foldToPressure: 0.14,
  barrelPersistence: 0.2,
};

/**
 * All twelve profiles the server ships, in the server's own order.
 *
 * It used to be eight, on the argument that a fixture's job is to cover the *shapes* a screen has
 * to render rather than the whole roster. That argument does not survive contact with what this
 * fixture is actually for. These screens fall back to it whenever the profile service is
 * unreachable, so "eight shapes" shipped as *the product*: the listing rendered eight cards under a
 * requirement for eleven named profiles plus the educational one, the home page and the footer both
 * said twelve, and the detail routes for the four that were missing rendered the not-found page.
 * A fallback that is missing a third of the roster is not a fallback, it is a different product.
 *
 * The order matches `PROFILE_LIST` in `packages/poker-ai/src/profiles.ts`, so the listing does not
 * reshuffle when the API comes back. `apps/api/test/legend-fixture-figures.test.ts` asserts the
 * ids here and the ids the server serves are the same set, in the same order.
 *
 * Both disclosure shapes are still covered — plain archetype, and the course-derived one that
 * carries a second disclaimer — and none of them is attributed. See rule 1 in the file header.
 */
export const LEGEND_PROFILE_FIXTURES: readonly LegendProfileCardDto[] = [
  {
    id: 'vocal-aggressor',
    disclosure: archetypeDisclosure({
      archetypeName: 'High-Variance Tournament Aggressor',
      tagline: 'Plays a lot of hands, applies constant pressure, and hates folding.',
    }),
    traits: VOCAL_AGGRESSOR_TRAITS,
    axes: axesFor(VOCAL_AGGRESSOR_TRAITS),
    learnFrom: [
      'How much value there is in reading an opponent and playing against *them* rather than playing a fixed strategy.',
      'What it costs to be reluctant to fold a made hand: this model pays off value bets that a more disciplined style would escape.',
      'Why a tournament style can rationally decline thin edges that a cash-game style would take — survival has value once a prize structure exists.',
    ],
    styleNotes: [
      'Enters a lot of pots and takes the betting lead in most of them.',
      'Rarely folds a hand it has already invested in, so bluffing it is expensive.',
      'Sizes bets modestly and fairly consistently, which makes it more readable than its aggression suggests.',
    ],
    counterStrategy: [
      'Value-bet thinly and often. A style that will not fold pays for it.',
      'Bluff less than you would against a disciplined opponent — this model calls.',
      'Do not try to out-aggress it early in a hand; let it commit chips and then charge it.',
    ],
    modelBasis: LOOSELY_INFORMED_BASIS,
    signatureTraits: ['aggressionFrequency', 'foldToPressure', 'tournamentOrientation'],
    bestFor: 'six-max',
  },
  {
    id: 'adaptive-exploiter',
    disclosure: archetypeDisclosure({
      archetypeName: 'Adaptive Exploitative Pro',
      tagline: 'Reads what you do and attacks it. Changes gears without warning.',
    }),
    traits: ADAPTIVE_EXPLOITER_TRAITS,
    axes: axesFor(ADAPTIVE_EXPLOITER_TRAITS),
    learnFrom: [
      'What adaptation actually looks like: the same hand played three different ways depending on what you did in the previous ten.',
      'How varying bet sizes removes information. Against a single-size opponent you can read strength from the size; against this one you cannot.',
      'How much position is worth to someone who uses it fully — compare its decisions from the button and from the blinds with identical cards.',
    ],
    styleNotes: [
      'Sizing changes with board texture and with what you have shown, so bet size tells you little.',
      'Applies pressure on later streets, not just the flop.',
      'Adjusts noticeably once it has seen you fold too often or call too often.',
    ],
    counterStrategy: [
      'Vary your own play. Any consistent habit is what this model is built to punish.',
      'Do not read strength from bet size; read it from the whole line and the board.',
      'Reduce the number of hands you play out of position against it — that is where it makes its money.',
    ],
    modelBasis: LOOSELY_INFORMED_BASIS,
    signatureTraits: ['exploitativeAdaptation', 'sizingVariance', 'positionSensitivity'],
    bestFor: 'both',
  },
  {
    id: 'patient-technician',
    disclosure: archetypeDisclosure({
      archetypeName: 'Patient Positional Technician',
      tagline: 'Waits, then applies pressure precisely where position gives it an edge.',
    }),
    traits: PATIENT_TECHNICIAN_TRAITS,
    axes: axesFor(PATIENT_TECHNICIAN_TRAITS),
    learnFrom: [
      'That patience is an active strategy, not passivity. This model folds a great deal and then commits decisively.',
      'How position and stack depth together decide whether a marginal hand is playable at all.',
      'Why folding a made hand can be correct: this model gives up hands that a stubborn style would lose a stack with.',
    ],
    styleNotes: [
      'Plays few hands, and almost always raises rather than calls when it does.',
      'Very reluctant to enter pots out of position.',
      'Will fold to sustained aggression when the situation says its hand is beaten.',
    ],
    counterStrategy: [
      'Attack its blinds — it is folding a lot, and that is exploitable.',
      'When it commits chips voluntarily, believe it. Its range is narrow.',
      'Apply pressure on later streets; this model folds more than a stubborn one.',
    ],
    modelBasis: LOOSELY_INFORMED_BASIS,
    signatureTraits: ['positionSensitivity', 'vpip', 'foldToPressure'],
    bestFor: 'both',
  },
  {
    id: 'reading-pressure-specialist',
    disclosure: archetypeDisclosure({
      archetypeName: 'Heads-Up Pressure Expert',
      tagline: 'Relentless in short-handed pots, and hard to put on a hand.',
    }),
    traits: PRESSURE_EXPERT_TRAITS,
    axes: axesFor(PRESSURE_EXPERT_TRAITS),
    learnFrom: [
      'Why heads-up and short-handed play requires a far wider range than a full table — folding too much is the losing strategy.',
      'What sustained pressure across three streets does to your decisions, and how to keep making them on the merits.',
      'How a roughly balanced value-to-bluff mix stops you being able to simply call more or fold more against it.',
    ],
    styleNotes: [
      'Plays a wide range and re-raises frequently.',
      'Keeps betting on the turn and river after taking the lead on the flop.',
      'Uses large sizes when it wants you to make a decision for real money.',
    ],
    counterStrategy: [
      'Widen your continuing range. Folding to a wide aggressor is how you lose slowly.',
      'Pick a street to make your stand and hold it, rather than folding a street late every time.',
      'Use its persistence: check-raising a barrel is far more effective against a model that keeps firing.',
    ],
    modelBasis: LOOSELY_INFORMED_BASIS,
    signatureTraits: ['pressureTendency', 'barrelPersistence', 'vpip'],
    bestFor: 'heads-up',
  },
  {
    id: 'old-school-pressure',
    disclosure: archetypeDisclosure({
      archetypeName: 'Classic Aggressive Fundamentalist',
      tagline: 'Plays a wide, connected range and bets it hard. Simple, and heavy.',
    }),
    traits: OLD_SCHOOL_PRESSURE_TRAITS,
    axes: axesFor(OLD_SCHOOL_PRESSURE_TRAITS),
    learnFrom: [
      'That a simple strategy played forcefully beats a complicated one played timidly.',
      'How hands that can make straights and flushes gain value when stacks are deep and the betting is heavy.',
      'What a single consistent large bet size gives away — and how you can use that against it.',
    ],
    styleNotes: [
      'Wide range, mostly raised rather than called.',
      'Large bets, and almost always the same fraction of the pot.',
      'Does not adjust much to what you are doing.',
    ],
    counterStrategy: [
      'Its uniform sizing is the leak. The same size with strong and weak hands means the size tells you nothing — but its *frequency* does.',
      'Play hands that flop well against a wide range rather than high-card hands that make one pair.',
      'It folds rarely, so value-bet more and bluff less.',
    ],
    modelBasis: LOOSELY_INFORMED_BASIS,
    signatureTraits: ['betSizingPreference', 'sizingVariance', 'aggressionFrequency'],
    bestFor: 'six-max',
  },
  {
    id: 'mixed-game-generalist',
    disclosure: archetypeDisclosure({
      archetypeName: 'Mixed-Game Structural Generalist',
      tagline: 'Thinks in terms of structure and stack depth rather than fixed ranges.',
    }),
    traits: MIXED_GAME_GENERALIST_TRAITS,
    axes: axesFor(MIXED_GAME_GENERALIST_TRAITS),
    learnFrom: [
      'How completely stack depth changes a hand. Watch this model play the same holding differently at 12, 40 and 120 big blinds.',
      'Why stack-to-pot ratio decides *when* the commitment decision happens, which is more useful than knowing whether a hand is "good".',
      'How a player who thinks structurally rather than in memorised ranges handles unfamiliar situations.',
    ],
    styleNotes: [
      'Its behaviour changes sharply as stacks shorten — more so than any other profile here.',
      'Varies bet size a lot, often to set up the next street rather than for this one.',
      'Comfortable in awkward, unfamiliar spots.',
    ],
    counterStrategy: [
      'Track the effective stack, not your own. Its decisions are driven by that number.',
      'At deep stacks it plays more carefully; at short stacks it commits fast. Adjust in the same direction it does.',
      'Watch for sizes that only make sense as preparation for a later street.',
    ],
    modelBasis: LOOSELY_INFORMED_BASIS,
    signatureTraits: ['stackDepthAdjustment', 'sizingVariance', 'positionSensitivity'],
    bestFor: 'both',
  },
  {
    id: 'volume-grinder',
    disclosure: archetypeDisclosure({
      archetypeName: 'High-Volume Analytical Grinder',
      tagline: 'Takes every small edge and accepts the swings that come with it.',
    }),
    traits: VOLUME_GRINDER_TRAITS,
    axes: axesFor(VOLUME_GRINDER_TRAITS),
    learnFrom: [
      'What a high risk tolerance actually means: this model takes edges of a fraction of a big blind, and the swings are large.',
      'Why variance is the price of an edge rather than evidence against one. Compare its results over 200 hands with its results over 5,000.',
      'How often re-raising preflop is available, and how much pressure that puts on someone who only raises with strong hands.',
    ],
    styleNotes: [
      'Re-raises preflop more than any other profile here.',
      'Takes marginal all-in spots that other profiles decline.',
      'Its short-run results swing hard in both directions.',
    ],
    counterStrategy: [
      'Do not interpret its willingness to gamble as weakness — the thin edges it takes are usually real.',
      'Tighten your opening range slightly, since it will re-raise you often.',
      'When it takes a marginal spot against you, work out the price rather than reacting to the aggression.',
    ],
    modelBasis: LOOSELY_INFORMED_BASIS,
    signatureTraits: ['riskTolerance', 'threeBetTendency', 'stackDepthAdjustment'],
    bestFor: 'six-max',
  },
  {
    id: 'disciplined-specialist',
    disclosure: archetypeDisclosure({
      archetypeName: 'Disciplined Mixed-Format Specialist',
      tagline: 'Extremely selective, extremely precise. Gives away almost nothing.',
    }),
    traits: DISCIPLINED_SPECIALIST_TRAITS,
    axes: axesFor(DISCIPLINED_SPECIALIST_TRAITS),
    learnFrom: [
      'What genuine selectivity costs and buys. This model folds far more than feels comfortable and is very hard to trap.',
      'Why a value-heavy betting range means you should fold more against it — and how to tell that from watching, not from being told.',
      'How a low risk tolerance shows up: it passes up edges that the grinder profile takes, and its results swing much less.',
    ],
    styleNotes: [
      'Plays the fewest hands of any profile here, and raises almost all of them.',
      'Bets are mostly for value, so a big bet usually means a big hand.',
      'Folds correctly to pressure rather than defending out of stubbornness.',
    ],
    counterStrategy: [
      'Steal from it relentlessly. A profile this tight is folding a lot of blinds.',
      'Believe its value bets — the balance is deliberately value-heavy.',
      'Bluff it more than you would bluff a calling station, but pick spots where its range is genuinely weak.',
    ],
    modelBasis: LOOSELY_INFORMED_BASIS,
    signatureTraits: ['vpip', 'valueBluffBalance', 'riskTolerance'],
    bestFor: 'both',
  },
  {
    id: 'foundational-reader',
    disclosure: archetypeDisclosure({
      archetypeName: 'Foundational Read-Based Player',
      tagline: 'Plays the opponent more than the cards. Straightforward, and stubborn.',
    }),
    traits: FOUNDATIONAL_READER_TRAITS,
    axes: axesFor(FOUNDATIONAL_READER_TRAITS),
    learnFrom: [
      'How far you can get on reads alone — and where that stops being enough against someone who varies their play.',
      'What low position-sensitivity costs. This model plays similar hands from every seat, and you can exploit that directly.',
      'Why a strategy built before modern range theory still wins pots: pressure and observation are timeless, precision is the addition.',
    ],
    styleNotes: [
      'Adapts strongly to what it has seen you do, but pays little attention to its own position.',
      'Uses one bet size for almost everything.',
      'Slow to fold a hand it likes.',
    ],
    counterStrategy: [
      'Attack it from position. It does not adjust for being out of position, and that is a persistent edge.',
      'Change your patterns — it is reading you, so give it the wrong read and then use it.',
      'Value-bet more than usual; it does not fold easily.',
    ],
    modelBasis: LOOSELY_INFORMED_BASIS,
    signatureTraits: ['exploitativeAdaptation', 'positionSensitivity', 'sizingVariance'],
    bestFor: 'six-max',
  },
  {
    id: 'range-narrator',
    disclosure: archetypeDisclosure({
      archetypeName: 'Range-Reading Communicator',
      tagline: 'Plays a wide range and narrows yours street by street.',
    }),
    traits: RANGE_NARRATOR_TRAITS,
    axes: axesFor(RANGE_NARRATOR_TRAITS),
    learnFrom: [
      'How to narrow an opponent’s range across streets. This is the profile whose replay commentary is most worth reading line by line.',
      'Why playing many hands can work when combined with genuine positional discipline and a willingness to fold later.',
      'How small bet sizes keep a pot controlled while still gathering information.',
    ],
    styleNotes: [
      'Enters many pots, but folds them readily when later streets go badly.',
      'Prefers smaller bets that keep the pot manageable.',
      'Its decisions visibly reflect what your earlier actions ruled out.',
    ],
    counterStrategy: [
      'Be aware that your line, not just your last action, is what it is reading. Consistency across streets is what it uses.',
      'Its small sizing means calling is cheap — take the price when your hand can improve.',
      'It folds later streets more than most, so a well-timed second or third barrel works.',
    ],
    modelBasis: LOOSELY_INFORMED_BASIS,
    signatureTraits: ['exploitativeAdaptation', 'vpip', 'betSizingPreference'],
    bestFor: 'both',
  },
  {
    id: 'fundamentals-coach',
    disclosure: archetypeDisclosure({
      archetypeName: 'Fundamentals-First Study Model',
      tagline: 'Plays textbook, explains itself clearly, and never takes a thin gamble.',
      courseDerived: true,
    }),
    traits: FUNDAMENTALS_COACH_TRAITS,
    axes: axesFor(FUNDAMENTALS_COACH_TRAITS),
    learnFrom: [
      'What a disciplined, fundamentals-first strategy looks like when played without deviation — the baseline every other style is a departure from.',
      'How position, pot odds and stack depth alone, applied consistently, produce a solid strategy with no reads at all.',
      'Why a consistent, readable strategy is a reasonable place to start: it is exploitable, but it is also correct often enough to learn from.',
    ],
    styleNotes: [
      'Tight, position-aware, and highly consistent — the easiest profile here to predict.',
      'One bet size for almost everything, chosen by pot fraction rather than by hand.',
      'Does not adapt to you at all, by design.',
    ],
    counterStrategy: [
      'Its consistency is the weakness. Once you know its opening range you know its continuing range.',
      'Steal position and blinds; it will fold correctly and often.',
      'Do not expect it to bluff much — when it bets big on the river, fold your marginal hands.',
    ],
    modelBasis:
      'Design parameters representing general, widely taught fundamentals — position, pot odds, stack ' +
      'depth, disciplined ranges. It does not reproduce or summarise any particular course, book or ' +
      'proprietary material.',
    signatureTraits: ['sizingVariance', 'exploitativeAdaptation', 'positionSensitivity'],
    bestFor: 'both',
  },
  {
    id: 'calling-station',
    disclosure: archetypeDisclosure({
      archetypeName: 'Passive Calling Station',
      tagline: 'Calls far too much and almost never raises. Beatable, and instructive.',
    }),
    traits: CALLING_STATION_TRAITS,
    axes: axesFor(CALLING_STATION_TRAITS),
    learnFrom: [
      'That the correct adjustment against someone who never folds is to value-bet relentlessly and stop bluffing entirely.',
      'How to recognise a passive opponent from their actions within a handful of hands.',
      'Why fold equity is worth naming as a separate concept: against this profile you have almost none, and every bluff calculation changes.',
    ],
    styleNotes: [
      'Calls with almost anything and rarely raises.',
      'Plays the same way from every position.',
      'When it does bet big, its range is genuinely strong — it is not bluffing.',
    ],
    counterStrategy: [
      'Bet your good hands, every street, and size up. It will pay.',
      'Stop bluffing. With no fold equity, a bluff is a donation.',
      'Believe its rare aggression.',
    ],
    modelBasis: ARCHETYPE_BASIS,
    signatureTraits: ['aggressionFrequency', 'foldToPressure', 'pfrShareOfVpip'],
    bestFor: 'both',
  },
];

/**
 * The three difficulty settings.
 *
 * `educational` is not "worse", it is *more legible* — which is why the description says so and
 * why `coachAvailable` is part of the wire type rather than a footnote. A learner choosing a
 * setting is choosing how readable the opponent is, and whether they can see the maths while
 * they play.
 */
export const LEGEND_DIFFICULTY_FIXTURES: readonly LegendDifficultyDto[] = [
  {
    id: 'educational',
    label: 'Educational',
    description:
      'The style is muted and consistent, so you can see its shape. Bet sizes are uniform, it does not ' +
      'adapt to you, and the Coach stays available while you play.',
    coachAvailable: true,
  },
  {
    id: 'realistic',
    label: 'Realistic',
    description:
      'The style is expressed as designed, with the sizing variation and inconsistency a real opponent ' +
      'shows. It adapts a little to what you have been doing.',
    coachAvailable: true,
  },
  {
    id: 'expert',
    label: 'Expert',
    description:
      'The style is fully expressed, adapts hard to what it has seen you do, and varies its sizing enough ' +
      'to be genuinely difficult to read. The Coach is available afterwards in review, not during the hand.',
    coachAvailable: false,
  },
];

export const LEGEND_PROFILES_FIXTURE: LegendProfilesResponse = {
  // `archetype`, matching the server's default, and not negotiable from inside this file: the mode
  // is a deployer's decision (`PRL_LEGEND_NAMING`) and an offline render path must not be able to
  // make it. `apps/api/test/legends-naming-fallback.test.ts` asserts this stays true.
  namingMode: 'archetype',
  profiles: LEGEND_PROFILE_FIXTURES,
  difficulties: LEGEND_DIFFICULTY_FIXTURES,
  universalDisclaimer: UNIVERSAL_DISCLAIMER,
};

export function profileFixtureById(profileId: string): LegendProfileCardDto | null {
  return LEGEND_PROFILE_FIXTURES.find((profile) => profile.id === profileId) ?? null;
}

// ---------------------------------------------------------------------------
// Contrasts — derived, not hand-written
// ---------------------------------------------------------------------------

/** How many other profiles a contrast section shows, and how many axes each one lists. */
const CONTRAST_PROFILES = 3;
const CONTRAST_AXES = 4;

/** Mean absolute difference across all sixteen axes: how far apart two styles actually are. */
function traitDistance(left: LegendTraits, right: LegendTraits): number {
  let total = 0;
  for (const key of LEGEND_TRAIT_KEYS) total += Math.abs(left[key] - right[key]);
  return total / LEGEND_TRAIT_KEYS.length;
}

/**
 * The axes where this profile differs most from the others, computed rather than written.
 *
 * Derived so the contrast section cannot go stale against the trait vectors above, and so it
 * says the same thing the server's `biggestTraitDifferences` would. `delta` keeps its sign:
 * which direction a style leans is the whole content of the comparison, and an absolute value
 * would turn "plays far more hands" into "differs on hands played".
 */
export function contrastsFor(profileId: string): LearnFromProfileResponse['contrasts'] {
  const subject = profileFixtureById(profileId);
  if (subject === null) return [];
  return LEGEND_PROFILE_FIXTURES.filter((other) => other.id !== profileId)
    .map((other) => ({ other, distance: traitDistance(subject.traits, other.traits) }))
    .sort((left, right) => right.distance - left.distance || left.other.id.localeCompare(right.other.id))
    .slice(0, CONTRAST_PROFILES)
    .map(({ other }) => ({
      otherProfileId: other.id,
      otherDisplayName: other.disclosure.displayName,
      differences: LEGEND_TRAIT_KEYS.map((key) => ({
        key,
        label: TRAIT_LABELS[key],
        delta: subject.traits[key] - other.traits[key],
      }))
        .sort(
          (left, right) => Math.abs(right.delta) - Math.abs(left.delta) || left.key.localeCompare(right.key),
        )
        .slice(0, CONTRAST_AXES),
    }));
}

/**
 * `PATIENT_TECHNICIAN_OBSERVED` is deliberately absent, and this note is its gravestone.
 *
 * It was a `ProfileObservedStats` — 128 hands, VPIP 0.27, PFR 0.22, and six more figures — handed
 * to a table whose own caption reads "Measured over 128 hands of your own play, not declared by the
 * profile". Nobody had played those hands. Because the fixture path was taken on every request for
 * the whole build-out, every reader who opened that profile was shown invented numbers described as
 * a measurement of their own session, in a product whose subject is how much confidence a number
 * deserves. It carried a sampling interval, which made it *more* convincing rather than less.
 *
 * There is no honest fixture value for this field. A fixture is by definition not a measurement,
 * and the field means "what happened when you played". So the fixture reports null — the state the
 * page already renders correctly — and the measurement that CAN be made honestly, of a simulation
 * rather than of the reader, is served live by `GET /legends/profiles/:id/stats` and is labelled as
 * a simulation everywhere it appears.
 */

/** The "what can I learn from this style" payload, assembled from the card plus the contrasts. */
export function learnFromFixture(profileId: string): LearnFromProfileResponse | null {
  const profile = profileFixtureById(profileId);
  if (profile === null) return null;
  return {
    profileId: profile.id,
    disclosure: profile.disclosure,
    learnFrom: profile.learnFrom,
    counterStrategy: profile.counterStrategy,
    // Null, and `observedBasis` null with it: an offline fixture has observed nothing. See above.
    observed: null,
    observedBasis: null,
    contrasts: contrastsFor(profile.id),
  };
}

// ---------------------------------------------------------------------------
// CoachReport construction
// ---------------------------------------------------------------------------

/**
 * Pot odds, derived from the pot and the price.
 *
 * `oddsRatio` is `pot / toCall`, and `null` when there is nothing to call: a free continuation has
 * no price, which is a real situation rather than an error. `null` rather than `Infinity` because
 * `JSON.stringify(Infinity)` is `null` anyway — a fixture emitting `Infinity` would describe a wire
 * value the wire cannot carry, and would be the one shape the live path could never produce.
 *
 * Nothing is rounded here: the components format, and a fixture that pre-rounded would disagree
 * with its own arithmetic.
 */
function potOdds(input: {
  readonly pot: number;
  readonly toCall: number;
  readonly heroEquity: number;
  readonly explanation: string;
}): PotOddsSummary {
  const breakEvenEquity = input.toCall === 0 ? 0 : input.toCall / (input.pot + input.toCall);
  return {
    pot: input.pot,
    toCall: input.toCall,
    breakEvenEquity,
    oddsRatio: input.toCall === 0 ? null : input.pot / input.toCall,
    equitySurplus: input.heroEquity - breakEvenEquity,
    explanation: input.explanation,
  };
}

/**
 * Facing a pot-sized bet, a caller needs a third of the final pot: `P / (2P + P)`.
 *
 * Written as the division rather than as `0.333…` so the figure on screen is the arithmetic,
 * not a number somebody typed.
 */
const POT_ODDS_OF_POT_SIZED_BET = 1 / 3;

const FOLD_CANDIDATE: ActionCandidate = {
  action: 'fold',
  cost: 0,
  ev: 0,
  derivation: 'Folding is the zero point every other expected value here is measured against.',
};

// ---------------------------------------------------------------------------
// Expected values: computed here, not written here
// ---------------------------------------------------------------------------

/**
 * ## Why these three functions are imported instead of the numbers being typed in
 *
 * Every expected value below used to be a literal with a prose derivation beside it and no
 * generator anywhere. None of them reproduced. From their own stated premises the two preflop
 * raises are worth 28.7 and 34.7 units and the file said 12.4 and 11.6; the flop table was out by
 * roughly a factor of seven on every row; and the compare block was not internally consistent under
 * any single convention at all — its call row priced the pot at 210 while its raise row said "the
 * 390 already committed", which are the before-call and after-call pots of the same spot.
 *
 * They erred conservatively, understating raises, which is the opposite direction from the Coach
 * bug this release fixed. That makes them not urgent and it does not make them teachable: a worked
 * example that does not survive its own arithmetic teaches a learner to stop checking, which is the
 * one habit this product exists to build.
 *
 * `evOfCall`, `evOfBet` and `evOfRaise` are the same functions `buildCoachReport` uses, so these
 * candidates are now the API's own arithmetic rather than an imitation of it, and a change to the
 * model moves them. The three conventions they encode, from `@prl/poker-math/ev`:
 *
 *     EV(call)  = e x (pot + toCall) - toCall
 *     EV(bet)   = f x pot + (1 - f) x [ e x (pot + 2b) - b ]
 *     EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ]
 *
 * `pot` is what is in the middle BEFORE the action and already includes the bet being called, so
 * it is what a fold wins — never the pot the call would create. `r` is the raise ON TOP of the
 * call, and the raiser risks `c + r`, which is the term the old figures dropped.
 *
 * `apps/api/test/legend-fixture-figures.test.ts` recomputes every candidate here from the pot,
 * price, equity and fold frequency this file states, and asserts the stored figure matches.
 */

/** One decimal place, the resolution every EV in this file is quoted at. */
function units(value: number): string {
  return value.toFixed(1);
}

/** A signed figure, because "+8.2" and "-8.2" are opposite claims. */
function signedUnits(value: number): string {
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(1)}`;
}

/** `EV(call) = e x (pot + toCall) - toCall`, from the shared model. */
function callEv(pot: number, toCall: number, equity: number): number {
  return evOfCall({ pot, toCall, equity }).ev;
}

/** `EV(bet) = f x pot + (1 - f) x [ e x (pot + 2b) - b ]`, from the shared model. */
function betEv(pot: number, betSize: number, foldProbability: number, equity: number): number {
  return evOfBet({ pot, betSize, foldProbability, equityWhenCalled: equity }).ev;
}

/**
 * `EV(raise)`, keyed on the candidate's own `cost` rather than on its `to`.
 *
 * ## Why `cost` and not `to`, which is the trap this helper exists to close
 *
 * `ActionCandidate.to` is a raise TO: the seat's total commitment for the street once the action
 * lands. `cost` is what leaves the stack now. The two differ by whatever the seat had already put
 * in — a small blind, a previous bet — and the difference is invisible in most spots because it is
 * usually zero.
 *
 * It is not zero preflop. Hero is the small blind with 10 already in, facing a big blind of 20, so
 * `toCall` is 10 and a raise to 60 costs 50, of which 40 is the raise on top of the call. A helper
 * that computed `raiseBy = to - toCall` would call it 50, charge hero the right total by accident
 * and give the opponent 10 too much to match, and report 30.5 instead of 28.7 — a small, plausible
 * overstatement of exactly the kind this whole rewrite is correcting, produced by the same class of
 * mistake. So the increment is derived from the chips actually moved: `raiseBy = cost - toCall`,
 * and the risk `evOfRaise` charges is `toCall + raiseBy`, which is `cost`.
 */
function raiseEv(input: {
  readonly pot: number;
  readonly toCall: number;
  /** Chips this action moves from the stack now, which is `to` minus anything already committed. */
  readonly cost: number;
  readonly foldProbability: number;
  readonly equity: number;
}): number {
  return evOfRaise({
    pot: input.pot,
    toCall: input.toCall,
    raiseBy: input.cost - input.toCall,
    foldProbability: input.foldProbability,
    equityWhenCalled: input.equity,
  }).ev;
}

/**
 * How often they must fold for a raise to break even, as a percentage.
 *
 * Solved from the same line the EV is: `f x pot + (1 - f) x S = 0` where `S` is the called branch,
 * so `f* = -S / (pot - S)`. Quoted in the copy, so it is derived rather than estimated.
 */
function breakEvenFoldPercent(input: {
  readonly pot: number;
  readonly toCall: number;
  /** Chips the raise moves now, as on the candidate. See `raiseEv` for why this is not `to`. */
  readonly cost: number;
  readonly equity: number;
}): number {
  const raiseBy = input.cost - input.toCall;
  const called = input.equity * (input.pot + input.toCall + 2 * raiseBy) - (input.toCall + raiseBy);
  if (called >= 0) return 0;
  return (-called / (input.pot - called)) * 100;
}

// ---------------------------------------------------------------------------
// The hand comparison
// ---------------------------------------------------------------------------

const BIG_BLIND = 20;

// --- Preflop -----------------------------------------------------------------

const PREFLOP_POT = 30;
const PREFLOP_TO_CALL = 10;
const PREFLOP_EQUITY = 0.6485;
const PREFLOP_CALL_EV = callEv(PREFLOP_POT, PREFLOP_TO_CALL, PREFLOP_EQUITY);
const PREFLOP_RAISE_60_FOLD = 0.42;
const PREFLOP_RAISE_60_EV = raiseEv({
  pot: PREFLOP_POT,
  toCall: PREFLOP_TO_CALL,
  // Raise TO 60 from a 10-chip small blind: 50 leaves the stack, of which 10 is the call.
  cost: 50,
  foldProbability: PREFLOP_RAISE_60_FOLD,
  equity: PREFLOP_EQUITY,
});
const PREFLOP_RAISE_100_FOLD = 0.52;
const PREFLOP_RAISE_100_EV = raiseEv({
  pot: PREFLOP_POT,
  toCall: PREFLOP_TO_CALL,
  cost: 90,
  foldProbability: PREFLOP_RAISE_100_FOLD,
  equity: PREFLOP_EQUITY,
});
/** The gap between the two raise sizes, which the suggestion below quotes in big blinds. */
const PREFLOP_RAISE_GAP = Math.abs(PREFLOP_RAISE_100_EV - PREFLOP_RAISE_60_EV);

/** Preflop: the learner opens for 60 out of a 400-unit stack. */
const PREFLOP_ANALYSIS: CoachReport = {
  street: 'preflop',
  potTotal: 30,
  toCall: 10,
  outs: null,
  equity: {
    heroEquity: 0.6485,
    method: 'monte-carlo',
    trials: 8_000,
    confidenceHalfWidthPoints: 1,
    ruleOfThumb: null,
    perPlayer: [
      { label: 'You, ace-king suited', equity: 0.6485, win: 0.6355, tie: 0.026 },
      { label: 'Opponent, assumed top 35% of hands', equity: 0.3515, win: 0.3385, tie: 0.026 },
    ],
  },
  potOdds: potOdds({
    pot: 30,
    toCall: 10,
    heroEquity: 0.6485,
    explanation:
      'Completing the small blind costs 10 units into a pot of 30, so a call needs 25% equity to break ' +
      'even on price alone. That is the floor, not the target: the raise below is priced separately.',
  }),
  candidates: [
    FOLD_CANDIDATE,
    {
      action: 'call',
      cost: 10,
      ev: PREFLOP_CALL_EV,
      derivation:
        `Completing costs 10 into a pot of ${PREFLOP_POT}, so the pot at showdown is 40 and 64.9% of it is ` +
        `${units(PREFLOP_EQUITY * (PREFLOP_POT + PREFLOP_TO_CALL))} units returned against 10 put in: ` +
        `${signedUnits(PREFLOP_CALL_EV)} units against folding at zero. It leaves the opponent to act with ` +
        'the initiative, which this one-action model does not price.',
      potShareIfCalled: PREFLOP_EQUITY,
    },
    {
      action: 'raise',
      to: 60,
      cost: 50,
      ev: PREFLOP_RAISE_60_EV,
      derivation:
        `Raising to 60 risks 50 — the 10 owed plus 40 on top — to win the ${PREFLOP_POT} in the middle. It ` +
        'takes that 30 outright 42% of the time, and the other 58% it takes 64.9% of a 120-unit pot for the ' +
        `50 it put in: ${signedUnits(PREFLOP_RAISE_60_EV)} units.`,
      foldEquityAssumed: PREFLOP_RAISE_60_FOLD,
      potShareIfCalled: PREFLOP_EQUITY,
    },
    {
      action: 'raise',
      to: 100,
      cost: 90,
      ev: PREFLOP_RAISE_100_EV,
      derivation:
        'Raising to 100 risks 90 and folds out more (52% assumed). The bigger fold share is worth less than ' +
        'the bigger called pot: at 64.9% equity every extra chip that goes in goes in good, so the larger ' +
        `size prices ahead at ${signedUnits(PREFLOP_RAISE_100_EV)} units.`,
      foldEquityAssumed: PREFLOP_RAISE_100_FOLD,
      potShareIfCalled: PREFLOP_EQUITY,
    },
  ],
  suggestion: {
    action: 'raise',
    // Both priced sizes, because they are inside a big blind of each other and the table cannot
    // separate them. A `min` that excluded the higher-valued row would be a range that disagrees
    // with the numbers underneath it.
    sizeRange: { min: 60, max: 100 },
    confidence: 'moderate',
    reason:
      'Ace-king suited is ahead of the assumed calling range and plays well with the initiative, so taking ' +
      `the lead is priced well ahead of limping — ${units(PREFLOP_RAISE_60_EV)} or ` +
      `${units(PREFLOP_RAISE_100_EV)} against ${units(PREFLOP_CALL_EV)}. The larger size is the better of ` +
      `the two, by ${units(PREFLOP_RAISE_GAP)} units, which is under a big blind at these stakes — so this ` +
      'is a range rather than a number.',
    whatWouldChangeIt: [
      'The ordering here is driven by equity, not by the fold assumption: above 50% share, more chips in the middle is worth more than more folds, so the model prefers the larger size. That is a property of a one-action model.',
      'A model that priced later streets would push back towards the smaller size, because a bigger pot out of position is harder to play, and none of that is in these figures.',
      'An opponent who re-raises very often makes the smaller size better, because it costs less to fold — also not modelled here.',
    ],
  },
  stackContext: {
    effectiveStack: 400,
    spr: 400 / 30,
    potOddsOfferedByPotSizedBet: POT_ODDS_OF_POT_SIZED_BET,
    explanation:
      'Twenty big blinds each. The stack-to-pot ratio is high before the flop and collapses the moment ' +
      'anyone bets twice, so the commitment decision is likely to arrive on the flop or the turn.',
  },
  assumptions: [
    'The opponent defends the top 35% of hands against a small-blind raise. A tighter or looser assumption moves every figure here.',
    'Fold frequencies are assumed from the profile card, not measured from this session.',
    'No further betting is modelled beyond the action being priced.',
  ],
  uncertainty: {
    method: 'monte-carlo',
    summary:
      'Equity is sampled over 8,000 random run-outs against the assumed range, so it carries a sampling ' +
      'interval rather than being exact.',
    confidenceInterval: { level: 0.95, halfWidthPoints: 1 },
    limitations: [
      'The opponent is modelled as a range of hands, not as the specific two cards they hold.',
      'The expected values assume the hand ends after the action being priced, which no real hand does.',
    ],
  },
  teachingNotes: [
    'Equity and price are two different questions. 25% is what a call needs; 64.9% is what the hand has.',
    `Raising is priced above limping because a raise buys two things a call does not: the ${PREFLOP_POT} in the middle when they fold, and a bigger pot to take 64.9% of when they do not.`,
    'A raise is not a bet with a different name. It risks the call as well as the increment — 50 here, not 40 — and an EV that charges only the increment flatters every raise it prices.',
  ],
};

// --- Flop --------------------------------------------------------------------

const FLOP_POT = 120;
const FLOP_EQUITY = 0.782;
const FLOP_CHECK_EV = callEv(FLOP_POT, 0, FLOP_EQUITY);
const FLOP_BET_60_FOLD = 0.22;
const FLOP_BET_60_EV = betEv(FLOP_POT, 60, FLOP_BET_60_FOLD, FLOP_EQUITY);
const FLOP_BET_90_FOLD = 0.28;
const FLOP_BET_90_EV = betEv(FLOP_POT, 90, FLOP_BET_90_FOLD, FLOP_EQUITY);
const FLOP_BET_135_FOLD = 0.34;
const FLOP_BET_135_EV = betEv(FLOP_POT, 135, FLOP_BET_135_FOLD, FLOP_EQUITY);
/** Largest minus smallest, which is the spread the teaching note is about. */
const FLOP_SIZE_SPREAD = FLOP_BET_135_EV - FLOP_BET_60_EV;

/** Flop: top pair, top kicker, and the learner bets three quarters of the pot. */
const FLOP_ANALYSIS: CoachReport = {
  street: 'flop',
  potTotal: 120,
  toCall: 0,
  outs: null,
  equity: {
    heroEquity: 0.782,
    method: 'monte-carlo',
    trials: 12_000,
    confidenceHalfWidthPoints: 0.9,
    ruleOfThumb: null,
    perPlayer: [
      { label: 'You, top pair with the best kicker', equity: 0.782, win: 0.775, tie: 0.014 },
      { label: 'Opponent, assumed flop-continuing range', equity: 0.218, win: 0.211, tie: 0.014 },
    ],
  },
  potOdds: potOdds({
    pot: 120,
    toCall: 0,
    heroEquity: 0.782,
    explanation:
      'There is nothing to call, so there is no break-even equity to clear. The question is what a bet is ' +
      'worth, which is the expected-value table rather than the price.',
  }),
  candidates: [
    {
      action: 'check',
      cost: 0,
      ev: FLOP_CHECK_EV,
      derivation:
        `Checking takes a free showdown: 78.2% of the ${FLOP_POT} already in the middle, with nothing further ` +
        `at risk, so ${signedUnits(FLOP_CHECK_EV)} units. The equity figure is measured over the whole run-out, ` +
        'so the times a free card beats this hand are already inside it rather than a deduction on top.',
    },
    {
      action: 'bet',
      to: 60,
      cost: 60,
      ev: FLOP_BET_60_EV,
      derivation:
        `A half-pot bet takes the ${FLOP_POT} outright 22% of the time, and the other 78% takes 78.2% of a ` +
        `240-unit pot for the 60 put in: ${signedUnits(FLOP_BET_60_EV)} units.`,
      foldEquityAssumed: FLOP_BET_60_FOLD,
      potShareIfCalled: FLOP_EQUITY,
    },
    {
      action: 'bet',
      to: 90,
      cost: 90,
      ev: FLOP_BET_90_EV,
      derivation:
        'Three quarters of the pot folds out 28% and charges the draws more when called, returning 78.2% of ' +
        `a 300-unit pot for the 90 put in: ${signedUnits(FLOP_BET_90_EV)} units.`,
      foldEquityAssumed: FLOP_BET_90_FOLD,
      potShareIfCalled: FLOP_EQUITY,
    },
    {
      action: 'bet',
      to: 135,
      cost: 135,
      ev: FLOP_BET_135_EV,
      derivation:
        'A larger bet charges the flush draw more still and folds out 34%. Losing those calls costs less ' +
        'than the bigger pot gains at 78.2% equity, so it is the best-priced size here at ' +
        `${signedUnits(FLOP_BET_135_EV)} units.`,
      foldEquityAssumed: FLOP_BET_135_FOLD,
      potShareIfCalled: FLOP_EQUITY,
    },
  ],
  suggestion: {
    action: 'bet',
    sizeRange: { min: 90, max: 135 },
    confidence: 'reasonable',
    reason:
      'Two hearts on the board mean the opponent has draws that are worth charging, and top pair with the ' +
      'best kicker is ahead of the range that continues. The size is not a detail here: the largest of the ' +
      `three prices ${units(FLOP_SIZE_SPREAD)} units above the smallest, which is more than a big blind, ` +
      'and the ordering runs the same way throughout — bigger is better while the hand holds this much of ' +
      'the pot.',
    whatWouldChangeIt: [
      'A board with no draw on it makes checking closer, because there is less to charge.',
      'This model prices one action and then assumes a showdown. It has no way to charge a bigger bet for the harder turn and river it creates, which is the main reason a real strategy stops short of the largest size the table likes.',
      'An opponent who folds far more makes the smaller size better: value comes from being called, and this table assumes a fold frequency rather than measuring one.',
    ],
  },
  stackContext: {
    effectiveStack: 340,
    spr: 340 / 120,
    potOddsOfferedByPotSizedBet: POT_ODDS_OF_POT_SIZED_BET,
    explanation:
      'A stack-to-pot ratio of 2.8 means one bet and one raise puts the stacks in, so this street decides ' +
      'whether the hand becomes an all-in.',
  },
  assumptions: [
    'The opponent continues on this flop with pairs, gutshots and both flush draws, and folds the rest.',
    'Fold frequencies come from the profile card rather than from this session.',
    'The expected values assume no further betting after the action being priced.',
  ],
  uncertainty: {
    method: 'monte-carlo',
    summary:
      'Equity is sampled over 12,000 run-outs against the assumed continuing range, so the figure carries ' +
      'a sampling interval.',
    confidenceInterval: { level: 0.95, halfWidthPoints: 0.9 },
    limitations: [
      'The three bet sizes priced here are representative, not exhaustive.',
      'Fold equity is the least reliable input in this table: it is an assumption about behaviour, not a measurement.',
    ],
  },
  teachingNotes: [
    `The three sizes are not interchangeable: ${units(FLOP_BET_60_EV)}, ${units(FLOP_BET_90_EV)} and ${units(FLOP_BET_135_EV)} units, a spread of ${units(FLOP_SIZE_SPREAD)} — more than a big blind between the ends, though each size and its neighbour are inside one.`,
    'Two hearts on the board is why a bet beats a check here: a check takes 78.2% of a 120-unit pot and nothing more, while a bet buys the folds as well as a bigger pot to hold 78.2% of.',
    'Every row above assumes the hand ends after this action. That is what makes the largest size look best, and it is the assumption to argue with rather than the number.',
  ],
};

// --- Turn --------------------------------------------------------------------

const TURN_POT = 550;
const TURN_TO_CALL = 250;
const TURN_EQUITY = 0.325;
/**
 * The one figure in this file that was already right.
 *
 * `0.325 x 800 - 250 = +10.0`, which is what the old literal said. Calls were correct throughout;
 * the arithmetic that did not reproduce was the raises and the bets. It is computed here anyway,
 * because a figure that happens to be right and a figure that is derived are different things the
 * next time somebody edits the equity above it.
 */
const TURN_CALL_EV = callEv(TURN_POT, TURN_TO_CALL, TURN_EQUITY);

/** Turn: the learner faces an all-in for their last 250 units. */
const TURN_ANALYSIS: CoachReport = {
  street: 'turn',
  potTotal: 550,
  toCall: 250,
  outs: {
    clean: 2,
    dirty: 3,
    total: 5,
    cleanCards: ['Ks', 'Kc'],
    dirtyCards: ['As', 'Ad', 'Ac'],
    explanation:
      'The two remaining kings make three of a kind, which beats everything in the assumed range. The three ' +
      'remaining aces make two pair, which improves the hand and still loses to a set — that is what "dirty" ' +
      'means here, and it is why they are counted separately rather than added in.',
  },
  equity: {
    heroEquity: 0.325,
    method: 'monte-carlo',
    trials: 12_000,
    confidenceHalfWidthPoints: 1.1,
    ruleOfThumb: {
      estimate: 0.1,
      errorPoints: -22.5,
      note:
        'Five outs with one card to come gives 10% on the rule of 2. The sampled figure is 32.5% because the ' +
        'rule only counts the times the hand improves and ignores the times top pair is already ahead. This is ' +
        'the situation where the shortcut is most misleading.',
    },
    perPlayer: [
      { label: 'You, top pair with the best kicker', equity: 0.325, win: 0.318, tie: 0.014 },
      { label: 'Opponent, assumed all-in range', equity: 0.675, win: 0.668, tie: 0.014 },
    ],
  },
  potOdds: potOdds({
    pot: 550,
    toCall: 250,
    heroEquity: 0.325,
    explanation:
      'Calling 250 into a pot of 550 needs 31.3% to break even: 250 divided by the 800-unit pot the call ' +
      'creates. The sampled equity is 32.5%, so the call clears the price by 1.3 points — which is inside the ' +
      'sampling interval, and the note below says so.',
  }),
  candidates: [
    FOLD_CANDIDATE,
    {
      action: 'call',
      cost: 250,
      ev: TURN_CALL_EV,
      derivation:
        `32.5% of the 800-unit pot the call creates is ${units(TURN_EQUITY * (TURN_POT + TURN_TO_CALL))} units ` +
        `returned on average, against 250 units to call, so ${signedUnits(TURN_CALL_EV)} units measured ` +
        'against folding at zero.',
      potShareIfCalled: TURN_EQUITY,
    },
  ],
  suggestion: {
    action: 'call',
    confidence: 'low',
    reason:
      'The call clears its price by 1.3 points and the sampling interval on the equity figure is 1.1 points ' +
      'wide, so the margin is roughly the size of the measurement. This is a suggestion at low confidence, ' +
      'not a conclusion: a slightly tighter assumed all-in range would flip it.',
    whatWouldChangeIt: [
      'A tighter assumed all-in range lowers the equity figure below the 31.3% the price needs.',
      'A wider one raises it, and the call becomes comfortable rather than marginal.',
      'Nothing about the card that arrives afterwards changes this figure. It is computed before the run-out.',
    ],
  },
  stackContext: {
    effectiveStack: 250,
    spr: 250 / 550,
    potOddsOfferedByPotSizedBet: POT_ODDS_OF_POT_SIZED_BET,
    explanation:
      'A stack-to-pot ratio below 1 means the pot is already larger than the stack behind it, so this is a ' +
      'decision about the whole stack whichever way it goes.',
  },
  assumptions: [
    'The opponent shoves the turn with sets, two pair, and the flush draws that picked up equity — the range its profile card describes.',
    'The equity figure is against that whole range, not against any particular holding.',
    'There is no further betting to model: this call closes the action.',
  ],
  uncertainty: {
    method: 'monte-carlo',
    summary:
      'Sampled over 12,000 run-outs. The interval is 1.1 points wide and the decision turns on 1.3 points, so ' +
      'the figure and the margin are almost the same size.',
    confidenceInterval: { level: 0.95, halfWidthPoints: 1.1 },
    limitations: [
      'A margin inside the sampling interval is not a margin you can rely on.',
      'The assumed shoving range is the largest source of error here, and it is an assumption rather than an observation.',
    ],
  },
  teachingNotes: [
    'A call that clears its price by less than the interval on the equity figure is a coin-flip dressed as arithmetic. Both figures are shown so that is visible.',
    'The rule of 2 says 10% here and the sample says 32.5%. The shortcut only counts improvement; it never counts already being ahead.',
  ],
};

// ---------------------------------------------------------------------------
// The decisions, and the quality bands they land in
// ---------------------------------------------------------------------------

/**
 * `QUALITY_BANDS_IN_BIG_BLINDS` from `@prl/poker-ai/comparison`, applied here.
 *
 * The bands are half a big blind and two big blinds of shortfall. They are copied rather than
 * imported because `@prl/poker-ai` is not a dependency of `apps/web` and must not become one — it
 * reaches the policy code, and nothing that decides an opponent's action belongs in a browser
 * bundle. `apps/api/test/legend-fixture-figures.test.ts` asserts every band below is the one
 * `bandForShortfall` returns for the same shortfall, so the copy cannot drift silently.
 */
function bandFor(shortfallUnits: number): DecisionQuality['band'] {
  const bigBlinds = Math.max(0, shortfallUnits) / BIG_BLIND;
  if (bigBlinds <= 0.5 + 1e-9) return 'consistent-with-analysis';
  if (bigBlinds <= 2 + 1e-9) return 'slightly-off';
  return 'materially-off';
}

/** How far behind the best-priced row an action came out, and what that reads as. */
function qualityOf(input: {
  readonly chosenEv: number;
  readonly bestEv: number;
  readonly note: (shortfall: number, bigBlinds: string) => string;
}): DecisionQuality {
  const evGivenUp = input.chosenEv - input.bestEv;
  const shortfall = Math.max(0, -evGivenUp);
  return {
    bestAvailableEv: input.bestEv,
    chosenEv: input.chosenEv,
    evGivenUp,
    band: bandFor(shortfall),
    note: input.note(shortfall, (shortfall / BIG_BLIND).toFixed(2)),
  };
}

/** Total shortfall across the three scored decisions, which is what the hand-level band uses. */
const HAND_SHORTFALL =
  Math.max(0, PREFLOP_RAISE_100_EV - PREFLOP_RAISE_60_EV) + Math.max(0, FLOP_BET_135_EV - FLOP_BET_90_EV) + 0;

const DECISIONS: readonly ComparedDecision[] = [
  {
    sequence: 1,
    street: 'preflop',
    potBefore: 30,
    toCall: 10,
    userAction: { action: 'raise', to: 60 },
    modelAction: null,
    modelReasoning: null,
    analysis: PREFLOP_ANALYSIS,
    alternatives: [
      {
        action: 'fold',
        to: null,
        ev: 0,
        note:
          `Folding: 0.0 units. ${units(PREFLOP_RAISE_60_EV)} units behind the action taken, on the same ` +
          'assumptions. Folding is the zero point every other figure here is measured against.',
      },
      {
        action: 'call',
        to: null,
        ev: PREFLOP_CALL_EV,
        note:
          `Calling: ${signedUnits(PREFLOP_CALL_EV)} units. ${units(PREFLOP_RAISE_60_EV - PREFLOP_CALL_EV)} ` +
          'units behind the action taken, on the same assumptions.',
      },
      {
        action: 'raise',
        to: 100,
        ev: PREFLOP_RAISE_100_EV,
        note:
          `Raising to 100: ${signedUnits(PREFLOP_RAISE_100_EV)} units. ${units(PREFLOP_RAISE_GAP)} units ` +
          'AHEAD of the action taken, on the same assumptions.',
      },
    ],
    userDecisionQuality: qualityOf({
      chosenEv: PREFLOP_RAISE_60_EV,
      bestEv: PREFLOP_RAISE_100_EV,
      note: (shortfall, bigBlinds) =>
        `Raising to 60 was priced ${units(shortfall)} units behind raising to 100, the best of the actions the ` +
        `analysis priced — ${bigBlinds} big blinds, on the range and fold-equity assumptions stated in that ` +
        "report. That is inside the 0.5 big blinds this band allows, which is the analysis's own resolution — " +
        'the two are not distinguishable here.',
    }),
    commentary:
      'Preflop, pot 30, 10 to call, 25.0% needed on price alone: you raised to 60. The review analysis put its ' +
      `highest expected value on raise to 100 at ${signedUnits(PREFLOP_RAISE_100_EV)} against folding at zero, ` +
      `with raise to 60 at ${signedUnits(PREFLOP_RAISE_60_EV)} on the same assumptions, at moderate confidence.`,
  },
  {
    sequence: 2,
    street: 'preflop',
    potBefore: 80,
    toCall: 40,
    userAction: null,
    modelAction: { action: 'call', to: null },
    modelReasoning: {
      modelPreference:
        'Price: this model prefers to call rather than re-raise here. 40 units to call into 80 needs 33.3% to ' +
        'break even, and with re-raises preflop set at 0.56 the weight sits on continuing rather than on ' +
        'contesting the pot from out of position.',
      drivingTraits: [
        { key: 'positionSensitivity', label: 'Position awareness', value: 0.92 },
        { key: 'threeBetTendency', label: 'Re-raises preflop', value: 0.56 },
        { key: 'vpip', label: 'Hands played', value: 0.25 },
      ],
      whatChangedIt: [
        'Position: this model is out of position for the rest of the hand, and at 0.92 on position awareness that is what keeps the re-raise weight low.',
        'Stack depth: at twenty big blinds each, adjusts-to-stack-depth of 0.78 pulls towards a decision now rather than a plan for three streets.',
        'Price: 40 into 80 is 33.3% to break even, which its assumed continuing range clears comfortably.',
        'Mix: this action was sampled from 3 weighted options rather than applied as a rule, and position awareness is the axis that sets how much of that weight sat here — the same spot can come out differently next time.',
      ],
      actionProbabilities: [
        { action: 'call', probability: 0.58 },
        { action: 'raise to 180', probability: 0.24 },
        { action: 'fold', probability: 0.18 },
      ],
    },
    analysis: null,
    alternatives: [],
    userDecisionQuality: null,
    commentary:
      'Preflop, pot 80, 40 to call, 33.3% needed on price alone: this model called. No analysis is computed for ' +
      'a model decision, because computing one would require its cards.',
  },
  {
    sequence: 3,
    street: 'flop',
    potBefore: 120,
    toCall: 0,
    userAction: null,
    modelAction: { action: 'check', to: null },
    modelReasoning: {
      modelPreference:
        'Board: this model prefers to check here. Keeps-betting sits at 0.58 and applies-pressure at 0.66, and ' +
        'out of position on a king-high two-tone board the weight moves to seeing what the opener does.',
      drivingTraits: [
        { key: 'barrelPersistence', label: 'Keeps betting', value: 0.58 },
        { key: 'pressureTendency', label: 'Applies pressure', value: 0.66 },
        { key: 'positionSensitivity', label: 'Position awareness', value: 0.92 },
      ],
      whatChangedIt: [
        'Position: acting first with 0.92 on position awareness is the single largest reason the betting weight is low here.',
        'Stack depth: a stack-to-pot ratio near 2.8 means a bet now is the first half of a commitment decision, and 0.78 on adjusts-to-stack-depth registers that.',
        'Sizing: bet size sits at 0.50 and varies-bet-size at 0.62, so when this model does lead it is usually around two thirds of the pot.',
        'Mix: this action was sampled from 3 weighted options rather than applied as a rule, and keeps betting is the axis that sets how much of that weight sat here — the same spot can come out differently next time.',
      ],
      actionProbabilities: [
        { action: 'check', probability: 0.62 },
        { action: 'bet 60', probability: 0.27 },
        { action: 'bet 90', probability: 0.11 },
      ],
    },
    analysis: null,
    alternatives: [],
    userDecisionQuality: null,
    commentary: 'Flop, pot 120, nothing to call: this model checked.',
  },
  {
    sequence: 4,
    street: 'flop',
    potBefore: 120,
    toCall: 0,
    userAction: { action: 'bet', to: 90 },
    modelAction: null,
    modelReasoning: null,
    analysis: FLOP_ANALYSIS,
    alternatives: [
      {
        action: 'check',
        to: null,
        ev: FLOP_CHECK_EV,
        note:
          `Checking: ${signedUnits(FLOP_CHECK_EV)} units. ${units(FLOP_BET_90_EV - FLOP_CHECK_EV)} units ` +
          'behind the action taken, on the same assumptions.',
      },
      {
        action: 'bet',
        to: 60,
        ev: FLOP_BET_60_EV,
        note:
          `Betting 60: ${signedUnits(FLOP_BET_60_EV)} units. ${units(FLOP_BET_90_EV - FLOP_BET_60_EV)} units ` +
          'behind the action taken, on the same assumptions.',
      },
      {
        action: 'bet',
        to: 135,
        ev: FLOP_BET_135_EV,
        note:
          `Betting 135: ${signedUnits(FLOP_BET_135_EV)} units. ${units(FLOP_BET_135_EV - FLOP_BET_90_EV)} units ` +
          'ahead of the action taken, on the same assumptions.',
      },
    ],
    userDecisionQuality: qualityOf({
      chosenEv: FLOP_BET_90_EV,
      bestEv: FLOP_BET_135_EV,
      note: (shortfall, bigBlinds) =>
        `Betting 90 was priced ${units(shortfall)} units behind betting 135, the best of the actions the ` +
        `analysis priced — ${bigBlinds} big blinds, on the range and fold-equity assumptions stated in that ` +
        'report. That is past the half a big blind this app treats as indistinguishable and well inside the two ' +
        'big blinds beyond it, so it reads as slightly off rather than as a different plan. The gap is entirely ' +
        'the size chosen; the decision to bet was the same one the table makes.',
    }),
    commentary:
      'Flop, pot 120, nothing to call: you bet 90. The review analysis put its highest expected value on bet 135 ' +
      `at ${signedUnits(FLOP_BET_135_EV)} against folding at zero, with bet 90 at ${signedUnits(FLOP_BET_90_EV)} ` +
      'on the same range and fold-equity assumptions, at reasonable confidence.',
  },
  {
    sequence: 5,
    street: 'flop',
    potBefore: 210,
    toCall: 90,
    userAction: null,
    modelAction: { action: 'call', to: null },
    modelReasoning: {
      modelPreference:
        'Price: this model prefers to call. 90 into 210 needs 30.0% to break even, and with folds-under-pressure ' +
        'at 0.62 the weight is split between continuing and giving the hand up, with continuing slightly ahead.',
      drivingTraits: [
        { key: 'foldToPressure', label: 'Folds under pressure', value: 0.62 },
        { key: 'stackDepthAdjustment', label: 'Adjusts to stack depth', value: 0.78 },
        { key: 'riskTolerance', label: 'Risk appetite', value: 0.46 },
      ],
      whatChangedIt: [
        'Price: 90 into 210 is 30.0% to break even. A larger bet would move weight onto folding, because 0.62 on folds-under-pressure is a real fold frequency rather than a token one.',
        'Stack depth: with 250 behind into a 300-unit pot, the next street is all-in or nothing, and 0.78 on adjusts-to-stack-depth prices that in now.',
        'Position: out of position with 0.92 on position awareness, this model discounts hands that need three streets to realise their value.',
        'Mix: this action was sampled from 3 weighted options rather than applied as a rule, and folds under pressure is the axis that sets how much of that weight sat here — the same spot can come out differently next time.',
      ],
      actionProbabilities: [
        { action: 'call', probability: 0.54 },
        { action: 'fold', probability: 0.29 },
        { action: 'raise to 300', probability: 0.17 },
      ],
    },
    analysis: null,
    alternatives: [],
    userDecisionQuality: null,
    commentary: 'Flop, pot 210, 90 to call, 30.0% needed on price alone: this model called.',
  },
  {
    sequence: 6,
    street: 'turn',
    potBefore: 300,
    toCall: 0,
    userAction: null,
    modelAction: { action: 'bet', to: 250 },
    modelReasoning: {
      modelPreference:
        'Commitment: this model prefers to bet its whole remaining 250 here. Adjusts-to-stack-depth is 0.78 and ' +
        'the stack-to-pot ratio has fallen below 1, so the weight collapses onto committing rather than sizing.',
      drivingTraits: [
        { key: 'stackDepthAdjustment', label: 'Adjusts to stack depth', value: 0.78 },
        { key: 'pressureTendency', label: 'Applies pressure', value: 0.66 },
        { key: 'barrelPersistence', label: 'Keeps betting', value: 0.58 },
      ],
      whatChangedIt: [
        'Stack depth: 250 behind into a 300-unit pot. Above about forty big blinds this model would size to keep betting; below one stack-to-pot ratio there is nothing to plan for.',
        'Position: out of position, so betting is how it stops the river being checked back and decided by the last card.',
        'Sizing: with only 250 left there is no size to choose. Bet size of 0.50 and varies-bet-size of 0.62 have nothing to act on once the stack is smaller than the pot.',
        'Mix: this action was sampled from 3 weighted options rather than applied as a rule, and adjusts to stack depth is the axis that sets how much of that weight sat here — the same spot can come out differently next time.',
      ],
      actionProbabilities: [
        { action: 'bet 250', probability: 0.41 },
        { action: 'check', probability: 0.38 },
        { action: 'bet 120', probability: 0.21 },
      ],
    },
    analysis: null,
    alternatives: [],
    userDecisionQuality: null,
    commentary: 'Turn, pot 300, nothing to call: this model bet 250, which is all of its remaining stack.',
  },
  {
    sequence: 7,
    street: 'turn',
    potBefore: 550,
    toCall: 250,
    userAction: { action: 'call', to: null },
    modelAction: null,
    modelReasoning: null,
    analysis: TURN_ANALYSIS,
    alternatives: [
      {
        action: 'fold',
        to: null,
        ev: 0,
        note:
          `Folding: 0.0 units. ${units(TURN_CALL_EV)} units behind the action taken, on the same assumptions. ` +
          'Folding is the zero point every other figure here is measured against.',
      },
    ],
    userDecisionQuality: qualityOf({
      chosenEv: TURN_CALL_EV,
      bestEv: TURN_CALL_EV,
      note: () =>
        'Calling was the best-priced action in the analysis, giving up nothing against the alternatives it ' +
        'considered, on the range and fold-equity assumptions stated in that report. That is inside the 0.5 big ' +
        "blinds this band allows, which is the analysis's own resolution — the two are not distinguishable here.",
    }),
    commentary:
      'Turn, pot 550, 250 to call, 31.3% needed on price alone: you called. The review analysis put its highest ' +
      `expected value on call at ${signedUnits(TURN_CALL_EV)} against folding at zero, at low confidence.`,
  },
];

/**
 * A finished hand: played close to the analysis at every scored decision, and lost in full.
 *
 * ## What this fixture demonstrates changed when its arithmetic was corrected, and that is the point
 *
 * It used to claim the line was the best-priced one at every decision and that the whole hand gave
 * up 0.4 units. Both figures came from EV literals that did not reproduce. Recomputed from the same
 * functions the API uses, the preflop raise gives up 5.9 units to the larger size and the flop bet
 * gives up 15.3 to the larger size — 21.2 units across the hand, 1.06 big blinds, which is
 * `slightly-off` rather than `consistent-with-analysis`.
 *
 * `outcomeVersusQualityNote` therefore has to be null, and that is not a loss of the teaching
 * moment — it is `@prl/poker-ai`'s rule working. That note fires only when the result and the
 * quality point in CLEARLY opposite directions, and it returns null for `slightly-off` precisely so
 * it does not become wallpaper. A hand that was a little off and lost is not a paradox worth a
 * paragraph; the paragraph is reserved for a hand that was right and lost, and this one no longer
 * is. Writing the old note over the new band would be teaching text contradicting the table above
 * it, which is the defect this rewrite exists to remove.
 *
 * What the hand still shows, and shows better: `chipResult` is the learner's entire 400-unit stack,
 * `decisionQuality` is computed from the analysis at each decision with no reference to the
 * run-out, and the two remain structurally unrelated. The per-decision notes now say exactly where
 * the 21.2 units went — both times, into choosing a smaller size than the table prices best.
 */
export const HAND_COMPARISON_FIXTURE: HandComparison = {
  handId: 'hand_9f4c2ab7',
  handNumber: 12,
  board: ['Kd', '7h', '2h', 'Ts', '3d'],
  decisions: DECISIONS,
  chipResult: -400,
  decisionQuality: {
    bestAvailableEv: PREFLOP_RAISE_100_EV + FLOP_BET_135_EV + TURN_CALL_EV,
    chosenEv: PREFLOP_RAISE_60_EV + FLOP_BET_90_EV + TURN_CALL_EV,
    evGivenUp: -HAND_SHORTFALL,
    band: bandFor(HAND_SHORTFALL),
    note:
      `Across 3 scored decisions this hand, the actions taken were ${units(HAND_SHORTFALL)} units behind the ` +
      `best the analysis priced at each point — ${(HAND_SHORTFALL / BIG_BLIND).toFixed(2)} big blinds in total, ` +
      'summed rather than averaged, because a cost paid on three streets is paid three times. All of it is bet ' +
      'sizing: the line — raise, bet, call — is the line the analysis prices best at every one of the three. ' +
      'Every figure here comes from the analysis at each decision and none of it comes from how the hand ended.',
  },
  // Null because the band is `slightly-off`, which is the rule in `@prl/poker-ai`'s
  // `outcomeVersusQualityNote`: the note is reserved for a result and a quality in clear
  // disagreement, and a hand played a big blind off the best available is not that. See the header.
  outcomeVersusQualityNote: null,
  profileId: 'patient-technician',
  disclosure: archetypeDisclosure({
    archetypeName: 'Patient Positional Technician',
    tagline: 'Waits, then applies pressure precisely where position gives it an edge.',
  }),
};

/** The blind level the bands above are scaled by. Exported so a screen can state it. */
export const HAND_COMPARISON_BIG_BLIND = BIG_BLIND;

// ---------------------------------------------------------------------------
// The same spot, played by several styles
// ---------------------------------------------------------------------------

export const COMPARE_SITUATION_FIXTURE: NonNullable<CompareProfilesRequest['situation']> = {
  heroCards: 'AhJh',
  board: 'Kd 7h 2h',
  pot: 210,
  toCall: 180,
  heroStack: 700,
  opponentStack: 700,
  bigBlind: 20,
  street: 'flop',
};

// --- The compare spot --------------------------------------------------------

const COMPARE_POT = 210;
const COMPARE_TO_CALL = 180;
const COMPARE_EQUITY = 0.418;
const COMPARE_CALL_EV = callEv(COMPARE_POT, COMPARE_TO_CALL, COMPARE_EQUITY);
const COMPARE_RAISE_520_FOLD = 0.42;
const COMPARE_RAISE_520_EV = raiseEv({
  pot: COMPARE_POT,
  toCall: COMPARE_TO_CALL,
  // Nothing committed on this street yet, so the whole 520 leaves the stack now.
  cost: 520,
  foldProbability: COMPARE_RAISE_520_FOLD,
  equity: COMPARE_EQUITY,
});
const COMPARE_RAISE_700_FOLD = 0.48;
const COMPARE_RAISE_700_EV = raiseEv({
  pot: COMPARE_POT,
  toCall: COMPARE_TO_CALL,
  cost: 700,
  foldProbability: COMPARE_RAISE_700_FOLD,
  equity: COMPARE_EQUITY,
});
/** The fold frequency at which raising to 520 stops being worth more than folding. */
const COMPARE_RAISE_520_BREAK_EVEN = breakEvenFoldPercent({
  pot: COMPARE_POT,
  toCall: COMPARE_TO_CALL,
  cost: 520,
  equity: COMPARE_EQUITY,
});

/**
 * The maths for that spot, identical for every profile.
 *
 * ## What this spot actually shows, now that its arithmetic reproduces
 *
 * It used to say the table "does not settle the argument": calling at minus 17, folding at zero,
 * raising at plus 6.2. Two of those three were wrong. Corrected, the table is emphatic — raising is
 * priced about forty-six units above folding, at either of the two sizes — and the spot is *more*
 * useful for it, not less, because of what the styles do with it. Three of the four columns below
 * do not take the highest-priced line. That is the lesson this page is for: these are tendencies
 * sampled from a distribution, not solvers, and a style disagreeing with the arithmetic is a fact
 * about the style rather than a mistake in the table.
 *
 * The raise still rests entirely on one assumed number. Below about a 26% fold frequency it stops
 * being worth more than folding, and 42% is an assumption from a profile card rather than anything
 * measured here — which is why its confidence is `low` and why the figure is quoted rather than
 * described.
 */
const COMPARE_ANALYSIS: CoachReport = {
  street: 'flop',
  potTotal: 210,
  toCall: 180,
  outs: {
    clean: 9,
    dirty: 3,
    total: 12,
    cleanCards: ['3h', '4h', '5h', '6h', '8h', '9h', 'Th', 'Qh', 'Kh'],
    dirtyCards: ['As', 'Ad', 'Ac'],
    explanation:
      'Nine hearts complete the best possible flush and win against everything in the assumed range. The three ' +
      'remaining aces make a pair of aces, which is an improvement that still loses to two pair or a set — ' +
      'counted separately for exactly that reason.',
  },
  equity: {
    heroEquity: 0.418,
    method: 'monte-carlo',
    trials: 12_000,
    confidenceHalfWidthPoints: 1,
    ruleOfThumb: {
      estimate: 0.48,
      errorPoints: 6.2,
      note:
        'Twelve outs with two cards to come gives 48% on the rule of 4. The sampled figure is 41.8%, so the ' +
        'shortcut overstates by 6.2 points: the rule assumes both cards will be seen, and facing a bet of this ' +
        'size they often will not be.',
    },
    perPlayer: [
      { label: 'You, the best flush draw with an overcard', equity: 0.418, win: 0.411, tie: 0.014 },
      { label: 'Opponent, assumed betting range', equity: 0.582, win: 0.575, tie: 0.014 },
    ],
  },
  potOdds: potOdds({
    pot: 210,
    toCall: 180,
    heroEquity: 0.418,
    explanation:
      'Calling 180 into 210 needs 46.2% to break even — 180 divided by the 390-unit pot the call creates. The ' +
      'sampled equity is 41.8%, which is 4.4 points short, so a call is priced below folding on these ' +
      'assumptions. That is what makes this spot worth comparing styles on.',
  }),
  candidates: [
    FOLD_CANDIDATE,
    {
      action: 'call',
      cost: 180,
      ev: COMPARE_CALL_EV,
      derivation:
        `41.8% of the 390-unit pot the call creates is ${units(COMPARE_EQUITY * (COMPARE_POT + COMPARE_TO_CALL))} ` +
        `units returned on average, against 180 units to call, so ${signedUnits(COMPARE_CALL_EV)} units against ` +
        'folding at zero. Implied odds are not modelled here.',
      potShareIfCalled: COMPARE_EQUITY,
    },
    {
      action: 'raise',
      to: 520,
      cost: 520,
      ev: COMPARE_RAISE_520_EV,
      derivation:
        `Raising to 520 risks 520 — the 180 owed plus 340 on top — to win the ${COMPARE_POT} in the middle. It ` +
        'takes that 210 outright 42% of the time, and the other 58% it takes 41.8% of a 1,070-unit pot: ' +
        `${signedUnits(COMPARE_RAISE_520_EV)} units. A fold wins the 210 that is there, not the 390 a call ` +
        'would have built — the two are different pots and pricing a raise against the second is the error ' +
        'this row used to make.',
      foldEquityAssumed: COMPARE_RAISE_520_FOLD,
      potShareIfCalled: COMPARE_EQUITY,
    },
    {
      action: 'raise',
      to: 700,
      cost: 700,
      ev: COMPARE_RAISE_700_EV,
      derivation:
        'Moving in for 700 risks the whole stack and folds out more (48% assumed). Both effects are larger and ' +
        `they almost cancel: ${signedUnits(COMPARE_RAISE_700_EV)} units, ` +
        `${units(Math.abs(COMPARE_RAISE_700_EV - COMPARE_RAISE_520_EV))} apart from the smaller raise, which ` +
        'is far inside a big blind. The table cannot separate these two sizes.',
      foldEquityAssumed: COMPARE_RAISE_700_FOLD,
      potShareIfCalled: COMPARE_EQUITY,
    },
  ],
  suggestion: {
    action: 'raise',
    // Both priced sizes. They are 1.6 units apart at a big blind of 20, so a narrower range would
    // claim a distinction the arithmetic does not support.
    sizeRange: { min: 520, max: 700 },
    confidence: 'low',
    reason:
      `Calling is priced ${units(Math.abs(COMPARE_CALL_EV))} units below folding, so the draw does not justify ` +
      `the price on its own. Raising is priced about ${units(COMPARE_RAISE_520_EV)} units above folding — but ` +
      'only because the opponent is assumed to fold 42% of the time, and that number came off a profile card ' +
      'rather than out of this session. Low confidence is about the assumption, not about the arithmetic.',
    whatWouldChangeIt: [
      `A fold frequency below about ${units(COMPARE_RAISE_520_BREAK_EVEN)}% makes folding the best-priced action instead. Everything above that is the raise's whole case.`,
      'Deeper stacks give the draw implied odds that this table does not model, which moves value towards calling.',
      'An opponent who re-raises rather than folding removes the entire basis for the raise, and no row here charges for that.',
    ],
  },
  stackContext: {
    effectiveStack: 700,
    spr: 700 / 210,
    potOddsOfferedByPotSizedBet: POT_ODDS_OF_POT_SIZED_BET,
    explanation:
      'A stack-to-pot ratio of 3.3 leaves room for one more decision after this street, which is exactly why ' +
      'the raise has anything to work with.',
  },
  assumptions: [
    'The opponent bets 180 into 210 with sets, two pair, top pair and roughly a third of their missed hands.',
    'The 42% fold frequency assumed for the raise comes from the profile card, not from this session.',
    'Implied odds are not modelled: the expected values assume the hand ends after the action being priced.',
  ],
  uncertainty: {
    method: 'monte-carlo',
    summary:
      'Equity is sampled over 12,000 run-outs against the assumed betting range, with a 1.0-point interval. The ' +
      'fold-equity assumption is not sampled at all — it is an assumption, and it moves the raise more than the ' +
      'sampling error moves anything.',
    confidenceInterval: { level: 0.95, halfWidthPoints: 1 },
    limitations: [
      'Fold equity is assumed rather than measured, and the raise is priced almost entirely on it.',
      'Implied odds from a completed flush on a later street are not in these figures.',
      'The two raise sizes priced here are representative, not exhaustive.',
    ],
  },
  teachingNotes: [
    'A draw with twelve outs is not automatically a call. 46.2% is what this price needs and 41.8% is what the hand has.',
    'The rule of 4 says 48% here. It assumes both cards get dealt, and a bet this size is what stops that being true.',
    `Where a decision rests on a single assumption, the assumption is the decision. Here it is the 42% fold frequency, and the raise stops being worth more than folding below about ${units(COMPARE_RAISE_520_BREAK_EVEN)}%.`,
    'The same draw is priced below folding as a call and well above it as a raise. Nothing about the cards changed between those two rows — only who is choosing whether the hand goes to showdown.',
  ],
};

function comparisonEntry(input: {
  readonly profileId: string;
  readonly modalAction: string;
  readonly distribution: ProfileComparisonEntry['actionDistribution'];
  readonly reasoning: ProfileComparisonEntry['reasoning'];
}): ProfileComparisonEntry {
  const profile = profileFixtureById(input.profileId);
  if (profile === null) {
    // A comparison entry for a profile this fixture does not define would render a column with
    // no name and no disclaimers. Failing at module load is the only safe answer.
    throw new Error(`compare fixture references unknown profile "${input.profileId}"`);
  }
  return {
    profileId: profile.id,
    disclosure: profile.disclosure,
    actionDistribution: input.distribution,
    modalAction: input.modalAction,
    reasoning: input.reasoning,
  };
}

/**
 * Trials per profile in this fixture — `MAX_COMPARE_TRIALS`, which is what the endpoint will run.
 *
 * It said 400, which the endpoint's own schema rejects: `trials` is capped at 40. Every weight
 * below was therefore a proportion of a sample size the server cannot produce, in a fixture whose
 * job is to look like the server's answer. They are now written as whole counts over 40 — `18 / 40`
 * rather than `0.46` — because a frequency measured over forty trials is a multiple of 1/40, and a
 * fixture that prints 0.46 is claiming a resolution the sample does not have.
 *
 * Forty is a coarse sample and the compare page prints what that costs: the widest 95% interval on
 * a proportion over forty trials is about 15 points, which is wider than most of the gaps between
 * two columns here. That is the honest reading of this table and the page says so.
 */
const COMPARE_TRIALS = MAX_COMPARE_TRIALS;

export const COMPARE_FIXTURE: CompareProfilesResponse = {
  analysis: COMPARE_ANALYSIS,
  trials: COMPARE_TRIALS,
  entries: [
    comparisonEntry({
      profileId: 'reading-pressure-specialist',
      modalAction: 'raise to 520',
      distribution: [
        { action: 'raise to 520', probability: 18 / COMPARE_TRIALS, medianSizeToPotFraction: 1.33 },
        { action: 'call', probability: 12 / COMPARE_TRIALS, medianSizeToPotFraction: null },
        { action: 'fold', probability: 10 / COMPARE_TRIALS, medianSizeToPotFraction: null },
      ],
      reasoning: {
        modelPreference:
          'Pressure: this model prefers to raise here. Applies-pressure sits at 0.84 and keeps-betting at 0.82, ' +
          'so a draw with a card to come is played as a reason to bet rather than a reason to call.',
        drivingTraits: [
          { key: 'pressureTendency', label: 'Applies pressure', value: 0.84 },
          { key: 'barrelPersistence', label: 'Keeps betting', value: 0.82 },
          { key: 'bluffFrequency', label: 'Bluffing', value: 0.46 },
        ],
        whatChangedIt: [
          'Price: 180 into 210 is 46.2% to break even, and this model reads that as a reason to take the lead rather than to pay it.',
          'Stack depth: with 700 behind, a raise to 520 leaves a threat for the river. At a shorter stack this becomes an all-in or a fold.',
          'Sizing: bet size of 0.62 and varies-bet-size of 0.66 put the raise a little over the pot rather than at a minimum.',
          'Mix: this action was sampled from 3 weighted options rather than applied as a rule, and applies pressure is the axis that sets how much of that weight sat here — the same spot can come out differently next time.',
        ],
        actionProbabilities: [
          { action: 'raise to 520', probability: 18 / COMPARE_TRIALS },
          { action: 'call', probability: 12 / COMPARE_TRIALS },
          { action: 'fold', probability: 10 / COMPARE_TRIALS },
        ],
      },
    }),
    comparisonEntry({
      profileId: 'patient-technician',
      modalAction: 'fold',
      distribution: [
        { action: 'fold', probability: 18 / COMPARE_TRIALS, medianSizeToPotFraction: null },
        { action: 'call', probability: 13 / COMPARE_TRIALS, medianSizeToPotFraction: null },
        { action: 'raise to 520', probability: 9 / COMPARE_TRIALS, medianSizeToPotFraction: 1.2 },
      ],
      reasoning: {
        modelPreference:
          'Price: this model prefers to fold, narrowly. Folds-under-pressure sits at 0.62 and risk appetite at ' +
          '0.46, and a draw that is 4.4 points short of its price out of position is where those two agree.',
        drivingTraits: [
          { key: 'foldToPressure', label: 'Folds under pressure', value: 0.62 },
          { key: 'riskTolerance', label: 'Risk appetite', value: 0.46 },
          { key: 'positionSensitivity', label: 'Position awareness', value: 0.92 },
        ],
        whatChangedIt: [
          'Position: in position this becomes a call more often than a fold. At 0.92 on position awareness, that one fact moves more weight than the price does.',
          'Price: a smaller bet clears its threshold and the fold weight collapses. This model is not folding the draw, it is folding this price.',
          'Stack depth: deeper stacks give the draw implied odds, and 0.78 on adjusts-to-stack-depth moves weight towards continuing when they exist.',
          'Mix: this action was sampled from 3 weighted options rather than applied as a rule, and folds under pressure is the axis that sets how much of that weight sat here — the same spot can come out differently next time.',
        ],
        actionProbabilities: [
          { action: 'fold', probability: 18 / COMPARE_TRIALS },
          { action: 'call', probability: 13 / COMPARE_TRIALS },
          { action: 'raise to 520', probability: 9 / COMPARE_TRIALS },
        ],
      },
    }),
    comparisonEntry({
      profileId: 'disciplined-specialist',
      modalAction: 'fold',
      distribution: [
        { action: 'fold', probability: 28 / COMPARE_TRIALS, medianSizeToPotFraction: null },
        { action: 'call', probability: 9 / COMPARE_TRIALS, medianSizeToPotFraction: null },
        { action: 'raise to 520', probability: 3 / COMPARE_TRIALS, medianSizeToPotFraction: 1.2 },
      ],
      reasoning: {
        modelPreference:
          'Selectivity: this model prefers to fold. Risk appetite of 0.20 is the lowest in this set and ' +
          'folds-under-pressure is 0.76, so a draw priced below its break-even point is released rather than ' +
          'defended.',
        drivingTraits: [
          { key: 'riskTolerance', label: 'Risk appetite', value: 0.2 },
          { key: 'foldToPressure', label: 'Folds under pressure', value: 0.76 },
          { key: 'valueBluffBalance', label: 'Value-heavy vs bluff-heavy', value: 0.84 },
        ],
        whatChangedIt: [
          'Price: this model needs the price to clear on its own. Implied odds are discounted heavily at 0.20 risk appetite.',
          'Position: out of position it folds more still. The 8% raise weight is almost entirely the in-position version of this spot.',
          'Value balance: at 0.84 value-heavy, raising as a semi-bluff is the line this model uses least.',
          'Mix: this action was sampled from 3 weighted options rather than applied as a rule, and risk appetite is the axis that sets how much of that weight sat here — the same spot can come out differently next time.',
        ],
        actionProbabilities: [
          { action: 'fold', probability: 28 / COMPARE_TRIALS },
          { action: 'call', probability: 9 / COMPARE_TRIALS },
          { action: 'raise to 520', probability: 3 / COMPARE_TRIALS },
        ],
      },
    }),
    comparisonEntry({
      profileId: 'calling-station',
      modalAction: 'call',
      distribution: [
        { action: 'call', probability: 35 / COMPARE_TRIALS, medianSizeToPotFraction: null },
        { action: 'fold', probability: 4 / COMPARE_TRIALS, medianSizeToPotFraction: null },
        { action: 'raise to 520', probability: 1 / COMPARE_TRIALS, medianSizeToPotFraction: 1.2 },
      ],
      reasoning: {
        modelPreference:
          'Passivity: this model prefers to call almost regardless of the price. Folds-under-pressure sits at ' +
          '0.14 and aggression at 0.16, so a draw is called with and the raise weight is close to nothing.',
        drivingTraits: [
          { key: 'foldToPressure', label: 'Folds under pressure', value: 0.14 },
          { key: 'aggressionFrequency', label: 'Aggression', value: 0.16 },
          { key: 'vpip', label: 'Hands played', value: 0.52 },
        ],
        whatChangedIt: [
          'Price: almost nothing. That is the point of this profile — the call weight barely moves as the price gets worse, which is what makes it beatable.',
          'Position: nothing. At 0.12 on position awareness this model plays the same spot the same way from either seat.',
          'Stack depth: nothing much. At 0.15 on adjusts-to-stack-depth it plays a short stack like a deep one.',
          'Mix: this action was sampled from 3 weighted options rather than applied as a rule, and folds under pressure is the axis that sets how much of that weight sat here — the same spot can come out differently next time.',
        ],
        actionProbabilities: [
          { action: 'call', probability: 35 / COMPARE_TRIALS },
          { action: 'fold', probability: 4 / COMPARE_TRIALS },
          { action: 'raise to 520', probability: 1 / COMPARE_TRIALS },
        ],
      },
    }),
  ],
  takeaway:
    'Four styles, one spot, and no agreement — including with the table above them. The analysis prices raising ' +
    `about ${units(COMPARE_RAISE_520_EV)} units above folding and calling ${units(Math.abs(COMPARE_CALL_EV))} ` +
    'units below it, and three of these four styles still take a different line: the disciplined model folds 28 ' +
    'times in 40, the passive model calls 35 times in 40, and only the pressure model raises more often than ' +
    'not. That is the lesson, and it is sharper than a disagreement about a close spot would be. These are ' +
    'tendencies sampled from a distribution, not solvers — a style is a set of habits with costs, and here the ' +
    'cost is visible. The other half of it is the assumption: the raise is worth what it is worth because the ' +
    `opponent is assumed to fold 42% of the time, and below about ${units(COMPARE_RAISE_520_BREAK_EVEN)}% ` +
    'folding prices best instead. Which column you would copy depends on whether you believe that number.',
};
