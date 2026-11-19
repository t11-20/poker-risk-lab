/**
 * The difficulty radios are uncontrolled, so the option the URL applied keeps whatever extra words its
 * name was rendered with after the reader ticks another. ", selected" then named an unticked radio.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const PICKER = readFileSync(join(SRC, 'components', 'DifficultyPicker.tsx'), 'utf8');

describe('the applied difficulty is named for what it is (REGRESSION)', () => {
  it('says it is the applied setting, which stays true whatever is ticked', () => {
    assert.match(PICKER, /defaultChecked=\{isSelected\}/u, 'the radios are no longer uncontrolled');
    assert.match(PICKER, /<span className="prl-visually-hidden">, the applied setting<\/span>/u);
    assert.doesNotMatch(PICKER, />, selected</u);
  });
});
