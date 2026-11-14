/**
 * Generated prose addresses the reader as "you", never "hero", which no glossary term defines.
 * It walks every string the generators return rather than a list of known fields, because the word
 * can arrive in any field. Identifiers such as `heroCards` are not swept, because readers never see them.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  analyseScenario,
  content,
  readSituation,
  SCENARIO_ANALYSIS_SAMPLES,
  SCENARIO_ANALYSIS_SEED,
} from '@prl/content';
import { type PlayerView, parseCards } from '@prl/poker-engine';
import {
  buildCoachReport,
  type CoachPolicy,
  coachInputFor,
  coachSpotForView,
  computeOuts,
  computeStrengthTable,
  defenceFrequency,
  deriveContestablePot,
  icmEquity,
  icmVsChipEv,
  impliedOdds,
  LIVE_COACH_POLICY,
  maximumOutsForRuleOf24,
  outsSummaryFor,
  parseRange,
  potOdds,
  priceLaidByBet,
  probabilityOfHitting,
  pushFoldChipEv,
  reverseImpliedOdds,
  ruleOf24,
  ruleOf24Accuracy,
} from '@prl/poker-math';
import { parseCoachRequest, parseEquityRequest } from '../src/calc/parse.ts';
import { isAppError } from '../src/errors.ts';
import { buildHypotheticalState, compareProfilesOnSpot } from '../src/rooms/bots.ts';

const HERO = /\bhero\b/iu;
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_FIXTURES = resolve(HERE, '..', '..', 'web', 'src', 'fixtures');
const COACH_VIEWS = resolve(HERE, '../../../packages/poker-math/test/fixtures/coach-views.json');

/** Every string value reachable from `value`, each with the path it was found at. Keys are not text. */
function* stringsIn(value: unknown, path: string): Generator<readonly [string, string]> {
  if (typeof value === 'string') {
    yield [path, value];
  } else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* stringsIn(item, `${path}[${index}]`);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) yield* stringsIn(item, `${path}.${key}`);
  }
}

class Sweep {
  read = 0;
  readonly offenders: string[] = [];

  add(where: string, value: unknown): void {
    for (const [path, text] of stringsIn(value, where)) {
      this.read += 1;
      if (HERO.test(text))
        this.offenders.push(`${path}: ${text.length > 160 ? `${text.slice(0, 160)}…` : text}`);
    }
  }

  /** `floor` sits a little under today's count, so a lost source fails instead of passing. */
  assertClean(floor: number): void {
    assert.ok(
      this.read >= floor,
      `read ${this.read} strings, expected at least ${floor}: a sweep of nothing is not a pass`,
    );
    assert.deepEqual(
      this.offenders,
      [],
      `${this.offenders.length} learner-visible string(s) say "hero":\n  ${this.offenders.slice(0, 12).join('\n  ')}`,
    );
  }
}

function addFieldErrorOf(sweep: Sweep, where: string, attempt: () => unknown): void {
  try {
    attempt();
  } catch (error) {
    assert.ok(isAppError(error), `${where}: expected an AppError, got ${String(error)}`);
    assert.ok(
      error.fields !== undefined,
      `${where}: the refusal names no field, so it carries no text to check`,
    );
    sweep.add(where, error.fields);
    return;
  }
  assert.fail(`${where}: the request was accepted, so the refusal it exists to check never ran`);
}

