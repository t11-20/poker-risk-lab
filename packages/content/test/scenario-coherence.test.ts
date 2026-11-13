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
