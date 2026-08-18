#!/usr/bin/env node
/**
 * Gate: first-party source files must be clean UTF-8 text.
 *
 * Added after a real incident during development: a stray NUL byte was written
 * into `scripts/supply-chain/lib.mjs` inside a template literal. It was invisible
 * in every editor and in `git diff`, the file still parsed, and the code still
 * ran — it silently changed a map key separator. Control characters are also a
 * classic way to hide code: a bidirectional override or a zero-width character
 * can make a line read as something other than what the parser sees.
 *
 * So: no NUL bytes, no unexpected C0 control characters, no Unicode bidi
 * overrides, no zero-width characters, no invalid UTF-8, and no CRLF drift in
 * first-party source.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Gate, REPO_ROOT, runGate } from './lib.mjs';

const gate = new Gate('repo-hygiene');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', 'coverage', 'sbom', '.pnpm-store']);
const CHECK_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.json',
  '.css',
  '.sql',
  '.yml',
  '.yaml',
  '.md',
  '.sh',
  '.html',
]);

/** Tab, LF and CR are the only C0 controls allowed in source. */
const ALLOWED_C0 = new Set([0x09, 0x0a, 0x0d]);

/** Bidi overrides / isolates and zero-width characters used for visual spoofing. */
const DANGEROUS_CODEPOINTS = new Map([
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE (BOM in the middle of a file)'],
]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (entry.isFile()) {
      yield join(dir, entry.name);
    }
  }
}

function extensionOf(path) {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot) : '';
}

/** Line/column of a byte offset, for an actionable error message. */
function positionOf(buf, offset) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return `${line}:${col}`;
}

await runGate(gate, () => {
  let checked = 0;

  for (const full of walk(REPO_ROOT)) {
    if (!CHECK_EXTENSIONS.has(extensionOf(full))) continue;
    if (statSync(full).size > 4 * 1024 * 1024) continue;
    const rel = relative(REPO_ROOT, full).split('\\').join('/');
    const buf = readFileSync(full);
    checked += 1;

    // --- raw byte checks ---
    for (let i = 0; i < buf.length; i++) {
      const byte = buf[i];
      if (byte === 0) {
        gate.fail(
          `NUL byte in ${rel} at ${positionOf(buf, i)}`,
          'invisible in editors and diffs, and it silently changes string contents',
        );
        break;
      }
      if (byte < 0x20 && !ALLOWED_C0.has(byte)) {
        gate.fail(
          `control character 0x${byte.toString(16).padStart(2, '0')} in ${rel} at ${positionOf(buf, i)}`,
        );
        break;
      }
      if (byte === 0x7f) {
        gate.fail(`DEL character in ${rel} at ${positionOf(buf, i)}`);
        break;
      }
    }

    // --- UTF-8 validity: decoding with fatal:true rejects malformed sequences ---
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      gate.fail(`${rel} is not valid UTF-8`);
      continue;
    }

    // --- dangerous codepoints ---
    for (const [index, char] of [...text].entries()) {
      const cp = char.codePointAt(0);
      if (cp === undefined) continue;
      // A BOM at offset 0 is tolerated; anywhere else it is a hidden character.
      if (cp === 0xfeff && index === 0) continue;
      const name = DANGEROUS_CODEPOINTS.get(cp);
      if (name) {
        gate.fail(
          `hidden/bidi character U+${cp.toString(16).toUpperCase().padStart(4, '0')} (${name}) in ${rel}`,
          'these can make source read differently to a human than to the parser',
        );
        break;
      }
    }

    // --- line endings ---
    if (buf.includes(0x0d)) {
      gate.fail(
        `CRLF or lone CR line endings in ${rel}`,
        'the repo is LF-only (tsconfig newLine=lf, biome lineEnding=lf)',
      );
    }

    // --- trailing newline ---
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) {
      gate.warn(`${rel} does not end with a newline`);
    }
  }

  gate.note(`checked ${checked} first-party source files for encoding and hidden-character defects`);

  checkRandomnessBan(gate);
});

