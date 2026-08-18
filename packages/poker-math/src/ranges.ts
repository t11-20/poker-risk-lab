/**
 * Starting-hand classes and range notation.
 *
 * There are 1326 distinct two-card combinations but only 169 strategically
 * distinct *classes*, because suits are interchangeable before a board exists:
 * 13 pairs, 78 suited classes and 78 offsuit classes.
 *
 * ## Notation supported
 *
 *   AA            a specific pair
 *   TT+           that pair and every higher pair
 *   22-77         an inclusive span of pairs
 *   AKs / AKo     a specific suited or offsuit class
 *   AK            both AKs and AKo
 *   A2s+          fixed high card, lower card increasing: A2s..AKs
 *   A5o+          same, offsuit
 *   random / 100% every hand
 *
 * `A2s+` uses the **fixed-high-card** convention: the first card stays, the second
 * climbs. Some writers use `T9s+` to mean "T9s and every higher suited connector",
 * which under the same syntax would mean something different. Rather than guess,
 * this parser implements only the fixed-high-card reading and *rejects* a `+` on a
 * class where the two readings disagree, telling the caller to list the hands
 * explicitly. Silently picking one meaning would make every range built on it
 * quietly wrong.
 */

import {
  type Card,
  makeCard,
  NUM_RANKS,
  NUM_SUITS,
  RANKS,
  rankIndexOf,
  suitIndexOf,
} from '@prl/poker-engine';

export class RangeParseError extends Error {
  override readonly name = 'RangeParseError';
}

/** A concrete two-card holding. Always stored with the higher card first. */
export type Combo = readonly [Card, Card];

export type ClassShape = 'pair' | 'suited' | 'offsuit';

/** One of the 169 strategically distinct starting-hand classes. */
export interface HandClass {
  /** Higher rank index. */
  readonly high: number;
  /** Lower rank index. For a pair, equal to `high`. */
  readonly low: number;
  readonly shape: ClassShape;
  /** Canonical label, e.g. "AA", "AKs", "T9o". */
  readonly label: string;
  /** 6 for a pair, 4 suited, 12 offsuit. */
  readonly comboCount: number;
}

function rankChar(rank: number): string {
  const ch = RANKS[rank];
  if (ch === undefined) throw new RangeParseError(`rank index out of range: ${rank}`);
  return ch;
}

const RANK_FROM_CHAR = new Map<string, number>();
for (const [index, ch] of RANKS.entries()) {
  RANK_FROM_CHAR.set(ch, index);
  RANK_FROM_CHAR.set(ch.toLowerCase(), index);
}

export function makeHandClass(high: number, low: number, shape: ClassShape): HandClass {
  if (high < low) throw new RangeParseError(`high rank ${high} must not be below low rank ${low}`);
  if (shape === 'pair' && high !== low) throw new RangeParseError('a pair class must have equal ranks');
  if (shape !== 'pair' && high === low)
    throw new RangeParseError('a non-pair class must have different ranks');
  const label =
    shape === 'pair'
      ? `${rankChar(high)}${rankChar(low)}`
      : `${rankChar(high)}${rankChar(low)}${shape === 'suited' ? 's' : 'o'}`;
  const comboCount = shape === 'pair' ? 6 : shape === 'suited' ? 4 : 12;
  return { high, low, shape, label, comboCount };
}

/** All 169 classes, strongest-label-first ordering not implied. */
export function allHandClasses(): HandClass[] {
  const out: HandClass[] = [];
  for (let high = NUM_RANKS - 1; high >= 0; high--) {
    out.push(makeHandClass(high, high, 'pair'));
    for (let low = high - 1; low >= 0; low--) {
      out.push(makeHandClass(high, low, 'suited'));
      out.push(makeHandClass(high, low, 'offsuit'));
    }
  }
  return out;
}

