/**
 * Content types: lessons, quizzes, glossary entries and Scenario Lab scenarios.
 *
 * ## The rule that shapes all of this
 *
 * Content stores *situations and reasoning*, never computed numbers. A scenario
 * says "hero holds Ah Kh, board is Qh 7h 2c, pot is 100, opponent bets 50, assume
 * this opponent range"; it does not say "hero has 35% equity". Every number the
 * learner sees is computed at runtime by `@prl/poker-math` from the situation.
 *
 * Two reasons this matters:
 *
 *   1. A hard-coded odds table is a lie waiting to happen. If the maths changes,
 *      or the number was wrong to begin with, nothing catches it — the content and
 *      the engine can disagree forever and the learner is taught the wrong thing.
 *   2. Tests can verify content. Because a scenario is a situation, the test suite
 *      can compute the answer independently and assert the teaching point holds.
 *
 * So `expectedInsight` below describes what should be true ("calling is
 * break-even or better", "folding is clearly best"), and the test suite checks
 * that the computed maths actually supports it. If a scenario's claim stops being
 * true, the build fails rather than the learner being misled.
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
      /**
       * Embeds a live calculation. The client computes it with @prl/poker-math and
       * renders the result, so the lesson text never contains a stale number.
       */
      readonly kind: 'liveCalculation';
      readonly calculation: LiveCalculation;
      readonly caption: string;
    }
  | { readonly kind: 'scenarioLink'; readonly scenarioId: ContentId; readonly prompt: string };

/**
 * A calculation a lesson or scenario asks the app to perform. The parameters are
 * the situation; the result is computed, never stored.
 */
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
      /**
       * Independent-chip-model prize equity for a stack/payout situation.
       * `stacks` and `payouts` are the situation; the shares are computed.
       */
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
      /**
       * The expected value is COMPUTED from `calculation`, not stored. The learner's
       * answer is accepted within `tolerance`.
       */
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
  /**
   * Deliberately absent: any notion of a score threshold, streak, or "pass".
   * Quizzes exist to surface reasoning, not to gate progress or manufacture
   * compulsion. See docs/PRODUCT-GUARDRAILS.md.
   */
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
  /**
   * A hand-class range in standard notation, e.g. "AA-TT, AKs, AQo+, 76s".
   * Parsed by @prl/poker-math into concrete combinations.
   */
  | { readonly kind: 'notation'; readonly notation: string; readonly label: string }
  /** Top N% of hands by a documented ordering. */
  | { readonly kind: 'topPercent'; readonly percent: number; readonly label: string };

export interface ScenarioSeat {
  readonly seat: number;
  readonly label: string;
  /**
   * Chips BEHIND: what this seat still has to put in, *after* whatever it has
   * already committed on the current street. It is NOT the seat's total.
   *
   * So a seat's chips at the start of the street are
   * `stack + (scenario.committedThisStreet?.[seat] ?? 0)`, and a seat that is all
   * in has `stack: 0` — nothing behind is the definition of all in, and a
   * jamming seat written with chips still behind is a content bug, not a
   * shorthand. `validate.ts` enforces both readings against the scenario's own
   * `facingAction` text.
   *
   * The distinction is load-bearing rather than pedantic. `readSituation` in
   * @prl/content passes this straight to `effectiveStack`, and the Coach computes
   * the largest legal raise as `heroCommittedThisStreet + heroStack` — which is
   * the total only under this reading. Under the other one it would double-count
   * every chip hero has already put in this street. The ambiguity has cost real
   * time: the release audit filed a P0 against that Coach line, and the P0 was
   * wrong, because the convention was never written down anywhere.
   *
   * The data has always meant this. In `foundations.json` every seat's
   * `stack + committedThisStreet` comes to the round 1000 the scenarios are built
   * on (990 + 10, 995 + 5), and `potBeforeStreet` equals the sum of what the
   * seats are missing from it. Neither holds under the "total" reading.
   */
  readonly stack: number;
  /** Only hero's cards are known to the learner. */
  readonly isHero?: boolean;
  readonly holeCards?: string;
  readonly profile?: OpponentProfile;
}

/**
 * A Scenario Lab situation.
 *
 * Note what is NOT here: any equity number, pot-odds percentage, or "correct
 * answer" expressed as a figure. `expectedInsight` states a *relationship* that the
 * computed maths must satisfy, and the scenario test suite enforces it.
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
  /**
   * Assumptions the learner must know the analysis depends on. These are shown
   * next to every number, because a number without its assumptions is a guess
   * dressed as a fact.
   */
  readonly assumptions: readonly string[];
  /** The reasoning the learner should arrive at, in prose. */
  readonly reasoning: string;
  /** Machine-checkable claims. Verified by packages/content/test/scenarios.test.ts. */
  readonly expectedInsight: readonly ScenarioClaim[];
  /** Common wrong reasoning, named so the learner can recognise it. */
  readonly commonMistakes: readonly string[];
  readonly glossaryTerms: readonly ContentId[];
}

/**
 * A machine-checkable claim about a scenario.
 *
 * The test suite computes the situation with @prl/poker-math and asserts each
 * claim. A scenario whose claim no longer holds fails the build, which is the whole
 * point: the teaching text and the maths cannot drift apart.
 */
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
