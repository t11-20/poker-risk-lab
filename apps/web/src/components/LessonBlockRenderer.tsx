/**
 * Every `LessonBlock` variant, drawn. A server component, so all lesson prose is in the first HTML
 * response and works with find-in-page and print. No reveal-on-scroll (§5.1).
 * No figures in this file. Every number comes from `LiveCalculation` (ADR 0006).
 * Heading numbers are `aria-hidden` because a screen reader already announces level and position.
 */

import type { GlossaryEntry, LessonBlock, LiveCalculation as LessonCalculationSpec } from '@prl/contracts';
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
  readonly outline: LessonOutline;
  readonly glossary: readonly GlossaryEntry[];
}

/** Blocks have no id, so the key comes from their text plus an occurrence counter. */
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
  readonly calculationIndex: number;
  readonly headingIndex: number;
  readonly blockIndex: number;
  readonly earlierOfKind: readonly LessonCalculationSpec[];
}

function keyBlocks(blocks: readonly LessonBlock[]): readonly KeyedBlock[] {
  const seen = new Map<string, number>();
  const out: KeyedBlock[] = [];
  let calculations = 0;
  let headings = 0;
  const byKind = new Map<string, LessonCalculationSpec[]>();

  blocks.forEach((block, blockIndex) => {
    const digest = digestOf(block);
    const count = seen.get(digest) ?? 0;
    seen.set(digest, count + 1);
    let earlierOfKind: readonly LessonCalculationSpec[] = [];
    if (block.kind === 'liveCalculation') {
      calculations += 1;
      const seenOfKind = byKind.get(block.calculation.kind) ?? [];
      earlierOfKind = [...seenOfKind];
      byKind.set(block.calculation.kind, [...seenOfKind, block.calculation]);
    }
    if (block.kind === 'heading') headings += 1;
    out.push({
      key: `${digest}#${count}`,
      block,
      calculationIndex: calculations,
      headingIndex: headings,
      blockIndex,
      earlierOfKind,
    });
  });

  return out;
}

function Prose(props: {
  readonly text: string;
  readonly matchers: readonly TermMatcher[];
  readonly claimed: Set<string>;
  readonly entries: ReadonlyMap<string, GlossaryEntry>;
  readonly related: ReadonlyMap<string, readonly RelatedTerm[]>;
}): ReactNode {
  const segments: readonly ProseSegment[] = splitProse(props.text, props.matchers, props.claimed);
  return segments.map((segment) => {
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
 * Resolved on the server and passed as data, because React cannot pass a resolver function to the
 * client `GlossaryTerm`. An id with no entry is dropped rather than rendered as a slug.
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
  /** Lesson-wide and mutated in document order, so only a term's first mention is a trigger. */
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
           * `h2` before the first heading block, `h3` after. `stack-to-pot-ratio` opens with two
           * calculations, and a fixed `h3` skipped a level under the `h1` (axe `heading-order`, WCAG 1.3.1).
           */
          return (
            <LiveCalculation
              key={key}
              calculation={block.calculation}
              caption={block.caption}
              {...(block.title === undefined ? {} : { title: block.title })}
              earlier={keyed.earlierOfKind}
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
