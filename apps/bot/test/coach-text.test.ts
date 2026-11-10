import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { COACH_DISCLAIMER, type CoachReading, coachLine, coachWhy, probabilityText } from '../src/coach.ts';
import { NEW_SESSION, type StepResult, step } from '../src/step.ts';
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

/** Every Coach reading and every message of a few real hands, with the real Coach. */
function playWithCoach(): { readings: CoachReading[]; texts: string[] } {
  const deps = testDeps(21, realCoach);
  const readings: CoachReading[] = [];
  const texts: string[] = [];
  const menu = step(NEW_SESSION, { kind: 'command', name: 'start' }, deps);
  const about = step(menu.session, { kind: 'command', name: 'about' }, deps);
  texts.push(message(menu).text, message(about).text);
  let current: StepResult = press(menu.session, find(buttonsOf(menu), /^Play a hand$/), deps);
  for (let hand = 0; hand < 4; hand += 1) {
    let pick = hand;
    while (current.session.phase.kind === 'deciding') {
      readings.push(current.session.phase.coach);
      texts.push(message(current).text);
      const why = press(current.session, find(buttonsOf(current), /^Why\?$/), deps);
      texts.push(message(why).text);
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
  return { readings, texts };
}

describe('the Coach in chat', () => {
  const { readings, texts } = playWithCoach();
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
      for (const assumption of reading.report.assumptions) assert.ok(why.includes(assumption), assumption);
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
});
