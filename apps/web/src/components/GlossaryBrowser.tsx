'use client';

/**
 * The glossary: ninety terms, filterable, with every entry addressable by id.
 *
 * ## The addressability is the requirement
 *
 * `GlossaryTerm`'s "open in the glossary" link and every `seeAlso` cross-reference point at
 * `/learn/glossary#<id>`, so each entry carries that `id` and the page must be able to reach it.
 * Which is why the filters start empty: a filtered-out entry has no box to scroll to, so an
 * arriving `#alpha` would silently do nothing. First paint shows everything.
 *
 * ## Cross-references are buttons, not links
 *
 * A `seeAlso` inside this page is a `<button>` rather than an `<a href="#id">` for one concrete
 * reason: if the reader has typed a filter, the target may not be rendered, and a fragment link
 * to a missing element fails quietly. The button clears the filters and then moves focus to the
 * target's heading, which scrolls it into view natively, announces it, and leaves the keyboard
 * user where a mouse user would be looking. An anchor could do the first of those three.
 *
 * The headings therefore carry `tabIndex={-1}`: programmatically focusable, never in the tab
 * order.
 *
 * ## Filtering is a render, not a fetch
 *
 * The whole glossary is already on the page — it is 90 short entries — so the search box is a
 * substring match over an array. No debounce, no request, no loading state, and it works with the
 * API down.
 */

import type { GlossaryEntry } from '@prl/contracts';
import { TOPICS } from '@prl/contracts';
import { Chip, pluralise } from '@prl/ui';
import { type ReactElement, useMemo, useRef, useState } from 'react';
import { topicLabel } from '@/lib/learn-curriculum.ts';

export interface GlossaryBrowserProps {
  readonly entries: readonly GlossaryEntry[];
}

/** The letter an entry files under. Anything not A–Z files under `#`. */
function initialOf(term: string): string {
  const first = term.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : '#';
}

interface LetterGroup {
  readonly letter: string;
  readonly entries: readonly GlossaryEntry[];
}

function groupByLetter(entries: readonly GlossaryEntry[]): readonly LetterGroup[] {
  const buckets = new Map<string, GlossaryEntry[]>();
  for (const entry of entries) {
    const letter = initialOf(entry.term);
    const bucket = buckets.get(letter);
    if (bucket === undefined) buckets.set(letter, [entry]);
    else bucket.push(entry);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([letter, group]) => ({
      letter,
      entries: [...group].sort((a, b) => a.term.localeCompare(b.term)),
    }));
}

export function GlossaryBrowser(props: GlossaryBrowserProps): ReactElement {
  const { entries } = props;
  const [query, setQuery] = useState('');
  const [topic, setTopic] = useState('');
  const headings = useRef(new Map<string, HTMLHeadingElement>());

  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);

  const topicsPresent = useMemo(() => {
    const present = new Set<string>();
    for (const entry of entries) for (const value of entry.topics) present.add(value);
    const ordered = TOPICS.filter((value) => present.has(value));
    const extra = [...present].filter((value) => !(TOPICS as readonly string[]).includes(value));
    return [...ordered, ...extra.sort()];
  }, [entries]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      // `entry.topics` is `readonly Topic[]` and the select's value is a plain string, so the
      // comparison is widened rather than the value being asserted into the union: a topic this
      // build has never heard of should simply not match, not become a `Topic` by fiat.
      const topics: readonly string[] = entry.topics;
      if (topic !== '' && !topics.includes(topic)) return false;
      if (needle === '') return true;
      return entry.term.toLowerCase().includes(needle) || entry.definition.toLowerCase().includes(needle);
    });
  }, [entries, query, topic]);

  const groups = useMemo(() => groupByLetter(filtered), [filtered]);

  /** Clears the filters so the target is rendered, then moves focus to it. */
  const jumpTo = (id: string): void => {
    setQuery('');
    setTopic('');
    // The heading may not be mounted yet if it was filtered out; a microtask is enough, because
    // React has already committed the state updates above by the time this resolves.
    queueMicrotask(() => headings.current.get(id)?.focus());
  };

  return (
    <div className="prl-learn-glossary">
      <div className="prl-learn-glossary__controls">
        <div className="prl-field">
          <label className="prl-field__label" htmlFor="glossary-search">
            Search the glossary
          </label>
          <input
            className="prl-input"
            id="glossary-search"
            type="search"
            value={query}
            placeholder="equity, alpha, SPR…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="prl-field">
          <label className="prl-field__label" htmlFor="glossary-topic">
            Filter by topic
          </label>
          <select
            className="prl-select"
            id="glossary-topic"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
          >
            <option value="">Every topic</option>
            {topicsPresent.map((value) => (
              <option key={value} value={value}>
                {topicLabel(value)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="prl-note" aria-live="polite">
        {filtered.length === entries.length
          ? `${pluralise(entries.length, 'term')}, ${pluralise(topicsPresent.length, 'topic')}.`
          : `${pluralise(filtered.length, 'term')} of ${entries.length} shown.`}
      </p>

      {groups.length === 0 ? (
        <div className="prl-empty">
          <p>
            Nothing matches that. The glossary covers the vocabulary the lessons use, so a term from somewhere
            else may genuinely not be here.
          </p>
        </div>
      ) : (
        <>
          <nav className="prl-learn-glossary__jump" aria-label="Jump to a letter">
            {groups.map((group) => (
              <a
                className="prl-learn-glossary__jump-link"
                href={`#glossary-letter-${group.letter}`}
                key={group.letter}
              >
                {group.letter}
              </a>
            ))}
          </nav>

          {groups.map((group) => (
            <section className="prl-learn-glossary__group" key={group.letter}>
              <h2 className="prl-learn-glossary__letter" id={`glossary-letter-${group.letter}`}>
                {group.letter}
              </h2>
              {/*
                An `<h3>` per term rather than a `<dl>`: a definition list would be the tidier
                semantic, but `dt`'s content model forbids heading content, and heading navigation
                is how a screen-reader user actually moves through ninety entries. The heading is
                the more useful of the two affordances, so the list goes.
              */}
              <div className="prl-learn-glossary__entries">
                {group.entries.map((entry) => (
                  <article className="prl-learn-glossary__entry" id={entry.id} key={entry.id}>
                    <h3
                      className="prl-learn-glossary__term"
                      tabIndex={-1}
                      ref={(node) => {
                        if (node === null) headings.current.delete(entry.id);
                        else headings.current.set(entry.id, node);
                      }}
                    >
                      {entry.term}
                    </h3>
                    <p className="prl-learn-glossary__definition">{entry.definition}</p>
                    {entry.formula === undefined ? null : (
                      <code className="prl-learn-glossary__formula">{entry.formula}</code>
                    )}
                    <p className="prl-learn-glossary__topics">
                      {entry.topics.map((value) => (
                        <Chip key={value}>{topicLabel(value)}</Chip>
                      ))}
                    </p>
                    {entry.seeAlso === undefined || entry.seeAlso.length === 0 ? null : (
                      <p className="prl-learn-glossary__related">
                        <span className="prl-label">See also</span>
                        {entry.seeAlso.map((id) => {
                          const related = byId.get(id);
                          if (related === undefined) return null;
                          return (
                            <button
                              className="prl-learn-glossary__related-btn"
                              key={id}
                              type="button"
                              onClick={() => jumpTo(id)}
                            >
                              {related.term}
                            </button>
                          );
                        })}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
