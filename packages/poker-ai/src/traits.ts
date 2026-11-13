/**
 * The trait vector. One shared decision engine reads it, so profiles are comparable, tests can check
 * observed frequencies against declared traits, and the card shows the whole model.
 * Every trait is 0..1. The values are design parameters chosen for contrast, not measurements of anyone.
 */

export class TraitError extends Error {
  override readonly name = 'TraitError';
}

/** All fields are 0..1 inclusive, read as "how far towards the second option". */
export interface Traits {
  /** Share of hands entered when folding is free. Roughly VPIP. 0.15 is very tight, 0.5 very loose. */
  readonly vpip: number;

  /** Preflop raise as a share of `vpip`, so PFR above VPIP cannot be represented. */
  readonly pfrShareOfVpip: number;

  /**
   * Bet-or-raise rate on a hand the model reads as neutral. It reads higher than the overall rate,
   * because hopeless hands bet at the lower `bluffFrequency`. `stats.ts` measures it over
   * `NEUTRAL_ASSESSMENT_BAND` and reports the unconditional rate separately.
   */
  readonly aggressionFrequency: number;

  /** Bet-or-raise rate with a hand that rarely wins at showdown. */
  readonly bluffFrequency: number;

  /** 0 plays a hand the same from every seat; 1 opens much wider late and folds more early. */
  readonly positionSensitivity: number;

  /**
   * A multiplier on the preflop calling range, not a 3-bet frequency. Re-raising needs entering the pot,
   * so the realised rate is capped by `vpip`. Its one frequency is `threeBetRaiseShare` in `policy.ts`,
   * which is what `stats.ts` compares against.
   */
  readonly threeBetTendency: number;

  /** Preferred bet size. 0 is a quarter pot, 1 is one and a half pots. */
  readonly betSizingPreference: number;

  /** 0 uses one size for everything; 1 varies size with texture and hand strength. */
  readonly sizingVariance: number;

  /** Value-to-bluff mix. 0.5 is roughly balanced; below bluffs more, above value-bets more. */
  readonly valueBluffBalance: number;

  /** How large its bets are, where `aggressionFrequency` is how often. */
  readonly pressureTendency: number;

  /** 0 plays 15bb like 150bb; 1 shifts sharply towards push-or-fold as stacks shorten. */
  readonly stackDepthAdjustment: number;

  /** 0 is pure chip-EV cash thinking; 1 weights survival and ladder position heavily. */
  readonly tournamentOrientation: number;

  /** Appetite for high-variance lines with thin edges. Independent of aggression. */
  readonly riskTolerance: number;

  /** 0 ignores opponents; 1 adapts hard to what it has seen, from public information only. */
  readonly exploitativeAdaptation: number;

  /** How readily it folds a made hand to sustained aggression. */
  readonly foldToPressure: number;

  /** How often it keeps betting on later streets after taking the lead. */
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

/** Learner copy. Each says what a high value costs, so no trait reads as "better". */
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

/** Rejects rather than clamps, so a profile never behaves differently from what its card claims. */
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

/** Mean absolute difference across all axes. Tests use it to assert the profile set is diverse. */
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

/** Cannot exceed VPIP by construction. */
export function preflopRaiseFrequency(traits: Traits): number {
  return traits.vpip * traits.pfrShareOfVpip;
}

/** 0 maps to 0.25 pot, 1 to 1.5 pot. */
export function preferredPotFraction(traits: Traits): number {
  return 0.25 + traits.betSizingPreference * 1.25;
}

/** A multiplier on VPIP. `relativePosition` is 0 for first to act and 1 for last. */
export function positionalVpipMultiplier(traits: Traits, relativePosition: number): number {
  if (relativePosition < 0 || relativePosition > 1) {
    throw new TraitError(`relativePosition must be between 0 and 1, received ${relativePosition}`);
  }
  // Spans 0.55x to 1.45x at full sensitivity.
  const swing = 0.45 * traits.positionSensitivity;
  return 1 - swing + relativePosition * 2 * swing;
}

/** 1 means no adjustment; larger is more willing to get all-in. Ramps in below 40bb. */
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
