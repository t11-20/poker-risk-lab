#!/usr/bin/env node
/**
 * Tests for the client bundle audit, on builds made in memory in the shapes Next 16's Turbopack writes.
 * Each control puts one leak back and asserts the audit names it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  ALLOWED_ROUTES,
  audit,
  CRYPTO_POLYFILL_MARKERS,
  parseClientManifest,
  REPO_ROOT,
  workerChunkLists,
} from './client-bundle-audit.mjs';

const POLYFILL = `!function(){${CRYPTO_POLYFILL_MARKERS.map((m) => JSON.stringify(m)).join(';')}}();`;
const ROOT = ['static/chunks/runtime.js'];
const ROUTES = [
  '/',
  '/privacy',
  '/terms',
  '/lab',
  '/lab/spots/edit',
  '/learn',
  '/learn/[lessonId]',
  '/play',
  '/review',
  '/record',
  '/review/[handId]',
];

/** A clean build: the polyfill sits in a chunk only /review/[handId] loads, and one worker exists. */
function cleanBuild() {
  const chunks = new Map([
    [
      'static/chunks/runtime.js',
      'e.v(e.r(1).f("static/chunks/turbopack-worker-a.js",["static/chunks/w.js"]))',
    ],
    ['static/chunks/layout.js', 'layout'],
    ['static/chunks/w.js', 'worker code'],
    ['static/chunks/turbopack-worker-a.js', 'worker entry'],
    ['static/chunks/proof.js', POLYFILL],
  ]);
  const routes = new Map(ROUTES.map((route) => [route, [...ROOT, 'static/chunks/layout.js']]));
  routes.get('/review/[handId]').push('static/chunks/proof.js');
  return {
    routes,
    chunks,
    workers: new Map([['static/chunks/turbopack-worker-a.js', ['static/chunks/w.js']]]),
  };
}

describe('client bundle audit', () => {
  it('passes a build whose polyfill reaches only the allowed route', () => {
    const { problems, sizes } = audit(cleanBuild());
    assert.deepEqual(problems, []);
    assert.deepEqual(
      sizes.filter((row) => row.polyfill).map((row) => row.route),
      [...ALLOWED_ROUTES.keys()],
    );
  });

  it('NEGATIVE CONTROL — names every route that ships the polyfill through a shared chunk', () => {
    const build = cleanBuild();
    build.chunks.set('static/chunks/layout.js', POLYFILL);
    const { problems } = audit(build);
    for (const route of ROUTES.filter((r) => !ALLOWED_ROUTES.has(r))) {
      assert.ok(
        problems.some((p) => p.startsWith(`${route} ships the crypto polyfill`)),
        `${route} not named in:\n${problems.join('\n')}`,
      );
    }
  });

  it('NEGATIVE CONTROL — catches one marker on its own, not only the full set', () => {
    for (const marker of CRYPTO_POLYFILL_MARKERS) {
      const build = cleanBuild();
      build.chunks.set('static/chunks/layout.js', `x(${JSON.stringify(marker)})`);
      assert.ok(
        audit(build).problems.some((p) => p.startsWith('/privacy ships')),
        marker,
      );
    }
  });

  it('NEGATIVE CONTROL — catches a worker that loads the polyfill', () => {
    const build = cleanBuild();
    build.chunks.set('static/chunks/w.js', POLYFILL);
    const { problems } = audit(build);
    assert.ok(
      problems.some((p) => p.startsWith('worker static/chunks/turbopack-worker-a.js ships')),
      problems,
    );
  });

  it('NEGATIVE CONTROL — catches a lazily loaded chunk that no route lists', () => {
    const build = cleanBuild();
    build.chunks.set('static/chunks/lazy.js', POLYFILL);
    const { problems } = audit(build);
    assert.ok(
      problems.some((p) => p.startsWith('static/chunks/lazy.js carries the crypto polyfill')),
      problems,
    );
  });

  it('refuses a worker whose chunk list it could not read', () => {
    const build = cleanBuild();
    build.workers.clear();
    assert.ok(
      audit(build).problems.some((p) => p.includes('is a worker whose chunk list this gate could not')),
    );
  });

  it('refuses when the allowed route stops matching the markers, rather than passing over nothing', () => {
    const build = cleanBuild();
    build.chunks.set('static/chunks/proof.js', JSON.stringify(CRYPTO_POLYFILL_MARKERS[0]));
    assert.ok(audit(build).problems.some((p) => p.includes('the markers are stale')));
  });

  it('refuses a sweep of nothing', () => {
    const { problems } = audit({ routes: new Map(), chunks: new Map(), workers: new Map() });
    assert.ok(problems.some((p) => p.startsWith('read only 0 routes')));
    assert.ok(problems.some((p) => p.startsWith('read no JS chunks')));
    assert.ok(problems.some((p) => p.includes('but the build has no such route')));
  });
});

describe('the build readers', () => {
  const manifest = (key, entries) =>
    'globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\n' +
    `globalThis.__RSC_MANIFEST[${JSON.stringify(key)}] = ${JSON.stringify({ clientModules: {}, entryJSFiles: entries })};\n`;

  it('reads a page manifest: layouts and the page load first, the error boundary does not', () => {
    const parsed = parseClientManifest(
      manifest('/lab/page', {
        '[project]/apps/web/src/app/layout': ['static/chunks/a.js'],
        '[project]/apps/web/src/app/error': ['static/chunks/err.js'],
        '[project]/apps/web/src/app/lab/page': ['static/chunks/a.js', 'static/chunks/b.js'],
      }),
    );
    assert.equal(parsed.route, '/lab');
    assert.deepEqual([...parsed.files], ['static/chunks/a.js', 'static/chunks/b.js']);
    assert.equal(
      parseClientManifest(manifest('/page', { '[project]/apps/web/src/app/page': ['x.js'] })).route,
      '/',
    );
  });

  it('reads /_global-error, whose only entry is global-error', () => {
    const parsed = parseClientManifest(
      manifest('/_global-error/page', { '[project]/apps/web/src/app/global-error': ['static/chunks/g.js'] }),
    );
    assert.deepEqual([...parsed.files], ['static/chunks/g.js']);
  });

  it('refuses a manifest it cannot read', () => {
    assert.throws(() => parseClientManifest('export default {}'), /not a client reference manifest/u);
    assert.throws(() => parseClientManifest(manifest('/lab/page', {})), /lists no entry files/u);
  });

  it('finds the chunk list of each worker a chunk spawns', () => {
    const text =
      'a,64511,e=>{e.v(e.r(10914).f("static/chunks/turbopack-worker-1hrsqshz0gfey.js",' +
      '["static/chunks/09vmpeb_9su_7.js","static/chunks/2860klx3xvlg-.js"]))},b';
    assert.deepEqual(workerChunkLists(text), [
      {
        worker: 'static/chunks/turbopack-worker-1hrsqshz0gfey.js',
        files: ['static/chunks/09vmpeb_9su_7.js', 'static/chunks/2860klx3xvlg-.js'],
      },
    ]);
    assert.deepEqual(workerChunkLists('no workers here'), []);
  });
});

describe('the audit runs without anybody remembering it', () => {
  it('`pnpm run build` ends by running it, so the verify build gate and every CI build fail on a leak', () => {
    const scripts = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts;
    assert.ok(scripts.build.endsWith('&& pnpm run test:bundle'), scripts.build);
    assert.equal(scripts['test:bundle'], 'node scripts/client-bundle-audit.mjs');
  });
});
