/**
 * A wrapped formula line hangs its continuation, so it does not read as the next line. Indent rules
 * reach only a block's first line, so each written line is its own block.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadComponent } from './support/render-component.ts';

interface FormulaProps {
  readonly expression: string;
  readonly explanation: string;
}

async function lines(expression: string): Promise<readonly string[]> {
  const Formula = await loadComponent<FormulaProps>('components/Formula', 'Formula');
  const markup = renderToStaticMarkup(createElement(Formula, { expression, explanation: 'Why.' }));
  return [...markup.matchAll(/<span class="prl-formula__line">([\s\S]*?)<\/span>/gu)].map((m) => m[1] ?? '');
}

test('each written line of an expression is its own block, newline kept', async () => {
  const expression = 'break-even equity = call / (pot + call)\nprice = pot / call';
  const found = await lines(expression);
  assert.deepEqual(found, ['break-even equity = call / (pot + call)\n', 'price = pot / call']);
  assert.equal(found.join(''), expression, 'the copied text is the expression unchanged');
});

test('a one-line expression is one block', async () => {
  assert.deepEqual(await lines('price = pot / call'), ['price = pot / call']);
});

test('the line block hangs its wrapped continuation', () => {
  const css = readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8');
  const rule = /\n\.prl-formula__line \{([^}]*)\}/u.exec(css)?.[1];
  assert.ok(rule !== undefined, 'no .prl-formula__line rule in components.css');
  assert.match(rule, /display: block;/u);
  const pad = /padding-inline-start: (\S+);/u.exec(rule)?.[1];
  const indent = /text-indent: -(\S+);/u.exec(rule)?.[1];
  assert.ok(pad !== undefined && indent !== undefined, 'a hanging indent is a padding and a negative indent');
  assert.equal(pad, indent, 'the first line starts on the block edge');
});
