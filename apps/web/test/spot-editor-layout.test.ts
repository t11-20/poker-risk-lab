/**
 * The spot editor's field grids and its two columns, held as the rules that fixed them. Five fields in
 * `auto-fit` tracks went 2 + 2 + 1 or 3 + 2, and three went 2 + 1, leaving a hole beside the last field.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readFileSync(join(SRC, 'styles', 'spot-editor.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
const editor = readFileSync(join(SRC, 'components', 'SpotEditor.tsx'), 'utf8');

/** The `<TextField ... />` elements inside one function component, by its declaration. */
function fieldsIn(component: string): readonly string[] {
  const start = editor.indexOf(`function ${component}(`);
  assert.ok(start >= 0, `no ${component} in SpotEditor.tsx`);
  const end = editor.indexOf('\nfunction ', start + 1);
  const body = editor.slice(start, end < 0 ? undefined : end);
  return [...body.matchAll(/<TextField\b[\s\S]*?\/>/gu)].map((match) => match[0]);
}

describe('spot editor field grids', () => {
  for (const component of ['PotPanel', 'OpponentFields']) {
    it(`${component}: Name takes a row, and the fields left over pair up`, () => {
      const fields = fieldsIn(component);
      assert.ok(fields.length > 0, `no fields read in ${component}`);
      const wide = fields.filter((field) => /\bwide\b/u.test(field));
      assert.equal(wide.length, 1, 'exactly one wide field');
      assert.match(wide[0] ?? '', /label="Name"/u);
      assert.equal((fields.length - wide.length) % 2, 0, `${fields.length - 1} fields leave one alone`);
    });
  }

  it('has two explicit columns from the inputs column’s own width, never auto-fit', () => {
    assert.doesNotMatch(css, /auto-fit/u);
    assert.match(css, /\.prl-spot-editor__inputs \{\s*container: prl-spot-inputs \/ inline-size;/u);
    assert.match(
      css,
      /@container prl-spot-inputs \(min-width: 30rem\) \{\s*\.prl-spot-editor__fields \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);\s*\}\s*\.prl-spot-field--wide \{\s*grid-column: 1 \/ -1;/u,
    );
  });

});
