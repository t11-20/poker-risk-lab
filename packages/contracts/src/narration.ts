/**
 * The narration verbs in both persons, and the rewrite that uses them.
 * Events are broadcast in the third person, so the client rewrites the reader's own sentences to "you".
 * The API writes from the `third` column and the page rewrites from the same rows, so the grammar has
 * one home (`apps/api/test/table-narration.test.ts`). An unmatched sentence comes back unchanged.
 * Names are not unique, so the caller decides attribution (`inReadersWords` in `use-live-table.ts`).
 */

import type { Pot } from '@prl/poker-engine';

/** Each narrated verb phrase, as the server writes it about a seat and as it reads about the reader. */
export const NARRATED_VERBS = {
  fold: { third: 'folds', second: 'fold' },
  check: { third: 'checks', second: 'check' },
  call: { third: 'calls', second: 'call' },
  bet: { third: 'bets to', second: 'bet to' },
  raise: { third: 'raises to', second: 'raise to' },
  act: { third: 'acts', second: 'act' },
  post: { third: 'posts', second: 'post' },
  show: { third: 'shows', second: 'show' },
  win: { third: 'wins', second: 'win' },
  getBack: { third: 'gets back', second: 'get back' },
} as const satisfies Readonly<Record<string, { readonly third: string; readonly second: string }>>;

/** What follows `getBack` and its amount: an uncalled bet, in the glossary's words. */
export const NOBODY_MATCHED = 'that nobody still in the hand matched';

/**
 * The part of `pot` that is its one eligible seat's own bet, which goes back to that seat rather
 * than being won. `buildPotLayers` keeps the layer above every other live seat's commitment as a pot
 * only its owner can win. Anything above the layer's own width came from seats that folded, and is
 * won. A main pot with one eligible seat is a fold-win with the blinds in it, so it is never returned.
 */
export function unmatchedPartOf(pot: Pot, pots: readonly Pot[]): number {
  if (pot.index === 0 || pot.eligibleSeats.length !== 1) return 0;
  const floor = pots.find((below) => below.index === pot.index - 1)?.capPerSeat ?? 0;
  return Math.min(pot.amount, pot.capPerSeat - floor);
}

/** The tail of a forced bet that took a seat's whole stack. */
export const ALL_THEY_HAD = { third: 'which is all they had', second: 'which is all you had' } as const;

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Longest first, because an alternation takes the first branch that matches, not the longest. */
const THIRD_TO_SECOND = new Map<string, string>(
  Object.values(NARRATED_VERBS)
    .map((verb): [string, string] => [verb.third, verb.second])
    .sort(([a], [b]) => b.length - a.length),
);
const VERB_ALTERNATION = [...THIRD_TO_SECOND.keys()].map(escaped).join('|');

/**
 * `text` with every sentence that opens on `name` and a narrated verb put in the second person.
 * A sentence opens at the start or after ". ", since `forcedBets` joins one sentence per seat. The verb
 * must be followed by a space, comma, full stop or the end, so "Technician 1" does not match "Technician 12".
 */
export function inSecondPerson(text: string, name: string): string {
  if (name.trim() === '') return text;
  const opening = new RegExp(`(^|\\. )${escaped(name)} (${VERB_ALTERNATION})(?=[ .,]|$)`, 'gu');
  let out = '';
  let from = 0;
  for (const match of text.matchAll(opening)) {
    const lead = match[1] ?? '';
    const third = match[2] ?? '';
    const start = match.index + lead.length;
    const verbEnd = match.index + match[0].length;
    // The rest of THIS sentence, and no further: a later sentence's "all they had" is somebody else's.
    const stop = text.indexOf('.', verbEnd);
    const end = stop < 0 ? text.length : stop;
    const rest = text.slice(verbEnd, end).replace(`, ${ALL_THEY_HAD.third}`, `, ${ALL_THEY_HAD.second}`);
    out += `${text.slice(from, start)}You ${THIRD_TO_SECOND.get(third) ?? third}${rest}`;
    from = end;
  }
  return out + text.slice(from);
}
