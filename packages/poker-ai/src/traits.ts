/**
 * The trait vector: what makes one opponent play differently from another.
 *
 * ## Why a trait vector and not eleven hand-written strategies
 *
 * Eleven bespoke strategies would be eleven things to test, eleven places for a bug, and
 * no way to say *how* two of them differ. A shared decision engine driven by a numeric
 * trait vector gives three things that matter more than expressiveness:
 *
 *   1. **Comparability.** "This profile enters 42% of pots and raises 78% of those; that
 *      one enters 19% and raises 91%" is a sentence a learner can act on. It is also a
 *      radar chart, and a test assertion.
 *   2. **Testability.** A statistical test can run 20,000 deterministic hands per profile
 *      and assert that the *observed* frequencies match the *declared* traits. A
 *      hand-written strategy can only be tested against itself.
 *   3. **Honesty.** The trait vector is the whole model. Nothing is hidden in
 *      hand-tuned special cases, so the profile card can show the learner exactly what
 *      they are up against — which is the difference between an educational tool and a
 *      black box.
 *
 * ## Every trait is on a 0..1 scale, and every one is documented
 *
 * A 0..1 scale makes profiles comparable at a glance and makes the radar view meaningful
 * without per-axis rescaling. Where a trait maps onto a poker statistic with a
 * conventional range (VPIP, PFR), the mapping is stated on the field so nobody has to
 * reverse-engineer it from the engine.
 *
 * ## What these numbers are, and are not
 *
 * They are **design parameters chosen to produce contrasting, instructive styles**. They
 * are not measurements. Nobody's real VPIP is in this file. See `labelling.ts` for the
 * full framing and `profiles.ts` for the per-profile rationale.
 */

export class TraitError extends Error {
  override readonly name = 'TraitError';
}

/**
 * A profile's playing style, entirely numeric.
 *
 * All fields are 0..1 inclusive. Read each as "how far towards the second option", so
 * 0 and 1 are both meaningful extremes rather than "off" and "on".
 */
export interface Traits {
  /**
   * Voluntarily put money in pot. Fraction of hands the profile enters when folding is
   * free to it. Maps roughly onto the conventional VPIP statistic: 0.15 is a very tight
   * player, 0.5 a very loose one.
   */
  readonly vpip: number;

  /**
   * Preflop raise, as a fraction of `vpip`. 1.0 means it never limps or cold-calls —
   * every hand it plays, it raises. 0.5 means half its entries are passive. This is
   * expressed relative to `vpip` rather than absolutely because PFR > VPIP is
   * impossible, and a relative field makes that unrepresentable.
   */
  readonly pfrShareOfVpip: number;

  /**
   * How often it takes the aggressive line (bet or raise) when aggression is available
   * and its hand assessment is neutral. The single biggest driver of how a profile
   * *feels* to play against.
   *
   * **The condition is part of the number.** This is not the profile's overall bet-and-raise
   * frequency, and it will always read higher than one: on a hand that cannot win at showdown
   * the model bets at `bluffFrequency` instead, which every profile declares lower, so the
   * unconditional rate is an average of the two and lands between them. `stats.ts` measures
   * this axis over the neutral band (`NEUTRAL_ASSESSMENT_BAND` in `policy.ts`) for that
   * reason, and reports the unconditional rate separately rather than instead.
   */
  readonly aggressionFrequency: number;

  /**
   * How often it bets or raises with a hand that has little chance of winning at
   * showdown. Distinct from `aggressionFrequency`: a profile can bet often *with good
   * hands* and rarely bluff, or the reverse.
   */
  readonly bluffFrequency: number;

  /**
   * How much position changes its decisions. 0 plays the same hand identically from
   * every seat; 1 opens dramatically wider in late position and folds far more in early
   * position. This is the trait most worth making a learner notice, because position is
   * the cheapest edge in poker and the easiest to ignore.
   */
  readonly positionSensitivity: number;

  /**
   * Willingness to re-raise preflop, as a multiplier on the range it would merely call
   * with. High values produce a profile that contests openings rather than flatting.
   *
   * **Not a 3-bet frequency, and it cannot be read as one.** A re-raise requires entering the
   * pot, so a profile's realised 3-bet frequency is capped by its `vpip`: a profile declaring
   * `vpip` 0.15 and `threeBetTendency` 0.44 is not claiming to re-raise 44% of the openings it
   * faces, which would contradict the other number on its own card. The multiplier's one
   * frequency is `threeBetRaiseShare` in `policy.ts` — the share of the openings it plays back
   * at that it re-raises rather than flat-calls — and that is the quantity `stats.ts` compares
   * against.
   */
  readonly threeBetTendency: number;

  /**
   * Preferred bet size as a fraction of the pot, before other adjustments. 0 maps to a
   * quarter pot, 1 maps to one and a half pots. Kept as a normalised trait rather than a
   * raw fraction so it can sit on the same radar axis as everything else.
   */
  readonly betSizingPreference: number;

  /**
   * How much it varies its sizing. 0 uses one size for everything (simple, readable,
   * exploitable); 1 changes size with board texture and hand strength. A learner facing
   * a 0 can start reading sizes; facing a 1 they cannot, and noticing that is the lesson.
   */
  readonly sizingVariance: number;

