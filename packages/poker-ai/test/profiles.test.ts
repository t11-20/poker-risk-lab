/**
 * Does a profile card agree with its own vector? `assertNoImpersonation` checks voice, not whether a
 * sentence matches the number beside it. `fundamentals-coach` once said "Does not adapt to you at
 * all" at `exploitativeAdaptation` 0.30. The check runs in `validateProfiles` at module load, and
 * these tests drive that function rather than restating its rule.
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

const NO_ADAPTATION_WORDINGS: readonly string[] = [
  'Does not adapt to you at all, by design.',
  'Never adapts to anything it has seen.',
  'Applies fundamentals with no reads at all.',
  'It does not adjust to you.',
  'Ignores what you have been doing.',
];

test('no shipped profile claims to ignore a read while carrying a non-zero adaptation trait', () => {
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
  // Built from a real profile so the sentence is the only thing wrong with it.
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
  // A profile that ignores everything it has seen is a legitimate design.
  const base = requireProfile('patient-technician');
  const honest: StrategyProfile = {
    ...base,
    traits: makeTraits({ ...base.traits, exploitativeAdaptation: 0 }, 'test'),
    styleNotes: [...base.styleNotes, 'Does not adapt to you at all, by design.'],
  };
  assert.doesNotThrow(() => validateProfiles([honest]));
});

/**
 * `expressTraits` zeroes adaptation at `educational`, so the guard reads the declared vector that
 * `profileCard` renders.
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
 * "Re-raises preflop more than any other profile here" is true under `threeBetShareOfEntries` and
 * false under the unconditional 3-bet rate, where looser profiles face more openings (3,000 hands:
 * `reading-pressure-specialist` 0.446 against `volume-grinder` 0.408).
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

  // Mirrors `threeBetRaiseShare` in `policy.ts`, written out so the card is checked against it.
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

  // The unconditional reading is false, which is why the sentence names its quantity.
  const grinderTraits = expressTraits(grinder, 'realistic');
  const specialist = expressTraits(requireProfile('reading-pressure-specialist'), 'realistic');
  assert.ok(specialist.vpip > grinderTraits.vpip, 'the profile that out-3-bets it is the looser one');
});
