/**
 * Content types: lessons, quizzes, glossary entries and Scenario Lab scenarios.
 * Content stores situations and reasoning, never computed numbers. `@prl/poker-math` computes every
 * figure at runtime, and the test suite checks that each `expectedInsight` claim holds, so the
 * teaching text and the maths cannot drift apart.
 */

/** A stable, human-readable identifier used in URLs and progress records. */
export type ContentId = string;

export type Difficulty = 'intro' | 'core' | 'advanced';

/** The syllabus areas, used for navigation and for progress reporting. */
export const TOPICS = [
  'rules-and-flow',
  'positions-and-blinds',
  'hand-reading-and-outs',
  'probability-and-equity',
  'pot-odds-and-ev',
  'bet-sizing-and-spr',
  'fold-equity-and-bluffing',
  'ranges',
  'variance-and-bankroll',
  'tournaments',
  'risk-psychology',
] as const;
export type Topic = (typeof TOPICS)[number];

/**
 * The one display name for each syllabus area, shared by every screen. Typed `Record<Topic, …>` so a
 * new topic without a name fails to compile. Written out because "Pot odds and EV" cannot be de-slugged.
 */
export const TOPIC_LABELS: Readonly<Record<Topic, string>> = {
  'rules-and-flow': 'Rules and flow',
  'positions-and-blinds': 'Position and the blinds',
  'hand-reading-and-outs': 'Hand reading and outs',
  'probability-and-equity': 'Probability and equity',
  'pot-odds-and-ev': 'Pot odds and EV',
  'bet-sizing-and-spr': 'Bet sizing and SPR',
  'fold-equity-and-bluffing': 'Fold equity and bluffing',
  ranges: 'Ranges',
  'variance-and-bankroll': 'Variance and bankroll',
  tournaments: 'Tournaments',
  'risk-psychology': 'Risk psychology',
};

export interface GlossaryEntry {
  readonly id: ContentId;
  readonly term: string;
  /** One or two sentences. Plain language first, jargon second. */
  readonly definition: string;
  /** Where the term is formally defined, if it has a formula. */
  readonly formula?: string;
  readonly topics: readonly Topic[];
  readonly seeAlso?: readonly ContentId[];
}

/** A block of lesson prose or an interactive element. */
export type LessonBlock =
  | { readonly kind: 'prose'; readonly text: string }
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[]; readonly ordered?: boolean }
  | {
      readonly kind: 'formula';
      /** The formula in plain text, e.g. "break-even equity = call / (pot + call)". */
      readonly expression: string;
      readonly explanation: string;
    }
  | {
      readonly kind: 'callout';
      readonly tone: 'insight' | 'warning' | 'misconception';
      readonly title: string;
      readonly text: string;
    }
  | {
      /** Embeds a calculation the client computes with @prl/poker-math, so lesson text never goes stale. */
      readonly kind: 'liveCalculation';
      readonly calculation: LiveCalculation;
      readonly caption: string;
      /** This instance's own heading, when a lesson shows one kind of calculation more than once. */
      readonly title?: string;
    }
  | { readonly kind: 'scenarioLink'; readonly scenarioId: ContentId; readonly prompt: string };

