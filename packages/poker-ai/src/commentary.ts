/**
 * Learner-facing explanation of what the model preferred, and why. Every string is about a model,
 * built from its declared parameters and public game state. The subject is always "this model", and
 * each claim names a trait axis with its value.
 *
 * `publishCommentary()` is the only function that mints a `LearnerFacing` string. It runs
 * `assertNoImpersonation` (labelling.ts) and `assertModelVoice`, which bans attributed-name tokens from
 * `PROFILES` (docs/AI-LEGENDS.md L7), human and first-person pronouns anywhere, verdict words
 * (docs/PRODUCT-GUARDRAILS.md §3), caller identity labels, and the acting seat's private cards.
 * A test asserts the brand cast appears exactly once.
 *
 * Caller labels are only checked against, never interpolated, because attributed mode puts a real
 * name in them. `PolicyDecisionSummary` has no field derived from hole cards, and the policy's own
 * `modelPreference`/`whatChangedIt` strings are not forwarded for the same reason. Card checks are
 * case-sensitive ("As" is a card), so no template opens a sentence with "As".
 * `always` and `never` are not banned because `stats.ts` rationales use "never". Trait descriptions
 * are not interpolated because `riskTolerance` contains "correct".
 *
 * Pass `difficulty` in the decision to get the noise-and-adaptation line.
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

/** Type-only brand, minted in `publishCommentary`. The wire types accept it as a plain `string`. */
export type LearnerFacing = string & { readonly learnerFacingBrand: 'checked-by-publishCommentary' };

export interface ActionProbability {
  readonly action: Action;
  /** 0..1. The whole distribution sums to 1. */
  readonly probability: number;
}

/**
 * The slice of a policy decision this module needs. `PolicyDecision` satisfies it structurally, and
 * a compile-time test pins that. It has no hand assessment and nothing about other seats.
 * `distribution` is required so a decision never reads as a scripted rule (docs/AI-LEGENDS.md §6).
 */
export interface PolicyDecisionSummary {
  readonly action: Action;
  /** The probability assigned to each legal action *before* sampling. Never empty. */
  readonly distribution: readonly ActionProbability[];
  /**
   * The trait vector in force. Resolved as this field, then `expressTraits(profile, difficulty)`, then
   * the declared vector. Every printed value comes from the winner.
   */
  readonly traits?: Traits;
  /** The axes the policy weighted. Preferred over this file's mapping. Only the keys are used. */
  readonly drivingTraits?: readonly { readonly key: TraitKey; readonly value: number }[];
  /** The difficulty in force, when the caller knows it. Adds the noise and adaptation note. */
  readonly difficulty?: Difficulty;
}

/** Extra material a particular call site knows must not appear in its own output. */
export interface VoiceContext {
  /** Identity labels the caller supplied. Banned verbatim. */
  readonly labels?: readonly string[];
  /** Cards visible only to the acting seat. Banned verbatim. */
  readonly privateCards?: readonly Card[];
}

/**
 * Attributed-name tokens of three letters or more. Each must be plain letters, so none needs regex
 * escaping.
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

/** Added to the shared list in `labelling.ts`. Each errs towards rejection. */
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

/** Exported so tests can prove the guard fires and `comparison.ts` can reuse it. */
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
    if (trimmed === '') continue;
    // "you" names a role, and the templates are built from it.
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

/** Collapses whitespace first, so the guards see exactly the text the learner reads. */
export function publishCommentary(text: string, where: string, context: VoiceContext = {}): LearnerFacing {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed === '') throw new CommentaryError(`${where}: generated an empty string`);
  assertNoImpersonation(collapsed, where);
  assertModelVoice(collapsed, where, context);
  // The single brand cast in this file. `test/commentary.test.ts` asserts it is the only one.
  return collapsed as LearnerFacing;
}

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

function traitValue(key: TraitKey, value: number): string {
  return `${TRAIT_LABELS[key]} at ${formatTraitValue(value)}`;
}

function trait(key: TraitKey, traits: Traits): string {
  return traitValue(key, traits[key]);
}

