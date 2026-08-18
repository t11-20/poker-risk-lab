/**
 * Every `LessonBlock` variant from the contract, drawn.
 *
 * A server component: no state, no effects, no `'use client'`. So the whole of a lesson's prose
 * is in the first HTML response, readable before any JavaScript arrives and findable with the
 * browser's own find-in-page. The two pieces that genuinely need the client — a computed figure
 * and a definition popover — are client components rendered from here, which is the smallest
 * client boundary the screen can have.
 *
 * ## What it will not do
 *
 * **No reveal-on-scroll.** A reveal answers "is this new information?" (§5.1), and a paragraph
 * of a lesson someone is reading is not new information — it is the thing they came for. Hiding
 * it until an observer fires breaks find-in-page, breaks printing, and breaks the reader who
 * scrolled fast. Lesson prose is present at first paint.
 *
 * **No number.** There is not a single figure in this file. Anything numeric a lesson shows
 * arrives through `LiveCalculation`, which computes it from the situation the content stored
 * (ADR 0006). If a percentage ever appears in this file, that is the bug.
 *
 * ## Headings are numbered
 *
 * `01 02 03` in the index voice, from `lessonOutline`. The numbers are `aria-hidden` — a screen
 * reader already announces heading level and position, and "zero two" before every title is
 * noise — but they are what turns a long lesson into something a reader can refer back to, and
 * they are the same ids the sticky contents links to.
 */

import type { GlossaryEntry, LessonBlock } from '@prl/contracts';
import { Callout, Chip, Formula, formatIndex, withKeys } from '@prl/ui';
import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';
import { GlossaryTerm, type RelatedTerm } from '@/components/GlossaryTerm.tsx';
import { LiveCalculation } from '@/components/LiveCalculation.tsx';
import type { LessonOutline } from '@/lib/learn-curriculum.ts';
import {
  buildTermMatchers,
  type ProseSegment,
  splitProse,
  type TermMatcher,
} from '@/lib/learn-glossary-links.ts';

export interface LessonBlockRendererProps {
  readonly blocks: readonly LessonBlock[];
  /** Heading ids, computed once by the page so the contents nav cannot drift from the page. */
  readonly outline: LessonOutline;
  /** The terms this lesson declares. Only these are marked up in the prose. */
  readonly glossary: readonly GlossaryEntry[];
}

/**
 * A content-derived key per block.
 *
 * Blocks have no id in the contract and `key={index}` is banned for good reason: on a reordered
 * list it makes React reuse the wrong DOM node. So the key comes from the block's own text, with
 * an occurrence counter for the case where a lesson legitimately repeats a heading.
 */
function digestOf(block: LessonBlock): string {
  switch (block.kind) {
    case 'prose':
      return `prose:${block.text.slice(0, 48)}`;
    case 'heading':
      return `heading:${block.text}`;
    case 'list':
      return `list:${block.items.join('|').slice(0, 48)}`;
    case 'formula':
      return `formula:${block.expression}`;
    case 'callout':
      return `callout:${block.title}`;
    case 'liveCalculation':
      return `calc:${block.calculation.kind}:${block.caption.slice(0, 32)}`;
    case 'scenarioLink':
      return `scenario:${block.scenarioId}`;
    default: {
      const unreachable: never = block;
      return unreachable;
    }
  }
}

interface KeyedBlock {
  readonly key: string;
  readonly block: LessonBlock;
  /** Position among `liveCalculation` blocks, 1-based, for the `01 02` motif. */
  readonly calculationIndex: number;
  /** Position among `heading` blocks, 1-based. */
  readonly headingIndex: number;
  readonly blockIndex: number;
}

function keyBlocks(blocks: readonly LessonBlock[]): readonly KeyedBlock[] {
  const seen = new Map<string, number>();
  const out: KeyedBlock[] = [];
  let calculations = 0;
  let headings = 0;

  blocks.forEach((block, blockIndex) => {
    const digest = digestOf(block);
    const count = seen.get(digest) ?? 0;
    seen.set(digest, count + 1);
    if (block.kind === 'liveCalculation') calculations += 1;
    if (block.kind === 'heading') headings += 1;
    out.push({
      key: `${digest}#${count}`,
      block,
      calculationIndex: calculations,
      headingIndex: headings,
      blockIndex,
    });
  });

  return out;
}

/**
 * One paragraph's worth of text, with its first mentions turned into definition triggers.
 *
 * The segments concatenate back to the original string exactly, so the sentence a learner reads
 * is the sentence the author wrote.
 */
function Prose(props: {
  readonly text: string;
  readonly matchers: readonly TermMatcher[];
  readonly claimed: Set<string>;
  readonly entries: ReadonlyMap<string, GlossaryEntry>;
  /** `seeAlso` ids resolved to terms, per entry. Data, not a resolver — see below. */
  readonly related: ReadonlyMap<string, readonly RelatedTerm[]>;
}): ReactNode {
  const segments: readonly ProseSegment[] = splitProse(props.text, props.matchers, props.claimed);
  return segments.map((segment) => {
    // Keys come from `splitProse`, derived from each run's own content with an occurrence counter.
    // Nothing here uses a position: an index key makes React reuse the wrong node when a list
    // changes, and the segments of a paragraph are exactly a list that changes.
    if (segment.kind === 'text') return <span key={segment.key}>{segment.text}</span>;
    const entry = props.entries.get(segment.entryId);
    if (entry === undefined) return <span key={segment.key}>{segment.text}</span>;
    return (
      <GlossaryTerm entry={entry} key={segment.key} related={props.related.get(entry.id) ?? []}>
        {segment.text}
      </GlossaryTerm>
    );
  });
}