describe('generated prose calls the reader "you", never "hero"', () => {
  it('the Coach and the analysis, for every bundled scenario', () => {
    const sweep = new Sweep();
    const scenarios = content().scenarios;
    assert.ok(scenarios.length >= 30, `${scenarios.length} scenarios`);
    for (const scenario of scenarios) {
      const situation = readSituation(scenario);
      const heroSeat = scenario.seats.find((seat) => seat.isHero === true);
      const committed = scenario.committedThisStreet?.[heroSeat?.seat ?? -1] ?? 0;
      const spot = {
        pot: situation.pot,
        toCall: situation.toCall,
        heroCommittedThisStreet: committed,
        heroStack: situation.heroStack,
        opponentStacks: [...situation.opponentStacks],
      };
      // The label `routes/content.ts` gives the opponent, so the report reads exactly like the wire.
      const label = scenario.opponentRange.kind === 'exact' ? 'the opponent' : scenario.opponentRange.label;
      sweep.add(
        `${scenario.id}.coach`,
        buildCoachReport({
          ...spot,
          heroCards: [...situation.heroCards],
          board: [...situation.board],
          street: scenario.street,
          opponents: [{ label, range: situation.opponentRange }],
          contestablePot: deriveContestablePot(spot),
          bigBlind: scenario.bigBlind,
          samples: SCENARIO_ANALYSIS_SAMPLES,
          seed: SCENARIO_ANALYSIS_SEED,
        }),
      );
      sweep.add(`${scenario.id}.analysis`, analyseScenario(scenario));
      // Every per-card note, which the Coach summarises and the Lab's outs list prints one by one.
      if (situation.board.length === 3 || situation.board.length === 4) {
        const outs = computeOuts({
          heroCards: [...situation.heroCards],
          board: [...situation.board],
          opponent: situation.opponentRange,
        });
        sweep.add(`${scenario.id}.outs`, outs);
        sweep.add(`${scenario.id}.outsSummary`, outsSummaryFor(outs));
      }
    }
    // 10,778 strings when this was written.
    sweep.assertClean(9_000);
  });

  it('the live table Coach, for the pinned dealt views', () => {
    const sweep = new Sweep();
    const pinned = JSON.parse(readFileSync(COACH_VIEWS, 'utf8')) as readonly {
      readonly name: string;
      readonly view: PlayerView;
      readonly options: { readonly samples: number; readonly opponentRange?: string };
    }[];
    assert.ok(pinned.length >= 5, `${pinned.length} pinned views`);
    for (const { name, view, options } of pinned) {
      const policy: CoachPolicy = {
        ...LIVE_COACH_POLICY,
        samples: options.samples,
        range:
          options.opponentRange === undefined
            ? LIVE_COACH_POLICY.range
            : { kind: 'notation', notation: options.opponentRange },
      };
      const reading = coachSpotForView(view, policy);
      assert.ok(reading.kind === 'spot', `${name}: the pinned view no longer produces a Coach spot`);
      sweep.add(name, buildCoachReport(coachInputFor(reading.spot)));
    }
    // 256 strings when this was written.
    sweep.assertClean(220);
  });

  it('the odds, outs, ICM and strength explanations, over a grid of inputs', () => {
    const sweep = new Sweep();
    for (const [pot, toCall] of [
      [30, 20],
      [195, 65],
      [120, 0],
      [0, 0],
    ] as const) {
      sweep.add(`potOdds(${pot}, ${toCall})`, potOdds(pot, toCall));
      sweep.add(
        `impliedOdds(${pot}, ${toCall})`,
        impliedOdds({ pot, toCall, expectedAdditionalWinnings: 40 }),
      );
      sweep.add(
        `reverseImpliedOdds(${pot}, ${toCall})`,
        reverseImpliedOdds({ pot, toCall, expectedAdditionalLosses: 40 }),
      );
    }
    for (const cardsToCome of [1, 2] as const) {
      // 47 is the most cards that can be unseen with a flop out, and `ruleOf24` refuses above it.
      for (let outs = 0; outs <= Math.min(47, maximumOutsForRuleOf24(cardsToCome)); outs += 3) {
        sweep.add(`ruleOf24(${outs}, ${cardsToCome})`, ruleOf24(outs, cardsToCome));
        sweep.add(`ruleOf24Accuracy(${outs}, ${cardsToCome})`, ruleOf24Accuracy(outs, cardsToCome, 0.3));
        sweep.add(
          `probabilityOfHitting(${outs}, ${cardsToCome})`,
          probabilityOfHitting(outs, 46, cardsToCome),
        );
      }
    }
    for (const [pot, bet] of [
      [100, 50],
      [100, 100],
      [60, 200],
    ] as const) {
      sweep.add(`defenceFrequency(${pot}, ${bet})`, defenceFrequency(pot, bet));
      sweep.add(`priceLaidByBet(${pot}, ${bet})`, priceLaidByBet(pot, bet));
    }
    // A board where the reader is already in front of a range, which takes the outs refusal's wording
    // rather than the draw's.
    const ahead = computeOuts({
      heroCards: parseCards('Ac 5d'),
      board: parseCards('Ah 5s 2c'),
      opponent: parseRange('22+, A2s+, KTs+', parseCards('Ac 5d Ah 5s 2c')),
    });
    sweep.add('computeOuts(ahead, range)', ahead);
    sweep.add('outsSummaryFor(ahead, range)', outsSummaryFor(ahead));

    const stacks = [5_000, 3_000, 2_000];
    const payouts = [50, 30, 20];
    sweep.add('icmEquity', icmEquity(stacks, payouts));
    sweep.add(
      'icmVsChipEv',
      icmVsChipEv({
        stacks,
        payouts,
        heroIndex: 2,
        outcomeIfWin: [5_000, 1_000, 4_000],
        outcomeIfLose: [5_000, 5_000, 0],
        winProbability: 0.55,
      }),
    );
    for (const stackBb of [1, 9]) {
      sweep.add(
        `pushFoldChipEv(${stackBb}bb)`,
        pushFoldChipEv({
          heroCards: parseCards('Ah 7d'),
          stackBb,
          smallBlindBb: 0.5,
          bigBlindBb: 1,
          callerRangeNotation: '22+, A2s+, A2o+, K9s+, K9o+',
          samples: 1_000,
        }),
      );
    }
    sweep.add('strengthTable.assumptions', computeStrengthTable({ samplesPerClass: 200 }).assumptions);
    // 450 strings when this was written.
    sweep.assertClean(400);
  });

  it('the Legends comparison: its takeaway and every profile’s reasoning', () => {
    const sweep = new Sweep();
    sweep.add(
      'compare',
      compareProfilesOnSpot({
        spot: {
          heroCards: parseCards('Ah Jh'),
          board: parseCards('Kd 7h 2h'),
          street: 'flop',
          pot: 210,
          toCall: 84,
          heroStack: 900,
          opponentStack: 900,
          bigBlind: 10,
        },
        profileIds: ['vocal-aggressor', 'patient-technician', 'volume-grinder'],
        difficulty: 'realistic',
        trials: 4,
        namingMode: 'attributed',
      }),
    );
    // 165 strings when this was written.
    sweep.assertClean(140);
  });

  it('the calculator’s field errors, which the Lab prints under the field', () => {
    const sweep = new Sweep();
    addFieldErrorOf(sweep, 'board repeats a hole card', () =>
      parseEquityRequest({ heroCards: 'AhKh', board: 'AhQd7c', opponents: ['QQ+'] }),
    );
    addFieldErrorOf(sweep, 'an exact opponent reuses a hole card', () =>
      parseEquityRequest({ heroCards: 'AhKh', opponents: ['AhQd'] }),
    );
    addFieldErrorOf(sweep, 'a range blocked to nothing', () =>
      parseEquityRequest({ heroCards: 'AhAs', board: 'AdAc7h', opponents: ['AA'] }),
    );
    addFieldErrorOf(sweep, 'the Coach with a board that repeats a hole card', () =>
      parseCoachRequest({
        heroCards: 'Th9h',
        board: 'Th7h2c',
        opponents: ['AsKs'],
        pot: 100,
        toCall: 50,
        heroStack: 500,
        opponentStacks: [500],
        bigBlind: 10,
        street: 'flop',
      }),
    );
    addFieldErrorOf(sweep, 'a compare spot whose pot is below the bet', () =>
      buildHypotheticalState({
        heroCards: parseCards('Ah Jh'),
        board: parseCards('Kd 7h 2h'),
        street: 'flop',
        pot: 40,
        toCall: 84,
        heroStack: 900,
        opponentStack: 900,
        bigBlind: 10,
      }),
    );
    sweep.assertClean(5);
  });

  it('the web’s offline copies, which a reader sees when the API is unreachable', async () => {
    const sweep = new Sweep();
    const files = readdirSync(WEB_FIXTURES).filter((file) => file.endsWith('.ts'));
    assert.ok(files.length >= 10, `${files.length} fixture modules in ${WEB_FIXTURES}`);
    for (const file of files) {
      // `learn.ts` re-exports the `learn-*` modules through Next's `@/` alias, and they are read
      // directly. `table.ts` imports TSX from `@prl/ui`, so it is read as text without comments.
      if (file === 'learn.ts') continue;
      if (file === 'table.ts') {
        const code = readFileSync(join(WEB_FIXTURES, file), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//gu, '')
          .replace(/^\s*\/\/.*$/gmu, '');
        sweep.add(file, code.split('\n'));
        continue;
      }
      const module = (await import(pathToFileURL(join(WEB_FIXTURES, file)).href)) as Record<string, unknown>;
      sweep.add(file, module);
    }
    // 5,343 strings when this was written.
    sweep.assertClean(4_800);
  });
});
