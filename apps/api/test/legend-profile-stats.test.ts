/**
 * The stored profile measurements are still what the simulation produces.
 *
 * ## Why the runs are stored, and what that costs
 *
 * `ProfileStatsResponse` had no producer anywhere — a wire type describing "what a large
 * deterministic simulation actually produced" with nothing producing it. The producer existed all
 * along in `@prl/poker-ai`; what was missing was a place to run it. It cannot be run per request: a
 * 4,000-hand run is about three seconds of solid CPU on the event loop of a server that is also
 * dealing live tables, and twelve of those behind an unauthenticated GET is a denial of service
 * anyone can trigger with a `for` loop.
 *
 * So the runs live in `src/routes/legends.ts` as a table. A table of numbers in a source file is
 * exactly the shape this release found repeatedly to be wrong — hand-authored figures with prose
 * derivations and no generator, which did not reproduce. The difference has to be made structural
 * rather than argued, and this file is the structure: every input that determines the table is
 * recorded beside it, and the run is re-performed here and compared exactly.
 *
 * ## What "exactly" means, and why not a tolerance
 *
 * `simulate` is deterministic from its seed, so the correct comparison is equality, not closeness.
 * A tolerance would let a genuine change in the policy — which is what this test exists to catch —
 * hide inside it until it grew. When this fails, the fix is to regenerate, not to widen:
 *
 * ```
 * // from apps/api, prints the STORED_RUNS body
 * node --experimental-strip-types -e "
 *   const {PROFILES,compareToDeclared,describeDivergence,seatStats,simulateHeadsUpAgainstReference,
 *          toObservedStats} = await import('@prl/poker-ai');
 *   const {PROFILE_SIMULATION} = await import('./src/routes/legends.ts');
 *   for (const p of PROFILES) {
 *     const run = simulateHeadsUpAgainstReference({ profileId: p.naming.id, ...PROFILE_SIMULATION });
 *     const stats = seatStats(run, 0);
 *     console.log(p.naming.id, JSON.stringify(toObservedStats(stats)),
 *                 JSON.stringify(compareToDeclared(p.naming.id, stats).divergences.map(
 *                   (d) => ({...d, note: describeDivergence(d)}))));
 *   }"
 * ```
 *
 * ## Only one profile is re-run
 *
 * Twelve runs is about forty seconds, which is not a unit test. One is enough for what this file
 * claims: the stored table came out of these functions with these inputs, and a change to the
 * policy invalidates it. The completeness of the table — a row for every profile, no row for
 * anything else — is asserted separately and costs nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compareToDeclared,
  describeDivergence,
  normalTwoSidedCriticalValue,
  PROFILES,
  seatStats,
  simulateHeadsUpAgainstReference,
  toObservedStats,
} from '@prl/poker-ai';
import { PROFILE_SIMULATION, profileStats, STORED_RUNS } from '../src/routes/legends.ts';

/** The profile re-simulated in full. Chosen for being the reference's opponent rather than itself. */
const REDERIVED = 'patient-technician';

describe('the stored profile simulations', () => {
  it('has a row for every profile and no row for anything else', () => {
    assert.deepEqual(Object.keys(STORED_RUNS).sort(), PROFILES.map((profile) => profile.naming.id).sort());
  });

  it('reproduces exactly when the simulation is re-run from the recorded inputs', () => {
    const run = simulateHeadsUpAgainstReference({
      profileId: REDERIVED,
      referenceProfileId: PROFILE_SIMULATION.referenceProfileId,
      difficulty: PROFILE_SIMULATION.difficulty,
      hands: PROFILE_SIMULATION.hands,
      seed: PROFILE_SIMULATION.seed,
    });
    const stats = seatStats(run, 0);
    const stored = STORED_RUNS[REDERIVED];
    assert.ok(stored !== undefined);
    assert.deepEqual(stored.simulated, toObservedStats(stats));
    assert.deepEqual(
      stored.divergences,
      compareToDeclared(REDERIVED, stats).divergences.map((divergence) => ({
        key: divergence.key,
        declared: divergence.declared,
        observed: divergence.observed,
        note: describeDivergence(divergence),
      })),
    );
  });

  it('states the hand count it was measured over rather than a number chosen elsewhere', () => {
    for (const [profileId, run] of Object.entries(STORED_RUNS)) {
      assert.equal(
        run.simulated.handsObserved,
        PROFILE_SIMULATION.hands,
        `${profileId} stores a different sample size from the one the runs were made at`,
      );
    }
  });

  it('carries a sampling interval consistent with that sample size', () => {
    // `z x sqrt(0.25 / n)`: the worst-case 95% half-width, which is what `stats.ts` publishes. A
    // figure claiming a narrower interval than its own sample allows is the fabrication this whole
    // surface is being corrected for, so it is checked rather than trusted.
    //
    // `z` comes from `normalTwoSidedCriticalValue` rather than from the textbook 1.96. That is not
    // pedantry: the package computes it from an inverse-normal approximation accurate to 1e-9, so a
    // rounded constant here disagrees in the seventh digit and this assertion fails for a reason
    // that has nothing to do with the figures. The same value, derived the same way, or nothing.
    const expected = normalTwoSidedCriticalValue(0.05) * Math.sqrt(0.25 / PROFILE_SIMULATION.hands);
    for (const [profileId, run] of Object.entries(STORED_RUNS)) {
      assert.ok(
        Math.abs(run.simulated.confidenceHalfWidth - expected) < 1e-9,
        `${profileId} reports a half-width of ${run.simulated.confidenceHalfWidth}, not ${expected}`,
      );
    }
  });

  it('serves every profile, with the provenance attached to the figures', () => {
    for (const profile of PROFILES) {
      const response = profileStats(profile.naming.id);
      assert.equal(response.profileId, profile.naming.id);
      assert.deepEqual(response.declaredTraits, profile.traits);
      assert.equal(response.simulationHands, PROFILE_SIMULATION.hands);
      assert.equal(response.simulationSeed, PROFILE_SIMULATION.seed);
      assert.equal(response.simulationDifficulty, PROFILE_SIMULATION.difficulty);
      assert.equal(response.referenceProfileId, PROFILE_SIMULATION.referenceProfileId);
      assert.ok(response.referenceName.length > 0, 'the opponent has to be nameable on screen');
      // The disclosure is what makes a profile safe to render at all, and it is required and
      // non-empty on the wire. Asserted here because this route builds it rather than inheriting it.
      assert.ok(response.disclosure.disclaimers.length > 0);
    }
  });

  it('refuses an unknown profile as content_not_found rather than inventing a run', () => {
    assert.throws(
      () => profileStats('no-such-profile'),
      (error: unknown) => error instanceof Error && error.name === 'AppError',
    );
  });

  it('never reports a divergence whose note does not name the axis it is about', () => {
    // The two conditional axes are the trap: `aggressionFrequency` is declared on a NEUTRAL hand
    // assessment and `threeBetTendency` is a multiplier, so a consumer pairing either against the
    // like-named field of `simulated` would print a false accusation under every profile. The note
    // is the only safe thing to render, so it must exist and must be about this axis.
    for (const run of Object.values(STORED_RUNS)) {
      for (const divergence of run.divergences) {
        assert.ok(divergence.note.length > 0, 'a divergence with no sentence cannot be rendered safely');
        assert.ok(
          divergence.note.includes('declares') && divergence.note.includes('measured'),
          'the sentence has to say which quantity is which',
        );
      }
    }
  });
});
