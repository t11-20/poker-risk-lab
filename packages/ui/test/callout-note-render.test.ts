/**
 * A note is a receipt, a status, a measured result or a pointer, so it must not wear the Insight marker.
 * Rendered, because the marker word is what a reader sees and what a screen reader speaks.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findAll, hasClass, type MarkupElement, markupTree } from './support/markup-tree.ts';
import { loadComponent } from './support/render-component.ts';

interface CalloutProps {
  readonly tone: 'insight' | 'warning' | 'misconception' | 'note';
  readonly title?: string;
}

async function render(props: CalloutProps, text: string): Promise<string> {
  const Callout = await loadComponent<CalloutProps>('components/Callout', 'Callout');
  return renderToStaticMarkup(createElement(Callout, props, text));
}

function callout(markup: string): MarkupElement {
  const found = findAll(
    markupTree(markup),
    (element) => element.tag === 'div' && element.attributes.get('role') === 'note',
  );
  assert.equal(found.length, 1, 'a callout is one role="note"');
  const element = found[0];
  assert.ok(element !== undefined);
  return element;
}

test('a note renders the word Note, role="note" and prl-callout--note', async () => {
  const element = callout(await render({ tone: 'note', title: 'A receipt' }, 'Gone for good.'));
  assert.ok(hasClass(element, 'prl-callout'));
  assert.ok(hasClass(element, 'prl-callout--note'));
  const marker = element.children.find((child) => hasClass(child, 'prl-callout__marker'));
  assert.ok(marker !== undefined, 'a note has no marker');
  assert.equal(marker.inner.replace(/\s+/gu, ''), 'Note');
  assert.equal(marker.children.length, 0, 'a note marker carries a glyph');
  const title = element.children.find((child) => hasClass(child, 'prl-callout__title'));
  assert.equal(title?.inner, 'A receipt');
  assert.doesNotMatch(element.inner, /Insight/u);
});

test('an insight still renders the word Insight', async () => {
  const element = callout(await render({ tone: 'insight', title: 'A teaching point' }, 'The takeaway.'));
  assert.ok(hasClass(element, 'prl-callout--insight'));
  const marker = element.children.find((child) => hasClass(child, 'prl-callout__marker'));
  assert.equal(marker?.inner.replace(/\s+/gu, ''), 'Insight');
});

test('the note tone is the decorative line and a muted medium marker', () => {
  const css = readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8');
  const box = /\.prl-callout--note \{([^}]*)\}/u.exec(css);
  assert.ok(box !== null, 'components.css has no .prl-callout--note rule');
  assert.match(box[1] ?? '', /border:\s*1px solid var\(--prl-line\)/u);
  const marker = /\.prl-callout--note \.prl-callout__marker \{([^}]*)\}/u.exec(css);
  assert.ok(marker !== null, 'the note marker has no rule of its own');
  assert.match(marker[1] ?? '', /color:\s*var\(--prl-text-muted\)/u);
  assert.match(marker[1] ?? '', /font-weight:\s*var\(--prl-weight-medium\)/u);
  const written = `${box[1] ?? ''}${marker[1] ?? ''}`;
  assert.doesNotMatch(written, /#[0-9a-fA-F]{3,8}|blue|light-dark\(/iu);
});
