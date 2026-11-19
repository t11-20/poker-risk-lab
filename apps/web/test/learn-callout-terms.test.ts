/**
 * The lesson page says each listed term is a button the first time it appears in the paragraphs, lists
 * and callouts. The renderer imports Next and cannot load under `node --test`, so which block kinds reach
 * `Prose` is read from its source and replayed over the bundled lesson.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { glossaryEntriesFor, lessonById } from '@prl/content';
import type { LessonBlock } from '@prl/contracts';
import { buildTermMatchers, splitProse } from '../src/lib/learn-glossary-links.ts';

const RENDERER = readFileSync(new URL('../src/components/LessonBlockRenderer.tsx', import.meta.url), 'utf8');
const LEARN_CSS = readFileSync(new URL('../src/styles/learn.css', import.meta.url), 'utf8');

/** Each `if (block.kind === '…') { … }` branch of the renderer, by kind. */
function branches(): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const match of RENDERER.matchAll(/if \(block\.kind === '([a-zA-Z]+)'\) \{([\s\S]*?)\n {8}\}/gu)) {
    out.set(match[1] ?? '', match[2] ?? '');
  }
  return out;
}

function linkedKinds(): ReadonlySet<string> {
  return new Set([...branches()].filter(([, body]) => body.includes('<Prose')).map(([kind]) => kind));
}

function textsOf(block: LessonBlock): readonly string[] {
  if (block.kind === 'prose' || block.kind === 'callout') return [block.text];
  if (block.kind === 'list') return block.items;
  return [];
}

describe('a listed term whose first mention is in a callout is a button', () => {
  it('counting-outs: "blocker" is listed, appears only in a callout, and is claimed (REGRESSION)', () => {
    const kinds = linkedKinds();
    assert.ok(kinds.has('prose') && kinds.has('list'), 'the source scan found the Prose branches');
    const lesson = lessonById('counting-outs');
    assert.ok(lesson !== null);
    const glossary = glossaryEntriesFor(lesson.glossaryTerms);
    assert.ok(
      glossary.some((entry) => entry.id === 'blocker'),
      'blocker is in the lesson term list',
    );
    const mentions = lesson.blocks.filter((block) => textsOf(block).some((text) => /\bblocker/iu.test(text)));
    assert.ok(mentions.length > 0, 'a sweep of nothing is not a pass');
    assert.ok(
      mentions.every((block) => block.kind === 'callout'),
      'the fixture still puts its only mention in a callout',
    );

    const matchers = buildTermMatchers(glossary);
    const claimed = new Set<string>();
    for (const block of lesson.blocks) {
      if (!kinds.has(block.kind)) continue;
      for (const text of textsOf(block)) splitProse(text, matchers, claimed);
    }
    assert.ok(claimed.has('blocker'), `no button for "blocker" (linked kinds: ${[...kinds].join(', ')})`);
  });

  it('wraps the callout text in a positioned box, so the popover spans it and is not clipped', () => {
    const callout = branches().get('callout') ?? '';
    const wrapper = /<span className="([^"]+)">\s*<Prose/u.exec(callout);
    assert.ok(wrapper !== null, `the callout's Prose has no wrapper:\n${callout}`);
    const rule = new RegExp(`\\.${wrapper[1]} \\{([^}]*)\\}`, 'u').exec(LEARN_CSS);
    assert.ok(rule !== null, `learn.css has no rule for .${wrapper[1]}`);
    assert.match(rule[1] ?? '', /position: relative;/u);
    // The callout's own type stays with `.prl-callout__body`.
    assert.doesNotMatch(rule[1] ?? '', /font|line-height|max-width/u);
  });
});
