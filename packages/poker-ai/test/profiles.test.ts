/**
 * Tests for the profile set itself: does a card say what its own vector says?
 *
 * The existing guard on this material, `assertNoImpersonation`, checks the *voice* of every
 * learner-facing string — third person, about the model, no person's name. It cannot tell
 * whether a sentence agrees with the number printed beside it, and `profileCard` renders the
 * prose and the trait vector in one object. That gap shipped: `fundamentals-coach` carried
 * "Does not adapt to you at all, by design." in its styleNotes while its
 * `exploitativeAdaptation` trait was 0.30 — not even the lowest in the set, and rendered on
 * the same card as the radar axis "Adapts to opponents: 0.30".
 *
 * A profile that behaves differently from its own card is the worst defect this package can
 * have, and a card that contradicts itself is that defect one step earlier. So the check runs
 * inside `validateProfiles`, at module load, and the tests below drive that function rather
 * than restating its rule — a test that recomputes the implementation passes whenever both are
 * wrong the same way.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DIFFICULTIES,
  expressTraits,
  PROFILES,
  ProfileError,
  profileCard,
  requireProfile,
  type StrategyProfile,
  validateProfiles,
} from '../src/profiles.ts';
import { makeTraits } from '../src/traits.ts';

/** The wordings the guard rejects, phrased the way a card would actually carry them. */
const NO_ADAPTATION_WORDINGS: readonly string[] = [
  'Does not adapt to you at all, by design.',
  'Never adapts to anything it has seen.',
  'Applies fundamentals with no reads at all.',
  'It does not adjust to you.',
  'Ignores what you have been doing.',
];

test('no shipped profile claims to ignore a read while carrying a non-zero adaptation trait', () => {
  // The set as it stands must survive its own guard. Before the fix `fundamentals-coach`
  // failed twice here: styleNotes[2] "Does not adapt to you at all, by design." and
  // learnFrom[1] "...produce a solid strategy with no reads at all.", both at adaptation 0.30.
  assert.doesNotThrow(() => validateProfiles(PROFILES));

  const coach = requireProfile('fundamentals-coach');
  assert.equal(coach.traits.exploitativeAdaptation, 0.3, 'the number is what moves the play');
  const card = profileCard(coach, 'archetype');
  assert.equal(card.traits.exploitativeAdaptation, 0.3, 'and the card renders it beside the prose');
  assert.ok(
    card.styleNotes.some((note) => note.includes('0.30')),
    'so the note that describes the axis names the same figure the axis shows',
  );
});

test('validateProfiles refuses a profile whose prose and adaptation trait disagree', () => {
  // Built from a real profile so the ONLY thing wrong with it is the sentence: impersonation,
  // the minimum entry counts and the stated modelBasis all still pass, which is what makes it
  // certain that the new check is the one that fired.
  const base = requireProfile('patient-technician');
  assert.ok(base.traits.exploitativeAdaptation > 0);

  for (const field of ['styleNotes', 'learnFrom', 'counterStrategy'] as const) {
    for (const wording of NO_ADAPTATION_WORDINGS) {
      const bad: StrategyProfile = { ...base, [field]: [...base[field], wording] };
      assert.throws(
        () => validateProfiles([bad]),
        ProfileError,
        `"${wording}" in ${field} must be refused at adaptation ${base.traits.exploitativeAdaptation}`,
      );
    }
  }
});

test('the same claim is allowed on a profile whose adaptation trait really is zero', () => {
  // The guard has to be a guard, not a ban: a profile that genuinely ignores everything it has
  // seen is a legitimate design, and this is what would have to be true for the old sentence.
  const base = requireProfile('patient-technician');
  const honest: StrategyProfile = {
    ...base,
    traits: makeTraits({ ...base.traits, exploitativeAdaptation: 0 }, 'test'),
    styleNotes: [...base.styleNotes, 'Does not adapt to you at all, by design.'],
  };
  assert.doesNotThrow(() => validateProfiles([honest]));
});

/**
 * The claim is about the trait, not about one difficulty setting.
 *
 * `expressTraits` zeroes adaptation at `educational`, so at that setting *every* profile
 * ignores what it has seen. A card sentence that is only true at one of three settings is not
 * a true sentence about the profile, which is why the guard reads the declared vector — the
 * one `profileCard` renders — rather than an expressed one.
 */
test('adaptation is zero for every profile at educational and non-zero for all of them elsewhere', () => {
  assert.deepEqual(DIFFICULTIES, ['educational', 'realistic', 'expert']);
  for (const profile of PROFILES) {
    assert.equal(
      expressTraits(profile, 'educational').exploitativeAdaptation,
      0,
      `${profile.naming.id} must not adapt at the educational setting`,
    );
    assert.ok(
      expressTraits(profile, 'realistic').exploitativeAdaptation > 0,
      `${profile.naming.id} adapts at least a little at realistic, so the card cannot say it never does`,
    );
  }
});

/**
 * The superlative in `volume-grinder`'s styleNotes names its denominator, and has to.
 *
 * "Re-raises preflop more than any other profile here" is true under `threeBetShareOfEntries`
 * — the share of the openings it plays back at that it re-raises, the only frequency
 * `threeBetTendency` declares — and false under the natural reading. Measured over 3,000 hands
 * per profile at `realistic`, unconditional 3-bet frequency put `reading-pressure-specialist`
 * (0.446) and `old-school-pressure` (0.408) at or above `volume-grinder` (0.408), because both
 * are looser and face more openings. On the declared quantity `volume-grinder` leads: 0.934
 * declared and 0.886 observed, against 0.881 declared for the next profile.
 *
 * `traits.ts` warns about exactly this misreading on `threeBetTendency`. This test asserts the
 * arithmetic behind the sentence, so a trait edit that costs the profile the lead fails here
 * rather than leaving a false superlative on a card.
 */
test('volume-grinder really does lead on the quantity its styleNote names', () => {
  const grinder = requireProfile('volume-grinder');
  const note = grinder.styleNotes.find((text) => text.startsWith('Re-raises'));
  assert.ok(note !== undefined, 'the profile still carries a re-raise claim');
  assert.match(
    note,
    /share of the openings it plays back at/,
    'the claim must name its denominator; a bare superlative reads as 3-bet frequency and is false',
  );

  // Mirrors `threeBetRaiseShare` in `policy.ts`. Written out rather than imported on purpose:
  // importing the expression would make this pass whenever the mapping and the card moved
  // together, and the card is supposed to be checkable against the mapping.
  const share = (id: string): number => {
    const traits = expressTraits(requireProfile(id), 'realistic');
    return Math.min(1, traits.pfrShareOfVpip * (0.55 + 0.55 * traits.threeBetTendency));
  };
  const ranked = [...PROFILES].sort((left, right) => share(right.naming.id) - share(left.naming.id));
  assert.equal(
    ranked[0]?.naming.id,
    'volume-grinder',
    `the leader on the declared quantity is ${ranked[0]?.naming.id}, so the styleNote is false`,
  );
  assert.ok(
    share('volume-grinder') > share(ranked[1]?.naming.id ?? '') + 0.03,
    'and it leads by more than the 3,000-hand sampling error, not by a rounding error',
  );

  // The natural misreading really is false, which is why the sentence had to name the
  // quantity: a looser profile enters more pots and therefore makes more 3-bets outright.
  const grinderTraits = expressTraits(grinder, 'realistic');
  const specialist = expressTraits(requireProfile('reading-pressure-specialist'), 'realistic');
  assert.ok(specialist.vpip > grinderTraits.vpip, 'the profile that out-3-bets it is the looser one');
});
