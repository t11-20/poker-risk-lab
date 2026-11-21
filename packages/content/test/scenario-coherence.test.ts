/**
 * Scenarios that are well-formed but describe a table that cannot exist. A shipped scenario said a
 * seat moved all in for 7,200 and still recorded 7,200 behind. The first tests pin the shipped data
 * by number. The rest reintroduce each defect to prove the validator fails on it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectContentProblems, content, readRawContent } from '../src/index.ts';

type RawScenario = Record<string, unknown>;

const isRecord = (value: unknown): value is RawScenario =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function scenarioNamed(id: string): RawScenario {
  const found = readRawContent().scenarios.find(
    (scenario): scenario is RawScenario => isRecord(scenario) && scenario['id'] === id,
  );
  assert.ok(found !== undefined, `no scenario "${id}" in the content data`);
  return structuredClone(found);
}

/** Problems about `scenario` alone. The rest of the bundle is real so cross-references resolve. */
function problemsFor(scenario: RawScenario): readonly string[] {
  const raw = readRawContent();
  return collectContentProblems({ ...raw, scenarios: [scenario] }).filter((problem) =>
    problem.startsWith('scenarios[0]'),
  );
}

function seatsOf(scenario: RawScenario): RawScenario[] {
  const seats = scenario['seats'];
  assert.ok(Array.isArray(seats), 'expected an array of seats');
  return seats.filter(isRecord);
}

function seatLabelled(scenario: RawScenario, label: string): RawScenario {
  const seat = seatsOf(scenario).find((entry) => entry['label'] === label);
  assert.ok(seat !== undefined, `no seat labelled ${label}`);
  return seat;
}

function heroOf(scenario: RawScenario): RawScenario {
  const hero = seatsOf(scenario).find((entry) => entry['isHero'] === true);
  assert.ok(hero !== undefined, 'no hero seat');
  return hero;
}

function committedOf(scenario: RawScenario): Record<string, number> {
  const committed = scenario['committedThisStreet'];
  assert.ok(isRecord(committed), 'expected committedThisStreet');
  return committed as Record<string, number>;
}

const mentioning = (problems: readonly string[], needle: RegExp): string[] =>
  problems.filter((problem) => needle.test(problem));

test('every shipped scenario is internally coherent', () => {
  const problems = collectContentProblems(readRawContent());
  assert.deepEqual(problems, [], `content validation failed:\n  - ${problems.join('\n  - ')}`);
});

test('a seat the prose calls all in has nothing behind, in every shipped scenario', () => {
  // `stack` is chips behind, so an all-in seat holds 0.
  const offenders: string[] = [];
  for (const scenario of content().scenarios) {
    const committed = scenario.committedThisStreet ?? {};
    for (const match of scenario.facingAction.matchAll(/all[-\s]?in for ([\d,]+)/gi)) {
      const amount = Number((match[1] ?? '').replace(/,/g, ''));
      const seat = scenario.seats.find((entry) => (committed[entry.seat] ?? 0) === amount);
      if (seat === undefined) {
        offenders.push(`${scenario.id}: nobody committed the ${amount} the prose describes`);
      } else if (seat.stack !== 0) {
        offenders.push(`${scenario.id}: ${seat.label} is all in for ${amount} but has ${seat.stack} behind`);
      }
    }
  }
  assert.deepEqual(offenders, [], `all-in seats with chips behind:\n  - ${offenders.join('\n  - ')}`);
});

test('rk-nine-big-blinds-call-or-fold is nine big blinds deep, on both sides', () => {
  // Pinned by number. This is the scenario the audit found.
  const scenario = content().scenarios.find((entry) => entry.id === 'rk-nine-big-blinds-call-or-fold');
  assert.ok(scenario !== undefined);
  const committed = scenario.committedThisStreet ?? {};
  const depth = (label: string): number => {
    const seat = scenario.seats.find((entry) => entry.label === label);
    assert.ok(seat !== undefined, `no ${label}`);
    return (seat.stack + (committed[seat.seat] ?? 0)) / scenario.bigBlind;
  };

  assert.equal(depth('SB'), 9, 'the small blind shoves nine big blinds');
  assert.equal(depth('BB'), 9, 'hero is nine big blinds deep, as the title says');

  const smallBlind = scenario.seats.find((entry) => entry.label === 'SB');
  const hero = scenario.seats.find((entry) => entry.isHero === true);
  assert.equal(smallBlind?.stack, 0, 'a seat that has moved all in has nothing behind');
  assert.equal(hero?.stack, scenario.toCall, 'calling is for the rest of hero');
});

