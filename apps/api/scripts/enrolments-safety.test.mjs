#!/usr/bin/env node
/**
 * The two orderings the enrolment CLI's operator-facing promises rest on.
 *
 * Run with:  node --test apps/api/scripts/enrolments-safety.test.mjs
 *
 * ## Why this exists
 *
 * `pnpm run enrolments` is how a class gets onto this system. There is no admin HTTP surface by
 * design, so this CLI is the ONLY way anybody is enrolled, and `prl_app` holds SELECT alone on both
 * tables — which means a mistake here cannot be repaired through the product.
 *
 * `docs/production/go-live.md` step 6.3 instructs the operator to rehearse with
 * `--dry-run` and states the pass condition: "every identifier resolves; **it refuses the whole
 * batch if any does not**". Two promises, both about ORDER:
 *
 *   1. `--dry-run` returns before anything is written.
 *   2. an unresolved identifier refuses the batch before anything is written.
 *
 * Neither was asserted anywhere. `apps/api/scripts/enrolments.test.mjs` tests `parseArgs` and
 * `parseInstant` — the two exports — and stops there; `apps/api/test/enrolments-database.test.ts`
 * imports `src/repositories/enrolments.ts` and never loads this file at all. So the repository
 * beneath the CLI is covered 27 ways and the CLI's own control flow, which is where both promises
 * live, was covered by reading it.
 *
 * ## Why a structural check rather than a driven one
 *
 * The realistic regression is a REORDER: a write hoisted above the `--dry-run` return, an audit
 * line moved up, `refuseUnresolved` shifted below the transaction during a tidy-up. Driving the CLI
 * proves the current order once; reading it proves the order is the one the promise needs, and it
 * needs no database, which is what lets it run in `test:scripts` on every commit rather than only
 * where PostgreSQL happens to be.
 *
 * It is deliberately narrow. It does not check that a grant grants — `enrolments-database.test.ts`
 * decides that against PostgreSQL's own `now()`. It checks that the two refusals cannot be
 * overtaken by a write.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'enrolments.mjs');
const SOURCE = readFileSync(CLI_PATH, 'utf8');

/** The body of one top-level `async function name(...)`, up to the next top-level declaration. */
export function functionBody(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`async function ${name}(`));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^(?:async )?function \w+\(|^const \w+ = /u.test(line));
  return rest.slice(0, end === -1 ? undefined : end).join('\n');
}

/**
 * Where the first WRITE happens in a body, or -1.
 *
 * `sql.begin(` is the transaction both writing commands open. The repository calls are listed too
 * so that a write moved out of the transaction — which would be a separate bug — is still seen as a
 * write rather than slipping past a check that only knew one spelling.
 */
export function firstWriteIndex(body) {
  const marks = ['sql.begin(', 'enrolments.grant(', 'enrolments.revoke(', 'enrolments.createCohort(']
    .map((mark) => body.indexOf(mark))
    .filter((at) => at !== -1);
  return marks.length === 0 ? -1 : Math.min(...marks);
}

/** Where the `--dry-run` early return is, measured at the `return` and not at the flag test. */
export function dryRunReturnIndex(body) {
  const guard = body.indexOf("options.flags.has('dry-run')");
  if (guard === -1) return -1;
  const ret = body.indexOf('return;', guard);
  return ret === -1 ? -1 : ret;
}

const WRITING_COMMANDS = ['commandGrant', 'commandRevoke'];

describe('the enrolment CLI cannot write before it has refused', () => {
  it('finds both writing commands, so a clean result is not an empty scan', () => {
    for (const name of WRITING_COMMANDS) {
      const body = functionBody(SOURCE, name);
      assert.ok(body !== null, `${name} is no longer a top-level async function; this guard is stale`);
      assert.ok(
        firstWriteIndex(body) !== -1,
        `${name} contains no write this guard recognises. Either it stopped writing — in which ` +
          'case say so here — or it writes by a spelling `firstWriteIndex` does not know, and ' +
          'every ordering assertion below it is vacuous.',
      );
    }
  });

  it('--dry-run returns before anything is written (REGRESSION)', () => {
    // go-live 6.3 tells the operator to rehearse a batch of thirty with this flag. A dry run that
    // wrote even one row would enrol somebody nobody meant to enrol, on an authority nobody typed,
    // and the operator would be reading "nothing was written" while it happened.
    for (const name of WRITING_COMMANDS) {
      const body = functionBody(SOURCE, name);
      const dry = dryRunReturnIndex(body);
      const write = firstWriteIndex(body);
      assert.notEqual(dry, -1, `${name} no longer has a --dry-run early return`);
      assert.ok(
        dry < write,
        `${name} writes before its --dry-run return, so --dry-run writes. go-live 6.3 tells an ` +
          'operator to rely on it.',
      );
    }
  });

  it('an unresolved identifier refuses the batch before anything is written (REGRESSION)', () => {
    // The other half of 6.3's pass condition. Resolving thirty names and enrolling the twenty-nine
    // that matched is the failure mode this ordering prevents: a class silently short by one, found
    // when somebody cannot take a seat.
    for (const name of WRITING_COMMANDS) {
      const body = functionBody(SOURCE, name);
      const refuse = body.indexOf('refuseUnresolved(');
      const write = firstWriteIndex(body);
      assert.notEqual(refuse, -1, `${name} no longer calls refuseUnresolved`);
      assert.ok(
        refuse < write,
        `${name} writes before refuseUnresolved, so a batch with an unresolved identifier is ` +
          'partly applied instead of refused',
      );
    }
  });

  it('NEGATIVE CONTROL — a write hoisted above either refusal is caught', () => {
    const body = functionBody(SOURCE, 'commandGrant');
    assert.ok(body !== null);

    // A write moved above the dry-run return: the shape a tidy-up produces.
    const hoisted = `const outcomes = await sql.begin(async (tx) => []);\n${body}`;
    assert.ok(
      dryRunReturnIndex(hoisted) > firstWriteIndex(hoisted),
      'the check cannot see a write hoisted above the dry-run return',
    );
    assert.ok(
      hoisted.indexOf('refuseUnresolved(') > firstWriteIndex(hoisted),
      'the check cannot see a write hoisted above refuseUnresolved',
    );

    // And the guard deleted outright rather than moved.
    const withoutGuard = body.replace("if (options.flags.has('dry-run')) {", 'if (false) {');
    assert.notEqual(withoutGuard, body, 'the dry-run guard moved; this control is stale');
    assert.equal(dryRunReturnIndex(withoutGuard), -1);
  });

  it('NEGATIVE CONTROL — a body it cannot parse is refused, not passed', () => {
    assert.equal(functionBody(SOURCE, 'commandThatDoesNotExist'), null);
    assert.equal(firstWriteIndex('const x = 1;'), -1);
    assert.equal(dryRunReturnIndex('const x = 1;'), -1);
  });
});