/** A calculation a lesson or scenario asks the app to perform. Only the situation is stored. */
export type LiveCalculation =
  | {
      readonly kind: 'equity';
      readonly heroCards: string;
      readonly board?: string;
      readonly opponents: readonly string[];
    }
  | {
      readonly kind: 'outs';
      readonly heroCards: string;
      readonly board: string;
      readonly opponentCards?: string;
    }
  | { readonly kind: 'potOdds'; readonly pot: number; readonly toCall: number }
  | {
      readonly kind: 'ruleOf24';
      readonly outs: number;
      readonly cardsToCome: 1 | 2;
    }
  | {
      readonly kind: 'callEv';
      readonly pot: number;
      readonly toCall: number;
      readonly equity: number;
    }
  | {
      readonly kind: 'foldEquity';
      readonly pot: number;
      readonly betSize: number;
      readonly foldProbability: number;
      readonly equityWhenCalled: number;
    }
  | { readonly kind: 'spr'; readonly effectiveStack: number; readonly pot: number }
  | {
      readonly kind: 'variance';
      readonly winRateBbPer100: number;
      readonly standardDeviationBbPer100: number;
      readonly hands: number;
    }
  | {
      readonly kind: 'riskOfRuin';
      readonly bankrollBb: number;
      readonly winRateBbPer100: number;
      readonly standardDeviationBbPer100: number;
    }
  | {
      /** Independent-chip-model prize equity. `stacks` and `payouts` are the situation. */
      readonly kind: 'icm';
      readonly stacks: readonly number[];
      readonly payouts: readonly number[];
    };

export interface Lesson {
  readonly id: ContentId;
  readonly title: string;
  /** One sentence shown in the lesson list. */
  readonly summary: string;
  readonly topic: Topic;
  readonly difficulty: Difficulty;
  /** Rough reading time in minutes, for the learner's planning. */
  readonly estimatedMinutes: number;
  /** Lessons that should be read first. */
  readonly prerequisites: readonly ContentId[];
  readonly blocks: readonly LessonBlock[];
  /** Three to six sentences the learner should leave with. */
  readonly keyTakeaways: readonly string[];
  readonly quizId?: ContentId;
  readonly glossaryTerms: readonly ContentId[];
}

/** A quiz question. Numeric answers are checked against computed values. */
export type QuizQuestion =
  | {
      readonly kind: 'multipleChoice';
      readonly id: ContentId;
      readonly prompt: string;
      readonly options: readonly string[];
      /** Index into `options`. */
      readonly correctIndex: number;
      /** Why the correct answer is correct, and why each distractor is wrong. */
      readonly explanation: string;
      readonly optionNotes?: readonly string[];
    }
  | {
      /** The expected value is computed from `calculation`, and the answer is accepted within `tolerance`. */
      readonly kind: 'numeric';
      readonly id: ContentId;
      readonly prompt: string;
      readonly calculation: LiveCalculation;
      /** Which field of the calculation result is being asked for. */
      readonly field: string;
      readonly unit: 'percent' | 'chips' | 'ratio' | 'count' | 'hands';
      readonly tolerance: number;
      readonly explanation: string;
    }
  | {
      readonly kind: 'decision';
      readonly id: ContentId;
      readonly prompt: string;
      readonly scenarioId: ContentId;
      readonly explanation: string;
    };

export interface Quiz {
  readonly id: ContentId;
  readonly title: string;
  readonly topic: Topic;
  readonly lessonId?: ContentId;
  readonly questions: readonly QuizQuestion[];
  /** No score threshold, streak or "pass" exists (docs/PRODUCT-GUARDRAILS.md). */
  readonly reviewAdvice: string;
}

/** An opponent's playing style, used by bots and by range assumptions. */
export const OPPONENT_PROFILES = [
  'nit',
  'tight-aggressive',
  'loose-aggressive',
  'calling-station',
  'maniac',
  'unknown',
] as const;
export type OpponentProfile = (typeof OPPONENT_PROFILES)[number];

/** How a scenario describes what the opponent might hold. */
export type RangeSpec =
  /** Exact cards, e.g. "AhKh" — used when the scenario is about a known hand. */
  | { readonly kind: 'exact'; readonly cards: string }
  /** Standard hand-class notation, e.g. "AA-TT, AKs, AQo+, 76s". */
  | { readonly kind: 'notation'; readonly notation: string; readonly label: string }
  /** Top N% of hands by a documented ordering. */
  | { readonly kind: 'topPercent'; readonly percent: number; readonly label: string };