/** A multiple of the pot, so it reads straight against `preferredPotFraction`. */
function potFractionOf(cost: number, potBefore: number): string {
  return potBefore > 0 ? `${(cost / potBefore).toFixed(2)} of the pot` : 'an unmeasurable share of the pot';
}

/** The equity a call needs purely on price. Independent of either hand. */
function breakEvenEquity(potBefore: number, toCall: number): number {
  const denominator = potBefore + toCall;
  return denominator <= 0 ? 0 : toCall / denominator;
}

/** Present tense, as in "raise to 140". */
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

/** Past tense, as in "raised to 140". */
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

// Shared with comparison.ts, which imports this file.

/** Throws on an empty candidate list. */
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
 * The candidate the report priced for this action, or null. Bet and raise never match each other.
 * A sized action matches the nearest size priced, and every caller showing the figure names that size.
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

/**
 * Axes whose meaning bears on each kind of action. A fallback mapping, not a measurement. The policy's
 * own `drivingTraits` wins when supplied.
 */
const AXES_BY_ACTION: Readonly<Record<Action['type'], readonly TraitKey[]>> = {
  fold: ['foldToPressure', 'riskTolerance', 'tournamentOrientation', 'vpip'],
  check: ['aggressionFrequency', 'bluffFrequency', 'barrelPersistence', 'valueBluffBalance'],
  call: ['riskTolerance', 'foldToPressure', 'vpip', 'aggressionFrequency'],
  bet: ['aggressionFrequency', 'betSizingPreference', 'pressureTendency', 'bluffFrequency'],
  raise: ['aggressionFrequency', 'pressureTendency', 'betSizingPreference', 'threeBetTendency'],
};

/** Signature axes first, then distance from the baseline, which is what distinguishes this profile. */
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

/** The policy's reported axes first, topped up from the fallback so a sentence can name two. */
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

/** Resolved once so one `ModelReasoning` never mixes muted and declared values. */
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

/**
 * The "nothing you did moves this decision" promise holds only while every channel out of
 * `opponent-model.ts` (`adjustmentsFor` and `rangeFor`) is gated on adaptation. Pinned by the
 * paired-decision test in `test/policy.test.ts` (0 of 1,050 changed). If a new channel appears,
 * gate it rather than soften this sentence.
 */
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
 * One sentence on what the model preferred, plus what would have moved it. `disclosure` is never
 * interpolated. Its names are passed in only so the output can be checked against them.
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
 * Which axis drove the action and how much weight it carried. Null when the decision carries neither
 * traits nor a driving axis, since there is no profile to fall back to.
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

/** One replay line. `actorLabel` is never placed in the output, only checked against. */
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

/**
 * The observed side of each axis, read from the wire's `ProfileObservedStats`. `stats.ts` owns the
 * declared side and tolerance. `Partial` matters. Three axes are left out because the wire cannot
 * express the quantity they declare.
 * `aggressionFrequency` is declared on a neutral hand read; the wire rate is unconditional and about
 * 0.1 lower by construction. `threeBetTendency` is a share of openings played back at; the wire rate
 * is capped by entry frequency. Both would accuse every profile falsely.
 * `foldToPressure` on the wire counts the preflop entry decision, so it tracks `vpip` in reverse
 * (8,000 hands). On priced turns observed rates span 0.165-0.301 against declared
 * 0.14-0.76, so the trait is a weight, not a frequency, and no watchable figure matches the card.
 */
const OBSERVED_FROM_WIRE: Readonly<Partial<Record<TraitKey, (observed: ProfileObservedStats) => number>>> = {
  vpip: (observed) => observed.vpip,
  pfrShareOfVpip: (observed) => (observed.vpip === 0 ? 0 : observed.pfr / observed.vpip),
  bluffFrequency: (observed) => observed.bluffFrequency,
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
 * The profile's own material plus what the learner's session showed. Other profiles are named by
 * archetype, which exists in both naming modes.
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
    // The generated lines only mean something next to the authored claim they check.
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

/**
 * Shown only when the chips and the analysis point in opposite directions. Null when they agree, when
 * the hand was flat, and for `slightly-off`, so the note stays rare enough to be read.
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
