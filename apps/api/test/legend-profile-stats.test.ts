/**
 * The stored profile runs in `src/routes/legends.ts` must equal a fresh simulation. A 4,000-hand
 * run is about three seconds of CPU, so it cannot run per request. `simulate` is deterministic from
 * its seed, so the comparison is exact. When it fails, regenerate rather than widen. Only one
 * profile is re-run, because twelve take about forty seconds.
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

/** The reference's opponent rather than the reference itself. */
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
    // The worst-case 95% half-width `stats.ts` publishes. `z` comes from
    // `normalTwoSidedCriticalValue`, because a rounded 1.96 differs in the seventh digit.
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
      // This route builds the disclosure rather than inheriting it.
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
    // `aggressionFrequency` is declared on a neutral hand and `threeBetTendency` is a multiplier, so
    // pairing either with the like-named simulated field accuses falsely. The note must exist.
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
