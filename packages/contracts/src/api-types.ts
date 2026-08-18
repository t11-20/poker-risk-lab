/**
 * REST request and response shapes.
 *
 * These types are the contract between `apps/api` and `apps/web`. They intentionally
 * describe only what crosses the wire: nothing here contains a deck, a salt, or an
 * opponent's hole cards, because those never leave the server (see
 * `redactFor` in @prl/poker-engine).
 *
 * Every response body is an object, never a bare array. A top-level array cannot be
 * extended later without breaking clients, and it is the shape most likely to be
 * consumed by a JSON hijacking attack in older browsers.
 */

import type { ContentBundle, ContentId, GlossaryEntry, Lesson, Quiz, Scenario } from './content-types.ts';

/** Bumped when a breaking change lands. Clients send it; the server rejects mismatches. */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Session and identity
// ---------------------------------------------------------------------------

export type UserKind = 'guest' | 'oidc';

export interface SessionUser {
  readonly id: string;
  readonly kind: UserKind;
  readonly displayName: string;
  /**
   * Free, resettable, valueless play units. Named "units" everywhere in the UI —
   * never "chips you own", never a currency symbol, never a balance.
   */
  readonly units: number;
  readonly createdAt: string;
}

export interface SessionResponse {
  readonly user: SessionUser | null;
  /**
   * Token the client must echo in the `x-csrf-token` header on every mutating
   * request. Paired with a `__Host-`-prefixed, SameSite=Strict cookie.
   */
  readonly csrfToken: string | null;
  readonly protocolVersion: number;
  readonly oidcEnabled: boolean;
}

export interface CreateGuestRequest {
  /** 2–24 characters. Sanitised and length-checked server-side. */
  readonly displayName?: string;
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export interface LessonListResponse {
  readonly lessons: readonly LessonSummary[];
}

export interface LessonSummary {
  readonly id: ContentId;
  readonly title: string;
  readonly summary: string;
  readonly topic: string;
  readonly difficulty: string;
  readonly estimatedMinutes: number;
  readonly prerequisites: readonly ContentId[];
  readonly quizId?: ContentId;
  readonly completed: boolean;
}

export interface LessonResponse {
  readonly lesson: Lesson;
  readonly quiz: Quiz | null;
  readonly glossary: readonly GlossaryEntry[];
}

export interface ScenarioListResponse {
  readonly scenarios: readonly ScenarioSummary[];
}

export interface ScenarioSummary {
  readonly id: ContentId;
  readonly title: string;
  readonly topic: string;
  readonly difficulty: string;
  readonly question: string;
  readonly street: string;
  readonly attempted: boolean;
}

export interface ScenarioResponse {
  readonly scenario: Scenario;
  /** Computed live from the scenario, never stored. */
  readonly analysis: CoachReport;
  readonly glossary: readonly GlossaryEntry[];
}

export interface GlossaryResponse {
  readonly entries: readonly GlossaryEntry[];
}

export interface ContentBundleResponse {
  readonly bundle: ContentBundle;
}

// ---------------------------------------------------------------------------
// Quiz and scenario attempts
// ---------------------------------------------------------------------------

export interface QuizAttemptRequest {
  readonly questionId: ContentId;
  /** Index for multiple choice, number for numeric, action name for decision. */
  readonly answer:
    | { readonly kind: 'choice'; readonly index: number }
    | { readonly kind: 'number'; readonly value: number }
    | { readonly kind: 'action'; readonly action: string };
}

export interface QuizAttemptResponse {
  readonly correct: boolean;
  readonly explanation: string;
  /** Present for numeric questions: the computed value the answer was checked against. */
  readonly expected?: { readonly value: number; readonly unit: string; readonly tolerance: number };
  /** Present for multiple choice: why each option is right or wrong. */
  readonly optionNotes?: readonly string[];
}

export interface ScenarioAttemptRequest {
  readonly action: 'fold' | 'check' | 'call' | 'bet' | 'raise';
  readonly to?: number;
}

export interface ScenarioAttemptResponse {
  /**
   * Whether the chosen action matches what the computed analysis supports. Framed as
   * "consistent with the analysis", never as a score — see the product guardrails.
   */
  readonly consistentWithAnalysis: boolean;
  readonly reasoning: string;
  readonly analysis: CoachReport;
  readonly commonMistakes: readonly string[];
}

// ---------------------------------------------------------------------------
// The Coach
// ---------------------------------------------------------------------------

/**
 * Everything the Coach shows at a decision point.
 *
 * Shape rules that are not negotiable:
 *   - `assumptions` is never empty. A number without its assumptions is a guess.
 *   - `uncertainty` states the method and, for sampled results, the interval.
 *   - `suggestion` is a *suggestion with a reason*, never "the correct play", and
 *     `suggestion.confidence` may be 'low'.
 */
export interface CoachReport {
  readonly street: string;
  readonly potTotal: number;
  readonly toCall: number;

