#!/usr/bin/env node
/**
 * Gate: first-party source is clean UTF-8 text. No NUL bytes, unexpected C0 controls, bidi
 * overrides, zero-width characters, invalid UTF-8 or CRLF drift. Added after a stray NUL inside a
 * template literal in `lib.mjs` silently changed a map key separator and was invisible in `git diff`.
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
  // `deploy/staging/nginx.conf` decides how TLS terminates and how X-Forwarded-For is set.
  '.conf',
]);

/**
 * Files identified by name. `extensionOf` gives `Dockerfile.api` the extension `.api`, so an
 * extension match never checks the Dockerfiles or `.dockerignore`.
 */
const CHECK_NAMES = /^(?:Dockerfile(?:\..+)?|\.dockerignore|Caddyfile)$/;

/** Both separators, because `walk` yields native paths. */
function isChecked(path) {
  const name = path.split(/[\\/]/).pop() ?? path;
  return CHECK_NAMES.test(name) || CHECK_EXTENSIONS.has(extensionOf(path));
}

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

/**
 * Proves the selector tells its files from others before the gate claims a clean repository. It
 * once silently skipped both Dockerfiles and `.dockerignore`.
 */
function checkFileSelector(gate) {
  for (const path of [
    'Dockerfile',
    'Dockerfile.api',
    'apps/api/src/app.ts',
    '.dockerignore',
    'a/nginx.conf',
  ]) {
    if (isChecked(path)) continue;
    gate.fail(
      `the file selector no longer matches ${path}`,
      'this gate would pass over it without reading it',
    );
  }
  for (const path of ['docs/sbom/report.pdf', 'deploy/staging/tls/staging-key.pem', 'notes.rtf']) {
    if (!isChecked(path)) continue;
    gate.fail(
      `the file selector matches ${path}, which is not first-party text`,
      'a selector that matches binaries and generated key material will fail the gate for the wrong reason',
    );
  }
}

await runGate(gate, () => {
  let checked = 0;
  let containerFiles = 0;

  checkFileSelector(gate);

  for (const full of walk(REPO_ROOT)) {
    if (!isChecked(full)) continue;
    if (CHECK_NAMES.test(full.split(/[\\/]/).pop() ?? '')) containerFiles += 1;
    if (statSync(full).size > 4 * 1024 * 1024) continue;
    const rel = relative(REPO_ROOT, full).split('\\').join('/');
    const buf = readFileSync(full);
    checked += 1;

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

    // fatal:true rejects malformed sequences.
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      gate.fail(`${rel} is not valid UTF-8`);
      continue;
    }

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

    if (buf.includes(0x0d)) {
      gate.fail(
        `CRLF or lone CR line endings in ${rel}`,
        'the repo is LF-only (tsconfig newLine=lf, biome lineEnding=lf)',
      );
    }

    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) {
      gate.warn(`${rel} does not end with a newline`);
    }
  }

  gate.note(`checked ${checked} first-party source files for encoding and hidden-character defects`);

  // A lower bound, so adding a container file passes and losing one fails. Three today:
  // Dockerfile.api, Dockerfile.web and .dockerignore.
  if (containerFiles < 3) {
    gate.fail(
      `only ${containerFiles} container file(s) were encoding-checked`,
      'Dockerfile.api, Dockerfile.web and .dockerignore all describe the artefact that ships and all ' +
        'used to be invisible to this gate. Fewer than three means one has stopped being read.',
    );
  } else {
    gate.note(`${containerFiles} container file(s) (Dockerfiles, .dockerignore) were among them`);
  }

  checkRandomnessBan(gate);
});

/**
 * `Math.random` must not appear in any first-party `src/` tree. Tests covered only two of eight
 * trees, and `packages/poker-math/src` holds the Monte Carlo code where it is most tempting. The
 * per-package tests stay. The self-test below must tell a violation from a prose mention.
 */
function checkRandomnessBan(gate) {
  const trees = sourceTrees();
  // Eight trees today, as a lower bound. It once read 7 while the scan printed 8, so it could not
  // fire for the tree that mattered.
  if (trees.length < 8) {
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
 * Removes comments so a prose mention is not read as a use. Not a parser: a comment opener inside a
 * string literal confuses it. The `[^:]` stops the line-comment rule eating a line after `https://`.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