  /**
   * The mix of value bets to bluffs it aims for. 0.5 is roughly balanced. Below 0.5 it
   * bluffs more than value-bets (exploitable by calling); above, the reverse
   * (exploitable by folding).
   */
  readonly valueBluffBalance: number;

  /**
   * Willingness to make large bets and put opponents to a decision for a big portion of
   * their stack. Separate from `aggressionFrequency`, which is about *how often*: this
   * is about *how much*.
   */
  readonly pressureTendency: number;

  /**
   * How much it changes with stack depth. 0 plays a 15 big-blind stack like a 150 big-
   * blind stack, which is a real and instructive mistake; 1 shifts sharply towards
   * push-or-fold as stacks shorten.
   */
  readonly stackDepthAdjustment: number;

  /**
   * Where it sits between cash-game and tournament instincts. 0 is pure chip-EV cash
   * thinking; 1 weights survival and ladder position heavily. Visible in how it treats a
   * marginal all-in.
   */
  readonly tournamentOrientation: number;

  /**
   * Appetite for high-variance lines with thin edges. Low values pass up small edges to
   * avoid swings; high values take every one. Deliberately distinct from aggression: a
   * profile can be relentlessly aggressive in small pots and risk-averse in big ones.
   */
  readonly riskTolerance: number;

  /**
   * How far it moves from a fixed strategy towards attacking observed opponent
   * tendencies. 0 plays its own game regardless; 1 adapts hard to what it has seen —
   * only from public information, never from hidden cards.
   */
  readonly exploitativeAdaptation: number;

  /**
   * How readily it folds a made hand to sustained aggression. Low values produce the
   * profile that will not be moved off a pair; high values fold correctly but can be
   * pushed around. Named for the direction that is easier to reason about.
   */
  readonly foldToPressure: number;

  /**
   * How often it continues on later streets after taking the betting lead. Low values
   * bet the flop and give up; high values follow through, which is what makes a profile
   * genuinely uncomfortable to play against.
   */
  readonly barrelPersistence: number;
}

export const TRAIT_KEYS = [
  'vpip',
  'pfrShareOfVpip',
  'aggressionFrequency',
  'bluffFrequency',
  'positionSensitivity',
  'threeBetTendency',
  'betSizingPreference',
  'sizingVariance',
  'valueBluffBalance',
  'pressureTendency',
  'stackDepthAdjustment',
  'tournamentOrientation',
  'riskTolerance',
  'exploitativeAdaptation',
  'foldToPressure',
  'barrelPersistence',
] as const;

export type TraitKey = (typeof TRAIT_KEYS)[number];

