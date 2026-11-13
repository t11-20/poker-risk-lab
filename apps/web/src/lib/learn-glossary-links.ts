/**
 * Finds the first mention of each glossary term a lesson declares in its prose, and splits the
 * paragraph into text and term segments that concatenate back to the exact input.
 * `indexOf` over a lower-cased copy, not a `RegExp` built from content, so `3-bet` needs no escaping.
 * Longest needle first, so "pot" cannot claim "pot odds". First mention per lesson only. Word
 * boundaries with an optional trailing `s`, so "bet" does not light up inside "better".
 */

import type { ContentId, GlossaryEntry } from '@prl/contracts';

export interface TermMatcher {
  readonly entryId: ContentId;
  /** Lower-cased, without a parenthetical gloss or a leading "the". */
  readonly needle: string;
}

/** Keys are built here, with an occurrence counter, because `key={index}` is banned. */
export type ProseSegment =
  | { readonly kind: 'text'; readonly key: string; readonly text: string }
  | { readonly kind: 'term'; readonly key: string; readonly text: string; readonly entryId: ContentId };

/** Strips a parenthetical gloss and a leading "the", which running prose does not carry. */
function needleFor(term: string): string {
  const withoutGloss = term.split(' (')[0] ?? term;
  const withoutArticle = withoutGloss.replace(/^the\s+/i, '');
  return withoutArticle.trim().toLowerCase();
}

function isWordCharacter(character: string | undefined): boolean {
  if (character === undefined) return false;
  return /[a-z0-9]/i.test(character);
}

/** Longest needle first. A needle that collapses to nothing is dropped. */
export function buildTermMatchers(entries: readonly GlossaryEntry[]): readonly TermMatcher[] {
  const matchers: TermMatcher[] = [];
  for (const entry of entries) {
    const needle = needleFor(entry.term);
    if (needle !== '') matchers.push({ entryId: entry.id, needle });
  }
  return matchers.sort((a, b) => b.needle.length - a.needle.length);
}

/** The earliest match, so segments come out in order. A tie goes to the longer needle, via the sort. */
function firstMatch(
  text: string,
  lower: string,
  matchers: readonly TermMatcher[],
  claimed: ReadonlySet<ContentId>,
): { readonly start: number; readonly end: number; readonly entryId: ContentId } | null {
  let best: { start: number; end: number; entryId: ContentId } | null = null;

  for (const matcher of matchers) {
    if (claimed.has(matcher.entryId)) continue;
    let from = 0;
    for (;;) {
      const start = lower.indexOf(matcher.needle, from);
      if (start === -1) break;
      let end = start + matcher.needle.length;
      // Absorb a plural `s` so "out" marks "outs" as one term rather than leaving a stray letter.
      if (lower[end] === 's' && !matcher.needle.endsWith('s')) end += 1;
      const before = start === 0 ? undefined : text[start - 1];
      const after = text[end];
      if (!isWordCharacter(before) && !isWordCharacter(after)) {
        if (best === null || start < best.start) best = { start, end, entryId: matcher.entryId };
        break;
      }
      from = start + 1;
    }
  }

  return best;
}

/** `claimed` is the lesson-wide set of terms already marked, and this writes to it. */
export function splitProse(
  text: string,
  matchers: readonly TermMatcher[],
  claimed: Set<ContentId>,
): readonly ProseSegment[] {
  /** Occurrence counter, so two identical text runs in one paragraph get distinct keys. */
  const seen = new Map<string, number>();
  const keyFor = (kind: string, value: string): string => {
    const base = `${kind}:${value.slice(0, 32)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return `${base}#${count}`;
  };

  if (matchers.length === 0) return [{ kind: 'text', key: keyFor('text', text), text }];

  const segments: ProseSegment[] = [];
  let rest = text;

  for (;;) {
    const match = firstMatch(rest, rest.toLowerCase(), matchers, claimed);
    if (match === null) break;
    if (match.start > 0) {
      const before = rest.slice(0, match.start);
      segments.push({ kind: 'text', key: keyFor('text', before), text: before });
    }
    segments.push({
      kind: 'term',
      key: keyFor('term', match.entryId),
      text: rest.slice(match.start, match.end),
      entryId: match.entryId,
    });
    claimed.add(match.entryId);
    rest = rest.slice(match.end);
  }

  if (rest !== '') segments.push({ kind: 'text', key: keyFor('text', rest), text: rest });
  return segments;
}
