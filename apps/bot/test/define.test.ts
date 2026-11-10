import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { glossary } from '@prl/content';
import { lookup } from '../src/define.ts';
import { GONE } from '../src/quiz.ts';
import { NEW_SESSION, type StepResult, step } from '../src/step.ts';
import { CALLBACK_DATA_MAX_BYTES, decodePress } from '../src/view.ts';
import { buttonsOf, find, message, press, testDeps } from './helpers.ts';

const deps = testDeps(1);

function define(term: string): StepResult {
  return step(NEW_SESSION, { kind: 'command', name: 'define', args: term }, deps);
}

function entries() {
  const all = glossary();
  assert.ok(all.length > 0, 'a sweep of nothing is not a pass');
  return all;
}

describe('/define', () => {
  test('an exact term answers with its definition, its formula and its see-also terms as buttons', () => {
    const shown = message(define('Pot odds'));
    const entry = entries().find((candidate) => candidate.id === 'pot-odds');
    assert.ok(entry?.formula !== undefined, 'pot-odds ships with a formula');
    assert.ok(shown.text.startsWith('Pot odds\n'));
    assert.ok(shown.text.includes(entry.definition));
    assert.ok(shown.text.includes(`Formula: ${entry.formula}`));
    assert.deepEqual(
      buttonsOf(define('Pot odds')).map((button) => decodePress(button.data)),
      (entry.seeAlso ?? []).map((id) => ({ kind: 'term', id })),
    );
  });

  test('case, punctuation, a leading "the" and the bracketed short name do not matter', () => {
    for (const [typed, id] of [
      ['POT ODDS', 'pot-odds'],
      ['  pot   odds ', 'pot-odds'],
      ['ev', 'expected-value'],
      ['Expected value', 'expected-value'],
      ['the nuts', 'nuts'],
      ['push fold', 'push-fold'],
      ['3-bet', 'three-bet'],
      ['spr', 'spr'],
    ] as const) {
      const found = lookup(typed);
      assert.equal(found.kind, 'found', `"${typed}" is found`);
      if (found.kind === 'found') assert.equal(found.entry.id, id, typed);
    }
    const dirty = lookup('dirty out');
    const dirtier = lookup('dirty outs');
    assert.ok(dirty.kind === 'found' && dirtier.kind === 'found');
    assert.notEqual(
      dirty.entry.id,
      dirtier.entry.id,
      'two entries whose names differ by an s each answer to their own',
    );
  });

  test('every one of the 90 terms is reachable by its own name, and by a button', () => {
    const all = entries();
    assert.equal(all.length, 90, 'the shipped glossary has 90 entries');
    for (const entry of all) {
      const found = lookup(entry.term);
      assert.ok(found.kind === 'found' && found.entry.id === entry.id, `"${entry.term}" finds ${entry.id}`);
      const pressed = step(NEW_SESSION, { kind: 'button', data: `g:${entry.id}` }, deps);
      assert.ok(message(pressed).text.includes(entry.definition), `the ${entry.id} button shows it`);
    }
  });

  test('every term and see-also button fits in 64 bytes and opens an entry', () => {
    let measured = 0;
    for (const entry of entries()) {
      const shown = step(NEW_SESSION, { kind: 'button', data: `g:${entry.id}` }, deps);
      for (const button of buttonsOf(shown)) {
        measured += 1;
        assert.ok(Buffer.byteLength(button.data, 'utf8') <= CALLBACK_DATA_MAX_BYTES, button.data);
        const linked = press(shown.session, button, deps);
        assert.equal(message(linked).kind, 'send', `${entry.id} → ${button.label} opens an entry`);
      }
    }
    assert.ok(measured > 90, `${measured} see-also buttons measured`);
  });

  test('an unknown term is answered with the closest names, never a definition', () => {
    const near = define('blind');
    assert.match(
      message(near).text,
      /^There is no glossary entry called "blind"\. The closest names are below\.$/,
    );
    const labels = buttonsOf(near).map((button) => button.label);
    assert.ok(labels.includes('Blinds') && labels.includes('Big blind'), labels.join(', '));
    assert.equal(find(buttonsOf(define('pot ods')), /^Pot odds$/).label, 'Pot odds', 'a typo finds its term');

    const nothing = define('xyzzy');
    assert.match(
      message(nothing).text,
      /^There is no glossary entry called "xyzzy", and none with a name close to it\./,
    );
    assert.equal(buttonsOf(nothing).length, 0);
    for (const entry of entries()) {
      for (const shown of [message(near).text, message(nothing).text]) {
        assert.ok(
          !shown.includes(entry.definition),
          `no definition of ${entry.id} is offered for an unknown term`,
        );
      }
    }
  });

  test('a reader’s text is quoted back without anything a glossary name could not contain', () => {
    const shown = message(define(`<b>zzqq</b>${String.fromCodePoint(0x202e)}zz`));
    assert.match(shown.text, /^There is no glossary entry called "b zzqq b zz"/);
  });

  test('/define on its own, and the Glossary button, explain how, with starting terms to press', () => {
    const alone = message(define(''));
    assert.match(alone.text, /^Send \/define and a term/);
    const menu = step(NEW_SESSION, { kind: 'command', name: 'start', args: '' }, deps);
    const viaMenu = press(menu.session, find(buttonsOf(menu), /^Glossary$/), deps);
    assert.equal(message(viaMenu).text, alone.text);
    assert.equal(buttonsOf(viaMenu).length, 5, 'every starting term exists');
  });

  test('a term button for an entry that no longer exists is a toast', () => {
    const refused = step(NEW_SESSION, { kind: 'button', data: 'g:no-such-entry' }, deps);
    assert.deepEqual(refused.out, [{ kind: 'toast', text: GONE }]);
  });

  test('a lookup changes nothing about a hand in progress', () => {
    const menu = step(NEW_SESSION, { kind: 'command', name: 'start', args: '' }, deps);
    const hand = press(menu.session, find(buttonsOf(menu), /^Play a hand$/), deps);
    const looked = step(hand.session, { kind: 'command', name: 'define', args: 'outs' }, deps);
    assert.equal(looked.session, hand.session);
  });
});
