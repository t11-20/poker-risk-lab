/**
 * The web app's tips are held to the owner's rule, one plain sentence each, by the check `@prl/ui`
 * holds its own to. Every tip shown comes from `WEB_TIPS`, so this sweep covers every one.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type TipCopy, tipSentenceProblems } from '@prl/ui/tips';
import { WEB_TIPS } from '../src/lib/tips.ts';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sourceFiles(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.tsx') ? [path] : [];
  });
}

describe('every web tip is one plain sentence', () => {
  const entries = Object.entries(WEB_TIPS) as readonly (readonly [string, TipCopy])[];

  it('reads a real catalogue', () => {
    assert.ok(entries.length >= 4, `only ${entries.length} tips`);
  });

  for (const [key, copy] of entries) {
    it(`${key}: "${copy.text}"`, () => {
      assert.deepEqual(tipSentenceProblems(copy), []);
    });
  }

  it('NEGATIVE CONTROL: the shared check rejects a second sentence and a long tip', () => {
    assert.notDeepEqual(tipSentenceProblems({ term: 'street', text: 'The round. Preflop to river.' }), []);
    assert.notDeepEqual(tipSentenceProblems({ term: 'street', text: `The ${'long '.repeat(30)}round.` }), []);
  });
});

describe('every tip on a page comes from WEB_TIPS, and every entry is shown', () => {
  const files = sourceFiles(SRC);
  const uses = files.flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/\btip=\{([^}]+)\}/gu)].map(
      (match) => [file.slice(SRC.length), (match[1] ?? '').trim()] as const,
    ),
  );

  it('found pages and tips to check', () => {
    assert.ok(files.length > 30, `only ${files.length} source files`);
    assert.ok(uses.length >= 5, `only ${uses.length} tips`);
  });

  it('passes a catalogue entry, or forwards a prop that carries one', () => {
    for (const [file, value] of uses) {
      assert.ok(/^WEB_TIPS\.[A-Za-z]+$/u.test(value) || value === 'tip', `${file}: tip={${value}}`);
    }
  });

  it('shows every entry somewhere', () => {
    const all = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const key of Object.keys(WEB_TIPS)) {
      assert.ok(all.includes(`WEB_TIPS.${key}`), `WEB_TIPS.${key} is never shown`);
    }
  });
});
