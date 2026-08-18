/**
 * Tests for src/commentary.ts.
 *
 * ## What is actually being proven here
 *
 * The interesting assertions in this file are not "the string looks right". They are:
 *
 *   1. **No generated string trips the guard, across hundreds of generated inputs.** The
 *      fuzz below walks every profile, every difficulty, several real hand situations and
 *      every action the engine offered in each of them, and asserts `findImpersonation`
 *      returns nothing for every learner-facing string produced. Views come from
 *      `startHand` + `redactFor`, so the inputs are the real redacted shape rather than a
 *      hand-written stand-in that might be missing the field that breaks a template.
 *   2. **The guard can fail.** A guard test that only ever sees passing text proves nothing,
 *      so `findImpersonation` and `assertModelVoice` are both fed text that must be
 *      rejected — including the three examples from `docs/AI-LEGENDS.md` §3.
 *   3. **The brand is minted in exactly one place.** A source scan asserts there is one
 *      `as LearnerFacing` cast in `src/commentary.ts`, with a proof that the scan would
 *      catch a second one. That is what makes "every string goes through the guard" a
 *      structural claim rather than a convention.
 *   4. **Every model sentence names a trait with its value.** Behaviour a learner cannot
 *      trace back to the profile card they picked is not an explanation.
 *   5. **The outcome-versus-quality note fires in exactly two of the four combinations**, so
 *      it stays the note that means something rather than wallpaper.
 *
 * Randomness in the fuzz comes from `createDeterministicRandomForTests`, so a failure here
 * is reproducible from the seed rather than a flake that reappears on Tuesdays.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ActionCandidate, CoachReport, DecisionQuality, ProfileObservedStats } from '@prl/contracts';
import {
  type Action,
  applyAction,
  cardToString,
  createDeterministicRandomForTests,
  type HandState,
  type PlayerView,
  redactFor,
  type SeatIndex,
  startHand,
  type TableConfig,
} from '@prl/poker-engine';
import {
  type ActionProbability,
  assertModelVoice,
  CommentaryError,
  commentOnDecision,
  explainModelDecision,
  learnFromSummary,
  outcomeVersusQualityNote,
  type PolicyDecisionSummary,
  publishCommentary,
} from '../src/commentary.ts';
import { findImpersonation, profileDisclosure } from '../src/labelling.ts';
import type { PolicyDecision } from '../src/policy.ts';
import { DIFFICULTIES, expressTraits, PROFILES, profileById, requireProfile } from '../src/profiles.ts';
import { TRAIT_KEYS, TRAIT_LABELS, type TraitKey } from '../src/traits.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// ---------------------------------------------------------------------------
// Real hands, real views
// ---------------------------------------------------------------------------

function config(overrides: Partial<TableConfig> = {}): TableConfig {
  return { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30, ...overrides };
}

function nextSeat(state: HandState): SeatIndex {
  const seat = state.toAct;
  if (seat === null) throw new Error('the scripted hand ended before the view was taken');
  return seat;
}

/** Plays a script and returns the acting seat's own view at the end of it. */
function situation(options: {
  readonly stacks: readonly number[];
  readonly maxSeats?: number;
  readonly script: readonly Action[];
  readonly seed: number;
  readonly bigBlind?: number;
}): PlayerView {
  const table = config({
    maxSeats: options.maxSeats ?? 6,
    ...(options.bigBlind === undefined
      ? {}
      : { bigBlind: options.bigBlind, smallBlind: options.bigBlind / 2 }),
  });
  let { state } = startHand({
    handId: `hand-${options.seed}`,
    roomId: 'room-1',
    handNumber: 1,
    config: table,
    buttonSeat: 0,
    seats: options.stacks.map((stack, index) => ({ seat: index, playerId: `p${index}`, stack })),
    random: createDeterministicRandomForTests(options.seed),
  });
  for (const action of options.script) {
    state = applyAction(state, nextSeat(state), action).state;
  }
  return redactFor(state, { viewerSeat: nextSeat(state) });
}

