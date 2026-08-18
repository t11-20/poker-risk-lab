/**
 * Finding the glossary terms a lesson declares inside the lesson's own prose.
 *
 * ## What this does and, more importantly, what it does not
 *
 * A `Lesson` carries `glossaryTerms: ContentId[]` and a set of `prose` blocks of plain text.
 * Nothing in the contract says *where* in the prose a term appears, so this locates the first
 * mention of each declared term and splits the paragraph into text and term segments. The
 * renderer then wraps the term segments in a definition trigger.
 *
 * It never changes a word. The output segments concatenate back to the exact input string, and
 * `LessonBlockRenderer` asserts nothing else — no rewriting, no synonyms, no injected
 * explanations. The lesson's author wrote the sentence; this only marks part of it.
 *
 * ## Why plain scanning rather than a regular expression
 *
 * The needles come from content. Building a `RegExp` out of data means escaping it correctly
 * for ever, and a term like `Push/fold` or `3-bet` is exactly the shape that gets escaping
 * wrong. `indexOf` over a lower-cased copy plus an explicit boundary check is longer to read
 * and has no such failure mode, and it is linear in the paragraph length.
 *
 * ## Three rules that keep the prose readable
 *
 *  1. **Longest needle first.** Otherwise "pot" would claim the first three letters of "pot
 *     odds" and the more specific entry would never match.
 *  2. **First mention per lesson, not per paragraph.** A lesson about equity says "equity"
 *     forty times; forty dotted-underlined buttons is not a reading experience, it is a
 *     minefield. The first one teaches the term and the rest are prose.
 *  3. **Word boundaries, with an optional trailing `s`.** So "out" matches "out" and "outs" but
 *     not "outside", and "bet" does not light up inside "better".
 */

import type { ContentId, GlossaryEntry } from '@prl/contracts';

export interface TermMatcher {
  readonly entryId: ContentId;
  /** Lower-cased, without a parenthetical gloss or a leading "the". */
  readonly needle: string;
}

/**
 * One run of a paragraph, with a React key derived from its own content.
 *
 * The key is produced here rather than at the call site because `key={index}` is banned — on a
 * reordered list index keys make React reuse the wrong node — and because the occurrence counter
 * that makes two identical runs distinct has to be kept somewhere. Keeping it in the splitter means
 * the renderer has nothing to get wrong, and the keys are testable as data.
 */
export type ProseSegment =
  | { readonly kind: 'text'; readonly key: string; readonly text: string }
  | { readonly kind: 'term'; readonly key: string; readonly text: string; readonly entryId: ContentId };

/**
 * The searchable form of a term.
 *
 * Glossary terms are written for a reader, so several carry a parenthetical gloss
 * ("Alpha (break-even bluff frequency)") or a leading article ("The button"). Neither appears
 * in running prose in that form, so both are stripped: what is left is what an author actually
 * types mid-sentence.
 */
function needleFor(term: string): string {
  const withoutGloss = term.split(' (')[0] ?? term;
  const withoutArticle = withoutGloss.replace(/^the\s+/i, '');
  return withoutArticle.trim().toLowerCase();
}

function isWordCharacter(character: string | undefined): boolean {
  if (character === undefined) return false;
  return /[a-z0-9]/i.test(character);
}

/**
 * Matchers for a lesson's declared terms, longest needle first.
 *
 * Entries whose needle collapses to nothing are dropped rather than matched against every
 * empty position in the paragraph.
 */
export function buildTermMatchers(entries: readonly GlossaryEntry[]): readonly TermMatcher[] {
  const matchers: TermMatcher[] = [];
  for (const entry of entries) {
    const needle = needleFor(entry.term);
    if (needle !== '') matchers.push({ entryId: entry.id, needle });
  }
  return matchers.sort((a, b) => b.needle.length - a.needle.length);
}

/**
 * The earliest unclaimed match in `text`, or `null`.
 *
 * "Earliest" rather than "longest overall": two terms can both appear in a paragraph, and the
 * one that comes first in the sentence is the one that must be marked first, or the segments
 * would come out in the wrong order. Ties at the same position go to the longer needle, which
 * is what the sort in `buildTermMatchers` delivers.
 */
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

/**
 * Splits one paragraph into text and term segments.
 *
 * `claimed` is read *and written*: it is the lesson-wide record of which terms have already been
 * marked, so a term is a trigger once and prose thereafter. Passing a mutable set through is
 * deliberate — the alternative is threading a return value through every block in the renderer,
 * which puts the same state in more places.
 */
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
