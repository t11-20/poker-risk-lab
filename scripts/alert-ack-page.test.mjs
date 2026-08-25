#!/usr/bin/env node
/**
 * Tests for the acknowledgement mechanism behind `pnpm run alerts:ack`.
 *
 * Run with:  node --test scripts/alert-ack-page.test.mjs
 *
 * ## The one behaviour that must never regress
 *
 * **When nobody answers, this command fails.** Everything else in that file is
 * plumbing; that is the assertion. A command that exits 0 when nobody acknowledged
 * is worse than not having the command, because it produces a record — a JSON file
 * attached to a promotion — saying a person was reached when none was. So the first
 * negative control below runs the real `awaitAcknowledgement` against a stream that
 * stays silent, and asserts that it comes back not-ok, with a reason.
 *
 * The rest are the ways a green result could be manufactured without a person: an
 * empty expected code matching a blank line, a closed stdin reading as agreement, a
 * `normaliseCode` so forgiving that a different code matches.
 *
 * The live half — a real alert posted to a real Alertmanager, delivered to a real
 * receiver, with the code in the `Subject:` — needs the observability overlay and is
 * exercised by running the command itself. What is here is everything that decides
 * whether a run passes.
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { awaitAcknowledgement, codeInNotification, makeCode, normaliseCode } from './alert-ack-page.mjs';

/** A stdin that produces these lines and then stays open, like a terminal does. */
function typing(lines, { close = false } = {}) {
  const stream = new Readable({
    read() {
      // Nothing is produced on demand: the lines are pushed up front and the stream is
      // then left open, which is what a terminal with nobody at it looks like.
    },
  });
  for (const line of lines) stream.push(`${line}\n`);
  if (close) stream.push(null);
  return stream;
}

/** A stdin that is open and silent — a terminal nobody is sitting at. */
const silence = () =>
  new Readable({
    read() {
      // Deliberately produces nothing, ever. This is the input the one assertion that
      // matters most runs against.
    },
  });

describe('NEGATIVE CONTROL: nobody acknowledges', () => {
  it('fails when the window closes with nothing typed', async () => {
    // The assertion this whole command exists to make. A pass here would mean a
    // promotion record can say a person was paged when the terminal sat empty.
    const outcome = await awaitAcknowledgement({
      input: silence(),
      expected: 'ABC123',
      deadlineMs: 120,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /nobody acknowledged/);
    assert.equal(outcome.attempts, 0);
  });

  it('fails when stdin closes without a matching code', async () => {
    // `pnpm run alerts:ack < /dev/null` in a CI job. The stream ends immediately, and
    // a `for await` that simply falls out of its loop returns a truthy nothing unless
    // the end of input is treated as the refusal it is.
    const outcome = await awaitAcknowledgement({
      input: typing([], { close: true }),
      expected: 'ABC123',
      deadlineMs: 5_000,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /input ended/);
  });

  it('fails on wrong codes alone, however many are typed', async () => {
    const attempts = [];
    const outcome = await awaitAcknowledgement({
      input: typing(['ABC124', 'nope', '']),
      expected: 'ABC123',
      deadlineMs: 200,
      onAttempt: (typed) => attempts.push(typed),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.attempts, 3);
    assert.deepEqual(attempts, ['ABC124', 'nope', '']);
  });

  it('refuses an empty expected code rather than matching a blank line', async () => {
    // The subtlest way to a false green: if the code were ever empty — a generator
    // that returned '', a record read back with a missing field — then `''` typed at
    // a prompt, or a bare enter, would acknowledge it.
    await assert.rejects(
      () => awaitAcknowledgement({ input: silence(), expected: '', deadlineMs: 50 }),
      /the expected code is empty/,
    );
  });
});

describe('a person types the code', () => {
  it('accepts it, and reports how long they took', async () => {
    const outcome = await awaitAcknowledgement({
      input: typing(['7QK3F2']),
      expected: '7QK3F2',
      deadlineMs: 5_000,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.attempts, 1);
    assert.ok(outcome.elapsedMs >= 0);
  });

  it('accepts it after a wrong attempt, because a transcription slip is not a failure', async () => {
    // The realistic wrong-code case is the very person this is meant to prove was
    // reached, mistyping a code off a phone screen at night. Failing them on a typo
    // measures the font.
    const outcome = await awaitAcknowledgement({
      input: typing(['7QK3F1', '7QK3F2']),
      expected: '7QK3F2',
      deadlineMs: 5_000,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.attempts, 2);
  });

  it('forgives case, spaces and a hyphen, and nothing else', async () => {
    assert.equal(normaliseCode(' 7qk-3 f2 \r'), '7QK3F2');
    // Forgiving is not the same as fuzzy: a different code must still be different.
    assert.notEqual(normaliseCode('7QK3F3'), normaliseCode('7QK3F2'));
    const outcome = await awaitAcknowledgement({
      input: typing([' 7qk-3f2 ']),
      expected: '7QK3F2',
      deadlineMs: 5_000,
    });
    assert.equal(outcome.ok, true);
  });
});

describe('the code itself', () => {
  it('has no character that can be misread off a phone at night', () => {
    // I/O/0/1 are excluded at the source, because `normaliseCode` can forgive spacing
    // and case and cannot forgive a zero read as an O.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      assert.match(makeCode(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });

  it('uses the whole alphabet rather than a corner of it', () => {
    // A generator whose randomness quietly collapsed — a modulo against the wrong
    // bound, a constant seed — still produces codes that look fine one at a time.
    const seen = new Set();
    for (let attempt = 0; attempt < 400; attempt += 1) for (const char of makeCode()) seen.add(char);
    assert.ok(seen.size > 24, `only ${seen.size} distinct characters in 2,400 draws`);
  });

  it('is read back out of a delivered notification by label, not by scraping text', () => {
    // What unattended rehearsals unlock on, and what a live run's subject assertion is
    // about: the code travels as a LABEL, so it reaches the `Subject:` line a locked
    // screen shows.
    const payload = {
      alerts: [{ labels: { alertname: 'OperatorTestPage', severity: 'page', ack_code: '7QK3F2' } }],
    };
    assert.equal(codeInNotification(payload), '7QK3F2');
    assert.equal(codeInNotification({ alerts: [{ labels: { alertname: 'ApiDown' } }] }), null);
    assert.equal(codeInNotification({}), null);
  });
});
