/**
 * `/define <term>`: a glossary entry from `@prl/content`, or the nearest names to what was typed.
 *
 * ## A definition is only ever an entry's own text
 *
 * An unknown term gets suggestions by NAME and nothing else: no definition is composed, guessed or
 * borrowed from a near match. A reader who typed "blind" is shown Blinds, Big blind and Small blind
 * as buttons and chooses; the bot does not decide that one of them is what they meant.
 *
 * ## What counts as the same name
 *
 * Case, punctuation and a leading "the" are ignored, and an entry answers to its term, its term
 * without the bracketed part, the bracketed part, and its id. So "EV", "expected value" and
 * "Expected value (EV)" all reach one entry, and "push fold" reaches "Push/fold".
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

/**
 * Every name to its entry. Built once: the content does not change while the process runs. Where
 * two entries share a derived name, the first in the file keeps it, and an entry's own term always
 * beats another's derived name, so "Dirty out" and "Dirty outs" each answer to themselves.
 */
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

/**
 * The closest entries by name: one name containing the other first, then by edit distance. A
 * distance is close when it is at most a third of the longer name, so "pot ods" finds Pot odds and
 * "xyzzy" finds nothing rather than the least unlike of ninety words.
 */
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

/** The entry as a message: term, definition, the formula in plain text when it has one. */
export function entryText(entry: GlossaryEntry): string {
  const lines = [entry.term, '', entry.definition];
  if (entry.formula !== undefined) lines.push('', `Formula: ${entry.formula}`);
  if (seeAlsoOf(entry).length > 0) lines.push('', 'See also:');
  return lines.join('\n');
}

/** The see-also entries that exist. The validator checks the links; this does not trust it to. */
export function seeAlsoOf(entry: GlossaryEntry): GlossaryEntry[] {
  return (entry.seeAlso ?? []).flatMap((id) => {
    const linked = entryById(id);
    return linked === null ? [] : [linked];
  });
}
