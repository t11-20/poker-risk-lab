#!/usr/bin/env node
/**
 * The negative control for PASS 3 of `scripts/check-contrast.mjs`, kept as a test rather than as a
 * story about one afternoon.
 *
 * Passes 1 and 2 of that gate read token PAIRS, and no test can shake that: a pair is two colours
 * and either the arithmetic is right or it is not. PASS 3 measures the COMPOSITED background of
 * real text in real Chrome, and that is a claim about a browser, so the only honest way to hold it
 * is to hand it a page whose contrast fails ONLY when the layers are composited and watch it
 * refuse.
 *
 * That is what the fixture below is. Its text is `#55606f` and the card under the text is
 * `#f5f7f9`: **5.95:1, comfortably AA**, and the first assertion in this file recomputes that from
 * the WCAG definitions so the claim is measured here rather than asserted. Passes 1 and 2 would
 * see that pairing and be right about it. The card then sits on a `#e8edf1` ground under an
 * `opacity` - and at 0.8 the same label paints at 3.86:1, which is a real reader failing to read a
 * real label while every token in the file is innocent.
 *
 * The numbers are not invented for the fixture. They are the poker table's own: `--prl-text-muted`
 * on `--prl-surface-page` over `--prl-surface-table`, which is the exact stack an agent proposed
 * fading with `opacity` and declined by hand because this gate could not see it.
 *
 * Two runs, because a checker that only ever refuses is as useless as one that only ever accepts:
 * the same fixture at `opacity: 1` must PASS the painted layer, and at `opacity: 0.8` must FAIL it
 * with the composited ratio printed.
 *
 * The gate needs a browser. Without one this file SKIPS, loudly and by name - `node --test` prints
 * the reason - because the alternative is a green tick over a check that never ran.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = resolve(HERE, 'check-contrast.mjs');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((path) => typeof path === 'string' && path !== '');

const CHROME = CHROME_CANDIDATES.find((path) => existsSync(path));
const chromeSkip =
  CHROME === undefined
    ? 'no Chrome on this machine, so the painted layer cannot be driven — set CHROME_PATH'
    : false;

/* The three colours, and the two ratios they produce. Named here so the fixture and the
   assertions cannot drift apart. */
const INK = '#55606f'; // --prl-text-muted, light theme
const CARD = '#f5f7f9'; // --prl-surface-page, light theme
const GROUND = '#e8edf1'; // --prl-surface-table, light theme — the felt the seat plate lies on
const FADE = 0.8;

/** WCAG 2.x, from the definitions, so the fixture's "the pair is fine" is measured and not said. */
function contrastOf(foreground, background) {
  const channel = (hex, at) => Number.parseInt(hex.slice(at, at + 2), 16);
  const toLinear = (value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex) =>
    0.2126 * toLinear(channel(hex, 1)) +
    0.7152 * toLinear(channel(hex, 3)) +
    0.0722 * toLinear(channel(hex, 5));
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * A page the gate can sweep: one card of labels, on a ground, under an `opacity`.
 *
 * More than twenty lines of text because PASS 3 refuses a page it barely looked at, and generous
 * padding because it probes its own arithmetic against a screenshot and needs somewhere inside the
 * card that no glyph covers. The two themes resolve `--prl-surface-page` differently for the same
 * reason the real app does - the gate checks that the theme it asked for is the theme it measured,
 * and a fixture with one theme painted twice would defeat that check rather than satisfy it.
 */
function fixture(opacity) {
  const rows = Array.from(
    { length: 24 },
    (_, i) => `<p class="label">Seat ${i + 1} &mdash; stack 1,000, in front 35, folded</p>`,
  ).join('\n      ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>composited contrast fixture</title>
    <style>
      :root { --prl-surface-page: ${CARD}; color-scheme: dark; }
      :root[data-theme="light"] { --prl-surface-page: ${GROUND}; color-scheme: light; }
      html, body { margin: 0; padding: 0; background: ${GROUND}; }
      main { padding: 40px; }
      .card {
        max-width: 720px;
        padding: 32px 32px 48px;
        background: ${CARD};
        opacity: ${opacity};
      }
      .label { margin: 0 0 14px; padding: 0; color: ${INK}; font: 500 12px/1.6 system-ui, sans-serif; }
    </style>
  </head>
  <body>
    <main>
      <h1 class="label">Folded seats, faded</h1>
      <div class="card">
      ${rows}
      </div>
    </main>
  </body>
</html>`;
}

/** Serves the fixture at every path, so `--routes` can name anything. */
async function withFixtureServer(opacity, run) {
  const body = fixture(opacity);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((closed) => server.close(closed));
  }
}

/** Runs the real gate, exactly as `pnpm run design:contrast` would, against the fixture. */
function runGate(baseUrl) {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [GATE, '--no-start', '--base-url', baseUrl, '--routes', '/fixture'],
      { env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', fail);
    child.on('exit', (code) => done({ code, output }));
  });
}

test('the pairing this fixture is built from passes on its own — the composite is the only defect', () => {
  // If this ever stops being true the fixture has stopped being a negative control for COMPOSITING
  // and has become an ordinary contrast failure, which passes 1 and 2 already catch.
  assert.ok(contrastOf(INK, CARD) > 4.5, `${INK} on ${CARD} is ${contrastOf(INK, CARD).toFixed(2)}:1`);
  assert.equal(contrastOf(INK, CARD).toFixed(2), '5.95');
});

test('PASS 3 passes the same fixture when nothing is faded', {
  skip: chromeSkip,
  timeout: 240_000,
}, async () => {
  const { output } = await withFixtureServer(1, runGate);
  assert.match(output, /PASS {2}painted layer/, output.slice(-3000));
  assert.doesNotMatch(output, /needs 4\.5:1/, output.slice(-3000));
});

test('PASS 3 refuses an opacity that no token pair can see, and prints the composited ratio', {
  skip: chromeSkip,
  timeout: 240_000,
}, async () => {
  const { code, output } = await withFixtureServer(FADE, runGate);
  assert.equal(code, 1, output.slice(-3000));
  assert.match(output, /FAIL {2}painted layer/, output.slice(-3000));
  // The measured ratio, not a range. #55606f and #f5f7f9 both faded 0.8 towards #e8edf1 paint
  // #727c89 on #f2f5f7, which is 3.86:1 - and a gate that only reported "something is wrong
  // here" would not be worth running. Note the composite is done in gamma-encoded sRGB, which
  // is what a browser does; interpolating the two LUMINANCES instead gives 3.10:1, and that is
  // the arithmetic behind the numbers in `apps/web/src/styles/play.css`.
  assert.match(output, /3\.86:1 needs 4\.5:1/, output.slice(-3000));
  assert.match(output, /label/, output.slice(-3000));
});