// ---------------------------------------------------------------------------
// The repo-wide Math.random ban
// ---------------------------------------------------------------------------

/**
 * `Math.random` must not appear in any first-party `src/` tree.
 *
 * ## Why this is a repo gate and not (only) a test
 *
 * The ban was enforced over TWO of the repository's seven source trees: `apps/api/src`
 * (`test/server-randomness.test.ts`) and `packages/poker-engine/src`
 * (`packages/poker-engine/test/rng.test.ts`). Unscanned were `packages/poker-math/src` — which
 * holds `monteCarloEquity` and the variance simulations, precisely where reaching for
 * `Math.random()` is most tempting — plus `packages/poker-ai/src`, `packages/ui/src`,
 * `packages/content/src`, `packages/contracts/src` and `apps/web/src`. Two of those packages have
 * no place to put such a test at all: `apps/web` had no test script until recently, and a
 * cross-package scan from inside one package's suite would be reaching across a boundary that
 * exists for a reason.
 *
 * A repository gate is the right home for a repository-wide rule. The per-package tests remain,
 * because a package's own suite should prove its own claims — `packages/poker-ai/src/policy.ts`
 * says "`Math.random` is banned in this package and asserted absent", and
 * `packages/poker-ai/test/no-math-random.test.ts` is now what makes that sentence true.
 *
 * ## The detector proves it can fail
 *
 * `gate.fail` on a violation is only half of a check. The self-test below feeds the detector a
 * violation and a prose mention and fails the gate if it cannot tell them apart, so a scan that
 * silently stopped matching cannot pass as a clean repository.
 */
function checkRandomnessBan(gate) {
  const trees = sourceTrees();
  // Seven trees today: apps/api, apps/web, and the five publishing packages. Stated as a lower
  // bound rather than an equality so adding a package does not fail the gate for the wrong reason —
  // but losing one does, because a tree that stops being scanned is exactly this defect.
  if (trees.length < 7) {
    gate.fail(
      `found only ${trees.length} src/ trees to scan for Math.random`,
      'the ban is repo-wide; a tree that silently drops out of the scan is how it was enforced over 2 of 7',
    );
  }

  if (stripComments('const x = Math.random();').includes('Math.random') === false) {
    gate.fail('the Math.random detector no longer fires on real code');
  }
  if (stripComments('// mentions Math.random in prose').includes('Math.random')) {
    gate.fail('the Math.random detector fires on prose, so it cannot be trusted');
  }

  let scanned = 0;
  for (const tree of trees) {
    for (const file of walk(join(REPO_ROOT, tree))) {
      if (!/\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(file)) continue;
      scanned += 1;
      const code = stripComments(readFileSync(file, 'utf8'));
      if (!code.includes('Math.random')) continue;
      gate.fail(
        `Math.random in ${relative(REPO_ROOT, file).split('\\').join('/')}`,
        'cards, tokens, invite codes and every reproducible simulation come from a CSPRNG or an ' +
          'injected seeded source; Math.random is neither and cannot be replayed',
      );
    }
  }
  if (scanned < 40) {
    gate.fail(`the Math.random scan matched only ${scanned} files`, 'a scan of nothing proves nothing');
  }
  gate.note(`scanned ${scanned} source files across ${trees.length} src/ trees for Math.random`);
}

/** Every first-party source tree: the `src` directory of each apps/ and packages/ member. */
function sourceTrees() {
  const trees = [];
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(join(REPO_ROOT, group), { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const tree = `${group}/${entry.name}/src`;
      try {
        if (statSync(join(REPO_ROOT, tree)).isDirectory()) trees.push(tree);
      } catch {
        // No `src/` in that workspace member. Nothing to scan, and not a defect.
      }
    }
  }
  return trees;
}

/**
 * Removes block and line comments, so a prose mention of a banned API is not read as a use of it.
 *
 * The same function the two existing guard tests use, limitation included: it is not a parser, so a
 * line comment or a block-comment opener inside a string literal would confuse it. The `[^:]` before the line-comment match is
 * what stops it eating the rest of a line after `https://`.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