test('rk-when-survival-outweighs-chip-ev really does put hero all in, as it says', () => {
  const scenario = content().scenarios.find((entry) => entry.id === 'rk-when-survival-outweighs-chip-ev');
  assert.ok(scenario !== undefined);
  const committed = scenario.committedThisStreet ?? {};
  const hero = scenario.seats.find((entry) => entry.isHero === true);
  const smallBlind = scenario.seats.find((entry) => entry.label === 'SB');
  assert.ok(hero !== undefined && smallBlind !== undefined);

  assert.equal(smallBlind.stack, 0);
  // "moves all in for 24,000, which is exactly what hero has"
  assert.equal(hero.stack + (committed[hero.seat] ?? 0), committed[smallBlind.seat]);
  // "Calling puts hero all in"
  assert.equal(scenario.toCall, hero.stack);
});

test('an all-in seat written with chips behind is rejected', () => {
  const scenario = scenarioNamed('rk-nine-big-blinds-call-or-fold');
  // The shipped defect: the whole stack recorded as both committed and behind.
  seatLabelled(scenario, 'SB')['stack'] = 7200;

  const problems = problemsFor(scenario);
  assert.ok(
    mentioning(problems, /moved all in for 7200/).length === 1,
    `expected an all-in coherence problem, got:\n  - ${problems.join('\n  - ')}`,
  );
  assert.match(problems.join('\n'), /must be 0/);
});

test('a title that names a stack depth hero does not have is rejected', () => {
  const scenario = scenarioNamed('rk-nine-big-blinds-call-or-fold');
  heroOf(scenario)['stack'] = 10000; // 10800 total at bigBlind 800: 13.5 blinds, not nine

  const problems = problemsFor(scenario);
  assert.ok(
    mentioning(problems, /\.title:.*Nine big blinds/).length === 1,
    `expected a stated-depth problem, got:\n  - ${problems.join('\n  - ')}`,
  );
});

test('a price that does not match the chips on the table is rejected', () => {
  const scenario = scenarioNamed('rk-nine-big-blinds-call-or-fold');
  scenario['toCall'] = 6000;

  assert.match(problemsFor(scenario).join('\n'), /hero owes 6400/);
});

test('hero cannot be asked to call more than hero has behind', () => {
  const scenario = scenarioNamed('eq-flush-draw-turn-small-bet');
  heroOf(scenario)['stack'] = 10;

  assert.match(problemsFor(scenario).join('\n'), /more than hero has behind \(10\)/);
});

test('"calling puts hero all in" is checked against hero\'s remaining chips', () => {
  const scenario = scenarioNamed('rk-when-survival-outweighs-chip-ev');
  heroOf(scenario)['stack'] = 30_000;

  assert.match(problemsFor(scenario).join('\n'), /says calling puts hero all in, but hero has 30000 behind/);
});

test('a bet size or pot in the prose that the numbers contradict is rejected', () => {
  const scenario = scenarioNamed('fl-board-plays-itself-river');
  scenario['potBeforeStreet'] = 84;

  assert.match(problemsFor(scenario).join('\n'), /pot of 85, but potBeforeStreet is 84/);
});

test('a preflop scenario where the blinds are not posted is rejected', () => {
  const scenario = scenarioNamed('fl-same-cards-under-the-gun');
  committedOf(scenario)['2'] = 4; // the big blind, posting less than the big blind

  assert.match(problemsFor(scenario).join('\n'), /a seat labelled BB has posted at least 10/);
});

test('committedThisStreet cannot name a seat that is not at the table', () => {
  const scenario = scenarioNamed('fl-board-plays-itself-river');
  // 0 keeps toCall unchanged, so only one check fires.
  committedOf(scenario)['4'] = 0;

  assert.match(problemsFor(scenario).join('\n'), /seat 4 is not at this table/);
});

test('a seat with nothing behind and nothing committed is rejected', () => {
  const scenario = scenarioNamed('fl-board-plays-itself-river');
  seatLabelled(scenario, 'SB')['stack'] = 0; // folded seat, nothing in, nothing behind

  assert.match(problemsFor(scenario).join('\n'), /not in the hand/);
});

test('a big blind that is not above the small blind is rejected', () => {
  const scenario = scenarioNamed('fl-board-plays-itself-river');
  scenario['bigBlind'] = 5;

  assert.match(problemsFor(scenario).join('\n'), /not above the small blind of 5/);
});

test('a bounded depth in the prose is not read as a claim about one seat', () => {
  // "under four big blinds each" describes stacks of 2.5 and 3.5. This control must stay quiet.
  const scenario = scenarioNamed('rk-when-survival-outweighs-chip-ev');
  assert.deepEqual(problemsFor(scenario), []);
  assert.ok(
    (scenario['assumptions'] as string[]).some((text) => /under four big blinds/.test(text)),
    'this control is only meaningful while the scenario still contains the bounded phrase',
  );
});

test('a scenario that says the opponent does not fold must declare that the whole range continues', () => {
  const draw = scenarioNamed('fl-flush-draw-counting-outs');
  assert.equal(draw['wholeRangeContinues'], true);
  draw['wholeRangeContinues'] = false;
  assert.equal(mentioning(problemsFor(draw), /wholeRangeContinues.*does not fold/).length, 1);

  const range = scenarioNamed('rk-high-spr-same-top-pair');
  range['wholeRangeContinues'] = true;
  assert.equal(mentioning(problemsFor(range), /wholeRangeContinues.*no assumption says/).length, 1);
});

