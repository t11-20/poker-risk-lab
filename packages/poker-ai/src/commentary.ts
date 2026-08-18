/**
 * Learner-facing explanation: what the model preferred, and why.
 *
 * This is the "Explain" step of the loop (Play → Observe → Calculate → Compare → Explain →
 * Replay), and it is the highest-risk surface in the whole feature. Every string here is
 * prose about a *model*, generated from that model's own declared parameters and from
 * public game state. Nothing here describes a person.
 *
 * ## The voice, stated once so every template can be checked against it
 *
 * The grammatical subject of a model sentence is always **this model**, and every claim is
 * tied to a named trait axis *with its value*, so a learner can put the sentence next to
 * the profile card they picked and see where the behaviour came from. "This model prefers a
 * larger bet here because its sizing preference is high" is the shape. "Ivey senses
 * weakness" is fabrication about a human being, and "he would raise here" speaks for a
 * person about a decision they never made.
 *
 * ## Three guards, all at generation time, all in one chokepoint
 *
 * `publishCommentary()` is the only function in this package that produces a
 * `LearnerFacing` string, and it runs three checks before it does:
 *
 *   1. **`assertNoImpersonation`** from `labelling.ts` — the shared pattern list. It
 *      catches pronoun-led mental-state attribution, first-person openings, claims of
 *      endorsement, and overstatement of what the model is.
 *   2. **`assertModelVoice`** — the checks this file adds, and the interesting ones:
 *      * **No person-name token.** The list is derived from `naming.attributedName` across
 *        `PROFILES`, so it is *known data* rather than a verb list. `docs/AI-LEGENDS.md`
 *        §12 L7 names this as the gap in the pattern-based guard and this as the fix: the
 *        regex cannot catch "Ivey senses weakness" because there is no pronoun in it, but a
 *        name check catches it by the name.
 *      * **No human pronoun anywhere** (`he/him/his/she/her/hers/himself/herself`) and no
 *        first-person pronoun anywhere — not only at the start of the string, which is all
 *        the shared pattern list checks.
 *      * **No verdict word** (`correct`, `optimal`, `mistake`, `wrong`, `solved`, …). The
 *        product never says a play was right or wrong; it says what the maths supported and
 *        under which assumptions (`docs/PRODUCT-GUARDRAILS.md` §3).
 *      * **No caller-supplied identity label, verbatim.** See the trap below.
 *      * **No private card.** See the second trap below.
 *   3. **The type system.** Prose fields on the internal builders are typed
 *      `LearnerFacing`, which is a branded string. There is exactly **one** cast that mints
 *      one, inside `publishCommentary`, so a template that forgets the guard does not
 *      type-check. A test scans this file and asserts that the cast appears once — a
 *      convention nobody can quietly widen.
 *
 * ## Traps this file is built around, named rather than left to be discovered
 *
 * **An identity label handed in by a caller is untrusted prose.** `commentOnDecision`
 * receives an `actorLabel`, and in attributed naming mode that label contains a real
 * person's name. Interpolating it would smuggle the name into commentary while every
 * template stayed innocent. So a label is never placed in prose: it is only something the
 * output is checked *against*. Replay lines refer to the actor by role — "you" or "this
 * model" — and the UI renders the seat plate from `ProfileDisclosure`, where a name belongs.
 *
 * **The model's read of its own hand is derived from its hole cards, so it is not
 * representable here.** `PolicyDecisionSummary` has no field for an equity estimate, a
 * hand-strength band, or anything else computed from the cards the model can see and the
 * learner cannot. A hand that ends in a fold reveals nothing at a real table, and a replay
 * line saying "its read was strong" would hand over exactly the information the game is
 * played over. The guard also checks that no card the view holds privately appears in the
 * text — case-sensitively, because `as` and `ad` are English words while `As` and `Ad` are
 * cards, which is also why no template here may open a sentence with the word "As".
 *
 * **`always` and `never` are deliberately *not* in the pattern list.** Authored prose this
 * file reuses — the axis rationales in `stats.ts` — legitimately contains "never", and a
 * guard that rejects the material it is supposed to pass through gets worked around instead
 * of obeyed. The rule is kept where it belongs: the templates below avoid both words as
 * strategy claims, and say how often instead.
 *
 * **Trait *descriptions* are not interpolated, only labels and values.**
 * `TRAIT_DESCRIPTIONS.riskTolerance` contains the word "correct" in an authored,
 * carefully-scoped sentence. It is fine on a profile card and wrong in generated
 * commentary, and the verdict-word check would reject it — correctly.
 *
 * ## Reconciliation note: `./policy.ts` is owned by another module author
 *
 * This file touches the smallest possible surface of it, so a mismatch is one compile error
 * rather than a rewrite. What it consumes, and nothing else:
 *
 *   - `decision.action`, an engine `Action`
 *   - `decision.distribution`, entries carrying `{ action, probability }`
 *   - `decision.drivingTraits`, entries carrying `{ key, value }` — optional
 *
 * `PolicyDecision` also carries `modelPreference` and `whatChangedIt` strings of its own, and
 * this module deliberately **does not** forward them. Two reasons, both worth stating rather
 * than assuming:
 *
 *   1. Those strings are checked against `assertNoImpersonation` only. The name, pronoun,
 *      verdict-word and private-card checks live here, so the strings that reach the wire
 *      should be the ones minted here.
 *   2. A policy's own explanation of its decision can quote its hand assessment — an equity
 *      figure derived from its hole cards. That is information a learner is not entitled to
 *      for a hand that never showed down, which is why `PolicyDecisionSummary` cannot carry
 *      it and why the sentence is regenerated rather than passed along.
 *
 * A caller that knows the difficulty should pass it through:
 * `explainModelDecision({ decision: { ...policyDecision, difficulty }, ... })`. That is what
 * adds the noise-and-adaptation line and lets the explanation say where the vector in force
 * differs from the profile card.
 */