function situations(): readonly { readonly name: string; readonly view: PlayerView }[] {
  return [
    { name: 'preflop, first in', view: situation({ stacks: [200, 200, 200], script: [], seed: 7 }) },
    {
      name: 'preflop, facing a raise',
      view: situation({ stacks: [200, 200, 200], script: [{ type: 'raise', to: 6 }], seed: 11 }),
    },
    {
      name: 'flop, nothing to call',
      view: situation({
        stacks: [200, 200, 200],
        script: [{ type: 'raise', to: 6 }, { type: 'call' }, { type: 'fold' }],
        seed: 13,
      }),
    },
    {
      name: 'flop, facing a bet',
      view: situation({
        stacks: [200, 200, 200],
        script: [{ type: 'raise', to: 6 }, { type: 'call' }, { type: 'fold' }, { type: 'bet', to: 8 }],
        seed: 17,
      }),
    },
    {
      name: 'heads-up preflop',
      view: situation({ stacks: [100, 100], maxSeats: 2, script: [], seed: 19 }),
    },
    {
      name: 'short stacks, 15 big blinds',
      view: situation({ stacks: [30, 30, 30], script: [], seed: 23 }),
    },
    {
      name: 'a stack that only reaches a shove',
      view: situation({
        stacks: [200, 200, 5],
        script: [{ type: 'raise', to: 6 }, { type: 'fold' }],
        seed: 29,
      }),
    },
    {
      name: 'turn, facing a large bet',
      view: situation({
        stacks: [400, 400, 400],
        script: [
          { type: 'raise', to: 8 },
          { type: 'call' },
          { type: 'fold' },
          { type: 'bet', to: 12 },
          { type: 'call' },
          { type: 'bet', to: 40 },
        ],
        seed: 31,
      }),
    },
  ];
}

/** Every action the engine offered in this view, at a few sizes where it offered a range. */
function offeredActions(view: PlayerView): readonly Action[] {
  const out: Action[] = [];
  for (const legal of view.legalActions) {
    if (legal.type === 'fold' || legal.type === 'check' || legal.type === 'call') {
      out.push({ type: legal.type });
      continue;
    }
    const minTo = legal.minTo ?? 0;
    const maxTo = legal.maxTo ?? minTo;
    const middle = Math.floor((minTo + maxTo) / 2);
    for (const to of new Set([minTo, middle, maxTo])) {
      if (to >= minTo && to <= maxTo) out.push({ type: legal.type, to });
    }
  }
  return out;
}

