/**
 * The opponent profiles.
 *
 * ## Read `labelling.ts` first
 *
 * Each profile has an **archetype name** (always used, and the production default) and an
 * optional **attributed name** shown only when a deployer explicitly opts in. The
 * educational content is identical either way, which is the point: the traits are the
 * substance and the name is a mnemonic.
 *
 * ## What the numbers are
 *
 * **Design parameters, not measurements.** Each vector was chosen to produce a style that
 * contrasts usefully with the others and that teaches something specific. Where a profile
 * carries an attributed name, the traits gesture at tendencies that have been widely
 * discussed in public poker commentary — *"plays a lot of hands and applies pressure"*,
 * *"famously patient"* — at exactly that level of coarseness. Nobody's hand histories were
 * consulted, nobody's real statistics appear here, and no claim is made that these
 * reproduce how any individual plays.
 *
 * Every profile therefore carries:
 *
 * * `learnFrom` — what a student should take from playing it. This is the actual product.
 * * `styleNotes` — how the style shows up at the table, in behavioural terms.
 * * `counterStrategy` — how to play *against* it. Included deliberately: an opponent you
 *   cannot form a plan against teaches nothing.
 * * `modelBasis` — an honest sentence about where the parameters came from.
 *
 * ## On the historical profiles
 *
 * Two profiles are attributed to players who have died. They get exactly the same
 * treatment: modelled tendencies, no impersonation, no invented quotes, no claims about
 * what anyone thought. Being unable to object is not a reason to be less careful.
 */

import {
  assertNoImpersonation,
  type NamingMode,
  type ProfileDisclosure,
  type ProfileNaming,
  profileDisclosure,
} from './labelling.ts';
import { baselineTraits, makeTraits, type TraitKey, type Traits, traitDistance } from './traits.ts';

export class ProfileError extends Error {
  override readonly name = 'ProfileError';
}

/** How hard the profile plays, chosen by the learner. */
export type Difficulty = 'educational' | 'realistic' | 'expert';

export const DIFFICULTIES: readonly Difficulty[] = ['educational', 'realistic', 'expert'];

export interface DifficultySettings {
  readonly id: Difficulty;
  readonly label: string;
  readonly description: string;
  /**
   * How strongly the profile's traits are expressed. Below 1 the style is muted towards
   * a straightforward baseline, which makes it easier to read.
   */
  readonly traitExpression: number;
  /**
   * Extra randomness added to every decision. Higher means less consistent — easier to
   * beat, and easier to misread.
   */
  readonly noise: number;
  /** Whether the profile adapts to observed opponent tendencies at all. */
  readonly adaptationEnabled: boolean;
  /** Monte Carlo samples the profile may use to assess its own hand. */
  readonly equitySamples: number;
  /** Whether the Coach panel is available while playing this difficulty. */
  readonly coachAvailable: boolean;
}

/**
 * The three difficulty settings.
 *
 * `educational` is not simply "worse". It is *more legible*: the style is muted, sizing is
 * more uniform, and the Coach stays available, so a learner can see the shape of the
 * strategy before facing the sharp version of it. `expert` expresses the traits fully,
 * adapts, and varies sizing — which is harder to play against precisely because it is
 * harder to read.
 */
export const DIFFICULTY_SETTINGS: Readonly<Record<Difficulty, DifficultySettings>> = {
  educational: {
    id: 'educational',
    label: 'Educational',
    description:
      'The style is muted and consistent, so you can see its shape. Bet sizes are uniform, it does not adapt to you, and the Coach stays available while you play.',
    traitExpression: 0.6,
    noise: 0.18,
    adaptationEnabled: false,
    equitySamples: 4_000,
    coachAvailable: true,
  },
  realistic: {
    id: 'realistic',
    label: 'Realistic',
    description:
      'The style is expressed as designed, with the sizing variation and inconsistency a real opponent shows. It adapts a little to what you have been doing.',
    traitExpression: 1,
    noise: 0.1,
    adaptationEnabled: true,
    equitySamples: 8_000,
    coachAvailable: true,
  },
  expert: {
    id: 'expert',
    label: 'Expert',
    description:
      'The style is fully expressed, adapts hard to what it has seen you do, and varies its sizing enough to be genuinely difficult to read. The Coach is available afterwards in review, not during the hand.',
    traitExpression: 1,
    noise: 0.05,
    adaptationEnabled: true,
    equitySamples: 12_000,
    coachAvailable: false,
  },
};

