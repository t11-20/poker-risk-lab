/**
 * Tests for the package's public surface.
 *
 * `src/index.ts` lists every export by name rather than using `export *`, which makes
 * the surface reviewable and costs one thing: the list can fall behind. A module gains
 * a function, nobody adds it to the index, and it is unreachable from outside the
 * package — the `exports` map publishes the index alone, so a deep import cannot rescue
 * it. That failure is invisible inside this package, because every test here imports
 * from `../src/<module>.ts` directly, and it shows up as a compile error in whichever
 * app needed the function weeks later.
 *
 * So this file compares the index against the modules themselves. It is a consistency
 * check between two things in the repository, not a list of expected names copied out
 * of the index — a hand-written list would need updating in two places and would
 * therefore stop being a check at all.
 *
 * ## What it can and cannot see
 *
 * Runtime bindings only: functions, classes and constants. Types and interfaces are
 * erased before this file runs, so nothing here can tell whether `EquityResult` is
 * exported. `tsc` covers that from the other side — re-exporting a type that does not
 * exist, or forgetting the `type` modifier under `verbatimModuleSyntax`, fails the
 * typecheck — so the two together cover the surface.
 *
 * Identity, not just presence: every check compares with `===` against the binding the
 * module itself exports. A name that matched but pointed at a different function would
 * pass a presence check and is exactly the kind of drift that matters.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as coach from '../src/coach.ts';
import * as consistency from '../src/consistency.ts';
import * as equity from '../src/equity.ts';
import * as ev from '../src/ev.ts';
import * as format from '../src/format.ts';
import * as handRanking from '../src/hand-ranking.ts';
import * as icm from '../src/icm.ts';
import * as index from '../src/index.ts';
import * as odds from '../src/odds.ts';
import * as outs from '../src/outs.ts';
import * as ranges from '../src/ranges.ts';
import * as stacks from '../src/stacks.ts';
import * as variance from '../src/variance.ts';

/** The modules whose exports the index is expected to republish, in its own order. */
const PUBLIC_MODULES: readonly (readonly [string, Record<string, unknown>])[] = [
  ['coach.ts', coach],
  ['consistency.ts', consistency],
  ['equity.ts', equity],
  ['ev.ts', ev],
  ['hand-ranking.ts', handRanking],
  ['icm.ts', icm],
  ['odds.ts', odds],
  ['outs.ts', outs],
  ['ranges.ts', ranges],
  ['stacks.ts', stacks],
  ['variance.ts', variance],
];

/** Named separately because the index is expected NOT to republish it. */
const INTERNAL_MODULES: readonly (readonly [string, Record<string, unknown>])[] = [['format.ts', format]];

const indexExports: Record<string, unknown> = index;

test('every runtime export of every public module is reachable from the index', () => {
  const missing: string[] = [];
  const wrongBinding: string[] = [];
  let checked = 0;
  for (const [moduleName, module] of PUBLIC_MODULES) {
    for (const [name, binding] of Object.entries(module)) {
      checked += 1;
      if (!(name in indexExports)) {
        missing.push(`${name} (${moduleName})`);
        continue;
      }
      if (indexExports[name] !== binding) wrongBinding.push(`${name} (${moduleName})`);
    }
  }
  assert.deepEqual(missing, [], 'these exports exist but no other package can reach them');
  assert.deepEqual(wrongBinding, [], 'these names are exported but do not point at the module binding');
  // A floor rather than an exact figure: it asserts the loop actually ran over a real
  // surface, without turning every new export into a failing count.
  assert.ok(checked >= 60, `expected the package to export at least 60 runtime bindings, saw ${checked}`);
});

test('the index invents nothing of its own', () => {
  const fromModules = new Set<unknown>();
  for (const [, module] of PUBLIC_MODULES) {
    for (const binding of Object.values(module)) fromModules.add(binding);
  }
  const unexpected = Object.keys(indexExports).filter((name) => !fromModules.has(indexExports[name]));
  assert.deepEqual(
    unexpected,
    [],
    'the index should re-export module bindings only — it holds no logic of its own',
  );
});

test('no two modules export the same name', () => {
  // This is the property that makes an explicit index safe to maintain. If two modules
  // exported the same name, the index would have to silently drop or rename one of
  // them, and a caller would get whichever the author happened to list.
  const owners = new Map<string, string[]>();
  for (const [moduleName, module] of PUBLIC_MODULES) {
    for (const name of Object.keys(module)) {
      const existing = owners.get(name) ?? [];
      existing.push(moduleName);
      owners.set(name, existing);
    }
  }
  const clashes = [...owners.entries()]
    .filter(([, modules]) => modules.length > 1)
    .map(([name, modules]) => `${name}: ${modules.join(' and ')}`);
  assert.deepEqual(clashes, [], 'two modules export the same name, so the index cannot republish both');
});

test('the formatting helpers stay internal', () => {
  // format.ts exists to build the sentences a learner reads. Publishing it would invite
  // another package to render a figure through it and treat the rounding as a promise,
  // which it is not.
  const leaked: string[] = [];
  for (const [moduleName, module] of INTERNAL_MODULES) {
    for (const [name, binding] of Object.entries(module)) {
      for (const [exportedName, exportedBinding] of Object.entries(indexExports)) {
        if (exportedBinding === binding) leaked.push(`${name} (${moduleName}) as ${exportedName}`);
      }
    }
  }
  assert.deepEqual(leaked, [], 'internal helpers must not appear on the package surface');
});

test('the error classes are part of the surface, not implementation detail', () => {
  // A caller matching on `error.message` has a contract that breaks the next time
  // somebody improves the teaching text, which happens often. Every module that throws
  // exports its class, and the index has to carry all of them.
  const expected = [
    'CoachError',
    'ConsistencyError',
    'EquityError',
    'EvError',
    'HandRankingError',
    'IcmError',
    'OddsError',
    'OutsError',
    'RangeParseError',
    'StackError',
    'VarianceError',
  ];
  for (const name of expected) {
    const exported = indexExports[name];
    assert.equal(typeof exported, 'function', `${name} must be exported from the package index`);
    assert.ok(
      Object.prototype.isPrototypeOf.call(Error, exported as object),
      `${name} must be an Error subclass`,
    );
  }
});
