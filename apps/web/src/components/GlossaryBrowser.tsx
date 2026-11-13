'use client';

/**
 * The glossary, filterable, with every entry addressable as `/learn/glossary#<id>`. Filters start
 * empty so an arriving fragment always has a target. A `seeAlso` is a button, not a fragment link,
 * because a filtered-out target is not rendered. It clears the filters and focuses the target's
 * `tabIndex={-1}` heading. Filtering is a substring match over entries already on the page.
 */

import type { GlossaryEntry } from '@prl/contracts';
import { TOPICS } from '@prl/contracts';
import { Chip, pluralise } from '@prl/ui';
import { type ReactElement, useMemo, useRef, useState } from 'react';
import { topicLabel } from '@/lib/learn-curriculum.ts';

export interface GlossaryBrowserProps {
  readonly entries: readonly GlossaryEntry[];
}

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
      // Widened, not asserted into the union, so an unknown topic simply does not match.
      const topics: readonly string[] = entry.topics;
      if (topic !== '' && !topics.includes(topic)) return false;
      if (needle === '') return true;
      return entry.term.toLowerCase().includes(needle) || entry.definition.toLowerCase().includes(needle);
    });
  }, [entries, query, topic]);

  const groups = useMemo(() => groupByLetter(filtered), [filtered]);

  const jumpTo = (id: string): void => {
    setQuery('');
    setTopic('');
    // A filtered-out heading mounts once React commits the updates above, before this microtask.
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
              {/* Not a `<dl>`, because `dt` forbids headings and heading navigation is how readers move. */}
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
                        <span className="prl-learn-glossary__related-list">
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
                        </span>
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