/** The concrete combinations that make up a class. */
export function combosOfClass(handClass: HandClass): Combo[] {
  const out: Combo[] = [];
  if (handClass.shape === 'pair') {
    for (let a = 0; a < NUM_SUITS; a++) {
      for (let b = a + 1; b < NUM_SUITS; b++) {
        out.push([makeCard(handClass.high, a), makeCard(handClass.high, b)] as const);
      }
    }
    return out;
  }
  if (handClass.shape === 'suited') {
    for (let suit = 0; suit < NUM_SUITS; suit++) {
      out.push([makeCard(handClass.high, suit), makeCard(handClass.low, suit)] as const);
    }
    return out;
  }
  for (let highSuit = 0; highSuit < NUM_SUITS; highSuit++) {
    for (let lowSuit = 0; lowSuit < NUM_SUITS; lowSuit++) {
      if (highSuit === lowSuit) continue;
      out.push([makeCard(handClass.high, highSuit), makeCard(handClass.low, lowSuit)] as const);
    }
  }
  return out;
}

/** The class a concrete combination belongs to. */
export function classOfCombo(combo: Combo): HandClass {
  const [first, second] = combo;
  const highRank = Math.max(rankIndexOf(first), rankIndexOf(second));
  const lowRank = Math.min(rankIndexOf(first), rankIndexOf(second));
  if (highRank === lowRank) return makeHandClass(highRank, lowRank, 'pair');
  const suited = suitIndexOf(first) === suitIndexOf(second);
  return makeHandClass(highRank, lowRank, suited ? 'suited' : 'offsuit');
}

export function comboToString(combo: Combo): string {
  const [a, b] = combo;
  const order = rankIndexOf(a) >= rankIndexOf(b) ? [a, b] : [b, a];
  return order
    .map((card) => `${rankChar(rankIndexOf(card))}${['c', 'd', 'h', 's'][suitIndexOf(card)] ?? '?'}`)
    .join('');
}

/**
 * A parsed range: a set of classes, and the concrete combinations they expand to.
 *
 * `weight` is deliberately absent. Weighted ranges ("call 60% of the time with
 * this") are a real concept, but presenting one to a learner without also
 * presenting the solver assumptions behind the weights would overstate how much is
 * known. Ranges here are unweighted sets, and the Coach says so.
 */
export interface ParsedRange {
  readonly notation: string;
  readonly classes: readonly HandClass[];
  readonly combos: readonly Combo[];
  /** Fraction of all 1326 combinations, 0..1. */
  readonly fractionOfAllHands: number;
}

const TOTAL_COMBOS = 1326;

function parseRankPair(text: string): { high: number; low: number } {
  const first = text[0];
  const second = text[1];
  if (first === undefined || second === undefined) throw new RangeParseError(`"${text}" is not two ranks`);
  const a = RANK_FROM_CHAR.get(first);
  const b = RANK_FROM_CHAR.get(second);
  if (a === undefined) throw new RangeParseError(`unknown rank "${first}" in "${text}"`);
  if (b === undefined) throw new RangeParseError(`unknown rank "${second}" in "${text}"`);
  return { high: Math.max(a, b), low: Math.min(a, b) };
}

/** The shape letter on a 3-character side of a span, or `undefined` for "A2"-style. */
function spanShapeChar(side: string): string | undefined {
  return side.length === 3 ? side[2]?.toLowerCase() : undefined;
}

/**
 * A span: "22-77" (pairs) or "A2s-A5s" (fixed high card, low card sweeping).
 *
 * Both sides are read before either is judged, so a span that is wrong in two ways
 * reports the wrong thing first rather than whichever check happens to be written
 * first: mixed shapes, then a moving high card, then a missing shape letter.
 *
 * The ends may arrive in either order — "77-22" and "22-77" are the same span — so the
 * bounds are taken with min/max rather than assuming the lower end comes first.
 */
