#!/usr/bin/env node
/**
 * Reads enrolments.mjs source to prove go-live 6.3's ordering promises. `--dry-run` returns, and an
 * unresolved identifier refuses the batch, before anything is written, in one transaction.
 * Structural rather than driven, because the likely regression is a reorder, and this needs no
 * database. `enrolments-database.test.ts` covers what a grant does.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'enrolments.mjs');
const SOURCE = readFileSync(CLI_PATH, 'utf8');

export function functionBody(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`async function ${name}(`));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^(?:async )?function \w+\(|^const \w+ = /u.test(line));
  return rest.slice(0, end === -1 ? undefined : end).join('\n');
}

// The repository calls are listed too, so a write moved out of the transaction is still seen.
export function firstWriteIndex(body) {
  const marks = ['sql.begin(', 'enrolments.grant(', 'enrolments.revoke(', 'enrolments.createCohort(']
    .map((mark) => body.indexOf(mark))
    .filter((at) => at !== -1);
  return marks.length === 0 ? -1 : Math.min(...marks);
}

// Measured at the `return`, not at the flag test.
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

  it('the whole batch is ONE transaction, not one per learner (REGRESSION)', () => {
    // go-live 6.4. Moving the transaction inside the loop would pass every other check in this file.
    for (const name of WRITING_COMMANDS) {
      const body = functionBody(SOURCE, name);
      const begin = body.indexOf('sql.begin(');
      const loop = body.indexOf('for (const { user } of resolution.resolved)', begin === -1 ? 0 : begin);
      assert.notEqual(begin, -1, `${name} no longer opens a transaction`);
      assert.notEqual(
        loop,
        -1,
        `${name} no longer loops over the resolved learners inside its transaction, so this guard ` +
          'cannot tell whether the batch is still atomic',
      );
      assert.ok(
        begin < loop,
        `${name} opens its transaction inside the per-learner loop, so a batch is one transaction ` +
          'per learner and a closed terminal leaves a class partly enrolled',
      );
      assert.equal(
        body.split('sql.begin(').length - 1,
        1,
        `${name} opens more than one transaction; the batch is no longer one unit`,
      );
    }
  });

  it('NEGATIVE CONTROL — a write hoisted above either refusal is caught', () => {
    const body = functionBody(SOURCE, 'commandGrant');
    assert.ok(body !== null);

    const hoisted = `const outcomes = await sql.begin(async (tx) => []);\n${body}`;
    assert.ok(
      dryRunReturnIndex(hoisted) > firstWriteIndex(hoisted),
      'the check cannot see a write hoisted above the dry-run return',
    );
    assert.ok(
      hoisted.indexOf('refuseUnresolved(') > firstWriteIndex(hoisted),
      'the check cannot see a write hoisted above refuseUnresolved',
    );

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
