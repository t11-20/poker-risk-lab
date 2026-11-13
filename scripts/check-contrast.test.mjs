#!/usr/bin/env node
/**
 * Negative control for pass 3 of `scripts/check-contrast.mjs`. `#55606f` on `#f5f7f9` is 5.95:1, but
 * the card sits on `#e8edf1` under `opacity: 0.8`, which paints 3.86:1. Only compositing sees it.
 * These are the poker table's own tokens. At opacity 1 the gate must pass, at 0.8 it must fail.
 * Without a browser the file skips by name.
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

const INK = '#55606f'; // --prl-text-muted, light theme
const CARD = '#f5f7f9'; // --prl-surface-page, light theme
const GROUND = '#e8edf1'; // --prl-surface-table, light theme — the felt the seat plate lies on
const FADE = 0.8;

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
 * Over twenty text lines, because pass 3 refuses a barely swept page, and padded so the probe finds a
 * glyph-free point. The two themes differ, as the gate checks the theme it measured.
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
  // Otherwise this is an ordinary contrast failure that passes 1 and 2 already catch.
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
  // Composited in gamma-encoded sRGB, as a browser does: #727c89 on #f2f5f7. Interpolating
  // luminances instead gives 3.10:1.
  assert.match(output, /3\.86:1 needs 4\.5:1/, output.slice(-3000));
  assert.match(output, /label/, output.slice(-3000));
});