export interface ScenarioSeat {
  readonly seat: number;
  readonly label: string;
  /**
   * Chips behind, after whatever the seat committed this street. Not the seat's total.
   * Street-start chips are `stack + (committedThisStreet?.[seat] ?? 0)`, and an all-in seat has
   * `stack: 0`. The Coach's largest raise is `heroCommittedThisStreet + heroStack`, which is correct
   * only under this reading. `validate.ts` enforces it against `facingAction`.
   */
  readonly stack: number;
  /** Only hero's cards are known to the learner. */
  readonly isHero?: boolean;
  readonly holeCards?: string;
  readonly profile?: OpponentProfile;
}

/**
 * A Scenario Lab situation. It holds no equity, pot-odds figure or numeric answer. `expectedInsight`
 * states relationships the computed maths must satisfy.
 */
export interface Scenario {
  readonly id: ContentId;
  readonly title: string;
  readonly topic: Topic;
  readonly difficulty: Difficulty;
  /** The question put to the learner. */
  readonly question: string;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante?: number;
  readonly buttonSeat: number;
  readonly seats: readonly ScenarioSeat[];
  readonly board: string;
  /** Chips already in the middle from previous streets. */
  readonly potBeforeStreet: number;
  /** What each seat has committed on the current street. */
  readonly committedThisStreet?: Readonly<Record<number, number>>;
  readonly street: 'preflop' | 'flop' | 'turn' | 'river';
  /** The action hero is facing, in words. */
  readonly facingAction: string;
  /** What hero must call to continue, 0 if hero can check. */
  readonly toCall: number;
  /** The range assumption the analysis rests on. Always stated, never implied. */
  readonly opponentRange: RangeSpec;
  /** Assumptions the analysis depends on, shown next to every number. */
  readonly assumptions: readonly string[];
  /** The reasoning the learner should arrive at, in prose. */
  readonly reasoning: string;
  /** Machine-checkable claims. Verified by packages/content/test/scenarios.test.ts. */
  readonly expectedInsight: readonly ScenarioClaim[];
  /** Common wrong reasoning, named so the learner can recognise it. */
  readonly commonMistakes: readonly string[];
  readonly glossaryTerms: readonly ContentId[];
}

/** A machine-checkable claim, asserted against @prl/poker-math by the scenario tests. */
export type ScenarioClaim =
  | {
      /** Hero's equity against the stated range falls in [min, max]. */
      readonly kind: 'equityBetween';
      readonly min: number;
      readonly max: number;
    }
  | {
      /** The break-even equity needed to call falls in [min, max]. */
      readonly kind: 'breakEvenEquityBetween';
      readonly min: number;
      readonly max: number;
    }
  | {
      /** Calling has non-negative expected value (or negative, if `expect` is 'negative'). */
      readonly kind: 'callEvSign';
      readonly expect: 'positive' | 'negative' | 'breakEven';
    }
  | {
      /** Hero has this many clean outs (outs that make hero the favourite). */
      readonly kind: 'cleanOutsEquals';
      readonly outs: number;
    }
  | {
      readonly kind: 'dirtyOutsAtLeast';
      readonly outs: number;
    }
  | {
      /** Hero's equity exceeds the equity needed to call — a profitable call. */
      readonly kind: 'equityExceedsBreakEven';
    }
  | {
      readonly kind: 'breakEvenExceedsEquity';
    }
  | {
      /** SPR falls in [min, max]. */
      readonly kind: 'sprBetween';
      readonly min: number;
      readonly max: number;
    }
  | {
      /** The rule of 2/4 estimate is within `maxErrorPoints` of exact equity. */
      readonly kind: 'ruleOf24ErrorAtMost';
      readonly maxErrorPoints: number;
    };

/** Everything the content package exports, as one bundle. */
export interface ContentBundle {
  readonly version: string;
  readonly lessons: readonly Lesson[];
  readonly quizzes: readonly Quiz[];
  readonly scenarios: readonly Scenario[];
  readonly glossary: readonly GlossaryEntry[];
}
