/**
 * The learner's place in a quiz, kept in the query so a reload reopens it. `?question=2` is 1-based,
 * as drawn; the first question is no parameter at all and the review is `review`. Anything else
 * reads as the first question, and rewriting the query then removes it.
 */

export const QUIZ_PLACE_PARAM = 'question';

const REVIEW = 'review';

/** Digits only, no sign, no leading zero, so `Number('')`, `' 2'`, `1e0` and `02` cannot slip through. */
const POSITION = /^[1-9][0-9]*$/u;

function decoded(part: string): string | null {
  try {
    return decodeURIComponent(part.replace(/\+/gu, ' '));
  } catch {
    return null;
  }
}

/** The raw `key=value` entries of a search string, so the others can be put back byte for byte. */
function entries(search: string): readonly string[] {
  const query = search.startsWith('?') ? search.slice(1) : search;
  return query === '' ? [] : query.split('&');
}

function entryKey(entry: string): string | null {
  const at = entry.indexOf('=');
  return decoded(at < 0 ? entry : entry.slice(0, at));
}

function entryValue(entry: string): string | null {
  const at = entry.indexOf('=');
  return at < 0 ? '' : decoded(entry.slice(at + 1));
}

/** The step a search string names: 0 to `total - 1` for a question, `total` for the review. */
export function parseQuizPlace(search: string, total: number): number {
  const entry = entries(search).find((part) => entryKey(part) === QUIZ_PLACE_PARAM);
  const value = entry === undefined ? null : entryValue(entry);
  if (value === null) return 0;
  if (value === REVIEW) return total;
  if (!POSITION.test(value)) return 0;
  const position = Number(value);
  return position <= total ? position - 1 : 0;
}

/** The parameter's value for `step`, or `null` for the first question, which carries none. */
export function formatQuizPlace(step: number, total: number): string | null {
  if (step <= 0) return null;
  if (step >= total) return REVIEW;
  return String(step + 1);
}

/**
 * `search` with the place set to `step`. Every other entry keeps its bytes and order; the first
 * `question` entry is replaced where it stood and any repeat is dropped.
 */
export function searchWithQuizPlace(search: string, step: number, total: number): string {
  const value = formatQuizPlace(step, total);
  const own = value === null ? null : `${QUIZ_PLACE_PARAM}=${value}`;
  const kept: string[] = [];
  let placed = false;
  for (const entry of entries(search)) {
    if (entryKey(entry) !== QUIZ_PLACE_PARAM) {
      kept.push(entry);
    } else if (!placed) {
      placed = true;
      if (own !== null) kept.push(own);
    }
  }
  if (!placed && own !== null) kept.push(own);
  return kept.length === 0 ? '' : `?${kept.join('&')}`;
}
