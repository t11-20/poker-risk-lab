import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { lessonsInReadingOrder } from '@prl/content';
import type { CoachReport } from '@prl/contracts';
import {
  applyAction,
  createDeterministicRandomForTests,
  type HandState,
  redactFor,
  startHand,
} from '@prl/poker-engine';
import {
  COACH_DISCLAIMER,
  type CoachReading,
  coachAssumptions,
  coachLine,
  coachNamer,
  coachReportFor,
  coachWhy,
  probabilityText,
} from '../src/coach.ts';
import { NEW_SESSION, type StepResult, step } from '../src/step.ts';
import { newTable, TABLE_CONFIG } from '../src/table.ts';
import { splitForChat } from '../src/telegram.ts';
import {
  actionButtonsOf,
  buttonsOf,
  find,
  message,
  passiveChoice,
  press,
  realCoach,
  testDeps,
} from './helpers.ts';

/** The words `CoachPanel.tsx` rule 3 bans, as whole words, in any case. */
const BANNED = /\b(?:correct|optimal|best play|GTO)\b/i;

const RANGE_ASSUMPTION = /^(.+) holds (any of \d+ combinations from ".*", each equally likely\.)$/;

/** Every Coach reading and every message of a few real hands, with the real Coach. */
function playWithCoach(): { readings: CoachReading[]; texts: string[]; whys: string[]; tables: string[] } {
  const deps = testDeps(21, realCoach);
  const readings: CoachReading[] = [];
  const texts: string[] = [];
  const whys: string[] = [];
  const tables: string[] = [];
  const menu = step(NEW_SESSION, { kind: 'command', name: 'start', args: '' }, deps);
  const about = step(menu.session, { kind: 'command', name: 'about', args: '' }, deps);
  texts.push(message(menu).text, message(about).text);
  let current: StepResult = press(menu.session, find(buttonsOf(menu), /^Play a hand$/), deps);
  for (let hand = 0; hand < 4; hand += 1) {
    let pick = hand;
    while (current.session.phase.kind === 'deciding') {
      readings.push(current.session.phase.coach);
      texts.push(message(current).text);
      tables.push(message(current).text);
      const why = press(current.session, find(buttonsOf(current), /^Why\?$/), deps);
      texts.push(message(why).text);
      whys.push(message(why).text);
      pick += 1;
      current = press(current.session, passiveChoice(actionButtonsOf(current), pick), deps);
    }
    texts.push(message(current).text);
    const next = buttonsOf(current).find((button) => /^(Deal the next hand|Reset units)$/.test(button.label));
    if (next === undefined) break;
    current = press(current.session, next, deps);
    if (current.session.phase.kind === 'idle') {
      current = press(current.session, find(buttonsOf(current), /^Play a hand$/), deps);
    }
  }
  return { readings, texts, whys, tables };
}

