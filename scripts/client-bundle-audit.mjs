#!/usr/bin/env node
/**
 * Gate: the bundler's Node `crypto` polyfill (about 135 KB gzip) reaches only the routes that hash in
 * the browser. It reads a production build of apps/web, not the source, because whether a barrel
 * import pulls `node:crypto` in is decided by tree-shaking and `"sideEffects"`, which only the bundler
 * knows. Every route's first-load JS, every worker and every lazily loaded chunk are checked.
 *
 * Run with:  node scripts/client-bundle-audit.mjs [--dir apps/web/.next] [--json]
 * `pnpm run build` runs it after `next build`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BUILD_DIR = join(REPO_ROOT, 'apps', 'web', '.next');

/**
 * Strings that survive minification, from three parts of crypto-browserify: randombytes, hash-base
 * and elliptic. The allowed route must carry all three, so a polyfill that changes shape fails loudly.
 */
export const CRYPTO_POLYFILL_MARKERS = Object.freeze([
  'Secure random number generation is not supported by this browser',
  'Digest already called',
  'secp256k1',
]);

/** Route → why it may ship the polyfill. */
export const ALLOWED_ROUTES = new Map([
  ['/review/[handId]', '`verifyDeckReveal` needs a synchronous SHA-256 (CommitmentVerifier.tsx)'],
]);

/** Entry kinds that load with the page; `error`, `not-found` and `global-error` load only on failure. */
const FIRST_LOAD_ENTRY = /\/(?:layout|page|template|loading)$/u;

const WORKER_CHUNK_LIST = /"(static\/chunks\/turbopack-worker-[^"]+\.js)",\[([^\]]*)\]/gu;

function manifestFiles(dir) {
  const found = [];
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'page_client-reference-manifest.js') found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}

