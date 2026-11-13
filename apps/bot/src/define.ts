/**
 * `/define <term>`. A definition is only ever an entry's own text. An unknown term gets suggestions
 * by name, and the reader chooses.
 * Case, punctuation and a leading "the" are ignored. An entry answers to its term, the term without
 * its bracketed part, the bracketed part, and its id.
 */

import { glossary } from '@prl/content';
import type { GlossaryEntry } from '@prl/contracts';

export type Lookup =
  | { readonly kind: 'found'; readonly entry: GlossaryEntry }
  | { readonly kind: 'unknown'; readonly suggestions: readonly GlossaryEntry[] };

/** Lower case, letters and digits only, single spaces, no leading article. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

function namesOf(entry: GlossaryEntry): string[] {
  const names = [entry.term, entry.id.replace(/-/g, ' ')];
  const bracketed = /^(.*?)\s*\((.+)\)\s*$/.exec(entry.term);
  if (bracketed !== null) names.push(bracketed[1] ?? '', bracketed[2] ?? '');
  return [...new Set(names.map(normalise).filter((name) => name !== ''))];
}

let index: ReadonlyMap<string, GlossaryEntry> | null = null;

/** On a shared derived name the first entry wins, and an entry's own term beats a derived one. */
function names(): ReadonlyMap<string, GlossaryEntry> {
  if (index !== null) return index;
  const built = new Map<string, GlossaryEntry>();
  for (const entry of glossary()) built.set(normalise(entry.term), entry);
  for (const entry of glossary()) {
    for (const name of namesOf(entry)) if (!built.has(name)) built.set(name, entry);
  }
  index = built;
  return built;
}

export function entryById(id: string): GlossaryEntry | null {
  return glossary().find((entry) => entry.id === id) ?? null;
}

const MAX_SUGGESTIONS = 3;

export function lookup(query: string): Lookup {
  const wanted = normalise(query);
  const exact = names().get(wanted);
  if (exact !== undefined) return { kind: 'found', entry: exact };
  return { kind: 'unknown', suggestions: wanted === '' ? [] : suggestionsFor(wanted) };
}

/** Containment first, then edit distance up to a third of the longer name. */
function suggestionsFor(wanted: string): GlossaryEntry[] {
  const scored: { entry: GlossaryEntry; score: number }[] = [];
  for (const entry of glossary()) {
    let best = Number.POSITIVE_INFINITY;
    for (const name of namesOf(entry)) {
      const contains = wanted.length >= 3 && (name.includes(wanted) || wanted.includes(name));
      const distance = editDistance(wanted, name);
      const close = distance <= Math.max(wanted.length, name.length) / 3;
      if (contains) best = Math.min(best, distance / 100);
      else if (close) best = Math.min(best, distance);
    }
    if (Number.isFinite(best)) scored.push({ entry, score: best });
  }
  return scored
    .sort((left, right) => left.score - right.score || left.entry.term.localeCompare(right.entry.term))
    .slice(0, MAX_SUGGESTIONS)
    .map((candidate) => candidate.entry);
}

/** Levenshtein distance, two rows. */
function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, column) => column);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = (previous[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1);
      current.push(Math.min((previous[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

export function entryText(entry: GlossaryEntry): string {
  const lines = [entry.term, '', entry.definition];
  if (entry.formula !== undefined) lines.push('', `Formula: ${entry.formula}`);
  if (seeAlsoOf(entry).length > 0) lines.push('', 'See also:');
  return lines.join('\n');
}

/** The validator checks see-also links. This does not rely on it. */
export function seeAlsoOf(entry: GlossaryEntry): GlossaryEntry[] {
  return (entry.seeAlso ?? []).flatMap((id) => {
    const linked = entryById(id);
    return linked === null ? [] : [linked];
  });
}