import type {
  ActionCandidate,
  CoachReport,
  DecisionQuality,
  LearnFromProfileResponse,
  ModelReasoning,
  ProfileObservedStats,
} from '@prl/contracts';
import { type Action, type Card, cardToString, type PlayerView, type SeatView } from '@prl/poker-engine';
import { assertNoImpersonation, type ProfileDisclosure } from './labelling.ts';
import {
  DIFFICULTY_SETTINGS,
  type Difficulty,
  expressTraits,
  PROFILES,
  type StrategyProfile,
} from './profiles.ts';
import { inversePreferredPotFraction, OBSERVABLE_AXES } from './stats.ts';
import {
  assertValidTraits,
  baselineTraits,
  biggestTraitDifferences,
  positionalVpipMultiplier,
  preferredPotFraction,
  stackDepthCommitmentMultiplier,
  TRAIT_LABELS,
  type TraitKey,
  type Traits,
} from './traits.ts';

export class CommentaryError extends Error {
  override readonly name = 'CommentaryError';
}

/**
 * A string that has been through `publishCommentary`, and therefore through every guard.
 *
 * The brand exists only in the type system — it has no runtime representation, so it costs
 * nothing and it cannot be stripped by serialisation. Internal builders type their prose
 * fields as `LearnerFacing`, so a template that returns a bare `string` fails to compile.
 * The wire types in `@prl/contracts` declare these fields as `string`, which a
 * `LearnerFacing` satisfies, so nothing downstream has to know the brand exists.
 */
export type LearnerFacing = string & { readonly learnerFacingBrand: 'checked-by-publishCommentary' };

// ---------------------------------------------------------------------------
// The policy decision, as commentary needs to see it
// ---------------------------------------------------------------------------

/** One entry of the pre-sampling distribution: an action and the weight it carried. */
export interface ActionProbability {
  readonly action: Action;
  /** 0..1. The whole distribution sums to 1. */
  readonly probability: number;
}

/**
 * The slice of a policy's decision this module needs.
 *
 * Deliberately narrow and deliberately structural. `policy.ts` owns the full `PolicyDecision`;
 * anything carrying these fields is accepted here without conversion — including that type,
 * which `test/commentary.test.ts` asserts at compile time so the two cannot drift apart
 * silently. Commentary never depends on the policy's internals. Two omissions are
 * load-bearing:
 *
 *   * **No hand assessment.** No equity figure, no strength band, nothing derived from the
 *     model's hole cards. See the module comment.
 *   * **No `HandState`, and no other seat's anything.** The reasoning is generated from
 *     this decision, the seat's own `PlayerView`, and the profile's declared parameters.
 *
 * `distribution` is required, not optional. A decision presented without the distribution
 * it was sampled from reads as a rule, and "these styles are not scripted" is a claim this
 * feature has to be able to show rather than assert (`docs/AI-LEGENDS.md` §6).
 */
export interface PolicyDecisionSummary {
  /** The action the policy sampled, exactly as it went to the engine. */
  readonly action: Action;
  /** The probability assigned to each legal action *before* sampling. Never empty. */
  readonly distribution: readonly ActionProbability[];
  /**
   * The trait vector actually in force — i.e. after `expressTraits` applied the difficulty.
   *
   * Optional, and resolved in this order: this field, then `expressTraits(profile,
   * difficulty)` when `difficulty` is given, then the profile's declared vector. Every value
   * printed in one `ModelReasoning` comes from whichever vector won, so nothing inside one
   * object can disagree with anything else in it.
   */
  readonly traits?: Traits;
  /**
   * The axes the policy itself weighted, when it reports them.
   *
   * Preferred over the mapping in this file, and the reason the preference matters: the
   * mapping here is a documented guess about which axes bear on a *kind* of action, while
   * this is what actually moved the score. Only the **keys** are used — every value printed
   * comes from the resolved vector above, so the two cannot drift apart inside one object.
   */
  readonly drivingTraits?: readonly { readonly key: TraitKey; readonly value: number }[];
  /** The difficulty in force, when the caller knows it. Adds the noise and adaptation note. */
  readonly difficulty?: Difficulty;
}

// ---------------------------------------------------------------------------
// The guards
// ---------------------------------------------------------------------------

/** Extra material a particular call site knows must not appear in its own output. */
export interface VoiceContext {
  /**
   * Identity labels the caller supplied (a display name, a seat plate, a short label).
   * Banned verbatim: identity belongs in `ProfileDisclosure`, not in prose.
   */
  readonly labels?: readonly string[];
  /** Cards visible only to the acting seat. Banned verbatim. */
  readonly privateCards?: readonly Card[];
}

/**
 * Name tokens taken from the profile set itself.
 *
 * Tokens shorter than three letters are dropped: none exists today, and a two-letter name
 * would match half the English language, which would break commentary rather than protect
 * anyone. Every token is plain letters, so none needs regex escaping — asserted below
 * rather than assumed, because a name with a full stop in it would otherwise build a
 * pattern that matches far more than intended.
 */
function personNameTokens(): readonly string[] {
  const tokens = new Set<string>();
  for (const profile of PROFILES) {
    const attributed = profile.naming.attributedName;
    if (attributed === undefined) continue;
    for (const rawToken of attributed.split(/\s+/u)) {
      const token = rawToken.replace(/[^\p{L}]/gu, '').toLowerCase();
      if (token.length >= 3) tokens.add(token);
    }
  }
  const list = [...tokens].sort();
  for (const token of list) {
    if (!/^\p{L}+$/u.test(token)) {
      throw new CommentaryError(`name token ${JSON.stringify(token)} is not plain letters`);
    }
  }
  return list;
}

const PERSON_NAME_TOKENS: readonly string[] = personNameTokens();

const PERSON_NAME_PATTERN = new RegExp(`\\b(?:${PERSON_NAME_TOKENS.join('|')})\\b`, 'iu');

/**
 * The patterns this file adds to the shared list in `labelling.ts`.
 *
 * Each one errs towards rejection. A false positive costs a reworded template; a false
 * negative ships a sentence that speaks for a person, or passes a verdict this product has
 * no basis for.
 */
