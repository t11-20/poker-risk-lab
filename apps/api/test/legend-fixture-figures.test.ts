/**
 * The Legends fixture's figures must match the shared EV model. Every candidate is re-derived from
 * the premises the fixture publishes on screen, not from its constants, so a figure that agrees
 * with the model but not its own printed premises still fails. `apps/web` cannot be imported
 * statically, so the fixture is loaded by URL. `@prl/poker-ai` is only available on this side.
 */

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  ActionCandidate,
  CoachReport,
  CompareProfilesResponse,
  DecisionQuality,
  HandComparison,
  LegendProfileCardDto,
} from '@prl/contracts';
import { MAX_COMPARE_TRIALS } from '@prl/contracts';
import {
  bandForShortfall,
  outcomeVersusQualityNote,
  PROFILES,
  TRAIT_DESCRIPTIONS,
  TRAIT_LABELS,
} from '@prl/poker-ai';
import { evOfBet, evOfCall, evOfRaise } from '@prl/poker-math';

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'web',
  'src',
  'fixtures',
  'legends.ts',
);

const module: Record<string, unknown> = (await import(pathToFileURL(FIXTURE).href)) as Record<
  string,
  unknown
>;

function exported<T>(name: string): T {
  const value = module[name];
  assert.ok(value !== undefined, `${name} is not exported from the legends fixture`);
  return value as T;
}

const HAND = exported<HandComparison>('HAND_COMPARISON_FIXTURE');
const BIG_BLIND = exported<number>('HAND_COMPARISON_BIG_BLIND');
const COMPARE = exported<CompareProfilesResponse>('COMPARE_FIXTURE');
const PROFILE_CARDS = exported<readonly LegendProfileCardDto[]>('LEGEND_PROFILE_FIXTURES');
const learnFromFixture = exported<(id: string) => { readonly observed: unknown } | null>('learnFromFixture');

/**
 * `pot` is `report.potTotal`, the pot before the action including the bet faced. A raise's
 * increment is `cost - toCall`, not `to - toCall`, because `to` includes chips already committed.
 * The risk is `cost`, so `evOfRaise` is charged `toCall + raiseBy`.
 */
function recompute(report: CoachReport, candidate: ActionCandidate): number {
  const pot = report.potTotal;
  const equity = candidate.potShareIfCalled ?? report.equity.heroEquity;
  switch (candidate.action) {
    case 'fold':
      return 0;
    case 'check':
      // `e x pot`, a free showdown.
      return evOfCall({ pot, toCall: 0, equity }).ev;
    case 'call':
      return evOfCall({ pot, toCall: report.toCall, equity }).ev;
    case 'bet': {
      assert.equal(report.toCall, 0, 'a bet is only legal with nothing to call');
      const fold = candidate.foldEquityAssumed;
      assert.ok(fold !== undefined, 'a bet without a stated fold frequency cannot be priced');
      return evOfBet({ pot, betSize: candidate.cost, foldProbability: fold, equityWhenCalled: equity }).ev;
    }
    case 'raise': {
      const fold = candidate.foldEquityAssumed;
      assert.ok(fold !== undefined, 'a raise without a stated fold frequency cannot be priced');
      return evOfRaise({
        pot,
        toCall: report.toCall,
        raiseBy: candidate.cost - report.toCall,
        foldProbability: fold,
        equityWhenCalled: equity,
      }).ev;
    }
    default:
      throw new Error(`no pricing convention for "${candidate.action}"`);
  }
}

function analyses(): readonly { readonly name: string; readonly report: CoachReport }[] {
  const found: { name: string; report: CoachReport }[] = [];
  for (const decision of HAND.decisions) {
    if (decision.analysis !== null) {
      found.push({
        name: `hand decision ${decision.sequence} (${decision.street})`,
        report: decision.analysis,
      });
    }
  }
  found.push({ name: 'the compare spot', report: COMPARE.analysis });
  return found;
}

