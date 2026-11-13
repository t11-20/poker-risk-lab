/**
 * Compiles this package's `src/` once and hands a test the real component back.
 * Node strips types but cannot run `.tsx`, and a hand-copy of a component would share its blind spots.
 * So the package's own `tsc` and `tsconfig.json` emit `src/` to a temp directory and the module is imported.
 * Each `node --test` file is its own process, so the compile cache below is per file.
 * The `node_modules` symlink makes the emitted module and the test resolve one physical React.
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
 * Registered at module scope, because `after()` attaches to the running test context. Inside
 * `compileSource` it would delete the build after the first test.
 */
after(() => {
  if (workspace !== null) rmSync(workspace, { recursive: true, force: true });
});

function tscEntryPoint(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
}

/**
 * Emits `src/` to a temp directory and returns it. Idempotent within a process.
 * `types` is emptied because ambient type packages do not resolve outside the workspace. Type errors
 * do not block emit, and `pnpm run typecheck` owns typechecking.
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

  writeFileSync(join(out, 'package.json'), '{"type":"module"}');
  symlinkSync(join(PACKAGE_ROOT, 'node_modules'), join(out, 'node_modules'), 'dir');

  outDir = out;
  return out;
}

/** One named export from the emitted build, asserted to be a component. `modulePath` has no extension. */
export async function loadComponent<P>(modulePath: string, exportName: string): Promise<Renderable<P>> {
  const entry = join(compileSource(), `${modulePath}.js`);
  assert.ok(existsSync(entry), `tsc emitted no ${modulePath}.js`);
  const loaded: unknown = await import(pathToFileURL(entry).href);
  const exported = (loaded as Record<string, unknown>)[exportName];
  assert.equal(typeof exported, 'function', `the emitted module does not export ${exportName}`);
  return exported as Renderable<P>;
}