const VOICE_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: PERSON_NAME_PATTERN,
    why: 'names a person; commentary describes the model, and a name belongs only in ProfileDisclosure',
  },
  {
    pattern: /\b(?:he|him|his|she|her|hers|himself|herself)\b/iu,
    why: 'uses a personal pronoun; the subject of a model sentence is "this model" and its possessive is "its"',
  },
  {
    pattern: /\b(?:i|me|my|mine|myself|we|us|our|ours)\b/iu,
    why: 'uses a first-person pronoun, which reads as a person speaking',
  },
  {
    pattern:
      /\b(?:correct|correctly|incorrect|incorrectly|optimal|optimally|suboptimal|gto|solved|mistake|mistakes|blunder|blunders|wrong|wrongly)\b/iu,
    why: 'passes a verdict on a play; say what the maths supported and under which assumptions instead',
  },
  {
    pattern: /\b(?:thinks?|feels?|believes?|senses?|intends?|wants?|remembers?)\b/iu,
    why: 'attributes a mental state; a model weights, prefers, treats and scores, it does not think',
  },
];

/** Role words the replay templates are built from, so a caller naming a role is not an echo. */
const ROLE_WORDS: ReadonlySet<string> = new Set([
  'you',
  'your',
  'model',
  'the model',
  'this model',
  'the learner',
  'hero',
]);

/**
 * Rejects generated prose that speaks for a person, passes a verdict, or leaks a card.
 *
 * Exported so the tests can prove the guard fires, and so `comparison.ts` can reuse the
 * same definition of the voice rather than growing a second one.
 */
export function assertModelVoice(text: string, where: string, context: VoiceContext = {}): void {
  for (const { pattern, why } of VOICE_PATTERNS) {
    const found = pattern.exec(text);
    if (found !== null) {
      throw new CommentaryError(
        `${where}: text ${JSON.stringify(text.slice(0, 120))} is not acceptable — ` +
          `${JSON.stringify(found[0])} ${why}.`,
      );
    }
  }
  for (const label of context.labels ?? []) {
    const trimmed = label.trim();
    // An empty label would match every string, so it is skipped rather than trusted.
    if (trimmed === '') continue;
    // A caller that hands in "you" is naming a role, not an identity, and the templates are
    // built from that word. Skipping the role words keeps this check about identity rather
    // than firing on the subject of the sentence.
    if (ROLE_WORDS.has(trimmed.toLowerCase())) continue;
    if (text.includes(trimmed)) {
      throw new CommentaryError(
        `${where}: text ${JSON.stringify(text.slice(0, 120))} repeats the identity label ` +
          `${JSON.stringify(trimmed)}. Refer to the actor by role — "you" or "this model" — and let the ` +
          'UI render the name from ProfileDisclosure.',
      );
    }
  }
  for (const card of context.privateCards ?? []) {
    const token = cardToString(card);
    // Case-sensitive and boundary-checked: "As" is a card, "as" is a word.
    if (new RegExp(`(?:^|[^\\p{L}])${token}(?:[^\\p{L}]|$)`, 'u').test(text)) {
      throw new CommentaryError(
        `${where}: text ${JSON.stringify(text.slice(0, 120))} contains ${token}, a card only the acting ` +
          'seat can see. Commentary is generated from public state and declared parameters.',
      );
    }
  }
}

/**
 * The one place a learner-facing string is minted.
 *
 * Whitespace is collapsed first so a template written across several lines cannot smuggle a
 * newline into a UI label, and so the guards see exactly the text a learner will read.
 */
export function publishCommentary(text: string, where: string, context: VoiceContext = {}): LearnerFacing {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed === '') throw new CommentaryError(`${where}: generated an empty string`);
  assertNoImpersonation(collapsed, where);
  assertModelVoice(collapsed, where, context);
  // The only cast that produces a LearnerFacing. Everything above it is the reason it is
  // safe, and `test/commentary.test.ts` asserts this is the only one in the file.
  return collapsed as LearnerFacing;
}

// ---------------------------------------------------------------------------
// Formatting, shared by every template
// ---------------------------------------------------------------------------