describe('the Legends fixture prices every action the way @prl/poker-math does', () => {
  for (const { name, report } of analyses()) {
    it(`${name} reproduces from its own published premises`, () => {
      assert.ok(report.candidates.length > 0);
      for (const candidate of report.candidates) {
        const expected = recompute(report, candidate);
        assert.ok(
          Math.abs(candidate.ev - expected) < 1e-9,
          `${name}: ${candidate.action}${candidate.to === undefined ? '' : ` to ${candidate.to}`} ` +
            `stores ${candidate.ev.toFixed(4)} and prices at ${expected.toFixed(4)}`,
        );
      }
    });

    it(`${name} quotes its own figures in its derivations`, () => {
      // A prose derivation that names a different number from its row is invisible to a numeric check.
      for (const candidate of report.candidates) {
        if (candidate.action === 'fold') continue;
        const stated = candidate.ev.toFixed(1).replace('-', '');
        assert.ok(
          candidate.derivation.includes(stated),
          `${name}: the ${candidate.action} derivation does not quote ${stated}: ${candidate.derivation}`,
        );
      }
    });
  }

  it('the suggested size range contains the best-priced action', () => {
    for (const { name, report } of analyses()) {
      const range = report.suggestion.sizeRange;
      if (range === undefined) continue;
      const best = [...report.candidates].sort((left, right) => right.ev - left.ev)[0];
      assert.ok(best !== undefined);
      if (best.to === undefined) continue;
      assert.ok(
        best.to >= range.min && best.to <= range.max,
        `${name}: the range ${range.min}–${range.max} excludes ${best.to}, which is the best-priced size`,
      );
    }
  });
});

describe('the Legends fixture bands its decisions the way @prl/poker-ai does', () => {
  it('scores each decision against the best row the analysis priced', () => {
    for (const decision of HAND.decisions) {
      const quality: DecisionQuality | null = decision.userDecisionQuality;
      if (quality === null || decision.analysis === null) continue;
      const best = Math.max(...decision.analysis.candidates.map((candidate) => candidate.ev));
      assert.ok(
        Math.abs(quality.bestAvailableEv - best) < 1e-9,
        `decision ${decision.sequence}: best available is ${best}, stored ${quality.bestAvailableEv}`,
      );
      assert.ok(Math.abs(quality.evGivenUp - (quality.chosenEv - quality.bestAvailableEv)) < 1e-9);
      assert.equal(
        quality.band,
        bandForShortfall(Math.max(0, -quality.evGivenUp) / BIG_BLIND),
        `decision ${decision.sequence} is in the wrong band for its own shortfall`,
      );
    }
  });

  it('bands the hand, and lets that decide whether the outcome note exists', () => {
    const quality = HAND.decisionQuality;
    assert.equal(quality.band, bandForShortfall(Math.max(0, -quality.evGivenUp) / BIG_BLIND));
    // `slightly-off` returns null on purpose, so an authored note must not outlive the band that earns it.
    assert.equal(
      HAND.outcomeVersusQualityNote,
      outcomeVersusQualityNote({ chipResult: HAND.chipResult, quality }),
    );
  });

  it('sums the per-decision figures into the hand-level ones', () => {
    let best = 0;
    let chosen = 0;
    for (const decision of HAND.decisions) {
      const quality = decision.userDecisionQuality;
      if (quality === null) continue;
      best += quality.bestAvailableEv;
      chosen += quality.chosenEv;
    }
    assert.ok(Math.abs(HAND.decisionQuality.bestAvailableEv - best) < 1e-9);
    assert.ok(Math.abs(HAND.decisionQuality.chosenEv - chosen) < 1e-9);
  });
});

