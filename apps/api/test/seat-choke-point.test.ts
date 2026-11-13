/**
 * `LiveTable.sit` has exactly three call sites in `rooms/registry.ts`, and the two that seat a
 * person name their entitlement gate first. This is what `PRL_ENROLMENT_REQUIRED` rests on.
 * A structural read on purpose, because an ungated fourth call site that no test exercises is invisible at
 * runtime (an ungated `reseatForRematch` left the three runtime suites at 77 passing, 0 failing).
 * Gate correctness is tested in seat-entitlement.test.ts and enrolments-database.test.ts.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = join(API_ROOT, 'src', 'rooms', 'registry.ts');

// Comments are skipped because `registry.ts` discusses `table.sit` in prose.
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
    const declaredName = declaration?.[1];
    if (declaredName !== undefined) method = declaredName;
    if (/\.sit\(/u.test(line)) found.push({ method, line: index + 1, text: trimmed });
  });
  return found;
}

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

// A new row here must come with its gate.
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
    // A bot can never hold an enrolment, so gating it would empty every Legends table on restart.
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

    const ungated = source.replace('await this.requireEntitledToSit(', 'await Promise.resolve(');
    assert.notEqual(ungated, source, 'the gate call moved; this control is stale');
    assert.equal(methodBody(ungated, 'sitAtTable').includes('requireEntitledToSit'), false);
  });

  it('does not count a comment that merely discusses table.sit (REGRESSION)', () => {
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
