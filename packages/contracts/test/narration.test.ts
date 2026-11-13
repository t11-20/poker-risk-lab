/**
 * `inSecondPerson`: the reader's own hand, narrated to them as "you".
 *
 * Audit at 308fadf: under the table, "How the hand ended" read "Guest 12D91B wins 1529 from the
 * pot." to the reader who was Guest 12D91B. The sentences here are the shapes
 * `apps/api/src/rooms/narration.ts` writes; `apps/api/test/table-narration.test.ts` runs the same
 * function over sentences a real table produced.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALL_THEY_HAD, inSecondPerson, NARRATED_VERBS } from '../src/index.ts';

const ME = 'Guest 12D91B';

describe('the reader’s own sentences are put in the second person', () => {
  it('every narrated verb, at the start of a sentence (REGRESSION)', () => {
    const verbs = Object.values(NARRATED_VERBS);
    assert.ok(verbs.length >= 9, 'a sweep of nothing is not a pass');
    for (const { third, second } of verbs) {
      assert.equal(inSecondPerson(`${ME} ${third} 1,529`, ME), `You ${second} 1,529`, third);
    }
  });

  it('the result line, the showdown and the blinds, as the server writes them', () => {
    assert.equal(inSecondPerson(`${ME} wins 1,529 from the pot.`, ME), 'You win 1,529 from the pot.');
    assert.equal(inSecondPerson(`${ME} shows a flush, ace high.`, ME), 'You show a flush, ace high.');
    assert.equal(
      inSecondPerson(
        `Nit posts the small blind, 5. ${ME} posts the big blind, 8, ${ALL_THEY_HAD.third}.`,
        ME,
      ),
      'Nit posts the small blind, 5. You post the big blind, 8, which is all you had.',
    );
  });

  it('touches nobody else’s sentence, even one that follows the reader’s', () => {
    const blinds = `${ME} posts the small blind, 5. Nit posts the big blind, 8, ${ALL_THEY_HAD.third}.`;
    assert.equal(
      inSecondPerson(blinds, ME),
      'You post the small blind, 5. Nit posts the big blind, 8, which is all they had.',
    );
    assert.equal(inSecondPerson('Nit wins 35 from the pot.', ME), 'Nit wins 35 from the pot.');
  });

  it('does not match a name inside a longer one', () => {
    assert.equal(
      inSecondPerson('Patient Technician 12 folds', 'Patient Technician 1'),
      'Patient Technician 12 folds',
    );
    assert.equal(inSecondPerson('Patient Technician 1 folds', 'Patient Technician 1'), 'You fold');
  });

  it('fails towards the server’s own sentence: an unknown verb, a mid-sentence name, no name', () => {
    assert.equal(inSecondPerson(`${ME} juggles`, ME), `${ME} juggles`);
    assert.equal(inSecondPerson(`Nit raises over ${ME} folds`, ME), `Nit raises over ${ME} folds`);
    assert.equal(inSecondPerson(`${ME} folds`, ''), `${ME} folds`);
    // A name with regex metacharacters is a name, not a pattern.
    assert.equal(inSecondPerson('A.B (x) folds', 'A.B (x)'), 'You fold');
    assert.equal(inSecondPerson('AxB (x) folds', 'A.B (x)'), 'AxB (x) folds');
  });
});