function parseSpanToken(token: string): HandClass[] {
  const [leftRaw, rightRaw] = token.split('-');
  if (leftRaw === undefined || rightRaw === undefined) {
    throw new RangeParseError(`malformed span "${token}"`);
  }
  const left = leftRaw.trim();
  const right = rightRaw.trim();
  const leftShapeChar = spanShapeChar(left);
  if (leftShapeChar !== spanShapeChar(right)) {
    throw new RangeParseError(`span "${token}" mixes suited and offsuit`);
  }
  const leftRanks = parseRankPair(left);
  const rightRanks = parseRankPair(right);

  if (leftRanks.high === leftRanks.low && rightRanks.high === rightRanks.low) {
    const from = Math.min(leftRanks.high, rightRanks.high);
    const to = Math.max(leftRanks.high, rightRanks.high);
    const out: HandClass[] = [];
    for (let rank = from; rank <= to; rank++) out.push(makeHandClass(rank, rank, 'pair'));
    return out;
  }
  if (leftRanks.high !== rightRanks.high) {
    throw new RangeParseError(
      `span "${token}" changes the high card; only spans with a fixed high card are supported ` +
        '(e.g. "A2s-A5s"), so list the hands explicitly instead',
    );
  }
  // Anything other than s or o is refused rather than read as suited. The shape used
  // to fall back to 'suited' whenever the letter was not an 'o', which quietly turned
  // a typo like "A2x-A5x" into a real suited range — a guess, and the one habit this
  // parser exists to avoid. The single-class branch below has always rejected it.
  if (leftShapeChar !== 's' && leftShapeChar !== 'o') {
    throw new RangeParseError(`span "${token}" must state s or o, e.g. "A2s-A5s"`);
  }
  const shape: ClassShape = leftShapeChar === 's' ? 'suited' : 'offsuit';
  const from = Math.min(leftRanks.low, rightRanks.low);
  const to = Math.max(leftRanks.low, rightRanks.low);
  const out: HandClass[] = [];
  for (let rank = from; rank <= to; rank++) out.push(makeHandClass(leftRanks.high, rank, shape));
  return out;
}

/**
 * Two ranks with no shape letter: "AA", "TT+", "AK".
 *
 * A pair takes a `+` ("and every higher pair"). An unpaired holding does not: "KQ+"
 * would have to mean both shapes climbing, and there is no reading of it that is
 * obviously right, so it is refused with the two spellings that are unambiguous.
 */
function parseRankOnlyToken(token: string, body: string, plus: boolean): HandClass[] {
  const { high, low } = parseRankPair(body);
  if (high === low) {
    if (!plus) return [makeHandClass(high, high, 'pair')];
    const out: HandClass[] = [];
    for (let rank = high; rank < NUM_RANKS; rank++) out.push(makeHandClass(rank, rank, 'pair'));
    return out;
  }
  if (plus) {
    throw new RangeParseError(`"${token}" is ambiguous: state a shape, e.g. "${body}s+" or "${body}o+"`);
  }
  return [makeHandClass(high, low, 'suited'), makeHandClass(high, low, 'offsuit')];
}

/** Two ranks and a shape letter: "AKs", "A2s+", "K5o". */
function parseShapedToken(token: string, body: string, plus: boolean): HandClass[] {
  const shapeChar = body[2]?.toLowerCase();
  if (shapeChar !== 's' && shapeChar !== 'o') {
    throw new RangeParseError(`"${token}" must end in s or o`);
  }
  const shape: ClassShape = shapeChar === 's' ? 'suited' : 'offsuit';
  const { high, low } = parseRankPair(body.slice(0, 2));
  if (high === low) throw new RangeParseError(`"${token}" is a pair, so it cannot be suited or offsuit`);
  if (!plus) return [makeHandClass(high, low, shape)];

  // The `+` ambiguity. "A2s+" is unambiguous because the ace is already the top
  // rank: the only way to climb is the second card. For a class whose high card
  // is NOT an ace, "T9s+" could mean T9s..TJs-style climbing of the low card, or
  // the connector reading (T9s, JTs, QJs, ...). Those differ, so reject it.
  if (high !== NUM_RANKS - 1 && low === high - 1) {
    throw new RangeParseError(
      `"${token}" is ambiguous: it could mean the low card climbing (${rankChar(high)}x${shapeChar}) ` +
        'or a run of connectors. List the hands explicitly.',
    );
  }
  const out: HandClass[] = [];
  for (let rank = low; rank < high; rank++) out.push(makeHandClass(high, rank, shape));
  return out;
}

