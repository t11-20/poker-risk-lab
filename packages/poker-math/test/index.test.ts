/**
 * `src/index.ts` lists every export by name, and the `exports` map publishes only the index, so a
 * function missing from it is unreachable outside the package. This compares the index against the
 * modules themselves, by identity (`===`). Runtime bindings only; `tsc` covers types.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as coach from '../src/coach.ts';
import * as coachView from '../src/coach-view.ts';
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
import * as reprice from '../src/reprice.ts';
import * as stacks from '../src/stacks.ts';
import * as tableSizing from '../src/table-sizing.ts';
import * as variance from '../src/variance.ts';

const PUBLIC_MODULES: readonly (readonly [string, Record<string, unknown>])[] = [
  ['coach.ts', coach],
  ['coach-view.ts', coachView],
  ['consistency.ts', consistency],
  ['equity.ts', equity],
  ['ev.ts', ev],
  ['hand-ranking.ts', handRanking],
  ['icm.ts', icm],
  ['odds.ts', odds],
  ['outs.ts', outs],
  ['ranges.ts', ranges],
  ['reprice.ts', reprice],
  ['stacks.ts', stacks],
  ['table-sizing.ts', tableSizing],
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
  // A floor proves the loop ran over a real surface without failing on every new export.
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
  // A name exported by two modules would force the index to drop or rename one.
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
  // format.ts builds learner sentences. Its rounding is not a promise to other packages.
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
  // Callers match on the error class, not `error.message`, so every module's error class is exported.
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
