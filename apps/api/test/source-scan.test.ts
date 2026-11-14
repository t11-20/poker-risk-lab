/**
 * Pins `stripComments` exactly, warts included, because four source scanners share it and a change
 * that "fixes" it silently changes what each of them can see.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stripComments } from './helpers/source-scan.ts';

describe('stripComments', () => {
  it('leaves code without comments untouched', () => {
    const code = 'const x = banned(1);\nconst y = 2;';
    assert.equal(stripComments(code), code);
  });

  it('drops a line comment to the end of its line and keeps the newline', () => {
    assert.equal(stripComments('a(); // banned(\nb();'), 'a(); \nb();');
    assert.equal(stripComments('// banned(\nb();'), '\nb();');
  });

  it('replaces a block comment, across lines, with one space', () => {
    assert.equal(stripComments('a();/* banned(\n still */b();'), 'a(); b();');
    assert.equal(stripComments('/** doc */\nb();'), ' \nb();');
  });

  it('ends a block comment at its first closer', () => {
    assert.equal(stripComments('/* one */ keep(); /* two */'), '  keep();  ');
  });

  it('keeps a URL, because a `//` after a colon is not a comment', () => {
    const code = "const u = 'https://x.test/path'; banned();";
    assert.equal(stripComments(code), code);
    assert.equal(stripComments('fetch(`http://127.0.0.1:3001/a`);'), 'fetch(`http://127.0.0.1:3001/a`);');
  });

  it('is not a parser: comment markers inside string and template literals are stripped too', () => {
    assert.equal(stripComments("const s = 'a // b'; banned();"), "const s = 'a ");
    assert.equal(stripComments('const s = "/* x */"; banned();'), 'const s = " "; banned();');
    assert.equal(stripComments('const s = `a // b`;\nbanned();'), 'const s = `a \nbanned();');
    assert.equal(stripComments('const s = `a /* x */ b`;'), 'const s = `a   b`;');
  });

  it('strips a line comment inside a block comment along with the block', () => {
    assert.equal(stripComments('a(); /* // banned( */ b();'), 'a();   b();');
  });
});