/**
 * `seeAlso` ids resolved to their terms, one list per entry.
 *
 * Built here, on the server, and passed down as plain data. A resolver function would be the
 * obvious shape and it does not work: `GlossaryTerm` is a client component, and React refuses to
 * serialise a function across that boundary — "Functions cannot be passed directly to Client
 * Components". Resolving up front also means the lookup happens once per lesson instead of once
 * per popover open.
 *
 * An id with no entry is dropped rather than rendered as a slug: a cross-reference the glossary
 * cannot resolve is a content defect for `packages/content` to report, not a link to nowhere.
 */
function resolveRelated(
  glossary: readonly GlossaryEntry[],
  entries: ReadonlyMap<string, GlossaryEntry>,
): ReadonlyMap<string, readonly RelatedTerm[]> {
  const out = new Map<string, readonly RelatedTerm[]>();
  for (const entry of glossary) {
    if (entry.seeAlso === undefined) continue;
    const related: RelatedTerm[] = [];
    for (const id of entry.seeAlso) {
      const target = entries.get(id);
      if (target !== undefined) related.push({ id: target.id, term: target.term });
    }
    if (related.length > 0) out.set(entry.id, related);
  }
  return out;
}

export function LessonBlockRenderer(props: LessonBlockRendererProps): ReactElement {
  const { blocks, outline, glossary } = props;
  const matchers = buildTermMatchers(glossary);
  const entries = new Map(glossary.map((entry) => [entry.id, entry]));
  const related = resolveRelated(glossary, entries);
  /**
   * Lesson-wide, so a term is a trigger on its first mention and plain prose after that. Mutated
   * as the blocks render, in document order, which is why this is created here and not inside
   * `Prose`.
   */
  const claimed = new Set<string>();

  return (
    <div className="prl-learn-lesson__blocks">
      {keyBlocks(blocks).map((keyed) => {
        const { block, key } = keyed;

        if (block.kind === 'heading') {
          const id = outline.idByBlockIndex.get(keyed.blockIndex);
          return (
            <h2 className="prl-learn-lesson__heading" id={id} key={key}>
              <span className="prl-index prl-learn-lesson__heading-index" aria-hidden="true">
                {formatIndex(keyed.headingIndex)}
              </span>
              {block.text}
            </h2>
          );
        }

        if (block.kind === 'prose') {
          return (
            <p className="prl-learn-prose" key={key}>
              <Prose
                text={block.text}
                matchers={matchers}
                claimed={claimed}
                entries={entries}
                related={related}
              />
            </p>
          );
        }

        if (block.kind === 'list') {
          const items = withKeys(block.items, 'item');
          const listItems = items.map((item) => (
            <li className="prl-learn-prose" key={item.key}>
              <Prose
                text={item.value}
                matchers={matchers}
                claimed={claimed}
                entries={entries}
                related={related}
              />
            </li>
          ));
          return block.ordered === true ? (
            <ol className="prl-learn-lesson__list" key={key}>
              {listItems}
            </ol>
          ) : (
            <ul className="prl-learn-lesson__list" key={key}>
              {listItems}
            </ul>
          );
        }

        if (block.kind === 'formula') {
          return (
            <Formula
              key={key}
              eyebrow="Formula"
              expression={block.expression}
              explanation={block.explanation}
            />
          );
        }

        if (block.kind === 'callout') {
          return (
            <Callout key={key} tone={block.tone} title={block.title}>
              {block.text}
            </Callout>
          );
        }

        if (block.kind === 'liveCalculation') {
          /**
           * `h3` inside a section, `h2` before the first one.
           *
           * A live calculation is a subsection of whatever heading precedes it, so `h3` is right
           * almost everywhere. It is wrong in the one case that actually occurs: `stack-to-pot-ratio`
           * opens with prose, a formula and TWO live calculations before its first `heading` block, so
           * a fixed `h3` made the first heading on that page an `h3` under the page's `h1` — a skipped
           * level (axe `heading-order`, WCAG 1.3.1), and a screen-reader outline claiming a section
           * that is not there.
           *
           * `headingIndex` is the number of `heading` blocks seen so far, so zero means "no section
           * has opened yet" and the calculation is a top-level block of the lesson. Deriving the level
           * from the outline rather than asserting one is also what keeps this correct for a lesson
           * nobody has written yet.
           */
          return (
            <LiveCalculation
              key={key}
              calculation={block.calculation}
              caption={block.caption}
              index={keyed.calculationIndex}
              headingLevel={keyed.headingIndex === 0 ? 2 : 3}
            />
          );
        }

        return (
          <div className="prl-learn-scenario" key={key}>
            <span className="prl-label prl-learn-scenario__eyebrow">Try it in the Scenario Lab</span>
            <p className="prl-learn-scenario__prompt">{block.prompt}</p>
            <p className="prl-learn-scenario__note">
              The Lab computes the same figures from the same maths, against a situation you can change.
              Nothing there marks an action right or wrong; it shows you what the numbers do.
            </p>
            <Link className="prl-btn prl-btn--secondary prl-btn--sm" href={`/lab/${block.scenarioId}`}>
              Open the scenario
              <Chip className="prl-learn-scenario__id" mono>
                {block.scenarioId}
              </Chip>
            </Link>
          </div>
        );
      })}
    </div>
  );
}
