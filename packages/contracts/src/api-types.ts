/**
 * REST request and response shapes between `apps/api` and `apps/web`.
 * Nothing here carries a deck, a salt or an opponent's hole cards (see `redactFor`).
 * Every response body is an object, never a bare array, so it can grow without breaking clients.
 */

import type { ContentBundle, ContentId, GlossaryEntry, Lesson, Quiz, Scenario } from './content-types.ts';

/** Bumped when a breaking change lands. Clients send it; the server rejects mismatches. */
export const PROTOCOL_VERSION = 1;

export type UserKind = 'guest' | 'oidc';

export interface SessionUser {
  readonly id: string;
  readonly kind: UserKind;
  readonly displayName: string;
  /** Free, resettable, valueless play units. Never shown as a currency or a balance. */
  readonly units: number;
  readonly createdAt: string;
}

export interface SessionResponse {
  readonly user: SessionUser | null;
  /** Echoed in `x-csrf-token` on every mutating request. Pairs with a `__Host-` SameSite=Strict cookie. */
  readonly csrfToken: string | null;
  readonly protocolVersion: number;
  readonly oidcEnabled: boolean;
}

export interface CreateGuestRequest {
  /** 2–24 characters. Sanitised and length-checked server-side. */
  readonly displayName?: string;
}

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
  /**
   * Whether the answer was stored. `false` is normal for a signed-out caller, who is graded but has no
   * user row. Required so the panel never claims to have recorded a discarded answer. A boolean
   * because `prl.quiz_attempts` is append-only and has no timestamp to echo.
   */
  readonly recorded: boolean;
}

/** `completed: false` records that the lesson was opened without claiming it was finished. */
export interface LessonReadRequest {
  readonly completed: boolean;
}

/**
 * The stored state after recording, so a client renders what the server holds.
 * `completedAt` is null until the lesson is finished and stays set afterwards.
 */
export interface LessonReadResponse {
  readonly lessonId: string;
  readonly completedAt: string | null;
  readonly lastViewedAt: string;
}

export interface ScenarioAttemptRequest {
  readonly action: 'fold' | 'check' | 'call' | 'bet' | 'raise';
  readonly to?: number;
}

export interface ScenarioAttemptResponse {
  /** Whether the action matches the computed analysis. Never framed as a score. */
  readonly consistentWithAnalysis: boolean;
  /** Whether a row was written. Same meaning as `QuizAttemptResponse.recorded`. */
  readonly recorded: boolean;
  readonly reasoning: string;
  readonly analysis: CoachReport;
  readonly commonMistakes: readonly string[];
}

/**
 * Everything the Coach shows at a decision point.
 * `assumptions` is never empty, `uncertainty` states the method and any sampling interval, and
 * `suggestion` is a suggestion with a reason, never "the correct play".
 */
export interface CoachReport {
  readonly street: string;
  /**
   * Every chip in the middle before hero's call, contested or not. `potOdds.pot` is the part hero can
   * win, and differs only when hero is all-in for less than the bet.
   */
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
  /** Cards that improve hero but can still lose, such as a flush card that also completes a straight. */
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
  /**
   * Chips in the middle that hero can win. Smaller than `CoachReport.potTotal` only when hero is
   * all-in for less than the bet, because the excess is a side pot hero cannot win. Every figure in
   * this summary is against this pot, so the price and the pot it buys into agree.
   */
  readonly pot: number;
  readonly toCall: number;
  /** `toCall / (pot + toCall)`, the equity a call needs to break even against the winnable pot. */
  readonly breakEvenEquity: number;
  /**
   * The price as "x to 1", or `null` when the call is free. Not `Infinity`, because JSON has no
   * `Infinity` and `JSON.stringify` turns it into `null`.
   */
  readonly oddsRatio: number | null;
  /** Positive when hero's equity clears the break-even point. */
  readonly equitySurplus: number;
  readonly explanation: string;
}