export interface StrategyProfile {
  readonly naming: ProfileNaming;
  readonly traits: Traits;
  /** What a learner should take away from playing against this style. 2–4 sentences. */
  readonly learnFrom: readonly string[];
  /** How the style shows up at the table, behaviourally. */
  readonly styleNotes: readonly string[];
  /** How to play against it. An opponent you cannot plan against teaches nothing. */
  readonly counterStrategy: readonly string[];
  /** An honest sentence about where these parameters came from. */
  readonly modelBasis: string;
  /** The trait axes this profile is most defined by, for the profile card. */
  readonly signatureTraits: readonly TraitKey[];
  /** Best format to meet this style in, for the mode selector. */
  readonly bestFor: 'heads-up' | 'six-max' | 'both';
}

const ATTRIBUTED_BASIS =
  'Design parameters chosen to produce a recognisable style, loosely informed by tendencies widely discussed in public poker commentary. Not measured from anyone’s hand histories, and not a reproduction of any individual’s play.';

const ARCHETYPE_BASIS =
  'Design parameters chosen to produce a specific, contrasting teaching style. Not modelled on any individual.';

const PROFILE_LIST: readonly StrategyProfile[] = [
  // -----------------------------------------------------------------------
  {
    naming: {
      id: 'vocal-aggressor',
      archetypeName: 'High-Variance Tournament Aggressor',
      archetypeTagline: 'Plays a lot of hands, applies constant pressure, and hates folding.',
      attributedName: 'Phil Hellmuth',
    },
    traits: makeTraits({
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
    }),
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
    modelBasis: ATTRIBUTED_BASIS,
    signatureTraits: ['aggressionFrequency', 'foldToPressure', 'tournamentOrientation'],
    bestFor: 'six-max',
  },

  // -----------------------------------------------------------------------
  {
    naming: {
      id: 'adaptive-exploiter',
      archetypeName: 'Adaptive Exploitative Pro',
      archetypeTagline: 'Reads what you do and attacks it. Changes gears without warning.',
      attributedName: 'Phil Ivey',
    },
    traits: makeTraits({
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
    }),
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
    modelBasis: ATTRIBUTED_BASIS,
    signatureTraits: ['exploitativeAdaptation', 'sizingVariance', 'positionSensitivity'],
    bestFor: 'both',
  },

  // -----------------------------------------------------------------------
  {
    naming: {
      id: 'patient-technician',
      archetypeName: 'Patient Positional Technician',
      archetypeTagline: 'Waits, then applies pressure precisely where position gives it an edge.',
      attributedName: 'Erik Seidel',
    },
    traits: makeTraits({
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
    }),
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
    modelBasis: ATTRIBUTED_BASIS,
    signatureTraits: ['positionSensitivity', 'vpip', 'foldToPressure'],
    bestFor: 'both',
  },

  // -----------------------------------------------------------------------
  {
    naming: {
      id: 'reading-pressure-specialist',
      archetypeName: 'Heads-Up Pressure Expert',
      archetypeTagline: 'Relentless in short-handed pots, and hard to put on a hand.',
      attributedName: 'Johnny Chan',
    },
    traits: makeTraits({
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
    }),
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
    modelBasis: ATTRIBUTED_BASIS,
    signatureTraits: ['pressureTendency', 'barrelPersistence', 'vpip'],
    bestFor: 'heads-up',
  },

  // -----------------------------------------------------------------------
  {
    naming: {
      id: 'old-school-pressure',
      archetypeName: 'Classic Aggressive Fundamentalist',
      archetypeTagline: 'Plays a wide, connected range and bets it hard. Simple, and heavy.',
      attributedName: 'Doyle Brunson',
    },
    traits: makeTraits({
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
    }),
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
    modelBasis: ATTRIBUTED_BASIS,
    signatureTraits: ['betSizingPreference', 'sizingVariance', 'aggressionFrequency'],
    bestFor: 'six-max',
  },

  // -----------------------------------------------------------------------
  {
    naming: {
      id: 'mixed-game-generalist',
      archetypeName: 'Mixed-Game Structural Generalist',
      archetypeTagline: 'Thinks in terms of structure and stack depth rather than fixed ranges.',
      attributedName: 'Michael Mizrachi',
    },
    traits: makeTraits({
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
    }),
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
    modelBasis: ATTRIBUTED_BASIS,
    signatureTraits: ['stackDepthAdjustment', 'sizingVariance', 'positionSensitivity'],
    bestFor: 'both',
  },

  // -----------------------------------------------------------------------
  {
    naming: {
      id: 'volume-grinder',
      archetypeName: 'High-Volume Analytical Grinder',
      archetypeTagline: 'Takes every small edge and accepts the swings that come with it.',
      attributedName: 'Shaun Deeb',
    },
    traits: makeTraits({
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
    }),
    learnFrom: [
      'What a high risk tolerance actually means: this model takes edges of a fraction of a big blind, and the swings are large.',
      'Why variance is the price of an edge rather than evidence against one. Compare its results over 200 hands with its results over 5,000.',
      'How often re-raising preflop is available, and how much pressure that puts on someone who only raises with strong hands.',
    ],
    styleNotes: [
      // The named quantity is `threeBetShareOfEntries`, which is what `threeBetTendency`
      // declares and the only frequency it can be compared against (see `traits.ts` on why the
      // multiplier is not a 3-bet frequency). This profile is the highest here on it — 0.93
      // declared, 0.89 measured over 3,000 hands at `realistic`, against 0.88 for the next.
      // The bare superlative that used to stand here was false under the natural reading: on
      // unconditional 3-bet frequency this profile is third, because two looser profiles face
      // and enter more openings. Naming the denominator is what makes the sentence checkable.
      'Re-raises a larger share of the openings it plays back at than any other profile here — which is not the same as making the most 3-bets, since looser profiles get more openings to answer.',
      'Takes marginal all-in spots that other profiles decline.',
      'Its short-run results swing hard in both directions.',
    ],
    counterStrategy: [
      'Do not interpret its willingness to gamble as weakness — the thin edges it takes are usually real.',
      'Tighten your opening range slightly, since it will re-raise you often.',
      'When it takes a marginal spot against you, work out the price rather than reacting to the aggression.',
    ],
    modelBasis: ATTRIBUTED_BASIS,
    signatureTraits: ['riskTolerance', 'threeBetTendency', 'stackDepthAdjustment'],
    bestFor: 'six-max',
  },

  // -----------------------------------------------------------------------
  {
    naming: {
      id: 'disciplined-specialist',
      archetypeName: 'Disciplined Mixed-Format Specialist',
      archetypeTagline: 'Extremely selective, extremely precise. Gives away almost nothing.',
      attributedName: 'Benny Glaser',
    },
    traits: makeTraits({
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
    }),
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
    modelBasis: ATTRIBUTED_BASIS,
    signatureTraits: ['vpip', 'valueBluffBalance', 'riskTolerance'],
    bestFor: 'both',
  },

  // -----------------------------------------------------------------------
  {
    naming: {
      id: 'foundational-reader',
      archetypeName: 'Foundational Read-Based Player',
      archetypeTagline: 'Plays the opponent more than the cards. Straightforward, and stubborn.',
      attributedName: 'Johnny Moss',
    },
    traits: makeTraits({
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
    }),
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
    modelBasis: ATTRIBUTED_BASIS,
    signatureTraits: ['exploitativeAdaptation', 'positionSensitivity', 'sizingVariance'],
    bestFor: 'six-max',
  },

  // -----------------------------------------------------------------------
  {
    naming: {
      id: 'range-narrator',
      archetypeName: 'Range-Reading Communicator',
      archetypeTagline: 'Plays a wide range and narrows yours street by street.',
      attributedName: 'Daniel Negreanu',
    },
    traits: makeTraits({
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
    }),
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
    modelBasis: ATTRIBUTED_BASIS,
    signatureTraits: ['exploitativeAdaptation', 'vpip', 'betSizingPreference'],
    bestFor: 'both',
  },

  // -----------------------------------------------------------------------
  {
    naming: {
      id: 'fundamentals-coach',
      archetypeName: 'Fundamentals-First Study Model',
      archetypeTagline: 'Plays textbook, explains itself clearly, and never takes a thin gamble.',
      isCourseDerived: true,
    },
    traits: makeTraits({
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
    }),
    learnFrom: [
      'What a disciplined, fundamentals-first strategy looks like when played without deviation — the baseline every other style is a departure from.',
      'How position, pot odds and stack depth alone, applied consistently, produce a solid strategy that leans on reads barely at all.',
      'Why a consistent, readable strategy is a reasonable place to start: it is exploitable, but it is also correct often enough to learn from.',
    ],
    styleNotes: [
      'Tight, position-aware, and highly consistent — the easiest profile here to predict.',
      'One bet size for almost everything, chosen by pot fraction rather than by hand.',
      // Both of these used to say the profile does not adapt at all, which contradicted the
      // 0.30 sitting on the `exploitativeAdaptation` axis of the very same card — and 0.30 is
      // not even the lowest here (the calling station is 0.10). The number is the one that
      // moves the play, so the sentence is what changed; `assertStyleNotesMatchTraits` now
      // refuses the old wording on any profile whose adaptation trait is not 0.
      'Barely adapts to you: 0.30 on that axis, and nothing at all at the Educational setting.',
    ],
    counterStrategy: [
      'Its consistency is the weakness. Once you know its opening range you know its continuing range.',
      'Steal position and blinds; it will fold correctly and often.',
      'Do not expect it to bluff much — when it bets big on the river, fold your marginal hands.',
    ],
    modelBasis:
      'Design parameters representing general, widely taught fundamentals — position, pot odds, stack depth, disciplined ranges. It does not reproduce or summarise any particular course, book or proprietary material.',
    signatureTraits: ['sizingVariance', 'exploitativeAdaptation', 'positionSensitivity'],
    bestFor: 'both',
  },

  // -----------------------------------------------------------------------
  // A pure archetype with no attribution, included because a learner should be able
  // to practise against the classic beginner-punishing profile too, and because it is
  // the clearest demonstration that the traits — not the names — do the teaching.
  {
    naming: {
      id: 'calling-station',
      archetypeName: 'Passive Calling Station',
      archetypeTagline: 'Calls far too much and almost never raises. Beatable, and instructive.',
    },
    traits: makeTraits({
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
    }),
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
 * Wordings that assert a profile ignores what it has seen, and the trait that would have to
 * be 0 for any of them to be true.
 *
 * Matched case-insensitively against the whole of every learner-facing string, so a claim
 * embedded mid-sentence is caught as well as one standing alone. The list is deliberately
 * about *phrasing* rather than meaning — nothing here can tell that "plays its own game
 * whatever you do" is the same claim — so it is a backstop, not a proof. What it does buy is
 * that the one specific sentence that shipped false cannot ship false again, and that anyone
 * copying it onto another profile has to make the number true first.
 */
const NO_ADAPTATION_CLAIMS: readonly string[] = [
  'does not adapt',
  'never adapts',
  'no reads at all',
  'does not adjust to you',
  'ignores what you',
];

/**
 * A styleNote may not claim the model ignores you unless its adaptation trait really is 0.
 *
 * `assertNoImpersonation` checks the *voice* of every string — third person, about the model,
 * no person's name. Nothing checked whether a sentence agreed with the vector printed beside
 * it, and `profileCard` renders both in one object: the radar axis read "Adapts to opponents:
 * 0.30" directly under "Does not adapt to you at all, by design." A card that contradicts
 * itself is the same class of defect as a model that contradicts its card, so this runs at
 * load time with the impersonation guard rather than in a test.
 *
 * The trait, not the difficulty, is the subject. `expressTraits` zeroes adaptation at
 * `educational`, so *every* profile ignores you there — a sentence on a card that is only true
 * at one of three settings is not a true sentence about the profile.
 */
function assertStyleNotesMatchTraits(profile: StrategyProfile): void {
  if (profile.traits.exploitativeAdaptation === 0) return;
  for (const [field, strings] of [
    ['learnFrom', profile.learnFrom],
    ['styleNotes', profile.styleNotes],
    ['counterStrategy', profile.counterStrategy],
  ] as const) {
    for (const text of strings) {
      const lowered = text.toLowerCase();
      for (const claim of NO_ADAPTATION_CLAIMS) {
        if (lowered.includes(claim)) {
          throw new ProfileError(
            `profile "${profile.naming.id}" ${field} claims "${claim}", but its ` +
              `exploitativeAdaptation trait is ${profile.traits.exploitativeAdaptation} and ` +
              'profileCard renders the sentence and the axis in the same object. Set the trait to 0 ' +
              'or say what the number actually means.',
          );
        }
      }
    }
  }
}

/**
 * Validates the profile set once, at module load, so a bad profile fails loudly.
 *
 * Exported so a test can run the real guard against a deliberately broken profile rather than
 * restating the rule. A test that recomputes the implementation's own check passes whenever
 * both are wrong in the same way, which is exactly the failure a guard exists to catch. Not
 * re-exported from `index.ts`: the package's public surface is the validated `PROFILES`, and
 * nothing outside this package assembles a profile of its own.
 */
export function validateProfiles(profiles: readonly StrategyProfile[]): readonly StrategyProfile[] {
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.naming.id)) throw new ProfileError(`duplicate profile id "${profile.naming.id}"`);
    ids.add(profile.naming.id);

    if (profile.learnFrom.length < 2) {
      throw new ProfileError(`profile "${profile.naming.id}" needs at least 2 learnFrom entries`);
    }
    if (profile.counterStrategy.length < 2) {
      throw new ProfileError(`profile "${profile.naming.id}" needs at least 2 counterStrategy entries`);
    }
    if (profile.modelBasis === '') {
      throw new ProfileError(`profile "${profile.naming.id}" must state where its parameters came from`);
    }

    // Every learner-facing string must describe the MODEL, not a person. This is the
    // guardrail that matters most in this feature, so it runs at load time rather than
    // only in a test — a profile that impersonates cannot even be imported.
    for (const [field, strings] of [
      ['learnFrom', profile.learnFrom],
      ['styleNotes', profile.styleNotes],
      ['counterStrategy', profile.counterStrategy],
      ['modelBasis', [profile.modelBasis]],
      ['archetypeTagline', [profile.naming.archetypeTagline]],
    ] as const) {
      for (const text of strings) {
        assertNoImpersonation(text, `profile "${profile.naming.id}" ${field}`);
      }
    }

    assertStyleNotesMatchTraits(profile);
  }
  return profiles;
}