/**
 * Expands one comma-separated token into classes.
 *
 * Four shapes of token, dispatched here and expanded in the three functions above.
 * Keeping the dispatch separate from the expansions is what stops this from becoming
 * one function nobody can follow: each branch of the notation is now readable, and
 * testable, on its own.
 */
function parseToken(rawToken: string): HandClass[] {
  const token = rawToken.trim();
  if (token === '') return [];

  const lower = token.toLowerCase();
  if (lower === 'random' || lower === '100%' || lower === 'any') return allHandClasses();

  if (token.includes('-')) return parseSpanToken(token);

  const plus = token.endsWith('+');
  const body = plus ? token.slice(0, -1).trim() : token;
  if (body.length === 2) return parseRankOnlyToken(token, body, plus);
  if (body.length === 3) return parseShapedToken(token, body, plus);

  throw new RangeParseError(`cannot parse range token "${token}"`);
}

/**
 * Parses a comma-separated range, e.g. `"AA-JJ, AKs, AQo+, 76s"`.
 *
 * `blockers` are cards known to be elsewhere (hero's hand, the board). Combinations
 * containing a blocker are removed, because an opponent cannot hold a card you can
 * see. Forgetting this is one of the most common range-arithmetic errors: it
 * inflates the opponent's number of strong combinations.
 */
export function parseRange(notation: string, blockers: readonly Card[] = []): ParsedRange {
  const classes: HandClass[] = [];
  const seenLabels = new Set<string>();
  for (const token of notation.split(',')) {
    for (const handClass of parseToken(token)) {
      if (seenLabels.has(handClass.label)) continue;
      seenLabels.add(handClass.label);
      classes.push(handClass);
    }
  }
  if (classes.length === 0) throw new RangeParseError(`range "${notation}" contains no hands`);

  const blocked = new Set(blockers);
  const combos: Combo[] = [];
  for (const handClass of classes) {
    for (const combo of combosOfClass(handClass)) {
      if (blocked.has(combo[0]) || blocked.has(combo[1])) continue;
      combos.push(combo);
    }
  }

  const totalUnblocked = classes.reduce((sum, handClass) => sum + handClass.comboCount, 0);
  return {
    notation,
    classes,
    combos,
    fractionOfAllHands: totalUnblocked / TOTAL_COMBOS,
  };
}

/** How many combinations a range holds before removing blockers. */
export function comboCountOf(range: ParsedRange): number {
  return range.classes.reduce((sum, handClass) => sum + handClass.comboCount, 0);
}

/** A single specific holding as a range, for hand-vs-hand analysis. */
export function exactRange(cards: readonly Card[]): ParsedRange {
  if (cards.length !== 2)
    throw new RangeParseError(`an exact range needs exactly 2 cards, got ${cards.length}`);
  const [a, b] = cards;
  if (a === undefined || b === undefined) throw new RangeParseError('exact range is missing a card');
  if (a === b) throw new RangeParseError('an exact range cannot hold the same card twice');
  const combo: Combo = rankIndexOf(a) >= rankIndexOf(b) ? [a, b] : [b, a];
  const handClass = classOfCombo(combo);
  return {
    notation: comboToString(combo),
    classes: [handClass],
    combos: [combo],
    fractionOfAllHands: 1 / TOTAL_COMBOS,
  };
}
