/**
 * Compiles this package's `src/` once and hands a test the **real** component back.
 *
 * ## Why any of this is necessary
 *
 * Node runs `.ts` by stripping types, but it cannot run `.tsx`: JSX has to be transformed,
 * not erased. The tempting alternative is to test a hand-copy of a component's logic — and
 * that is precisely the failure mode the render tests exist to catch. `format.test.ts`
 * proved `formatPercent(0.36) === "36.0%"` throughout the entire period in which a shipped
 * page told a learner a nine-out flush draw was **"3,600.0%"**. The formatter was never
 * wrong; the *pairing* between producer and component was, and no test of either half could
 * see the join. A copy of the component would have reproduced the same blind spot.
 *
 * So the package's own `tsc` emits `src/` to a temporary directory and the emitted module is
 * imported. That is the real component, compiled by the same compiler and the same
 * `tsconfig.json` the app uses, rendered by the same React the app ships.
 *
 * ## Why this is a shared helper rather than a copy per test file
 *
 * The compile is the expensive part and the fiddly part — the `types: []` override, the
 * `node_modules` symlink, the `{"type":"module"}` marker — and every one of those is a
 * detail a second copy would get subtly different. It is also what makes adding a render
 * test for the *next* component a five-line job rather than a hundred-line one, which
 * matters: only a handful of this package's components have ever been rendered by a test.
 *
 * Each `node --test` file is its own process, so the compile happens once per file that
 * needs it and the cache below is per-process by construction.
 *
 * ## The `node_modules` symlink
 *
 * The temp directory gets a symlink to this package's own `node_modules`, so
 * `react/jsx-runtime` and `@prl/contracts` inside the emitted module resolve to the same
 * physical files as the `react` the test imports. Node realpaths symlinked packages, so both
 * paths reach one instance and there is no second copy of React.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ReactElement } from 'react';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A component as a test needs to see it: props in, element out. */
export type Renderable<P> = (props: P) => ReactElement;

let outDir: string | null = null;
let workspace: string | null = null;

/**
 * Registered at module scope, not inside `compileSource`.
 *
 * `after()` attaches to whatever test context is running when it is called. `compileSource`
 * is first reached from *inside* a test, so registering there would tear the emitted build
 * down as soon as that first test finished and every later one would fail with "tsc emitted
 * nothing" — which is exactly what happened. At module scope it is a root hook, so the
 * directory lives for the whole file.
 */
after(() => {
  if (workspace !== null) rmSync(workspace, { recursive: true, force: true });
});

/** The `tsc` this repo pins, found through its own package rather than by guessing a path. */
function tscEntryPoint(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
}

/**
 * Emits `src/` to a temp directory and returns it. Idempotent within a process.
 *
 * The package's own config is extended with emit turned on. `types` is emptied because the
 * ambient type packages are not resolvable from a directory outside the workspace; type
 * errors do not block emit, and typechecking is `pnpm run typecheck`'s job, not this file's.
 */
export function compileSource(): string {
  if (outDir !== null) return outDir;

  const dir = mkdtempSync(join(tmpdir(), 'prl-ui-render-'));
  workspace = dir;

  const out = join(dir, 'out');
  const config = join(dir, 'tsconfig.json');
  writeFileSync(
    config,
    JSON.stringify({
      extends: join(PACKAGE_ROOT, 'tsconfig.json'),
      compilerOptions: {
        noEmit: false,
        outDir: out,
        rootDir: join(PACKAGE_ROOT, 'src'),
        declaration: false,
        declarationMap: false,
        sourceMap: false,
        incremental: false,
        skipLibCheck: true,
        types: [],
      },
      include: [join(PACKAGE_ROOT, 'src', '**', '*.ts'), join(PACKAGE_ROOT, 'src', '**', '*.tsx')],
    }),
  );

  const result = spawnSync(process.execPath, [tscEntryPoint(), '-p', config], { encoding: 'utf8' });
  assert.ok(
    existsSync(join(out, 'index.js')),
    `tsc emitted nothing.\nstdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`,
  );

  // `type: module` so the emitted ESM is read as ESM, and the symlink so `react/jsx-runtime`
  // and `@prl/contracts` resolve from inside the temp tree.
  writeFileSync(join(out, 'package.json'), '{"type":"module"}');
  symlinkSync(join(PACKAGE_ROOT, 'node_modules'), join(out, 'node_modules'), 'dir');

  outDir = out;
  return out;
}

/**
 * One named export from the emitted build, asserted to be a component.
 *
 * @param modulePath path under `src/`, without an extension — e.g. `components/CardRow`
 * @param exportName the export to take, e.g. `CardRow`
 */
export async function loadComponent<P>(modulePath: string, exportName: string): Promise<Renderable<P>> {
  const entry = join(compileSource(), `${modulePath}.js`);
  assert.ok(existsSync(entry), `tsc emitted no ${modulePath}.js`);
  const loaded: unknown = await import(pathToFileURL(entry).href);
  const exported = (loaded as Record<string, unknown>)[exportName];
  assert.equal(typeof exported, 'function', `the emitted module does not export ${exportName}`);
  return exported as Renderable<P>;
}