test('an action an assumption says is not being evaluated is the one the scenario sets aside', () => {
  const setAsideProblems = (scenario: RawScenario) => mentioning(problemsFor(scenario), /actionsSetAside/);
  const river = scenarioNamed('fl-board-plays-itself-river');
  assert.deepEqual(river['actionsSetAside'], ['raise']);
  assert.deepEqual(setAsideProblems(river), [], 'control: the shipped scenario is consistent');

  const undeclared = structuredClone(river);
  undeclared['actionsSetAside'] = undefined;
  assert.deepEqual(setAsideProblems(undeclared), [
    'scenarios[0].actionsSetAside: must include "raise": an assumption says it is not being evaluated, ' +
      'and without it the verdict can still name it as supported',
  ]);

  const unsaid = scenarioNamed('rk-high-spr-same-top-pair');
  assert.deepEqual(setAsideProblems(unsaid), [], 'control: no field and no sentence');
  unsaid['actionsSetAside'] = ['bet'];
  assert.equal(mentioning(setAsideProblems(unsaid), /lists "bet", but no assumption says/).length, 1);
});

test('a set-aside sentence is read in the plural and with a contraction', () => {
  const setAsideProblems = (sentence: string, field: unknown) => {
    const scenario = scenarioNamed('fl-board-plays-itself-river');
    const assumptions = scenario['assumptions'] as string[];
    scenario['assumptions'] = assumptions.map((text) =>
      /raising is not being evaluated/.test(text) ? sentence : text,
    );
    scenario['actionsSetAside'] = field;
    return mentioning(problemsFor(scenario), /actionsSetAside/);
  };
  const plural = 'You are choosing between calling and folding; betting and raising are not evaluated here.';
  assert.deepEqual(setAsideProblems(plural, ['bet', 'raise']), []);
  assert.equal(setAsideProblems(plural, undefined).length, 2, 'both actions must be declared');
  assert.deepEqual(setAsideProblems("Raising isn't evaluated here.", ['raise']), []);
  assert.equal(setAsideProblems("Raising isn't evaluated here.", undefined).length, 1);
  // "calling and folding" is not followed by "not evaluated", so neither is read as set aside.
  assert.equal(mentioning(setAsideProblems(plural, ['bet', 'raise']), /call|fold/).length, 0);
});

test('actionsSetAside is a list of action names, each reported once', () => {
  const field = (value: unknown) => {
    const scenario = scenarioNamed('fl-board-plays-itself-river');
    scenario['actionsSetAside'] = value;
    return mentioning(problemsFor(scenario), /actionsSetAside/);
  };
  assert.deepEqual(field([]), [
    'scenarios[0].actionsSetAside: must be a non-empty list of action names, or left out',
  ]);
  assert.deepEqual(field('raise'), [
    'scenarios[0].actionsSetAside: must be a non-empty list of action names, or left out',
  ]);
  assert.deepEqual(field(['raise', 'shove']), [
    'scenarios[0].actionsSetAside[1]: expected one of fold | check | call | bet | raise, got string "shove"',
  ]);
  assert.deepEqual(field(['raise', 'raise']), [
    'scenarios[0].actionsSetAside: names an action more than once',
  ]);
});

test('a fold rate stated in an assumption is the one the scenario declares', () => {
  const stated =
    'Every bet and raise below is priced against an assumed 30% chance that the opponent folds to it.';
  const foldRateProblems = (scenario: RawScenario) => mentioning(problemsFor(scenario), /assumedFoldEquity/);
  const scenario = scenarioNamed('rk-high-spr-same-top-pair');
  assert.deepEqual(foldRateProblems(scenario), []);
  scenario['assumptions'] = [...(scenario['assumptions'] as string[]), stated];
  assert.match(foldRateProblems(scenario).join('\n'), /must be 0\.3: an assumption states a 30% fold rate/);

  scenario['assumedFoldEquity'] = 0.3;
  assert.deepEqual(foldRateProblems(scenario), []);
  scenario['assumedFoldEquity'] = 0.35;
  assert.match(foldRateProblems(scenario).join('\n'), /is 0\.35, but an assumption states a 30% fold rate/);
  scenario['assumedFoldEquity'] = '0.3';
  assert.match(foldRateProblems(scenario).join('\n'), /expected a finite number/);
  scenario['assumedFoldEquity'] = 1.5;
  assert.match(foldRateProblems(scenario).join('\n'), /must be at most 1/);

  const silent = scenarioNamed('rk-high-spr-same-top-pair');
  silent['assumedFoldEquity'] = 0.3;
  assert.match(foldRateProblems(silent).join('\n'), /is 0\.3, but no assumption states the rate/);
});
