/**
 * Which boxes the contrast gate's painted pass may skip as hiding their text. Each false positive here
 * was confirmed in Chrome: the text painted, and the gate would not have measured it.
 * Run with: node --test scripts/contrast-hidden-text.test.mjs
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hidesItsText } from './contrast-hidden-text.mjs';

const style = (overrides) => ({
  position: 'static',
  clip: 'auto',
  clipPath: 'none',
  display: 'block',
  overflow: 'visible',
  ...overrides,
});
const LINE = { width: 240, height: 20 };
const DOT = { width: 1, height: 1 };

describe('the visually hidden idiom', () => {
  it('hides, as base.css writes it', () => {
    const hidden = style({ position: 'absolute', overflow: 'hidden', clipPath: 'inset(50%)' });
    assert.equal(hidesItsText(hidden, DOT), true);
  });

  it('hides under the older spellings', () => {
    assert.equal(hidesItsText(style({ position: 'absolute', clip: 'rect(0px, 0px, 0px, 0px)' }), LINE), true);
    assert.equal(hidesItsText(style({ clipPath: 'inset(0px 0px 20px)' }), LINE), true);
    assert.equal(hidesItsText(style({ clipPath: 'inset(0% 60% 0% 40%)' }), LINE), true);
    assert.equal(hidesItsText(style({ overflow: 'hidden' }), DOT), true);
  });
});

describe('text that still paints', () => {
  it('is measured under clip on a box that is not absolutely positioned, where clip does nothing', () => {
    assert.equal(hidesItsText(style({ clip: 'rect(0px, 0px, 0px, 0px)' }), LINE), false);
    assert.equal(
      hidesItsText(style({ position: 'relative', clip: 'rect(0px, 0px, 0px, 0px)' }), LINE),
      false,
    );
  });

  it('is measured under an inset that leaves half the box showing', () => {
    assert.equal(hidesItsText(style({ clipPath: 'inset(50% 0px 0px)' }), LINE), false);
    assert.equal(hidesItsText(style({ clipPath: 'inset(0px 0px 0px 60%)' }), LINE), false);
    assert.equal(hidesItsText(style({ clipPath: 'inset(10% round 4px)' }), LINE), false);
  });

  it('is measured inside display: contents or an inline box, which overflow does not clip', () => {
    assert.equal(
      hidesItsText(style({ display: 'contents', overflow: 'hidden' }), { width: 0, height: 0 }),
      false,
    );
    assert.equal(hidesItsText(style({ display: 'inline', overflow: 'hidden' }), DOT), false);
    const boxless = { width: 0, height: 0 };
    assert.equal(hidesItsText(style({ display: 'contents', clipPath: 'inset(0px)' }), boxless), false);
  });

  it('carries no reference to anything outside itself, as it runs stringified in the page', () => {
    const injected = new Function(`return (${String(hidesItsText)})(arguments[0], arguments[1]);`);
    assert.equal(
      injected(style({ position: 'absolute', overflow: 'hidden', clipPath: 'inset(50%)' }), DOT),
      true,
    );
    assert.equal(injected(style({ clip: 'rect(0px, 0px, 0px, 0px)' }), LINE), false);
  });
});