describe('the Legends fixture is a fixture, not a measurement', () => {
  it('offers every profile the server offers', () => {
    assert.deepEqual(
      PROFILE_CARDS.map((card) => card.id),
      PROFILES.map((profile) => profile.naming.id),
      'the offline roster and the served roster are the same set, in the same order',
    );
  });

  it('carries the same axis PROSE the served profiles do (REGRESSION)', () => {
    // Measured 2026-08-27, 25 trait descriptions in the fixture were wording the source had already
    // corrected. This is the offline path a reader sees whenever the API is unreachable.
    const labels = TRAIT_LABELS as Readonly<Record<string, string>>;
    const descriptions = TRAIT_DESCRIPTIONS as Readonly<Record<string, string>>;
    let compared = 0;
    for (const card of PROFILE_CARDS) {
      for (const axis of card.axes) {
        assert.equal(axis.label, labels[axis.key], `${card.id}.${axis.key}: the fixture's label is stale`);
        assert.equal(
          axis.description,
          descriptions[axis.key],
          `${card.id}.${axis.key}: the fixture's description is stale`,
        );
        compared += 2;
      }
    }
    assert.ok(compared >= 100, `only ${compared} string(s) compared; a sweep of nothing is not a pass`);
  });

  it('carries the same style notes the served profiles do (REGRESSION)', () => {
    // `profiles.ts` documents the old `volume-grinder` sentence as false.
    const byId = new Map(PROFILES.map((profile) => [profile.naming.id, profile]));
    let compared = 0;
    for (const card of PROFILE_CARDS) {
      const profile = byId.get(card.id);
      assert.ok(profile !== undefined, `${card.id} is in the fixture and not in the served set`);
      assert.deepEqual(
        card.styleNotes,
        profile.styleNotes,
        `${card.id}: the fixture's style notes are stale`,
      );
      // These were not covered at first, and `calling-station`'s corrected strings went stale.
      assert.deepEqual(card.learnFrom, profile.learnFrom, `${card.id}: the fixture's learnFrom is stale`);
      assert.deepEqual(
        card.counterStrategy,
        profile.counterStrategy,
        `${card.id}: the fixture's counterStrategy is stale`,
      );
      compared += 3;
    }
    assert.ok(compared >= 10, `only ${compared} profile(s) compared; a sweep of nothing is not a pass`);
  });

  it('carries the SAME trait numbers the served profiles do (REGRESSION)', () => {
    // The fixture copies the trait blocks from `profiles.ts`, so tuning a profile left `/legends`
    // describing the old one. Compared over the keys the fixture declares, because `makeTraits`
    // fills every key on the profile side. The count stops a sweep of nothing passing.
    let compared = 0;
    for (const card of PROFILE_CARDS) {
      const profile = PROFILES.find((candidate) => candidate.naming.id === card.id);
      assert.ok(profile !== undefined, `${card.id} is in the fixture and not in PROFILES`);
      const keys = Object.keys(card.traits) as (keyof typeof profile.traits)[];
      assert.ok(keys.length >= 12, `${card.id} declares only ${keys.length} traits in the fixture`);
      for (const key of keys) {
        assert.equal(
          card.traits[key as keyof typeof card.traits],
          profile.traits[key],
          `${card.id}.${String(key)}: the fixture says ` +
            `${String(card.traits[key as keyof typeof card.traits])} and @prl/poker-ai says ` +
            `${String(profile.traits[key])}`,
        );
        compared += 1;
      }
    }
    assert.ok(
      compared >= 150,
      `only ${compared} trait value(s) were compared across ${PROFILE_CARDS.length} profile(s); ` +
        'a pass over an empty comparison is the failure this assertion rules out',
    );
  });

  it('never claims to have observed anything', () => {
    // A fixture has observed nothing. This once shipped 128 invented hands as "your own play".
    for (const card of PROFILE_CARDS) {
      const learn = learnFromFixture(card.id);
      assert.ok(learn !== null, `${card.id} has a card but no learn-from payload`);
      assert.equal(learn.observed, null, `${card.id} offers observed statistics it cannot have`);
    }
  });

  it('asks for a trial count the endpoint will actually run', () => {
    assert.equal(COMPARE.trials, MAX_COMPARE_TRIALS);
    for (const entry of COMPARE.entries) {
      const total = entry.actionDistribution.reduce((sum, row) => sum + row.probability, 0);
      assert.ok(Math.abs(total - 1) < 1e-9, `${entry.profileId}'s weights do not sum to 1`);
      for (const row of entry.actionDistribution) {
        // A frequency over N trials is a multiple of 1/N.
        const trials = row.probability * COMPARE.trials;
        assert.ok(
          Math.abs(trials - Math.round(trials)) < 1e-9,
          `${entry.profileId}: ${row.action} at ${row.probability} is not a whole number of ${COMPARE.trials} trials`,
        );
      }
    }
  });
});

describe('the web client and the API agree on the compare limit', () => {
  it('publishes the same maximum the endpoint enforces', async () => {
    // `rooms/bots.ts` is the authority and the contract carries a copy. The copy once said 400
    // against a cap of 40, and a CSRF failure hid the rejections.
    const bots: Record<string, unknown> = await import('../src/rooms/bots.ts');
    assert.equal(bots['MAX_COMPARE_TRIALS'], MAX_COMPARE_TRIALS);
  });
});