export interface ActionCandidate {
  readonly action: 'fold' | 'check' | 'call' | 'bet' | 'raise';
  /**
   * The seat's total commitment for the street after the action ("raise to", as in `Action.to`),
   * not the increment. Absent for fold and check.
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
   * Defensible sizes for this action, as street totals ("raise to"). Both ends, and every candidate
   * between them, are priced within one big blind of the best candidate and accepted by the engine.
   * `min === max` when only one size qualifies. Absent for fold and check.
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
  /** Returned once, at creation. Only a hash is stored, so it cannot be recovered. */
  readonly inviteCode: string;
}

export interface RoomSummary {
  readonly id: string;
  readonly name: string;
  /**
   * The creator, or null once that account is erased (`ON DELETE SET NULL` since migration 0004).
   * Null matches no session, so owner checks refuse everyone. A detached room is always closed.
   */
  readonly ownerUserId: string | null;
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
  /**
   * True while this seat owes a blind and is not dealt in yet. Derived from `LiveTable.owesBlind`.
   * Public, as at a real table. False for a member who is not seated.
   */
  readonly awaitingBigBlind: boolean;
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

/**
 * Why the server acted for a seat.
 *  - `timeout`: the seat's clock ran out (`applyTimeout`), so it checks if free and otherwise folds.
 *    A dropped connection reaches this too.
 *  - `departed`: the player stood up, left, or started another practice table while holding cards
 *    (`runAutomaticActions`), so the seat folds when the action reaches it.
 * All-in run-outs and sitting out make no decision and have no reason.
 */
export const AUTOMATIC_REASONS = ['timeout', 'departed'] as const;

export type AutomaticReason = (typeof AUTOMATIC_REASONS)[number];

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
   * Why the server decided, when `wasAutomatic`. Also null for automatic decisions archived before
   * `db/migrations/0009`, where a client must not guess. Additive, so no `PROTOCOL_VERSION` bump.
   */
  readonly automaticReason: AutomaticReason | null;
  /** Only for the requesting user's own decisions, because analysing others needs their hole cards. */
  readonly analysis: CoachReport | null;
}

export interface ProgressResponse {
  readonly lessonsCompleted: readonly ContentId[];
  readonly scenariosAttempted: readonly ContentId[];
  readonly quizQuestionsAnswered: number;
  /** Learning statistics only: no streaks, levels or leaderboards. */
  readonly handsPlayed: number;
  readonly unitsNetLifetime: number;
  readonly topicsTouched: readonly string[];
}

export interface ResetUnitsResponse {
  readonly units: number;
}

/**
 * The exact text `POST /me/delete` requires in `confirm`. Shared so `deleteAccountBodySchema` and the
 * web control agree character for character. A typed phrase rather than a boolean, so a mis-wired
 * client or a replay cannot erase an account. Lower case so the client can compare case-folded.
 */
export const ACCOUNT_DELETE_CONFIRMATION = 'delete my account';

export interface DeleteAccountRequest {
  /** Must equal `ACCOUNT_DELETE_CONFIRMATION`. Anything else is `invalid_request`. */
  readonly confirm: string;
}

/**
 * What the erasure did, counted table by table and verified inside the deleting transaction.
 * Policy in `db/migrations/0004_account_deletion.sql`.
 */
export interface DeleteAccountResponse {
  /** Rows that no longer exist. Every one of them described this learner and nobody else. */
  readonly deleted: {
    readonly sessions: number;
    readonly lessonsCompleted: number;
    readonly quizAttempts: number;
    readonly scenarioAttempts: number;
    /** Seats at tables, live and departed alike. The tables themselves are not deleted. */
    readonly roomMemberships: number;
  };
  /**
  /** Shared rows that still exist and no longer name this learner. */
  readonly anonymised: {
    /** Seats in played hands. The hand, its actions and its commitment proof are untouched. */
    readonly handSeats: number;
    readonly auditEvents: number;
    /** Tables this learner created. Each is closed and its creator is detached. */
    readonly roomsCreated: number;
  };
}

export interface HealthResponse {
  readonly status: 'ok';
  readonly version: string;
  readonly protocolVersion: number;
}

export interface ReadinessResponse {
  readonly status: 'ready' | 'degraded';
  readonly checks: Readonly<Record<string, { readonly ok: boolean; readonly detail?: string }>>;
}