/** Parsed as JSON rather than evaluated: the file is one assignment of an object literal. */
export function parseClientManifest(text) {
  const match = /__RSC_MANIFEST\[("[^"]+")\]\s*=\s*(\{[\s\S]*\})\s*;?\s*$/u.exec(text);
  if (match === null) throw new Error('not a client reference manifest in the shape this gate reads');
  const key = JSON.parse(match[1]);
  const manifest = JSON.parse(match[2]);
  if (!key.endsWith('/page')) throw new Error(`manifest key ${key} does not name a page`);
  const entries = manifest.entryJSFiles;
  if (entries === null || typeof entries !== 'object') throw new Error(`${key} has no entryJSFiles`);
  const route = key.slice(0, -'/page'.length) || '/';
  const pairs = Object.entries(entries);
  // `/_global-error` has no page entry: its `global-error` entry is what it loads.
  const firstLoad = pairs.filter(([entry]) => FIRST_LOAD_ENTRY.test(entry));
  const files = new Set((firstLoad.length > 0 ? firstLoad : pairs).flatMap(([, list]) => list));
  if (files.size === 0) throw new Error(`${key} lists no entry files`);
  return { route, files };
}

/** Every worker spawned anywhere, one entry per spawn site: Turbopack gives all workers one entry file. */
export function collectWorkers(chunks) {
  const workers = [];
  for (const [chunk, text] of chunks) {
    for (const { worker, files } of workerChunkLists(text)) workers.push({ worker, spawnedBy: chunk, files });
  }
  return workers;
}

export function workerChunkLists(chunkText) {
  return [...chunkText.matchAll(WORKER_CHUNK_LIST)].map((match) => ({
    worker: match[1],
    files: [...match[2].matchAll(/"([^"]+)"/gu)].map((file) => file[1]),
  }));
}

/** Everything the audit needs, read off disk once. Refuses a build it cannot read. */
export function readBuild(dir = DEFAULT_BUILD_DIR) {
  if (!existsSync(join(dir, 'BUILD_ID'))) {
    throw new Error(`${dir} holds no production build (no BUILD_ID); run pnpm run build first`);
  }
  const buildManifest = JSON.parse(readFileSync(join(dir, 'build-manifest.json'), 'utf8'));
  const rootMainFiles = buildManifest.rootMainFiles;
  if (!Array.isArray(rootMainFiles) || rootMainFiles.length === 0) {
    throw new Error('build-manifest.json lists no rootMainFiles');
  }
  const routeManifest = JSON.parse(readFileSync(join(dir, 'app-path-routes-manifest.json'), 'utf8'));
  const expectedRoutes = Object.keys(routeManifest)
    .filter((key) => key.endsWith('/page'))
    .map((key) => key.slice(0, -'/page'.length) || '/');
  const routes = new Map();
  for (const path of manifestFiles(join(dir, 'server', 'app'))) {
    const { route, files } = parseClientManifest(readFileSync(path, 'utf8'));
    routes.set(route, [...new Set([...rootMainFiles, ...files])]);
  }
  const chunks = new Map();
  const chunkDir = join(dir, 'static', 'chunks');
  for (const name of readdirSync(chunkDir, { recursive: true })) {
    if (name.endsWith('.js')) {
      chunks.set(`static/chunks/${name.split(sep).join('/')}`, readFileSync(join(chunkDir, name), 'utf8'));
    }
  }
  return { dir, expectedRoutes, routes, chunks, workers: collectWorkers(chunks) };
}

const gzipBytes = (text) => gzipSync(text, { level: 6 }).length;

/** Problems, empty when the build is clean, plus each route's first-load JS size for the report. */
export function audit({ expectedRoutes, routes, chunks, workers }) {
  const problems = [];
  // A sweep of nothing would pass, so every page the build's own route manifest names must be read.
  if (expectedRoutes.length === 0) problems.push('the route manifest lists no pages');
  for (const route of expectedRoutes) {
    if (!routes.has(route))
      problems.push(`${route} is a page in the route manifest whose chunks were not read`);
  }
  for (const route of routes.keys()) {
    if (!expectedRoutes.includes(route)) problems.push(`${route} was read but is not in the route manifest`);
  }
  if (chunks.size === 0) problems.push('read no JS chunks out of the build');
  for (const name of chunks.keys()) {
    if (name.startsWith('static/chunks/turbopack-worker-') && !workers.some((w) => w.worker === name)) {
      problems.push(`${name} is a worker whose chunk list this gate could not find, so it is unchecked`);
    }
  }
  const lists = [
    ...[...routes].map(([route, files]) => ({ who: route, files })),
    ...workers.map(({ worker, spawnedBy, files }) => ({ who: `worker ${worker} from ${spawnedBy}`, files })),
  ];
  for (const { who, files } of lists) {
    for (const file of files) {
      if (!chunks.has(file)) problems.push(`${who} lists ${file}, which was never read, so it is unchecked`);
    }
  }

  const marked = new Set();
  for (const [name, text] of chunks) {
    if (CRYPTO_POLYFILL_MARKERS.some((marker) => text.includes(marker))) marked.add(name);
  }
  const carries = (files) => files.filter((file) => marked.has(file));

  const allowedFiles = new Set();
  for (const [route, why] of ALLOWED_ROUTES) {
    const files = routes.get(route);
    if (files === undefined) {
      problems.push(`${route} is allowed the polyfill (${why}) but the build has no such route`);
      continue;
    }
    for (const file of files) allowedFiles.add(file);
    const text = files.map((file) => chunks.get(file) ?? '').join('\n');
    const missing = CRYPTO_POLYFILL_MARKERS.filter((marker) => !text.includes(marker));
    if (missing.length > 0) {
      problems.push(
        `${route} should carry the polyfill (${why}) and lacks ${missing.map((m) => JSON.stringify(m)).join(', ')}: ` +
          'the markers are stale or the route stopped needing it. Update this gate; do not delete it.',
      );
    }
  }

  for (const [route, files] of routes) {
    if (ALLOWED_ROUTES.has(route)) continue;
    const found = carries(files);
    if (found.length > 0) problems.push(`${route} ships the crypto polyfill in ${found.join(', ')}`);
  }
  for (const { worker, spawnedBy, files } of workers) {
    const found = carries(files);
    if (found.length > 0) {
      problems.push(`worker ${worker} from ${spawnedBy} ships the crypto polyfill in ${found.join(', ')}`);
    }
  }
  for (const file of marked) {
    if (!allowedFiles.has(file)) {
      problems.push(`${file} carries the crypto polyfill and is not first-load JS of an allowed route`);
    }
  }

  const sizes = [...routes]
    .map(([route, files]) => {
      const texts = files.map((file) => chunks.get(file) ?? '');
      return {
        route,
        files: files.length,
        raw: texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
        gzip: texts.reduce((sum, text) => sum + gzipBytes(text), 0),
        polyfill: carries(files).length > 0,
      };
    })
    .sort((a, b) => a.route.localeCompare(b.route));
  return { problems, sizes, marked: [...marked] };
}

function main(argv) {
  const at = argv.indexOf('--dir');
  const dir = at === -1 ? DEFAULT_BUILD_DIR : resolve(argv[at + 1] ?? '');
  const result = audit(readBuild(dir));
  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const kb = (bytes) => `${(bytes / 1024).toFixed(1)}K`;
    console.log(`First-load JS per route, ${dir.startsWith(REPO_ROOT) ? relative(REPO_ROOT, dir) : dir}:`);
    for (const row of result.sizes) {
      const flag = row.polyfill ? '  crypto polyfill' : '';
      console.log(
        `  ${row.route.padEnd(36)} ${kb(row.raw).padStart(8)} raw ${kb(row.gzip).padStart(7)} gzip${flag}`,
      );
    }
  }
  if (result.problems.length > 0) {
    console.error(`\nclient-bundle-audit FAILED:\n${result.problems.map((p) => `  - ${p}`).join('\n')}`);
    return 1;
  }
  // stderr, so `--json` output stays one parseable document.
  console.error(
    `\nclient-bundle-audit: the crypto polyfill reaches only ${[...ALLOWED_ROUTES.keys()].join(', ')}`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