function formatChips(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatTraitValue(value: number): string {
  return value.toFixed(2);
}

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function formatSignedUnits(value: number): string {
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  return `${rounded >= 0 ? '+' : '-'}${Math.abs(rounded).toFixed(1)} units`;
}

function formatMultiplier(value: number): string {
  return `${value.toFixed(2)}x`;
}

/** "Aggression at 0.68" — the atom every model sentence is built from. */
function traitValue(key: TraitKey, value: number): string {
  return `${TRAIT_LABELS[key]} at ${formatTraitValue(value)}`;
}

function trait(key: TraitKey, traits: Traits): string {
  return traitValue(key, traits[key]);
}

/**
 * A cost as a multiple of the pot, in the same units as `preferredPotFraction`.
 *
 * A multiple rather than a percentage so the learner can read the size straight against the
 * profile's declared sizing preference — "a preferred 0.97 of the pot, and this one is 1.18"
 * is a comparison; "118.2% of the pot against a preferred 0.97" is arithmetic homework.
 */
function potFractionOf(cost: number, potBefore: number): string {
  return potBefore > 0 ? `${(cost / potBefore).toFixed(2)} of the pot` : 'an unmeasurable share of the pot';
}

/** The equity a call needs purely on price. Independent of either hand. */
function breakEvenEquity(potBefore: number, toCall: number): number {
  const denominator = potBefore + toCall;
  return denominator <= 0 ? 0 : toCall / denominator;
}

/** Present tense, for a sentence about a preference: "raise to 140". */
function describeAction(action: Action): string {
  switch (action.type) {
    case 'fold':
      return 'fold';
    case 'check':
      return 'check';
    case 'call':
      return 'call';
    case 'bet':
      return `bet ${formatChips(action.to)}`;
    case 'raise':
      return `raise to ${formatChips(action.to)}`;
    default:
      throw new CommentaryError(`unknown action type in ${JSON.stringify(action)}`);
  }
}

/** Past tense, for a replay line: "raised to 140". */
function describeActionTaken(action: Action): string {
  switch (action.type) {
    case 'fold':
      return 'folded';
    case 'check':
      return 'checked';
    case 'call':
      return 'called';
    case 'bet':
      return `bet ${formatChips(action.to)}`;
    case 'raise':
      return `raised to ${formatChips(action.to)}`;
    default:
      throw new CommentaryError(`unknown action type in ${JSON.stringify(action)}`);
  }
}

function actionTotal(action: Action): number | null {
  return action.type === 'bet' || action.type === 'raise' ? action.to : null;
}

function sameAction(left: Action, right: Action): boolean {
  if (left.type !== right.type) return false;
  return actionTotal(left) === actionTotal(right);
}

// ---------------------------------------------------------------------------
// Reading a CoachReport
//
// These live here rather than in comparison.ts because both files need them and the
// dependency runs one way: comparison imports commentary. One direction is enough.
// ---------------------------------------------------------------------------

/** The highest-EV candidate in the report. Throws on an empty candidate list. */
export function bestCandidate(analysis: CoachReport): ActionCandidate {
  let best: ActionCandidate | null = null;
  for (const candidate of analysis.candidates) {
    if (best === null || candidate.ev > best.ev) best = candidate;
  }
  if (best === null)
    throw new CommentaryError('a Coach report with no candidate actions cannot be compared against');
  return best;
}

/**
 * The candidate the report priced for this action, or null when it priced none.
 *
 * A bet and a raise are different actions to the engine and to the report, and they are not
 * matched across: a decision the report did not price is reported as unscored rather than
 * scored against something else. For a sized action the report offers three representative
 * sizes, so the chosen size is matched to the nearest one it priced — and every caller that
 * shows a figure derived from this says which size it used.
 */
export function candidateForAction(analysis: CoachReport, action: Action): ActionCandidate | null {
  const sameType = analysis.candidates.filter((candidate) => candidate.action === action.type);
  const first = sameType[0];
  if (first === undefined) return null;
  const target = actionTotal(action);
  if (target === null) return first;
  let nearest = first;
  for (const candidate of sameType) {
    const here = Math.abs((candidate.to ?? 0) - target);
    const bestSoFar = Math.abs((nearest.to ?? 0) - target);
    if (here < bestSoFar) nearest = candidate;
  }
  return nearest;
}

// ---------------------------------------------------------------------------
// explainModelDecision
// ---------------------------------------------------------------------------

/**
 * Which axes plausibly drove which action, when the policy does not say.
 *
 * A mapping, not a measurement: the policy scores every legal action from many traits at
 * once, and no post-hoc reading of one action can recover the exact weights. What this does
 * claim is narrower and true — these are the axes whose documented meaning bears on this
 * kind of action, and the values shown are the ones that were in force. `whatChangedIt`
 * carries the rest of the honesty. When `PolicyDecisionSummary.drivingTraits` is supplied it
 * is used first, because it is the real answer and this is the fallback.
 */
const AXES_BY_ACTION: Readonly<Record<Action['type'], readonly TraitKey[]>> = {
  fold: ['foldToPressure', 'riskTolerance', 'tournamentOrientation', 'vpip'],
  check: ['aggressionFrequency', 'bluffFrequency', 'barrelPersistence', 'valueBluffBalance'],
  call: ['riskTolerance', 'foldToPressure', 'vpip', 'aggressionFrequency'],
  bet: ['aggressionFrequency', 'betSizingPreference', 'pressureTendency', 'bluffFrequency'],
  raise: ['aggressionFrequency', 'pressureTendency', 'betSizingPreference', 'threeBetTendency'],
};

/**
 * Ranks the candidate axes by how much they distinguish *this* profile.
 *
 * Signature axes first — they are what the profile card highlights — then by distance from
 * the baseline vector, because an axis sitting on the baseline explains nothing about why
 * this profile played differently from a plain one.
 */
function rankAxes(
  keys: readonly TraitKey[],
  traits: Traits,
  signature: readonly TraitKey[],
): readonly TraitKey[] {
  const baseline = baselineTraits();
  return [...keys].sort((left, right) => {
    const signatureGap = Number(signature.includes(right)) - Number(signature.includes(left));
    if (signatureGap !== 0) return signatureGap;
    const distance = Math.abs(traits[right] - baseline[right]) - Math.abs(traits[left] - baseline[left]);
    if (distance !== 0) return distance;
    return left.localeCompare(right);
  });
}

/**
 * The axes a sentence may name, best first.
 *
 * The policy's own report comes first when it made one, in its order, and is then topped up
 * from the fallback mapping — a sentence needs two axes to name, and a policy that reports one
 * driving axis should not force the explanation to say less than it can.
 */
function chooseAxes(
  decision: PolicyDecisionSummary,
  traits: Traits,
  profile: StrategyProfile,
): readonly TraitKey[] {
  const reported = (decision.drivingTraits ?? []).map((entry) => entry.key);
  const fallback = rankAxes(AXES_BY_ACTION[decision.action.type], traits, profile.signatureTraits);
  const ordered = [...reported, ...fallback];
  const seen = new Set<TraitKey>();
  const out: TraitKey[] = [];
  for (const key of ordered) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function ownSeat(view: PlayerView, where: string): SeatView {
  if (view.viewerSeat === null) {
    throw new CommentaryError(
      `${where}: a model decision must be explained from that seat's own view, not a spectator view`,
    );
  }
  const self = view.seats.find((seat) => seat.isSelf);
  if (self === undefined)
    throw new CommentaryError(`${where}: view for seat ${view.viewerSeat} contains no own seat`);
  return self;
}

/**
 * The vector whose values every sentence quotes.
 *
 * Resolved once, in one place, so that a single `ModelReasoning` cannot mix a muted value into
 * one sentence and a declared value into the next. `expressTraits` is deterministic, so
 * recomputing it from the difficulty is exact rather than an approximation of what the policy
 * used.
 */
function traitsInForce(decision: PolicyDecisionSummary, profile: StrategyProfile): Traits {
  if (decision.traits !== undefined) return decision.traits;
  if (decision.difficulty !== undefined) return expressTraits(profile, decision.difficulty);
  return profile.traits;
}

function validateDecision(decision: PolicyDecisionSummary, view: PlayerView, where: string): void {
  if (decision.traits !== undefined) assertValidTraits(decision.traits, where);
  if (view.viewerSeat === null) {
    throw new CommentaryError(
      `${where}: a model decision must be explained from that seat's own view, not a spectator view`,
    );
  }
  if (decision.distribution.length === 0) {
    throw new CommentaryError(`${where}: a decision must carry the distribution it was sampled from`);
  }
  let total = 0;
  for (const entry of decision.distribution) {
    if (!Number.isFinite(entry.probability) || entry.probability < 0 || entry.probability > 1) {
      throw new CommentaryError(
        `${where}: probability ${entry.probability} for ${describeAction(entry.action)} is not a probability`,
      );
    }
    total += entry.probability;
  }
  if (Math.abs(total - 1) > 1e-3) {
    throw new CommentaryError(
      `${where}: the distribution sums to ${total.toFixed(4)}, so it is not a distribution`,
    );
  }
  const chosen = decision.distribution.find((entry) => sameAction(entry.action, decision.action));
  if (chosen === undefined || chosen.probability <= 0) {
    throw new CommentaryError(
      `${where}: ${describeAction(decision.action)} carries no weight in the distribution, so it cannot have been sampled from it`,
    );
  }
  if (view.toAct !== view.viewerSeat) {
    throw new CommentaryError(`${where}: the view must be the one in force while that seat was to act`);
  }
  if (!view.legalActions.some((legal) => legal.type === decision.action.type)) {
    throw new CommentaryError(
      `${where}: the engine did not offer "${decision.action.type}" in this view, and commentary must not explain an action that was never available`,
    );
  }
}

function preferenceSentence(input: {
  readonly action: Action;
  readonly traits: Traits;
  readonly axes: readonly TraitKey[];
  readonly potBefore: number;
  readonly toCall: number;
  readonly committedThisStreet: number;
}): string {
  const { action, traits, potBefore, toCall } = input;
  const [first, second] = input.axes;
  if (first === undefined || second === undefined) {
    throw new CommentaryError('a model sentence needs at least two candidate axes to name');
  }
  const pair = `${trait(first, traits)} and ${trait(second, traits)}`;
  const price = `${formatChips(toCall)} into a pot of ${formatChips(potBefore)}`;
  const needed = formatPercent(breakEvenEquity(potBefore, toCall));

  switch (action.type) {
    case 'fold':
      return toCall > 0
        ? `This model prefers to fold here — ${pair} — because ${price} asks for ${needed} to break even on price alone, and settings there decline that more often than they take it.`
        : `This model prefers to fold here with a free check available — ${pair} — which is far enough from a neutral vector to give up a hand that costs nothing to keep.`;
    case 'check':
      return `This model prefers to check here — ${pair} — so with nothing to call it takes the free card more often than it opens the betting into a pot of ${formatChips(potBefore)}.`;
    case 'call':
      return `This model prefers to call rather than escalate here — ${pair} — paying ${price}, a price that needs ${needed} to break even whatever either hand holds.`;
    case 'bet': {
      const fraction = potFractionOf(action.to - input.committedThisStreet, potBefore);
      return `This model prefers to bet ${formatChips(action.to)} here — ${pair}, with a preferred ${preferredPotFraction(traits).toFixed(2)} of the pot before other adjustments — which is ${fraction} of the ${formatChips(potBefore)} already in the middle.`;
    }
    case 'raise': {
      const fraction = potFractionOf(action.to - input.committedThisStreet, potBefore);
      return `This model prefers to raise to ${formatChips(action.to)} here rather than call ${formatChips(toCall)} — ${pair}, with a preferred ${preferredPotFraction(traits).toFixed(2)} of the pot before other adjustments — putting in ${fraction} of the ${formatChips(potBefore)} in the middle.`;
    }
    default:
      throw new CommentaryError(`unknown action type in ${JSON.stringify(action)}`);
  }
}

function positionLine(traits: Traits, self: SeatView): string {
  const worst = positionalVpipMultiplier(traits, 0);
  const best = positionalVpipMultiplier(traits, 1);
  const seat = self.position === null ? '' : ` This decision came from the ${self.position}.`;
  return (
    `Position: with ${trait('positionSensitivity', traits)}, this model's entry frequency spans ` +
    `${formatMultiplier(worst)} of its base rate in the first seat to ${formatMultiplier(best)} in the last, ` +
    `so the same holding from another seat is a different decision for it.${seat}`
  );
}

function stackDepthLine(traits: Traits, view: PlayerView, self: SeatView): string {
  const contenders = view.seats.filter(
    (seat) => !seat.isSelf && (seat.status === 'active' || seat.status === 'allIn'),
  );
  let biggestOther = 0;
  for (const seat of contenders) biggestOther = Math.max(biggestOther, seat.stack);
  const effective = contenders.length === 0 ? self.stack : Math.min(self.stack, biggestOther);
  if (effective <= 0) {
    return `Stack depth: with no chips behind on the other side of this pot, ${trait('stackDepthAdjustment', traits)} has nothing left to act on here.`;
  }
  const bigBlinds = effective / view.config.bigBlind;
  const here = stackDepthCommitmentMultiplier(traits, bigBlinds);
  const short = stackDepthCommitmentMultiplier(traits, 10);
  return (
    `Stack depth: at ${bigBlinds.toFixed(1)} big blinds effective, ${trait('stackDepthAdjustment', traits)} ` +
    `multiplies this model's willingness to commit by ${formatMultiplier(here)}; at 10 big blinds the same axis ` +
    `would make it ${formatMultiplier(short)} and pull the decision towards getting all-in.`
  );
}

function priceLine(traits: Traits, potBefore: number, toCall: number): string {
  const needed = breakEvenEquity(potBefore, toCall);
  const halved = breakEvenEquity(potBefore, toCall / 2);
  return (
    `Price: ${formatChips(toCall)} into ${formatChips(potBefore)} needs ${formatPercent(needed)} to break even, ` +
    `and half that bet would need ${formatPercent(halved)}; ${trait('riskTolerance', traits)} is the axis that ` +
    'decides how thin a price this model takes.'
  );
}

function sizingLine(traits: Traits): string {
  return (
    `Sizing: ${trait('sizingVariance', traits)} sets how much the size here tells you — a model near 0 on that ` +
    'axis uses one size for everything and hands you a read, a model near 1 does not.'
  );
}

function difficultyLine(traits: Traits, difficulty: Difficulty): string {
  const settings = DIFFICULTY_SETTINGS[difficulty];
  const adaptation = settings.adaptationEnabled
    ? `${trait('exploitativeAdaptation', traits)} is live, so what you have done in earlier hands moves this decision`
    : `${trait('exploitativeAdaptation', traits)} is switched off at this setting, so nothing you did in earlier hands moves this decision`;
  return (
    `Difficulty: at the ${settings.label} setting every score carries ${settings.noise.toFixed(2)} of added noise and ` +
    `${adaptation}.`
  );
}

function cardVersusSettingLine(declared: Traits, inForce: Traits, axes: readonly TraitKey[]): string | null {
  for (const key of axes) {
    const gap = Math.abs(declared[key] - inForce[key]);
    if (gap >= 0.02) {
      return (
        `Card versus setting: the profile card declares ${trait(key, declared)} and this decision used ` +
        `${formatTraitValue(inForce[key])}, because the difficulty setting pulls every axis part of the way ` +
        'towards a plain baseline vector.'
      );
    }
  }
  return null;
}

function mixLine(
  traits: Traits,
  distribution: readonly ActionProbability[],
  axes: readonly TraitKey[],
): string {
  const weighted = distribution.filter((entry) => entry.probability > 0).length;
  const [first] = axes;
  if (first === undefined) throw new CommentaryError('a mix sentence needs an axis to name');
  return (
    `Mix: this action was sampled from ${weighted} weighted options rather than applied as a rule, and ` +
    `${trait(first, traits)} is the axis that sets how much of that weight sat here — the same spot can come out ` +
    'differently next time.'
  );
}

/**
 * One sentence on what the model preferred, plus what would have moved it.
 *
 * `disclosure` is not interpolated anywhere. It is passed in so its display name and short
 * label can be banned from the output: that is the tightest available check that a name has
 * not leaked into prose, and it uses the data the call site already has.
 */
export function explainModelDecision(input: {
  readonly decision: PolicyDecisionSummary;
  readonly profile: StrategyProfile;
  readonly disclosure: ProfileDisclosure;
  readonly view: PlayerView;
}): ModelReasoning {
  const where = `explainModelDecision(${input.profile.naming.id})`;
  const { decision, view } = input;
  validateDecision(decision, view, where);

  const self = ownSeat(view, where);
  const traits = traitsInForce(decision, input.profile);
  const context: VoiceContext = {
    labels: [input.disclosure.displayName, input.disclosure.shortLabel],
    privateCards: self.holeCards ?? [],
  };

  const axes = chooseAxes(decision, traits, input.profile);
  const potBefore = view.potTotal;
  const toCall = view.amountToCall;

  const modelPreference = publishCommentary(
    preferenceSentence({
      action: decision.action,
      traits,
      axes,
      potBefore,
      toCall,
      committedThisStreet: self.committedThisStreet,
    }),
    `${where}.modelPreference`,
    context,
  );

  const changed: string[] = [positionLine(traits, self), stackDepthLine(traits, view, self)];
  if (toCall > 0) changed.push(priceLine(traits, potBefore, toCall));
  if (decision.action.type === 'bet' || decision.action.type === 'raise') changed.push(sizingLine(traits));
  if (decision.difficulty !== undefined) changed.push(difficultyLine(traits, decision.difficulty));
  const cardVersusSetting = cardVersusSettingLine(input.profile.traits, traits, axes);
  if (cardVersusSetting !== null) changed.push(cardVersusSetting);
  changed.push(mixLine(traits, decision.distribution, axes));

  return {
    modelPreference,
    drivingTraits: axes.slice(0, 3).map((key) => ({ key, label: TRAIT_LABELS[key], value: traits[key] })),
    whatChangedIt: changed.map((text, index) =>
      publishCommentary(text, `${where}.whatChangedIt[${index}]`, context),
    ),
    actionProbabilities: [...decision.distribution]
      .sort(
        (left, right) =>
          right.probability - left.probability ||
          describeAction(left.action).localeCompare(describeAction(right.action)),
      )
      .map((entry) => ({ action: describeAction(entry.action), probability: entry.probability })),
  };
}

// ---------------------------------------------------------------------------
// commentOnDecision
// ---------------------------------------------------------------------------

function headSentence(input: {
  readonly street: string;
  readonly potBefore: number;
  readonly toCall: number;
  readonly action: Action;
  readonly isUser: boolean;
}): string {
  const street = input.street === '' ? 'this street' : input.street;
  const opener = `${street.charAt(0).toUpperCase()}${street.slice(1)}`;
  const price =
    input.toCall > 0
      ? `${formatChips(input.toCall)} to call, ${formatPercent(breakEvenEquity(input.potBefore, input.toCall))} needed on price alone`
      : 'nothing to call';
  const actor = input.isUser ? 'you' : 'this model';
  return `${opener}, pot ${formatChips(input.potBefore)}, ${price}: ${actor} ${describeActionTaken(input.action)}.`;
}

function analysisSentence(analysis: CoachReport, action: Action, isUser: boolean): string {
  const best = bestCandidate(analysis);
  const chosen = candidateForAction(analysis, action);
  const subject = isUser ? 'The review analysis' : 'The review analysis of that spot';
  const bestText = `${describeAction(bestAsAction(best))} at ${formatSignedUnits(best.ev)}`;
  if (chosen === null) {
    return (
      `${subject} put its highest expected value on ${bestText} against folding at zero, and it did not price ` +
      `${describeAction(action)} at all, so this decision is left unscored rather than measured against something else.`
    );
  }
  const sized = actionTotal(action) !== null && chosen.to !== undefined && chosen.to !== actionTotal(action);
  const sizeNote = sized ? ` The nearest size the analysis priced was ${formatChips(chosen.to ?? 0)}.` : '';
  return (
    `${subject} put its highest expected value on ${bestText} against folding at zero, with ` +
    `${describeAction(action)} at ${formatSignedUnits(chosen.ev)} on the same range and fold-equity assumptions, ` +
    `at ${analysis.suggestion.confidence} confidence.${sizeNote}`
  );
}

/** Rebuilds an `Action` from a priced candidate, so one formatter covers both. */
function bestAsAction(candidate: ActionCandidate): Action {
  if (candidate.action === 'bet' || candidate.action === 'raise') {
    return { type: candidate.action, to: candidate.to ?? 0 };
  }
  return { type: candidate.action };
}

/**
 * The replay line's second sentence: which axis, and how much weight this action had.
 *
 * Returns null when the decision carries neither a trait vector nor a reported driving axis.
 * `commentOnDecision` is not given a profile, so there is nothing to fall back to — and a
 * sentence claiming an axis it cannot name would be worse than the silence. The line then
 * states the action and claims nothing about why, which is the honest degradation.
 */
function modelSentence(decision: PolicyDecisionSummary, action: Action): string | null {
  const named = namedAxis(decision, action);
  if (named === null) return null;
  const weighted = decision.distribution.filter((entry) => entry.probability > 0);
  const chosen = weighted.find((entry) => sameAction(entry.action, action));
  const share = chosen === undefined ? 'no recorded' : formatPercent(chosen.probability);
  return (
    `${named} is the axis behind that, and the action carried ${share} of the ` +
    `pre-sampling weight across ${weighted.length} options.`
  );
}

function namedAxis(decision: PolicyDecisionSummary, action: Action): string | null {
  if (decision.traits !== undefined) {
    const [first] = rankAxes(AXES_BY_ACTION[action.type], decision.traits, []);
    if (first === undefined) return null;
    return trait(first, decision.traits);
  }
  const [reported] = decision.drivingTraits ?? [];
  return reported === undefined ? null : traitValue(reported.key, reported.value);
}

/**
 * One replay line for one decision.
 *
 * `actorLabel` is never placed in the output — see the module comment. It is passed in so
 * that it can be *banned* from the output, which is what makes a caller in attributed
 * naming mode safe by construction rather than by review.
 */
export function commentOnDecision(input: {
  readonly street: string;
  readonly potBefore: number;
  readonly toCall: number;
  readonly actorLabel: string;
  readonly action: Action;
  readonly isUser: boolean;
  readonly analysis: CoachReport | null;
  readonly decision: PolicyDecisionSummary | null;
}): string {
  const where = 'commentOnDecision';
  for (const [name, value] of [
    ['potBefore', input.potBefore],
    ['toCall', input.toCall],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new CommentaryError(`${where}: ${name} must be a non-negative finite number, received ${value}`);
    }
  }
  const context: VoiceContext = { labels: [input.actorLabel] };

  const parts: string[] = [
    headSentence({
      street: input.street,
      potBefore: input.potBefore,
      toCall: input.toCall,
      action: input.action,
      isUser: input.isUser,
    }),
  ];
  if (input.analysis !== null) parts.push(analysisSentence(input.analysis, input.action, input.isUser));
  if (!input.isUser && input.decision !== null) {
    const model = modelSentence(input.decision, input.action);
    if (model !== null) parts.push(model);
  }

  return publishCommentary(parts.join(' '), where, context);
}

// ---------------------------------------------------------------------------
// learnFromSummary
// ---------------------------------------------------------------------------

/**
 * The observed side of each measurable axis, read off the wire type.
 *
 * `stats.ts` already owns the declared side, the tolerance and the reason for it, and those
 * are reused here rather than restated. Only the observed accessor is rebuilt: its
 * `ObservableAxis.observedFrom` reads a `SeatSimulationStats`, which carries the raw counts
 * a simulation harness produces, and what arrives here is the wire's `ProfileObservedStats`,
 * which does not. Two shapes, one meaning, so the mapping is written out once here.
 *
 * ## Two axes are deliberately absent, and the absence is the honest answer
 *
 * `Partial` is load-bearing: `observedGaps` skips any axis with no entry here, and two axes
 * have none because the wire type cannot express the quantity they declare.
 *
 * `aggressionFrequency` is declared as the rate on a NEUTRAL hand assessment. The wire's
 * `aggressionFrequency` is the unconditional rate — the one a tracker computes and the only
 * one a learner watching from the other side of the table could ever compute, since the
 * model's read of its own hand is derived from cards the learner cannot see. The two differ
 * by about 0.1 by construction (see `stats.ts`), so mapping one onto the other would print
 * "this model is not behaving the way its card describes" under every profile in the set, for
 * every learner, permanently — a false accusation generated by a units error.
 *
 * `threeBetTendency` is a multiplier on the flat-calling range, and its only frequency is the
 * share of the openings the model plays back at that it re-raises. The wire carries the
 * unconditional 3-bet frequency instead, which is capped by how often the model enters a pot
 * at all. Same mismatch, same false accusation.
 *
 * Adding the two conditional figures to `ProfileObservedStats` would let both axes come back.
 * Until then, saying nothing about an axis is better than saying something untrue about it —
 * and `learnFrom` already carries the profile's authored material on both.
 */
const OBSERVED_FROM_WIRE: Readonly<Partial<Record<TraitKey, (observed: ProfileObservedStats) => number>>> = {
  vpip: (observed) => observed.vpip,
  pfrShareOfVpip: (observed) => (observed.vpip === 0 ? 0 : observed.pfr / observed.vpip),
  bluffFrequency: (observed) => observed.bluffFrequency,
  foldToPressure: (observed) => observed.foldToBetFrequency,
  betSizingPreference: (observed) => inversePreferredPotFraction(observed.averageBetSizeAsPotFraction),
};

interface ObservedGap {
  readonly key: TraitKey;
  readonly declared: number;
  readonly observed: number;
  readonly gap: number;
  readonly tolerance: number;
  readonly why: string;
}

function observedGaps(traits: Traits, observed: ProfileObservedStats): readonly ObservedGap[] {
  const gaps: ObservedGap[] = [];
  for (const axis of OBSERVABLE_AXES) {
    const read = OBSERVED_FROM_WIRE[axis.key];
    if (read === undefined) continue;
    const declared = axis.declaredFrom(traits);
    const measured = read(observed);
    gaps.push({
      key: axis.key,
      declared,
      observed: measured,
      gap: Math.abs(declared - measured),
      tolerance: axis.tolerance,
      why: axis.why,
    });
  }
  return [...gaps].sort((left, right) => right.gap - left.gap || left.key.localeCompare(right.key));
}

function observedGapLine(entry: ObservedGap, traits: Traits, observed: ProfileObservedStats): string {
  const head =
    `Observed: the card declares ${trait(entry.key, traits)} and across ${observed.handsObserved} hands you ` +
    `have seen ${formatTraitValue(entry.observed)}, give or take ${formatTraitValue(observed.confidenceHalfWidth)} ` +
    'at 95% confidence';
  if (entry.gap <= entry.tolerance) {
    return `${head} — inside the ${formatTraitValue(entry.tolerance)} this axis allows, so the card and the play agree so far.`;
  }
  if (entry.gap <= observed.confidenceHalfWidth) {
    return (
      `${head} — further apart than the ${formatTraitValue(entry.tolerance)} this axis allows, but inside the ` +
      'sampling error, so this many hands cannot separate the two.'
    );
  }
  return (
    `${head} — further apart than both the ${formatTraitValue(entry.tolerance)} this axis allows and the sampling ` +
    'error, so this model is not behaving the way its card describes, which is a defect worth reporting rather ' +
    `than a quirk of the deal (${entry.why}).`
  );
}

function sampleLine(traits: Traits, observed: ProfileObservedStats, anchor: TraitKey): string {
  if (observed.handsObserved <= 0) {
    return (
      'Sample: no hands observed against this profile yet, so nothing here can be checked against its declared ' +
      `${trait(anchor, traits)}.`
    );
  }
  return (
    `Sample: ${observed.handsObserved} hands, with a 95% half-width of about ` +
    `${formatTraitValue(observed.confidenceHalfWidth)} on every frequency below — wide enough that a gap smaller ` +
    `than that says nothing about ${trait(anchor, traits)} or any other axis.`
  );
}

/** How many observed-versus-declared lines a summary carries before it stops being read. */
const MAX_OBSERVED_LINES = 3;

function observedLines(profile: StrategyProfile, observed: ProfileObservedStats | null): readonly string[] {
  if (observed === null) return [];
  const anchor = profile.signatureTraits[0] ?? 'vpip';
  const lines: string[] = [sampleLine(profile.traits, observed, anchor)];
  if (observed.handsObserved <= 0) return lines;
  for (const entry of observedGaps(profile.traits, observed).slice(0, MAX_OBSERVED_LINES)) {
    lines.push(observedGapLine(entry, profile.traits, observed));
  }
  return lines;
}

/**
 * "What can I learn from this player?" — the profile's own material, plus what the
 * learner's own session actually showed.
 *
 * Other profiles are named by their **archetype** name. That name exists in both naming
 * modes and is safe prose; deriving an attributed one here would need a naming mode this
 * function is not given, and inventing one would be the wrong kind of guess.
 */
export function learnFromSummary(input: {
  readonly profile: StrategyProfile;
  readonly disclosure: ProfileDisclosure;
  readonly observed: ProfileObservedStats | null;
  readonly others: readonly StrategyProfile[];
}): LearnFromProfileResponse {
  const where = `learnFromSummary(${input.profile.naming.id})`;
  const context: VoiceContext = { labels: [input.disclosure.displayName, input.disclosure.shortLabel] };

  const generated = observedLines(input.profile, input.observed).map((text, index) =>
    publishCommentary(text, `${where}.observed[${index}]`, context),
  );

  return {
    profileId: input.profile.naming.id,
    disclosure: input.disclosure,
    // The authored material comes first: it is what the profile is for. The generated
    // lines follow, because they only mean anything next to the claim they check.
    learnFrom: [...input.profile.learnFrom, ...generated],
    counterStrategy: [...input.profile.counterStrategy],
    observed: input.observed,
    contrasts: input.others
      .filter((other) => other.naming.id !== input.profile.naming.id)
      .map((other) => ({
        otherProfileId: other.naming.id,
        otherDisplayName: other.naming.archetypeName,
        differences: biggestTraitDifferences(input.profile.traits, other.traits, 3).map((difference) => ({
          key: difference.key,
          label: difference.label,
          delta: difference.delta,
        })),
      })),
  };
}

// ---------------------------------------------------------------------------
// outcomeVersusQualityNote
// ---------------------------------------------------------------------------

/**
 * The note shown when the chips and the maths point in opposite directions.
 *
 * Returns `null` whenever they agree, and whenever the hand was flat, so the note never
 * becomes wallpaper — a paragraph that appears under every hand is a paragraph nobody
 * reads, and this is the one worth reading.
 *
 * `slightly-off` returns `null` on purpose. A decision inside two big blinds of the best
 * expected value the report found is not in clear disagreement with any result; calling it
 * one would fire the note on most hands and cost it all its weight.
 *
 * Neither half of the note explains the other. It says both things are true, and says
 * plainly that the result is not evidence about the decision — which is the single most
 * transferable idea in the syllabus and the reason this field exists at all.
 */
export function outcomeVersusQualityNote(input: {
  readonly chipResult: number;
  readonly quality: DecisionQuality;
}): string | null {
  const { chipResult, quality } = input;
  if (!Number.isFinite(chipResult)) {
    throw new CommentaryError(`outcomeVersusQualityNote: chipResult must be finite, received ${chipResult}`);
  }
  if (!Number.isFinite(quality.evGivenUp)) {
    throw new CommentaryError(
      `outcomeVersusQualityNote: evGivenUp must be finite, received ${quality.evGivenUp}`,
    );
  }
  const shortfall = Math.abs(quality.evGivenUp).toFixed(1);
  const size = formatChips(Math.abs(chipResult));

  if (chipResult < 0 && quality.band === 'consistent-with-analysis') {
    return publishCommentary(
      `This hand lost ${size} units, and the analysis supported the line taken: every scored decision landed ` +
        `within ${shortfall} units of the best expected value the report found, on its stated assumptions. ` +
        'Both of those are true at the same time. A line the maths supports loses a large share of the time — ' +
        'that is what variance is, and one hand carries almost no information about the reasoning behind it. ' +
        'The result here is not evidence against the decisions, and there is nothing in it that needs changing.',
      'outcomeVersusQualityNote.wellPlayedLoss',
    );
  }

  if (chipResult > 0 && quality.band === 'materially-off') {
    return publishCommentary(
      `This hand won ${size} units, and the analysis did not support the line taken: the scored decisions gave ` +
        `up about ${shortfall} units of expected value against the best the report found, on its stated ` +
        'assumptions. The result does not settle that. One hand cannot show whether a decision was sound, so a ' +
        'win is not evidence for the decisions that produced it — which is why the chips and the analysis are ' +
        'reported side by side here, and why neither is ever used to explain the other.',
      'outcomeVersusQualityNote.badlyPlayedWin',
    );
  }

  return null;
}