export const PROFILES: readonly StrategyProfile[] = validateProfiles(PROFILE_LIST);

export function profileById(id: string): StrategyProfile | null {
  return PROFILES.find((profile) => profile.naming.id === id) ?? null;
}

export function requireProfile(id: string): StrategyProfile {
  const profile = profileById(id);
  if (profile === null) {
    throw new ProfileError(`unknown profile "${id}". Known: ${PROFILES.map((p) => p.naming.id).join(', ')}`);
  }
  return profile;
}

export interface ProfileCard {
  readonly id: string;
  readonly disclosure: ProfileDisclosure;
  readonly traits: Traits;
  readonly learnFrom: readonly string[];
  readonly styleNotes: readonly string[];
  readonly counterStrategy: readonly string[];
  readonly modelBasis: string;
  readonly signatureTraits: readonly TraitKey[];
  readonly bestFor: StrategyProfile['bestFor'];
}

/** Everything the selector needs to render one profile, disclaimers included. */
export function profileCard(profile: StrategyProfile, mode: NamingMode): ProfileCard {
  return {
    id: profile.naming.id,
    disclosure: profileDisclosure(profile.naming, mode),
    traits: profile.traits,
    learnFrom: profile.learnFrom,
    styleNotes: profile.styleNotes,
    counterStrategy: profile.counterStrategy,
    modelBasis: profile.modelBasis,
    signatureTraits: profile.signatureTraits,
    bestFor: profile.bestFor,
  };
}

