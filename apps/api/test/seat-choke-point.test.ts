/**
 * The claim `PRL_ENROLMENT_REQUIRED` rests on: `LiveTable.sit` has exactly three call sites.
 *
 * ## Why this file exists
 *
 * `seat-entitlement.test.ts` opens by stating it: "There are exactly three call sites of
 * `LiveTable.sit` in this codebase — `sitAtTable`, the restore loop in `ensureOpen`, and `seatBot`
 * — and `sitAtTable` is the only one a person reaches ... which is the property the guard rests
 * on." `CLAUDE.md` says the same thing from the other side: the guard "lives at a single choke
 * point in `rooms/registry.ts`, not on the routes, because there are three ways to reach a seat
 * and a fourth would otherwise arrive ungated."
 *
 * Both were **prose**. Nothing read the source. A fourth call site — a spectator promoted to a
 * player, a rematch that re-seats last hand's players, a tournament that assigns tables — would
 * have seated somebody with no entitlement check, and the suites that look like they would notice
 * do not. Measured: a `reseatForRematch` taking a seat with no gate was added to `registry.ts`,
 * and `seat-entitlement.test.ts`, `rooms.test.ts` and `ws-router.test.ts` together reported
 * **77 passing, 0 failing**. They assert the two transports, not the set of ways to be seated.
 * That is precisely the shape this branch keeps finding: a guard argued from a comment.
 *
 * It is worth a file of its own because of what it protects. A deployment running
 * `PRL_ENROLMENT_REQUIRED=enforced` is one where a seat is the thing a student was enrolled for.
 * An ungated fourth path is not a missing check; it is the product given away.
 *
 * ## What it asserts, and what it deliberately does not
 *
 * The set of enclosing methods, and for the two that seat a PERSON, that the entitlement gate is
 * named in that method before the seat is taken. It does not try to prove the gate is *correct* —
 * `seat-entitlement.test.ts` drives both transports through a real registry for that, and
 * `enrolments-database.test.ts` decides the window against PostgreSQL's own `now()`. This is the
 * completeness half: that there is no fourth door.
 *
 * A structural read rather than a runtime one on purpose: the defect is a call site that EXISTS
 * and is never exercised by any test, so nothing that runs the code can see it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = join(API_ROOT, 'src', 'rooms', 'registry.ts');

/**
 * Every call to `LiveTable.sit`, with the method it sits in.
 *
 * `sitAtTable` is excluded by the `\.sit\(` shape itself — it is a different name — and comments
 * are skipped so that the several paragraphs in `registry.ts` that DISCUSS `table.sit` are not
 * counted as calls. A parser that read prose would report the sites it hoped to find, which is a
 * mistake made twice on this branch.
 */
function sitCallSites(source: string): { method: string; line: number; text: string }[] {
  const found: { method: string; line: number; text: string }[] = [];
  let method = '<top level>';
  let inBlockComment = false;
  source.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      return;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      return;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

    const declaration =
      /^ {2}(?:private |public |protected )?(?:static )?(?:async )?([A-Za-z_]\w*)\s*[(<]/u.exec(line);
    // `noUncheckedIndexedAccess`: a capture group is `string | undefined` to the compiler even
    // when the pattern cannot match without it. Guarded rather than asserted, so a future edit to
    // the pattern that really does drop the group leaves the last method name in place instead of
    // writing `undefined` into it.
    const declaredName = declaration?.[1];
    if (declaredName !== undefined) method = declaredName;
    if (/\.sit\(/u.test(line)) found.push({ method, line: index + 1, text: trimmed });
  });
  return found;
}

/** The body of one method, from its declaration to the next one at the same indentation. */
function methodBody(source: string, name: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) =>
    new RegExp(`^ {2}(?:private |public |protected )?(?:static )?(?:async )?${name}\\s*[(<]`, 'u').test(line),
  );
  assert.notEqual(start, -1, `no method named ${name} in registry.ts; this guard is pointed at nothing`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) =>
    /^ {2}(?:private |public |protected )?(?:static )?(?:async )?[A-Za-z_]\w*\s*[(<]/u.test(line),
  );
  return rest.slice(0, end === -1 ? undefined : end).join('\n');
}

/**
 * The three, each with why it is allowed to seat somebody and what makes that safe.
 *
 * Adding a row here is the deliberate act this guard exists to force. It should be accompanied by
 * the gate, not by an entry.
 */