/** Human-readable axis labels for the radar view and the profile card. */
export const TRAIT_LABELS: Readonly<Record<TraitKey, string>> = {
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

/**
 * What each axis means in plain language, for the learner. Written so a beginner can
 * read the radar chart without a glossary open, and so a high value never reads as
 * "better" — every trait is a trade-off, and the descriptions say what it costs.
 */
export const TRAIT_DESCRIPTIONS: Readonly<Record<TraitKey, string>> = {
  vpip: 'How many hands it plays. Playing more hands wins more small pots and loses more big ones.',
  pfrShareOfVpip:
    'When it plays a hand, how often it raises rather than calls. Raising takes the initiative but commits more chips.',
  aggressionFrequency:
    'How often it bets and raises on a hand it reads as neither strong nor hopeless. With nothing it bets less often than this, and with a real hand more, so its overall bet-and-raise rate sits below this number. Aggression wins pots nobody contests, and loses more when it runs into a real hand.',
  bluffFrequency:
    'How often it bets with a hand that cannot win at showdown. Bluffing too little is readable; too much is expensive.',
  positionSensitivity:
    'How much it cares about acting last. Acting last is a genuine edge, and ignoring it is one of the most common leaks.',
  threeBetTendency:
    'How much of the range it would have called an opening raise with it re-raises instead. It only applies to the hands it plays at all, so a tight profile still re-raises rarely however high this reads. Re-raising isolates and takes control, at the cost of a bigger pot with less information.',
  betSizingPreference:
    'How big it likes to bet. Bigger bets charge draws more but risk more to win the same pot.',
  sizingVariance:
    'Whether it uses one size for everything or changes it. One size is simple and readable; varying it hides information.',
  valueBluffBalance:
    'Whether its bets are mostly strong hands or mostly bluffs. Knowing which tells you whether to call or fold more.',
  pressureTendency:
    'How willing it is to make you decide for a lot of chips. Pressure creates mistakes, including its own.',
  stackDepthAdjustment:
    'How much it changes when stacks get short. Short stacks make implied odds vanish, and a profile that ignores that is beatable.',
  tournamentOrientation:
    'How much it values survival over chips. In a tournament, busting costs more than the chips say — but over-folding gives the edge away.',
  riskTolerance:
    'Whether it takes thin edges. Taking every small edge is correct for chips and brutal for the swings.',
  exploitativeAdaptation:
    'How much it targets what it has seen you do. Adapting wins more against a predictable opponent and can be turned against it.',
  foldToPressure:
    'How easily it gives up a made hand. Folding too little pays off every bluff; folding too much invites them.',
  barrelPersistence:
    'Whether it keeps betting on later streets after taking the lead. Following through wins more pots and costs more when called.',
};

const DEFAULT_TRAITS: Traits = {
  vpip: 0.25,
  pfrShareOfVpip: 0.7,
  aggressionFrequency: 0.5,
  bluffFrequency: 0.3,
  positionSensitivity: 0.5,
  threeBetTendency: 0.4,
  betSizingPreference: 0.5,
  sizingVariance: 0.4,
  valueBluffBalance: 0.55,
  pressureTendency: 0.5,
  stackDepthAdjustment: 0.5,
  tournamentOrientation: 0.4,
  riskTolerance: 0.5,
  exploitativeAdaptation: 0.4,
  foldToPressure: 0.5,
  barrelPersistence: 0.5,
};

/** A baseline vector, for building a profile by stating only what differs. */
export function baselineTraits(): Traits {
  return { ...DEFAULT_TRAITS };
}

/**
 * Validates a trait vector. Rejects out-of-range and non-finite values rather than
 * clamping, because a trait quietly clamped from 1.4 to 1.0 makes a profile behave
 * differently from what its own card claims — and the card is the teaching material.
 */
export function assertValidTraits(traits: Traits, where: string): void {
  for (const key of TRAIT_KEYS) {
    const value = traits[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TraitError(`${where}: trait "${key}" must be a finite number, received ${String(value)}`);
    }
    if (value < 0 || value > 1) {
      throw new TraitError(`${where}: trait "${key}" must be between 0 and 1, received ${value}`);
    }
  }
}

export function makeTraits(overrides: Partial<Traits>, where = 'traits'): Traits {
  const traits: Traits = { ...DEFAULT_TRAITS, ...overrides };
  assertValidTraits(traits, where);
  return traits;
}

/**
 * How far apart two profiles are: mean absolute difference across all axes.
 *
 * Used by the tests to assert that the profile set genuinely spans a range of styles
 * rather than being eleven variations on one. A set where every pair scores below some
 * threshold would look diverse on a card and play identically, which is the failure this
 * catches.
 */
export function traitDistance(a: Traits, b: Traits): number {
  let total = 0;
  for (const key of TRAIT_KEYS) total += Math.abs(a[key] - b[key]);
  return total / TRAIT_KEYS.length;
}

/** The axes on which two profiles differ most, for "how does this compare?" copy. */
export function biggestTraitDifferences(
  a: Traits,
  b: Traits,
  count = 3,
): readonly { readonly key: TraitKey; readonly label: string; readonly delta: number }[] {
  return TRAIT_KEYS.map((key) => ({ key, label: TRAIT_LABELS[key], delta: a[key] - b[key] }))
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, count);
}

// ---------------------------------------------------------------------------
// Derived quantities the decision engine needs
// ---------------------------------------------------------------------------

/** Absolute preflop-raise frequency, which cannot exceed VPIP by construction. */
export function preflopRaiseFrequency(traits: Traits): number {
  return traits.vpip * traits.pfrShareOfVpip;
}

/** Maps `betSizingPreference` onto an actual pot fraction: 0 → 0.25, 1 → 1.5. */
export function preferredPotFraction(traits: Traits): number {
  return 0.25 + traits.betSizingPreference * 1.25;
}

/**
 * How much position widens or tightens the entry threshold.
 *
 * Returns a multiplier on VPIP. A profile with `positionSensitivity` 0 always returns 1;
 * a highly position-aware profile plays materially more hands on the button than under
 * the gun. `relativePosition` is 0 for first to act and 1 for last.
 */
export function positionalVpipMultiplier(traits: Traits, relativePosition: number): number {
  if (relativePosition < 0 || relativePosition > 1) {
    throw new TraitError(`relativePosition must be between 0 and 1, received ${relativePosition}`);
  }
  // Spans 0.6x in the worst seat to 1.5x in the best, scaled by the trait.
  const swing = 0.45 * traits.positionSensitivity;
  return 1 - swing + relativePosition * 2 * swing;
}

/**
 * How much short stacks pull the profile towards committing.
 *
 * 1 means "no adjustment"; larger means more willing to get all-in. `stackInBigBlinds`
 * below about 20 is where implied odds stop existing and the adjustment starts to matter.
 */
export function stackDepthCommitmentMultiplier(traits: Traits, stackInBigBlinds: number): number {
  if (!Number.isFinite(stackInBigBlinds) || stackInBigBlinds < 0) {
    throw new TraitError(
      `stackInBigBlinds must be a non-negative finite number, received ${stackInBigBlinds}`,
    );
  }
  if (stackInBigBlinds >= 40) return 1;
  // Ramps from 1 at 40bb to 1 + adjustment at 5bb and below.
  const shortness = Math.min(1, (40 - Math.max(5, stackInBigBlinds)) / 35);
  return 1 + shortness * traits.stackDepthAdjustment;
}
