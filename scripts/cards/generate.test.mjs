/**
 * The committed deck is exactly what the generator makes from tokens.css today, and no face can show a
 * letter. Run with: node --test scripts/cards/generate.test.mjs
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BACK, BACK_TITLE, DECK_DIR, faceTitle, readPalette, renderDeck, TOKENS } from './generate.mjs';

const tokens = readFileSync(TOKENS, 'utf8');
const palette = readPalette(tokens);
const deck = renderDeck(palette);
const onDisk = readdirSync(DECK_DIR).filter((name) => name.endsWith('.svg'));

/** What a reader would see as characters: everything outside the tags, the title aside. */
const characterData = (svg) =>
  svg
    .replace(/<title>[^<]*<\/title>/u, '')
    .replace(/<[^>]*>/gu, '')
    .trim();
const titles = (svg) => [...svg.matchAll(/<title>([^<]*)<\/title>/gu)].map((m) => m[1]);

describe('the committed deck', () => {
  it('is 52 faces and the back, each committed', () => {
    assert.equal(deck.size, 52 + 2);
    for (const name of ['2C.svg', 'TD.svg', 'KH.svg', 'AS.svg', 'back.svg', 'back-charcoal.svg']) {
      assert.ok(deck.has(name), `the generator makes no ${name}`);
    }
    assert.deepEqual([...onDisk].sort(), [...deck.keys()].sort(), 'files on disk and generated files differ');
  });

  it('is byte-identical to a fresh generation. Run `node scripts/cards/generate.mjs` if not', () => {
    for (const [name, content] of deck) {
      assert.equal(readFileSync(join(DECK_DIR, name), 'utf8'), content, `${name} is stale`);
    }
  });

  it('draws every rank and suit as a path: no text, font or description to carry a letter', () => {
    assert.ok(onDisk.length >= 54, 'read no card files');
    for (const name of onDisk) {
      const svg = readFileSync(join(DECK_DIR, name), 'utf8');
      assert.doesNotMatch(svg, /<(text|tspan|desc|foreignObject|style)\b|font|@import/iu, name);
      assert.equal(characterData(svg), '', `${name} has character data outside its tags`);
      assert.doesNotMatch(svg, /[♠♣♥♦]/u, `${name} carries a suit glyph as text`);
    }
  });

  it('names each file in words in one non-empty title, which is metadata and never drawn', () => {
    assert.equal(faceTitle('K', 'H'), 'King of hearts');
    assert.equal(faceTitle('T', 'C'), 'Ten of clubs');
    for (const name of onDisk) {
      const svg = readFileSync(join(DECK_DIR, name), 'utf8');
      const expected = name.startsWith('back') ? BACK_TITLE : faceTitle(name[0], name[1]);
      assert.deepEqual(titles(svg), [expected], `${name} should carry one title, "${expected}"`);
      assert.match(svg, /^<svg [^>]*><title>/u, `${name}: the title is the first child of the root`);
    }
  });

  it('paints only colours declared in tokens.css', () => {
    const allowed = new Set(Object.values(palette));
    for (const [name, content] of deck) {
      for (const [colour] of content.matchAll(/#[\da-f]{3,8}\b/giu)) {
        assert.ok(allowed.has(colour.toLowerCase()), `${name} paints ${colour}, which no --prl-deck-* names`);
      }
    }
  });

  it('has one back, charcoal: green sinks into the felt and wine sits close to the red ink', () => {
    assert.equal(BACK, 'charcoal');
    assert.equal(deck.get('back.svg'), deck.get('back-charcoal.svg'));
    const backs = [...deck.keys()].filter((name) => name.startsWith('back'));
    assert.deepEqual(backs.sort(), ['back-charcoal.svg', 'back.svg']);
  });
});

describe('the palette read from tokens.css', () => {
  it('NEGATIVE CONTROL: a changed token changes the files, so the colours are read and not baked in', () => {
    const redder = renderDeck({ ...palette, red: '#ff0000' });
    assert.notEqual(redder.get('KH.svg'), deck.get('KH.svg'));
    assert.equal(redder.get('KS.svg'), deck.get('KS.svg'), 'a black suit does not use the red ink');
  });

  it('refuses a token declared twice, which could make a theme disagree with the files', () => {
    assert.throws(() => readPalette(`${tokens}\n:root { --prl-deck-red: #b3262d; }`), /more than once/u);
  });

  it('refuses a missing token or one that is not a plain hex colour', () => {
    assert.throws(() => readPalette(tokens.replace(/--prl-deck-edge:[^;]+;/u, '')), /--prl-deck-edge/u);
    assert.throws(
      () => readPalette(tokens.replace(/--prl-deck-edge:[^;]+;/u, '--prl-deck-edge: var(--prl-line);')),
      /not a #rrggbb/u,
    );
  });
});