const ACCOUNTED_FOR = [
  {
    method: 'sitAtTable',
    reached: 'a person, over REST or the socket `sit` frame',
    gate: 'requireEntitledToSit',
  },
  {
    method: 'ensureOpen',
    reached: 'a person, given their chair back when a room re-opens after a restart',
    gate: 'entitledToResumeSeat',
  },
  {
    // A bot has a user row and can never hold an enrolment, so asking would empty every Legends
    // table on the first restart. `is_bot` is the whole of the exemption and it is read from the
    // durable row rather than inferred — which is `registry.ts`'s own argument, restated here so
    // that a reader of this list does not have to take the omission on trust.
    method: 'seatBot',
    reached: 'a bot, which cannot be enrolled and is never asked',
    gate: null,
  },
] as const;

describe('there is no fourth way to be seated', () => {
  const source = readFileSync(REGISTRY_PATH, 'utf8');

  it('finds the call sites at all, so a clean result is not an empty scan', () => {
    const sites = sitCallSites(source);
    assert.ok(
      sites.length >= 3,
      `parsed ${sites.length} call site(s) of LiveTable.sit. The parser has stopped understanding ` +
        'registry.ts, and every assertion below it would be vacuous.',
    );
  });

  it('every call site is one of the three accounted for (REGRESSION)', () => {
    const sites = sitCallSites(source);
    const expected = ACCOUNTED_FOR.map((entry) => entry.method).sort();
    const actual = [...new Set(sites.map((site) => site.method))].sort();
    assert.deepEqual(
      actual,
      expected,
      'the set of methods that seat somebody has changed. Every one of them is a way to take a ' +
        'seat, and on a deployment running PRL_ENROLMENT_REQUIRED=enforced a seat is the thing a ' +
        'student was enrolled for. A new call site must take the entitlement gate before it seats ' +
        `anybody, and then be added to ACCOUNTED_FOR with the reason. Found: ${actual.join(', ')}`,
    );
  });

  it('each site that seats a PERSON names its entitlement gate before doing it', () => {
    let checked = 0;
    for (const entry of ACCOUNTED_FOR) {
      if (entry.gate === null) continue;
      const body = methodBody(source, entry.method);
      const gateAt = body.indexOf(entry.gate);
      const sitAt = body.search(/\.sit\(/u);
      assert.notEqual(
        gateAt,
        -1,
        `${entry.method} seats ${entry.reached} and no longer mentions ${entry.gate}. The seat is ` +
          'ungated.',
      );
      assert.notEqual(sitAt, -1, `${entry.method} no longer calls .sit(); this guard is stale`);
      assert.ok(
        gateAt < sitAt,
        `${entry.method} calls ${entry.gate} AFTER taking the seat, which refuses somebody who is ` +
          'already sitting',
      );
      checked += 1;
    }
    assert.equal(
      checked,
      2,
      'the two person-reaching sites are the point; the loop checked a different number',
    );
  });

  it('NEGATIVE CONTROL — a fourth call site is caught, and a removed gate is caught', () => {
    // A rematch feature, written the obvious way: it has the room and the seat, so it seats.
    const withFourth = source.replace(
      '  async seatBot(',
      '  async reseatForRematch(roomId: string, userId: string, seat: number): Promise<void> {\n' +
        '    const room = this.require(roomId, userId);\n' +
        '    await room.table.sit({ userId, seat });\n' +
        '  }\n\n  async seatBot(',
    );
    assert.notEqual(withFourth, source, 'seatBot moved; this control is stale');
    const methods = [...new Set(sitCallSites(withFourth).map((site) => site.method))];
    assert.ok(
      methods.includes('reseatForRematch'),
      `a fourth call site was not detected; found ${methods.join(', ')}`,
    );

    // And the gate quietly dropped from the one a person reaches.
    const ungated = source.replace('await this.requireEntitledToSit(', 'await Promise.resolve(');
    assert.notEqual(ungated, source, 'the gate call moved; this control is stale');
    assert.equal(methodBody(ungated, 'sitAtTable').includes('requireEntitledToSit'), false);
  });

  it('does not count a comment that merely discusses table.sit (REGRESSION)', () => {
    // `registry.ts` argues about `table.sit` at length in prose, including the sentence this file
    // is written against. A parser that read those would report call sites nobody wrote.
    const commentary = [
      'class X {',
      '  // await room.table.sit({ userId, seat });',
      '  /* this method used to call room.table.sit() and no longer does */',
      '  harmless(): void {',
      '    return;',
      '  }',
      '}',
    ].join('\n');
    assert.deepEqual(sitCallSites(commentary), []);
  });
});