export function allProfileCards(mode: NamingMode): readonly ProfileCard[] {
  return PROFILES.map((profile) => profileCard(profile, mode));
}

/**
 * Applies a difficulty setting to a profile's traits.
 *
 * Muting pulls every trait towards the baseline rather than towards 0.5, so a muted
 * profile still leans the way it is supposed to lean — just less far. Pulling towards 0.5
 * would make every profile converge on the same middling style, which would defeat the
 * point of having an easier difficulty at all.
 */
export function expressTraits(profile: StrategyProfile, difficulty: Difficulty): Traits {
  const settings = DIFFICULTY_SETTINGS[difficulty];
  const baseline = baselineTraits();
  const expression = settings.traitExpression;
  const out: Record<string, number> = {};
  for (const key of Object.keys(profile.traits) as TraitKey[]) {
    const target = profile.traits[key];
    const base = baseline[key];
    out[key] = base + (target - base) * expression;
  }
  // Adaptation is switched off entirely at the easiest setting, so the style stays legible.
  if (!settings.adaptationEnabled) out['exploitativeAdaptation'] = 0;
  return makeTraits(out as Partial<Traits>, `${profile.naming.id} @ ${difficulty}`);
}

/**
 * How different the profile set is, pairwise. Used by the tests to assert the set spans a
 * genuine range of styles rather than being variations on one — a set that looked diverse
 * on its cards but played identically would be the quiet failure here.
 */
export function profileDiversity(): {
  readonly pairs: number;
  readonly minDistance: number;
  readonly meanDistance: number;
  readonly closestPair: readonly [string, string];
} {
  let min = Number.POSITIVE_INFINITY;
  let total = 0;
  let pairs = 0;
  let closest: [string, string] = ['', ''];
  for (let i = 0; i < PROFILES.length; i++) {
    for (let j = i + 1; j < PROFILES.length; j++) {
      const left = PROFILES[i];
      const right = PROFILES[j];
      if (left === undefined || right === undefined) continue;
      const distance = traitDistance(left.traits, right.traits);
      total += distance;
      pairs += 1;
      if (distance < min) {
        min = distance;
        closest = [left.naming.id, right.naming.id];
      }
    }
  }
  return { pairs, minDistance: min, meanDistance: total / pairs, closestPair: closest };
}