describe('the Coach in chat', () => {
  const { readings, texts, whys, tables } = playWithCoach();
  const reports = readings.flatMap((reading) => (reading.kind === 'report' ? [reading.report] : []));

  test('the run produced real reports to check', () => {
    assert.ok(reports.length >= 3, `only ${reports.length} reports from ${readings.length} readings`);
  });

  test('wherever the suggestion appears, the disclaimer and every assumption appear with it', () => {
    for (const reading of readings) {
      const why = coachWhy(reading);
      if (reading.kind !== 'report') continue;
      assert.match(why, /One reading: /);
      assert.ok(why.includes(COACH_DISCLAIMER), 'the disclaimer is in the Why? text');
      assert.ok(reading.report.assumptions.length > 0);
      for (const assumption of coachAssumptions(reading.report))
        assert.ok(why.includes(assumption), assumption);
      for (const limit of reading.report.uncertainty.limitations) assert.ok(why.includes(limit), limit);
    }
  });

  test('the one-liner carries figures with method and interval, and no suggestion', () => {
    for (const reading of readings) {
      if (reading.kind !== 'report') continue;
      const line = coachLine(reading);
      assert.doesNotMatch(line, /One reading:/);
      assert.doesNotMatch(line, /suggest/i);
      assert.match(line, /\(exact enumeration, no sampling\)|Monte Carlo, 2,000 samples, 95% interval/);
      if (reading.report.equity.method === 'monte-carlo') assert.match(line, /± \d+\.\d\d pts/);
    }
  });

  test('no message says correct, optimal, best play or GTO', () => {
    assert.ok(texts.length > 10, `scanned ${texts.length} messages`);
    for (const text of texts) assert.doesNotMatch(text, BANNED, text);
  });

  test('a sampled figure that arrives without its interval says so', () => {
    const report = reports.find((entry) => entry.equity.method === 'monte-carlo');
    assert.ok(report, 'a Monte Carlo report to strip the interval from');
    const stripped: CoachReading = {
      kind: 'report',
      at: 'x',
      report: { ...report, uncertainty: { ...report.uncertainty, confidenceInterval: null } },
    };
    assert.match(coachLine(stripped), /no interval reported: treat as approximate/);
  });

  test('when the price is against less than the whole pot, the side pot is named', () => {
    const report = reports.find((entry) => entry.toCall > 0);
    assert.ok(report, 'a report with a price');
    const capped: CoachReading = {
      kind: 'report',
      at: 'x',
      report: { ...report, potTotal: report.potOdds.pot + 22 },
    };
    assert.match(coachLine(capped), /the other 22 units are a side pot you cannot win/);
    assert.doesNotMatch(coachLine({ kind: 'report', at: 'x', report }), /side pot/);
  });

  test('a probability outside 0..1 is refused, not printed', () => {
    assert.equal(probabilityText(1.6), '(not a probability)');
    assert.equal(probabilityText(Number.NaN), '(not a probability)');
    assert.equal(probabilityText(-0.2), '(not a probability)');
    assert.equal(probabilityText(0.412), '41.2%');
    assert.equal(probabilityText(1 + 1e-12), '100.0%');
  });

  test('a call names what its button names, a check or fold no amount, a bet or raise its size', () => {
    const report = reports.find((entry) => entry.toCall > 0);
    assert.ok(report, 'a report with a price');
    const suggesting = (suggestion: Partial<CoachReport['suggestion']>, toCall = report.toCall): string => {
      const { sizeRange: _dropped, ...rest } = report.suggestion;
      return coachWhy({
        kind: 'report',
        at: 'x',
        report: { ...report, toCall, suggestion: { ...rest, ...suggestion } },
      });
    };
    const call = suggesting({ action: 'call', sizeRange: { min: 1_000, max: 1_000 } }, 358);
    assert.match(call, /^One reading: Call 358 units \(/m);
    assert.doesNotMatch(call, /1,000/);
    assert.match(suggesting({ action: 'check', sizeRange: { min: 10, max: 10 } }), /^One reading: Check \(/m);
    assert.match(suggesting({ action: 'fold' }), /^One reading: Fold \(/m);
    assert.match(
      suggesting({ action: 'raise', sizeRange: { min: 20, max: 35 } }),
      /^One reading: Raise to between 20 units and 35 units \(/m,
    );
    assert.match(
      suggesting({ action: 'bet', sizeRange: { min: 40, max: 40 } }),
      /^One reading: Bet to 40 units \(/m,
    );
  });

  test('Why? names opponents as the table does, never by a seat number the table does not show', () => {
    assert.ok(whys.length >= 3, `scanned ${whys.length} Why? messages`);
    for (const why of whys) assert.doesNotMatch(why, /\bseat \d\b/i, why);
    const plates =
      /(?:SB|BB|UTG|HJ|CO|BTN) (?:Patient Technician \d|Calling Station|Reading Pressure|Disciplined Specialist)/;
    assert.ok(
      whys.some((why) => plates.test(why)),
      'at least one Why? names an opponent by position and plate',
    );
  });

  test('cards read as on the table, in the table’s notation', () => {
    // The Coach lists a holding high card first, the table in deal order, so compare the cards.
    const cards = (text: string | undefined): string => (text ?? '?').split(' ').sort().join(' ');
    let compared = 0;
    for (const [index, why] of whys.entries()) {
      assert.doesNotMatch(why, /(?<![A-Za-z0-9])(?:[2-9TJQKA][shdc]){2,}(?![A-Za-z0-9])/, why);
      const shown = /^Your cards: (.+)$/m.exec(tables[index] ?? '')?.[1];
      if (shown === undefined || !why.includes('One reading')) continue;
      const held = /^- You hold exactly (.+)\.$/m.exec(why)?.[1];
      assert.equal(cards(held), cards(shown), why);
      compared += 1;
    }
    assert.ok(compared >= 3, `compared ${compared} hands`);
  });

  test('the heading names the street as the table does', () => {
    for (const why of whys) {
      if (!why.includes('One reading')) continue;
      assert.match(why, /^Coach, (?:Preflop|Flop|Turn|River)\n/);
    }
  });

  test('no Why? speaks of chips or points at a Scenario Lab this client does not have', () => {
    for (const why of whys) {
      assert.doesNotMatch(why, /\bchips?\b/i, why);
      assert.doesNotMatch(why, /Scenario Lab/, why);
    }
    assert.ok(whys.some((why) => why.includes('Units already in the pot are spent either way.')));
    assert.ok(whys.some((why) => why.includes('/learn has a lesson on fold equity')));
    assert.ok(lessonsInReadingOrder().some((lesson) => lesson.id === 'fold-equity'));
  });

  test('no assumption is dropped: each appears, or its range is in the one line every opponent shares', () => {
    for (const reading of readings) {
      if (reading.kind !== 'report') continue;
      const why = coachWhy(reading);
      const ranges = reading.report.assumptions.flatMap((line) => RANGE_ASSUMPTION.exec(line)?.[2] ?? []);
      for (const assumption of reading.report.assumptions) {
        const range = RANGE_ASSUMPTION.exec(assumption);
        if (range === null) {
          // Cards and two shared sentences are reworded further on, never in the opening words.
          const opening = assumption.split(' ').slice(0, 3).join(' ');
          assert.ok(why.includes(`- ${opening}`), opening);
          continue;
        }
        assert.ok(why.includes(range[1] ?? '?'), `${range[1]} is named`);
        assert.ok(why.includes(`holds ${range[2]}`), `${range[2]} is stated`);
      }
      const collapsed = ranges.length > 1 && ranges.every((range) => range === ranges[0]);
      const folded = collapsed ? ranges.length - 1 : 0;
      assert.equal(coachAssumptions(reading.report).length, reading.report.assumptions.length - folded);
    }
  });

  test('opponents with different ranges keep a line each', () => {
    const report = reports.find(
      (entry) => entry.assumptions.filter((line) => RANGE_ASSUMPTION.test(line)).length >= 2,
    );
    assert.ok(report, 'a multiway report');
    let first = true;
    const assumptions = report.assumptions.map((line) => {
      if (!RANGE_ASSUMPTION.test(line) || !first) return line;
      first = false;
      return line.replace(/any of \d+ combinations/, 'any of 7 combinations');
    });
    const lines = coachAssumptions({ ...report, assumptions });
    const ranges = report.assumptions.filter((line) => RANGE_ASSUMPTION.test(line)).length;
    assert.equal(lines.filter((line) => / holds any of /.test(line)).length, ranges);
    assert.ok(!lines.some((line) => line.startsWith('Each opponent')));
  });
});

/** Seat `buttonSeat` deals, and every seat before the reader calls, so all six are in. */
function everyoneIn(seed: number, buttonSeat: number): HandState {
  let { state } = startHand({
    handId: `worst-${seed}-${buttonSeat}`,
    roomId: 'worst',
    handNumber: 1,
    config: TABLE_CONFIG,
    buttonSeat,
    seats: [0, 1, 2, 3, 4, 5].map((seat) => ({ seat, playerId: `p${seat}`, stack: 1_000 })),
    random: createDeterministicRandomForTests(seed),
  });
  while (state.toAct !== 0) {
    const seat = state.toAct ?? -1;
    const legal = redactFor(state, { viewerSeat: seat }).legalActions;
    const passive =
      legal.find((entry) => entry.type === 'call') ?? legal.find((entry) => entry.type === 'check');
    assert.ok(passive, `seat ${seat} can call or check`);
    state = applyAction(state, seat, passive.type === 'call' ? { type: 'call' } : { type: 'check' }).state;
  }
  return state;
}

describe('the longest Why?', () => {
  test('six-handed preflop with every opponent in fits in one Telegram message', () => {
    // The longest of 48 such deals (seeds 1 to 8, every button) measured 4,617 characters before.
    const view = redactFor(everyoneIn(4, 3), { viewerSeat: 0 });
    const random = () => createDeterministicRandomForTests(1);
    const table = newTable('worst', { dealRandom: random, decisionRandom: random });
    assert.equal(view.seats.filter((seat) => !seat.isSelf && seat.status === 'active').length, 5);
    const why = coachWhy({ kind: 'report', at: 'x', report: coachReportFor(view, coachNamer(table, view)) });
    assert.equal(splitForChat(why).length, 1, `${why.length} characters`);
    assert.ok(why.length <= 4_096);
    assert.equal(why.match(/combinations from/g)?.length, 1, 'the shared range is printed once');
    assert.match(why, /^- Each opponent \(.*CO Patient Technician 2.*\) holds any of \d+ combinations/m);
  });
});