  readonly outs: OutsBreakdown | null;
  readonly equity: EquitySummary;
  readonly potOdds: PotOddsSummary;
  readonly candidates: readonly ActionCandidate[];
  readonly suggestion: CoachSuggestion;
  readonly stackContext: StackContext;

  /** Plain-language statements of everything the numbers depend on. Never empty. */
  readonly assumptions: readonly string[];
  readonly uncertainty: UncertaintyNote;
  /** Short teaching notes tied to this specific spot. */
  readonly teachingNotes: readonly string[];
}

export interface OutsBreakdown {
  /** Cards that make hero the winner against the assumed range. */
  readonly clean: number;
  /**
   * Cards that improve hero but can still lose — a flush card that also completes
   * a straight, a pair that gives an opponent a better two pair.
   */
  readonly dirty: number;
  readonly total: number;
  readonly cleanCards: readonly string[];
  readonly dirtyCards: readonly string[];
  readonly explanation: string;
}

export interface EquitySummary {
  readonly heroEquity: number;
  readonly method: 'exact-enumeration' | 'monte-carlo';
  readonly trials: number;
  readonly confidenceHalfWidthPoints: number | null;
  /** The rule-of-2/4 estimate and how far off it is, as a teaching aid. */
  readonly ruleOfThumb: {
    readonly estimate: number;
    readonly errorPoints: number;
    readonly note: string;
  } | null;
  readonly perPlayer: readonly {
    readonly label: string;
    readonly equity: number;
    readonly win: number;
    readonly tie: number;
  }[];
}

export interface PotOddsSummary {
  /** Chips already in the middle. */
  readonly pot: number;
  readonly toCall: number;
  /** `toCall / (pot + toCall)` — the equity a call needs to break even. */
  readonly breakEvenEquity: number;
  /**
   * The price as "x to 1", or `null` when the call is free and there is no price.
   *
   * `null` rather than a sentinel number, and that is a wire decision rather than a
   * modelling preference. `@prl/poker-math` used `Infinity` here — a defensible choice in
   * process, since 0 reads as "the worst price there is" and `NaN` poisons everything it
   * touches — but **JSON has no `Infinity`**: `JSON.stringify(Infinity)` is `"null"`, so
   * every free-call spot crossed this wire as `null` while this line declared `number`.
   * The client's formatter threw and took the route down with it.
   *
   * So the rule this member exists to illustrate: a contract may only declare types its own
   * serialisation can carry. `number | null` is what goes over the wire, survives
   * `JSON.parse(JSON.stringify(x))` unchanged, and forces every consumer to say out loud
   * what it does when there is no price to show.
   */
  readonly oddsRatio: number | null;
  /** Positive when hero's equity clears the break-even point. */
  readonly equitySurplus: number;
  readonly explanation: string;
}

export interface ActionCandidate {
  readonly action: 'fold' | 'check' | 'call' | 'bet' | 'raise';
  /**
   * The seat's TOTAL commitment for the street after the action, in the same
   * "raise to" units the engine's `Action.to` and `legalActions` use — not the
   * increment. Absent for fold and check, which move no chips.
   */
  readonly to?: number;
  /** Chips leaving the stack. For a raise that is the call plus the raise on top. */
  readonly cost: number;
  /** Expected value in units, relative to folding. */
  readonly ev: number;
  /** How the EV was arrived at, in words. */
  readonly derivation: string;
  /** Present for aggressive actions. */
  readonly foldEquityAssumed?: number;
  readonly potShareIfCalled?: number;
}

export interface CoachSuggestion {
  readonly action: 'fold' | 'check' | 'call' | 'bet' | 'raise';
  /**
   * The sizes that are defensible for this action, as street totals ("raise to"),
   * not a ladder of every size considered.
   *
   * A range rather than a single number because sizing is not that precise, but a
   * *bounded* one: both ends are candidate sizes priced within one big blind of the
   * best candidate, every candidate size between them is too, and both ends are sizes
   * the engine accepts.
   * `min === max` when only one size qualifies — a single defensible size, stated as
   * such rather than padded out into a span that would read as "anything in here is
   * fine". Absent when the suggested action has no size at all (fold, check).
   */
  readonly sizeRange?: { readonly min: number; readonly max: number };
  readonly confidence: 'low' | 'moderate' | 'reasonable';
  readonly reason: string;
  /** What would change this suggestion. Always populated. */
  readonly whatWouldChangeIt: readonly string[];
}

export interface StackContext {
  readonly effectiveStack: number;
  readonly spr: number;
  readonly potOddsOfferedByPotSizedBet: number;
  readonly explanation: string;
}

export interface UncertaintyNote {
  readonly method: 'exact-enumeration' | 'monte-carlo';
  readonly summary: string;
  readonly confidenceInterval: { readonly level: number; readonly halfWidthPoints: number } | null;
  /** Named limitations of this analysis. Never empty. */
  readonly limitations: readonly string[];
}

// ---------------------------------------------------------------------------
// Ad-hoc calculation endpoints
// ---------------------------------------------------------------------------

export interface EquityRequest {
  /** Two cards, e.g. "AhKh". */
  readonly heroCards: string;
  /** 0, 3, 4 or 5 community cards, e.g. "Qh 7h 2c". */
  readonly board?: string;
  /**
   * One to five opponents. Each is exact cards ("QsQd"), range notation
   * ("QQ+, AKs"), or a top-percentage ("top:15").
   */
  readonly opponents: readonly string[];
  /** Caps the Monte Carlo sample count. Server clamps to its own limit. */
  readonly samples?: number;
}

export interface EquityResponse {
  readonly equity: EquitySummary;
  readonly assumptions: readonly string[];
  readonly elapsedMs: number;
}

export interface CoachRequest {
  readonly heroCards: string;
  readonly board?: string;
  readonly opponents: readonly string[];
  readonly pot: number;
  readonly toCall: number;
  readonly heroStack: number;
  readonly opponentStacks: readonly number[];
  readonly bigBlind: number;
  readonly street: 'preflop' | 'flop' | 'turn' | 'river';
}

export interface CoachResponse {
  readonly report: CoachReport;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export interface CreateRoomRequest {
  readonly name: string;
  readonly maxSeats: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante?: number;
  readonly startingStack: number;
  readonly actionTimeoutSeconds?: number;
  /** Bots to seat immediately, by profile name. */
  readonly bots?: readonly { readonly profile: string; readonly count: number }[];
}

export interface CreateRoomResponse {
  readonly room: RoomSummary;
  /**
   * Returned exactly once, at creation. Only a hash is stored, so it cannot be
   * recovered later — the owner must share it now or create a new room.
   */
  readonly inviteCode: string;
}

export interface RoomSummary {
  readonly id: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly maxSeats: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante: number;
  readonly startingStack: number;
  readonly actionTimeoutSeconds: number;
  readonly status: 'open' | 'playing' | 'closed';
  /** Always 'invite_only'. There is no public matchmaking. */
  readonly visibility: 'invite_only';
  readonly members: readonly RoomMember[];
  readonly createdAt: string;
}

export interface RoomMember {
  readonly userId: string;
  readonly displayName: string;
  readonly seat: number | null;
  readonly stack: number;
  readonly isBot: boolean;
  readonly botProfile: string | null;
  readonly connected: boolean;
}

export interface JoinRoomRequest {
  readonly inviteCode: string;
}

export interface JoinRoomResponse {
  readonly room: RoomSummary;
}

export interface SitRequest {
  readonly seat: number;
}

export interface RoomListResponse {
  readonly rooms: readonly RoomSummary[];
}

// ---------------------------------------------------------------------------
// Hand history and review
// ---------------------------------------------------------------------------

export interface HandListResponse {
  readonly hands: readonly HandSummary[];
  readonly nextCursor: string | null;
}

export interface HandSummary {
  readonly id: string;
  readonly roomId: string;
  readonly handNumber: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly board: readonly string[];
  readonly heroNet: number | null;
  readonly endedByFold: boolean;
  readonly potTotal: number;
}

/** A completed hand, with per-decision analysis computed at read time. */
export interface HandReviewResponse {
  readonly hand: HandSummary;
  readonly commitmentRoot: string;
  readonly commitmentContext: string;
  /** Merkle proofs for the cards that legitimately became public. */
  readonly reveal: unknown;
  readonly verification: {
    readonly ok: boolean;
    readonly reason?: string;
    readonly verifiedPositions: number;
  };
  readonly seats: readonly HandReviewSeat[];
  readonly decisions: readonly HandReviewDecision[];
}

export interface HandReviewSeat {
  readonly seat: number;
  readonly displayName: string;
  readonly isBot: boolean;
  readonly startingStack: number;
  readonly net: number;
  /** Null unless this seat showed down, or it is the requesting user's own seat. */
  readonly holeCards: readonly string[] | null;
  readonly showedDown: boolean;
}

export interface HandReviewDecision {
  readonly sequence: number;
  readonly street: string;
  readonly seat: number;
  readonly action: string;
  readonly to: number | null;
  readonly amountPaid: number;
  readonly potBefore: number;
  readonly wasAutomatic: boolean;
  /**
   * Computed at review time for the requesting user's own decisions only. Analysing
   * an opponent's decision would require their hole cards, which the server will
   * not disclose even after the hand.
   */
  readonly analysis: CoachReport | null;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export interface ProgressResponse {
  readonly lessonsCompleted: readonly ContentId[];
  readonly scenariosAttempted: readonly ContentId[];
  readonly quizQuestionsAnswered: number;
  /**
   * Session statistics, framed for learning rather than achievement: no streaks,
   * no levels, no leaderboards.
   */
  readonly handsPlayed: number;
  readonly unitsNetLifetime: number;
  readonly topicsTouched: readonly string[];
}

export interface ResetUnitsResponse {
  readonly units: number;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  readonly status: 'ok';
  readonly version: string;
  readonly protocolVersion: number;
}

export interface ReadinessResponse {
  readonly status: 'ready' | 'degraded';
  readonly checks: Readonly<Record<string, { readonly ok: boolean; readonly detail?: string }>>;
}
