/**
 * The verbs the table's narration is written in, in both persons, and the one rewrite that uses them.
 *
 * ## The defect
 *
 * Events are broadcast: every socket in a room receives the same `action`, `forcedBets`, `showdown`
 * and `handComplete` sentences, written by `apps/api/src/rooms/narration.ts` with the name each seat
 * was dealt in under. So the reader's own hand was narrated to them in the third person under a name
 * they never chose — "Guest 12D91B posts the big blind, 10.", "Guest 12D91B folds", and under the
 * table, in "How the hand ended", "Guest 12D91B wins 1,529 from the pot." (audit at 308fadf). Every
 * other surface on the page calls the reader "you".
 *
 * ## Why a rewrite, and why here
 *
 * Narrating per recipient on the server means building every event once per socket in the router's
 * fan-out, which is a protocol change for a wording fix. The client already knows the one name that
 * is the reader's, and `WsEvent` says events are never load-bearing, so the page may say them in its
 * own words. What it must not do is parse a sentence meant for a person against a grammar of its own
 * — that is how a client breaks the first time somebody rewords the server (`AUTO_ACTED_NOTICE` in
 * `apps/web/src/lib/use-live-table.ts` names the same trap). So the grammar has ONE home: the API
 * writes its sentences from the `third` column below, the page rewrites from the same rows, and
 * `apps/api/test/table-narration.test.ts` runs this rewrite over sentences the real table produced.
 *
 * ## Which direction it fails in
 *
 * Towards the server's own sentence. A sentence that does not open on exactly the reader's name and
 * a verb from this table comes back unchanged, and that sentence is true — it names the reader the
 * way the server does. Nothing here can put "You" on a sentence about somebody else.
 */

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
} as const satisfies Readonly<Record<string, { readonly third: string; readonly second: string }>>;

/** The tail of a forced bet that took a seat's whole stack. */
export const ALL_THEY_HAD = { third: 'which is all they had', second: 'which is all you had' } as const;

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Longest first, so "raises to" is tried before a hypothetical "raises": an alternation takes the
 * first branch that matches, not the longest.
 */
const THIRD_TO_SECOND = new Map<string, string>(
  Object.values(NARRATED_VERBS)
    .map((verb): [string, string] => [verb.third, verb.second])
    .sort(([a], [b]) => b.length - a.length),
);
const VERB_ALTERNATION = [...THIRD_TO_SECOND.keys()].map(escaped).join('|');

/**
 * `text` with every sentence that opens on `name` and a narrated verb put in the second person.
 *
 * A sentence opens at the start of `text` or after ". " — `forcedBets` joins one sentence per seat
 * into one string, so the reader's blind may be the second sentence. The verb must be followed by a
 * space, a comma, a full stop or the end, so "Patient Technician 1" is not matched inside "Patient
 * Technician 12 folds" (the name must be followed by a space and then the verb).
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