/** A distribution over the offered actions, weighted by an injected deterministic source. */
function distributionOver(
  actions: readonly Action[],
  chosen: Action,
  seed: number,
): readonly ActionProbability[] {
  const random = createDeterministicRandomForTests(seed);
  const weights = actions.map((action) => {
    const isChosen =
      action.type === chosen.type &&
      ('to' in action ? action.to : null) === ('to' in chosen ? chosen.to : null);
    // The chosen action must carry weight: a policy cannot sample what it never scored.
    return (isChosen ? 4 : 0) + random.nextInt(5);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return actions.map((action, index) => ({
    action,
    probability: (weights[index] ?? 0) / total,
  }));
}

/**
 * A decision in one of the three shapes a caller can legitimately supply.
 *
 * The seed picks between them, so the fuzz covers all three: the full summary, a
 * `PolicyDecision`-style object that reports its driving axes but no vector, and the bare
 * minimum of an action and a distribution. All three have to produce guarded prose.
 */
function decisionFor(
  view: PlayerView,
  action: Action,
  profileId: string,
  seed: number,
): PolicyDecisionSummary {
  const profile = requireProfile(profileId);
  const difficulty = DIFFICULTIES[seed % DIFFICULTIES.length] ?? 'realistic';
  const traits = expressTraits(profile, difficulty);
  const distribution = distributionOver(offeredActions(view), action, seed);
  switch (seed % 3) {
    case 0:
      return { action, distribution, traits, difficulty };
    case 1:
      // The shape `policy.ts` returns: driving axes reported, no vector, no difficulty.
      return {
        action,
        distribution,
        drivingTraits: (profile.signatureTraits.length > 0
          ? profile.signatureTraits
          : TRAIT_KEYS.slice(0, 1)
        ).map((key) => ({ key, value: traits[key] })),
      };
    default:
      return { action, distribution, difficulty };
  }
}

// ---------------------------------------------------------------------------
// A CoachReport, built here so the EVs are exact
// ---------------------------------------------------------------------------

export function coachReport(options: {
  readonly candidates: readonly ActionCandidate[];
  readonly toCall?: number;
  readonly pot?: number;
  readonly confidence?: CoachReport['suggestion']['confidence'];
}): CoachReport {
  const pot = options.pot ?? 60;
  const toCall = options.toCall ?? 20;
  const best = [...options.candidates].sort((left, right) => right.ev - left.ev)[0];
  if (best === undefined) throw new Error('a test report needs at least one candidate');
  return {
    street: 'flop',
    potTotal: pot,
    toCall,
    outs: null,
    equity: {
      heroEquity: 0.42,
      method: 'monte-carlo',
      trials: 8000,
      confidenceHalfWidthPoints: 1.1,
      ruleOfThumb: null,
      perPlayer: [
        { label: 'you', equity: 0.42, win: 0.4, tie: 0.02 },
        { label: 'an opponent', equity: 0.58, win: 0.56, tie: 0.02 },
      ],
    },
    potOdds: {
      pot,
      toCall,
      breakEvenEquity: toCall / (pot + toCall),
      // `null`, not `0`, and for the same reason as in `comparison.test.ts`: a free call has
      // no "X to 1" price, and 0 is a price — the worst one there is. Two test helpers had
      // invented that third convention between them; the contract's `number | null` is the
      // only one now.
      oddsRatio: toCall === 0 ? null : pot / toCall,
      equitySurplus: 0.42 - toCall / (pot + toCall),
      explanation: 'A test price, stated so the figures below have something to be relative to.',
    },
    candidates: options.candidates,
    suggestion: {
      action: best.action,
      confidence: options.confidence ?? 'moderate',
      reason: 'A test suggestion, carrying its own confidence so nothing here reads as certainty.',
      whatWouldChangeIt: ['A different range assumption would move every figure here.'],
    },
    stackContext: {
      effectiveStack: 200,
      spr: 3.3,
      potOddsOfferedByPotSizedBet: 0.33,
      explanation: 'A test stack context.',
    },
    assumptions: ['Every figure here was invented by the test, and the arithmetic is the assertion.'],
    uncertainty: {
      method: 'monte-carlo',
      summary: 'A test uncertainty note.',
      confidenceInterval: { level: 0.95, halfWidthPoints: 1.1 },
      limitations: ['This report exists to pin band boundaries, not to describe a real spot.'],
    },
    teachingNotes: [],
  };
}

function candidate(action: ActionCandidate['action'], ev: number, to?: number): ActionCandidate {
  return {
    action,
    ...(to === undefined ? {} : { to }),
    cost: to ?? 0,
    ev,
    derivation: 'A test derivation.',
  };
}

// ---------------------------------------------------------------------------
// Assertions shared by the fuzz
// ---------------------------------------------------------------------------

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the text names a trait axis and gives its value to two decimals. */
function namesATraitWithValue(text: string): boolean {
  return TRAIT_KEYS.some((key: TraitKey) =>
    new RegExp(`${escapeForRegex(TRAIT_LABELS[key])} at \\d\\.\\d{2}`).test(text),
  );
}

function assertClean(text: string, where: string): void {
  const findings = findImpersonation(text);
  assert.deepEqual(
    findings.map((finding) => finding.why),
    [],
    `${where} tripped the impersonation guard: ${JSON.stringify(text)}`,
  );
  // The stricter local guard as well, with no context: a generated string must survive both.
  assertModelVoice(text, where);
}

// ---------------------------------------------------------------------------
// The guard, and the proof it can fail
// ---------------------------------------------------------------------------

test('findImpersonation rejects the shapes the shared pattern list covers', () => {
  const banned = [
    'He would think about raising here.',
    'I like a bet here.',
    'My read is that this spot is a fold.',
    'In their view the board favours a bet.',
    'This model is endorsed by the player it is named after.',
    'This profile is a digital twin of a real player.',
    'She feels the pressure and folds.',
    'The player famously said that aggression pays.',
    'They think the board favours a bet.',
  ];
  for (const text of banned) {
    assert.ok(findImpersonation(text).length > 0, `should have been rejected: ${JSON.stringify(text)}`);
  }
  // And the voice it requires is accepted, so the guard is not simply rejecting everything.
  assert.deepEqual(
    findImpersonation('This model prefers a larger bet here because its sizing preference is high.'),
    [],
  );
});

test('the shared pattern list catches a name plus a mental-state verb, and so does the local guard', () => {
  // This test used to assert the OPPOSITE: that the shared list could not see
  // "Ivey senses weakness" because the sentence contains no pronoun, and that only
  // commentary.ts's stricter local guard caught it. That was measured and documented rather
  // than assumed, which was right — but it left the shared guard weakest at the exact case it
  // was written to prevent, and four modules (policy, stats, opponent-model, profiles) gate on
  // the shared half alone.
  //
  // The shared list now carries a name-plus-mental-state-verb pattern and a gendered-pronoun
  // pattern. Both were validated against every string the package can produce (4,955 of them)
  // with zero false positives, so closing the gap cost nothing. Both guards must now catch it,
  // and the assertion is kept in BOTH directions so a later loosening of either one fails here.
  const impersonation = 'Ivey senses weakness and applies pressure.';
  const findings = findImpersonation(impersonation);
  assert.ok(findings.length > 0, 'the shared guard must catch a named person plus a mental-state verb');
  assert.match(findings[0]?.why ?? '', /named person/);
  assert.throws(() => assertModelVoice(impersonation, 'test'), /names a person/);

  // The other sentence the shared list used to miss: a gendered pronoun with a poker verb,
  // which the `would (say|tell|think|feel)` pattern could not see because `raise` is neither.
  assert.ok(findImpersonation('He would raise here.').length > 0);

  // And legitimate model commentary is still accepted, so this is not a guard that rejects
  // everything — which is the failure mode a tightened pattern list invites.
  assert.deepEqual(
    findImpersonation('This model prefers a larger bet, and it treats position as decisive.'),
    [],
  );
  // Every attributed name in the set is caught, whichever half of it appears.
  for (const profile of PROFILES) {
    const attributed = profile.naming.attributedName;
    if (attributed === undefined) continue;
    for (const token of attributed.split(' ')) {
      assert.throws(
        () => assertModelVoice(`This model plays a range close to the one ${token} plays.`, 'test'),
        /names a person/,
        `the name token ${JSON.stringify(token)} should be rejected in commentary`,
      );
    }
  }
});

test('assertModelVoice rejects what the shared pattern list misses', () => {
  const cases: readonly (readonly [string, RegExp])[] = [
    ['This model plays a range close to the one Ivey plays.', /names a person/],
    ['This model prefers a bet, and his range is wide.', /personal pronoun/],
    ['This model prefers a bet, and my read agrees.', /first-person pronoun/],
    ['This model prefers the correct bet here.', /verdict/],
    ['This model wants a bigger pot.', /mental state/],
  ];
  for (const [text, expected] of cases) {
    assert.throws(() => assertModelVoice(text, 'test'), expected, `should have been rejected: ${text}`);
  }
  assert.doesNotThrow(() =>
    assertModelVoice('This model prefers to bet: Aggression at 0.68 is the axis behind it.', 'test'),
  );
});

test('a caller-supplied label and a private card are both banned from prose', () => {
  assert.throws(
    () =>
      assertModelVoice('Phil Ivey — modelled style raised to 140.', 'test', {
        labels: ['Phil Ivey — modelled style'],
      }),
    /names a person/,
  );
  assert.throws(
    () =>
      assertModelVoice('The seat plate reads Passive Calling Station.', 'test', {
        labels: ['Passive Calling Station'],
      }),
    /repeats the identity label/,
  );
  // An empty label matches every string, so it must be skipped rather than trusted.
  assert.doesNotThrow(() => assertModelVoice('This model checked.', 'test', { labels: ['', '   '] }));

  const view = situations()[0]?.view;
  assert.ok(view !== undefined);
  const holeCards = view.seats.find((seat) => seat.isSelf)?.holeCards ?? null;
  assert.ok(holeCards !== null, 'the acting seat sees its own cards, which is what must not be printed');
  const card = holeCards[0];
  assert.throws(
    () =>
      assertModelVoice(`This model holds ${cardToString(card)} and prefers a bet.`, 'test', {
        privateCards: holeCards,
      }),
    /a card only the acting seat can see/,
  );
  // Case matters: "as" is a word, "As" is a card, and lowercase prose must survive.
  assert.doesNotThrow(() =>
    assertModelVoice('This model prefers a bet, as the price is short.', 'test', {
      privateCards: [card],
    }),
  );
});

test('publishCommentary rejects empty text and collapses whitespace', () => {
  assert.throws(() => publishCommentary('   ', 'test'), CommentaryError);
  assert.equal(publishCommentary('This  model\n  prefers a bet.', 'test'), 'This model prefers a bet.');
});

/**
 * Compile-time reconciliation with `policy.ts`.
 *
 * `PolicyDecisionSummary` exists so that commentary depends on the smallest possible surface
 * of the policy. This assertion is what stops that from being a hope: if `PolicyDecision` ever
 * stops being usable as a commentary input, the *typecheck* fails here with a named type
 * rather than the API failing to compile somewhere further out. It costs one erased type and
 * one boolean.
 */
type PolicyDecisionIsAcceptableHere = PolicyDecision extends PolicyDecisionSummary ? true : never;
const POLICY_DECISION_RECONCILED: PolicyDecisionIsAcceptableHere = true;

test('a policy decision is accepted as commentary input with no conversion', () => {
  assert.equal(POLICY_DECISION_RECONCILED, true);
});

test('the LearnerFacing brand is minted in exactly one place', () => {
  // This is what makes "every learner-facing string went through the guard" structural: the
  // only way to produce the branded type is the one cast inside publishCommentary.
  const source = readFileSync(join(SRC, 'commentary.ts'), 'utf8');
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const casts = withoutComments.match(/as LearnerFacing/g) ?? [];
  assert.equal(casts.length, 1, `expected exactly one brand cast, found ${casts.length}`);
  // Proof the scan can fail: it must count a second cast if one is ever added.
  assert.equal(
    ('const a = x as LearnerFacing; const b = y as LearnerFacing;'.match(/as LearnerFacing/g) ?? []).length,
    2,
  );
});

// ---------------------------------------------------------------------------
// The fuzz
// ---------------------------------------------------------------------------

test('explainModelDecision never impersonates, over every profile and every offered action', () => {
  let generated = 0;
  for (const { name, view } of situations()) {
    for (const action of offeredActions(view)) {
      for (const [index, profile] of PROFILES.entries()) {
        const disclosure = profileDisclosure(profile.naming, index % 2 === 0 ? 'archetype' : 'attributed');
        const decision = decisionFor(view, action, profile.naming.id, index + action.type.length);
        const reasoning = explainModelDecision({ decision, profile, disclosure, view });
        const where = `${name} / ${profile.naming.id} / ${action.type}`;

        assertClean(reasoning.modelPreference, `${where} modelPreference`);
        assert.ok(
          namesATraitWithValue(reasoning.modelPreference),
          `${where} modelPreference names no trait with its value: ${reasoning.modelPreference}`,
        );
        assert.ok(reasoning.modelPreference.startsWith('This model prefers'), `${where}: wrong voice`);

        assert.ok(reasoning.whatChangedIt.length >= 3, `${where}: too little context`);
        for (const [line, text] of reasoning.whatChangedIt.entries()) {
          assertClean(text, `${where} whatChangedIt[${line}]`);
          assert.ok(namesATraitWithValue(text), `${where} whatChangedIt[${line}] names no trait: ${text}`);
        }

        assert.ok(reasoning.drivingTraits.length > 0, `${where}: no driving traits`);
        // Every value printed comes from one vector, resolved the same way here as there.
        const inForce =
          decision.traits ??
          (decision.difficulty === undefined ? profile.traits : expressTraits(profile, decision.difficulty));
        for (const driving of reasoning.drivingTraits) {
          assert.equal(driving.label, TRAIT_LABELS[driving.key]);
          assert.equal(driving.value, inForce[driving.key]);
        }
        // A reported driving axis is used, so the explanation names what actually moved.
        const reported = decision.drivingTraits?.[0]?.key;
        if (reported !== undefined) assert.equal(reasoning.drivingTraits[0]?.key, reported);

        // The pre-sampling distribution is exposed, and it is a distribution.
        const total = reasoning.actionProbabilities.reduce((sum, entry) => sum + entry.probability, 0);
        assert.ok(Math.abs(total - 1) < 1e-9, `${where}: probabilities sum to ${total}`);
        assert.ok(reasoning.actionProbabilities.length >= 1);
        for (const entry of reasoning.actionProbabilities) assertClean(entry.action, `${where} action label`);

        // Identical input, identical output: nothing here reads a clock or a global.
        assert.deepEqual(explainModelDecision({ decision, profile, disclosure, view }), reasoning);
        generated += 1;
      }
    }
  }
  assert.ok(generated > 300, `the fuzz should cover hundreds of inputs, covered ${generated}`);
});

test('explainModelDecision shows more than one plausible action wherever more than one is legal', () => {
  for (const { view } of situations()) {
    const actions = offeredActions(view);
    if (actions.length < 2) continue;
    const action = actions[0];
    assert.ok(action !== undefined);
    const profile = requireProfile('adaptive-exploiter');
    const reasoning = explainModelDecision({
      decision: decisionFor(view, action, profile.naming.id, 5),
      profile,
      disclosure: profileDisclosure(profile.naming, 'archetype'),
      view,
    });
    const nonZero = reasoning.actionProbabilities.filter((entry) => entry.probability > 0);
    assert.ok(nonZero.length >= 2, 'a spot with several legal actions should show several weighted options');
  }
});

test('explainModelDecision refuses inputs that could not have happened', () => {
  const view = situations()[1]?.view;
  assert.ok(view !== undefined);
  const profile = requireProfile('patient-technician');
  const disclosure = profileDisclosure(profile.naming, 'archetype');
  const traits = expressTraits(profile, 'realistic');
  const legal = offeredActions(view);
  const action = legal[0];
  assert.ok(action !== undefined);

  // No distribution at all.
  assert.throws(
    () => explainModelDecision({ decision: { action, distribution: [], traits }, profile, disclosure, view }),
    /distribution it was sampled from/,
  );
  // A distribution that does not sum to 1.
  assert.throws(
    () =>
      explainModelDecision({
        decision: { action, distribution: [{ action, probability: 0.4 }], traits },
        profile,
        disclosure,
        view,
      }),
    /not a distribution/,
  );
  // An action with no weight cannot have been sampled.
  const other = legal[1];
  assert.ok(other !== undefined);
  assert.throws(
    () =>
      explainModelDecision({
        decision: {
          action,
          distribution: [
            { action, probability: 0 },
            { action: other, probability: 1 },
          ],
          traits,
        },
        profile,
        disclosure,
        view,
      }),
    /carries no weight/,
  );
  // An action the engine never offered.
  const illegal: Action = view.legalActions.some((entry) => entry.type === 'check')
    ? { type: 'call' }
    : { type: 'check' };
  assert.throws(
    () =>
      explainModelDecision({
        decision: { action: illegal, distribution: [{ action: illegal, probability: 1 }], traits },
        profile,
        disclosure,
        view,
      }),
    /did not offer/,
  );
  // A spectator view has no seat whose decision this could be.
  const spectator = { ...view, viewerSeat: null };
  assert.throws(
    () =>
      explainModelDecision({
        decision: { action, distribution: [{ action, probability: 1 }], traits },
        profile,
        disclosure,
        view: spectator,
      }),
    /own view/,
  );
});

test('commentOnDecision never impersonates, and never repeats the label it was handed', () => {
  const attributed = PROFILES.filter((profile) => profile.naming.attributedName !== undefined);
  const labels = [
    'you',
    ...attributed.map((profile) => profileDisclosure(profile.naming, 'attributed').shortLabel),
    ...attributed.map((profile) => profileDisclosure(profile.naming, 'archetype').shortLabel),
  ];
  const analyses: readonly (CoachReport | null)[] = [
    null,
    coachReport({
      candidates: [candidate('fold', 0), candidate('call', 2.4, 20), candidate('raise', -1.1, 60)],
    }),
    coachReport({
      candidates: [candidate('fold', 0), candidate('check', 0), candidate('bet', 1.2, 30)],
      toCall: 0,
    }),
  ];

  let generated = 0;
  for (const { name, view } of situations()) {
    for (const action of offeredActions(view)) {
      for (const [index, label] of labels.entries()) {
        for (const isUser of [true, false]) {
          const analysis = analyses[index % analyses.length] ?? null;
          const profile = PROFILES[index % PROFILES.length];
          assert.ok(profile !== undefined);
          const decision = isUser ? null : decisionFor(view, action, profile.naming.id, index + 1);
          const text = commentOnDecision({
            street: view.street,
            potBefore: view.potTotal,
            toCall: view.amountToCall,
            actorLabel: label,
            action,
            isUser,
            analysis,
            decision,
          });
          const where = `${name} / ${label} / ${action.type} / ${isUser ? 'user' : 'model'}`;
          assertClean(text, where);
          if (label.trim() !== '' && label !== 'you') {
            assert.ok(!text.includes(label), `${where}: the label leaked into prose`);
          }
          // A model line names an axis whenever the decision gave it one to name. With
          // neither a vector nor a reported axis there is no profile to fall back to, and the
          // line states the action and claims nothing about why.
          const canName =
            decision !== null && (decision.traits !== undefined || (decision.drivingTraits ?? []).length > 0);
          if (!isUser && canName) {
            assert.ok(namesATraitWithValue(text), `${where}: a model line names no trait: ${text}`);
          }
          if (!isUser && decision !== null && !canName) {
            assert.ok(!namesATraitWithValue(text), `${where}: named an axis it was never given`);
          }
          assert.ok(text.includes(isUser ? 'you ' : 'this model '), `${where}: no actor in the line`);
          generated += 1;
        }
      }
    }
  }
  assert.ok(generated > 300, `the fuzz should cover hundreds of inputs, covered ${generated}`);
});

test('commentOnDecision says when the analysis did not price the action taken', () => {
  const text = commentOnDecision({
    street: 'flop',
    potBefore: 60,
    toCall: 20,
    actorLabel: 'you',
    action: { type: 'check' },
    isUser: true,
    analysis: coachReport({ candidates: [candidate('fold', 0), candidate('call', 2.4, 20)] }),
    decision: null,
  });
  assert.match(text, /did not price check at all/);
  assert.match(text, /unscored/);
});

test('commentOnDecision rejects impossible inputs', () => {
  const base = {
    street: 'flop',
    potBefore: 60,
    toCall: 20,
    actorLabel: 'you',
    action: { type: 'call' } as Action,
    isUser: true,
    analysis: null,
    decision: null,
  };
  assert.throws(() => commentOnDecision({ ...base, potBefore: -1 }), /potBefore/);
  assert.throws(() => commentOnDecision({ ...base, toCall: Number.NaN }), /toCall/);
});

// ---------------------------------------------------------------------------
// learnFromSummary
// ---------------------------------------------------------------------------

function observedStats(overrides: Partial<ProfileObservedStats> = {}): ProfileObservedStats {
  return {
    handsObserved: 120,
    vpip: 0.3,
    pfr: 0.22,
    threeBetFrequency: 0.4,
    aggressionFrequency: 0.6,
    bluffFrequency: 0.35,
    wentToShowdown: 0.28,
    foldToBetFrequency: 0.5,
    averageBetSizeAsPotFraction: 0.75,
    confidenceHalfWidth: 0.09,
    ...overrides,
  };
}

test('learnFromSummary passes the authored material through and adds only guarded prose', () => {
  const profile = requireProfile('calling-station');
  const disclosure = profileDisclosure(profile.naming, 'archetype');
  const others = PROFILES.filter((other) => other.naming.id !== profile.naming.id);
  const summary = learnFromSummary({ profile, disclosure, observed: observedStats(), others });

  assert.equal(summary.profileId, 'calling-station');
  assert.deepEqual(summary.counterStrategy, profile.counterStrategy);
  for (const authored of profile.learnFrom) assert.ok(summary.learnFrom.includes(authored));
  assert.ok(summary.learnFrom.length > profile.learnFrom.length, 'the observed session should add something');

  for (const [index, line] of summary.learnFrom.slice(profile.learnFrom.length).entries()) {
    assertClean(line, `generated learnFrom[${index}]`);
    assert.ok(namesATraitWithValue(line), `generated learnFrom[${index}] names no trait: ${line}`);
  }

  // Contrasts name other profiles by archetype only — the name that is safe in both modes.
  assert.equal(summary.contrasts.length, others.length);
  for (const contrast of summary.contrasts) {
    const other = profileById(contrast.otherProfileId);
    assert.ok(other !== null);
    assert.equal(contrast.otherDisplayName, other.naming.archetypeName);
    assert.equal(contrast.differences.length, 3);
    assertModelVoice(contrast.otherDisplayName, 'contrast display name');
  }
});

test('learnFromSummary adds nothing observational when there is nothing observed', () => {
  const profile = requireProfile('disciplined-specialist');
  const disclosure = profileDisclosure(profile.naming, 'archetype');
  const none = learnFromSummary({ profile, disclosure, observed: null, others: [] });
  assert.deepEqual(none.learnFrom, [...profile.learnFrom]);
  assert.equal(none.observed, null);
  assert.deepEqual(none.contrasts, []);

  const empty = learnFromSummary({
    profile,
    disclosure,
    observed: observedStats({ handsObserved: 0, confidenceHalfWidth: 1 }),
    others: [],
  });
  const generated = empty.learnFrom.slice(profile.learnFrom.length);
  assert.equal(generated.length, 1);
  assert.match(generated[0] ?? '', /no hands observed/);
});

test('learnFromSummary separates sampling error from a model that does not match its card', () => {
  const profile = requireProfile('disciplined-specialist');
  const disclosure = profileDisclosure(profile.naming, 'archetype');

  // Declared vpip is 0.15. An observed 0.55 with a tight interval is a real disagreement.
  const wide = learnFromSummary({
    profile,
    disclosure,
    observed: observedStats({ vpip: 0.55, pfr: 0.5, confidenceHalfWidth: 0.02 }),
    others: [],
  });
  assert.ok(
    wide.learnFrom.some((line) => line.includes('not behaving the way its card describes')),
    'a gap past both the tolerance and the sampling error should be reported as a defect',
  );

  // The same gap with a 40-hand interval cannot be separated from noise, and must not be.
  const narrow = learnFromSummary({
    profile,
    disclosure,
    observed: observedStats({ handsObserved: 40, vpip: 0.55, pfr: 0.5, confidenceHalfWidth: 0.45 }),
    others: [],
  });
  assert.ok(
    narrow.learnFrom.some((line) => line.includes('cannot separate the two')),
    'a gap inside the sampling error should say the sample cannot separate the two',
  );
  assert.ok(!narrow.learnFrom.some((line) => line.includes('not behaving the way its card describes')));
});

test('learnFromSummary drops the profile from its own contrast list', () => {
  const profile = requireProfile('range-narrator');
  const summary = learnFromSummary({
    profile,
    disclosure: profileDisclosure(profile.naming, 'archetype'),
    observed: null,
    others: PROFILES,
  });
  assert.ok(!summary.contrasts.some((contrast) => contrast.otherProfileId === profile.naming.id));
});

// ---------------------------------------------------------------------------
// outcomeVersusQualityNote
// ---------------------------------------------------------------------------

function quality(band: DecisionQuality['band'], evGivenUp: number): DecisionQuality {
  return {
    bestAvailableEv: 2,
    chosenEv: 2 + evGivenUp,
    evGivenUp,
    band,
    note: 'A test note.',
  };
}

test('the outcome-versus-quality note fires in exactly the two combinations that disagree', () => {
  const wellPlayedLoss = outcomeVersusQualityNote({
    chipResult: -42,
    quality: quality('consistent-with-analysis', 0),
  });
  const badlyPlayedWin = outcomeVersusQualityNote({
    chipResult: 42,
    quality: quality('materially-off', -6.2),
  });
  const wellPlayedWin = outcomeVersusQualityNote({
    chipResult: 42,
    quality: quality('consistent-with-analysis', 0),
  });
  const badlyPlayedLoss = outcomeVersusQualityNote({
    chipResult: -42,
    quality: quality('materially-off', -6.2),
  });

  assert.ok(wellPlayedLoss !== null, 'a well-played hand that lost is the note that matters most');
  assert.ok(badlyPlayedWin !== null, 'a badly-played hand that won must not pass unremarked');
  assert.equal(wellPlayedWin, null, 'agreement must not produce a note, or the note becomes wallpaper');
  assert.equal(badlyPlayedLoss, null, 'agreement must not produce a note, or the note becomes wallpaper');

  // The separation has to be explicit in the wording, not implied by the field name.
  assert.match(wellPlayedLoss, /Both of those are true at the same time/);
  assert.match(wellPlayedLoss, /that is what variance is/);
  assert.match(wellPlayedLoss, /not evidence against the decisions/);
  assert.match(badlyPlayedWin, /The result does not settle that/);
  assert.match(badlyPlayedWin, /not evidence for the decisions that produced it/);
  assert.match(badlyPlayedWin, /neither is ever used to explain the other/);

  assertClean(wellPlayedLoss, 'wellPlayedLoss');
  assertClean(badlyPlayedWin, 'badlyPlayedWin');
});

test('a flat hand and a middling band produce no note', () => {
  assert.equal(
    outcomeVersusQualityNote({ chipResult: 0, quality: quality('consistent-with-analysis', 0) }),
    null,
  );
  assert.equal(outcomeVersusQualityNote({ chipResult: 0, quality: quality('materially-off', -9) }), null);
  // 'slightly-off' is not a clear disagreement with either result, in either direction.
  assert.equal(outcomeVersusQualityNote({ chipResult: -42, quality: quality('slightly-off', -2) }), null);
  assert.equal(outcomeVersusQualityNote({ chipResult: 42, quality: quality('slightly-off', -2) }), null);
});

test('the note rejects figures it cannot describe', () => {
  assert.throws(
    () =>
      outcomeVersusQualityNote({ chipResult: Number.NaN, quality: quality('consistent-with-analysis', 0) }),
    /chipResult must be finite/,
  );
  assert.throws(
    () =>
      outcomeVersusQualityNote({ chipResult: -1, quality: quality('consistent-with-analysis', Number.NaN) }),
    /evGivenUp must be finite/,
  );
});
