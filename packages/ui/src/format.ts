/**
 * Number-to-text formatting for every figure the UI shows.
 *
 * These are the only pure functions in this package, and they carry more weight
 * than their size suggests: every number a learner reads passes through here, so
 * a wrong or unstable rendering is a teaching error, not a cosmetic one.
 *
 * ## Why this hand-rolls grouping instead of using `Intl.NumberFormat`
 *
 * Two reasons, both learned the hard way in server-rendered React:
 *
 *  1. `Intl.NumberFormat()` with no explicit locale reads the *host* default.
 *     Next.js renders these strings twice — once in Node, once in the browser —
 *     and those two hosts routinely disagree (`1,250` vs `1 250` vs `1.250`).
 *     The result is a hydration mismatch that only reproduces on some machines.
 *  2. Even with a pinned locale, ICU output drifts between Node versions
 *     (grouping of 4-digit numbers, the shape of the minus sign). Tests that
 *     assert on it become version-dependent.
 *
 * So the output here is fixed, ASCII-grouped and identical everywhere. The app is
 * English-only by design; if it is ever localised, that becomes a deliberate piece
 * of work rather than an accident of the host's environment.
 *
 * ## Why plain ASCII `+` and `-` for signs
 *
 * A signed figure is one of the places the accessibility rules bite: win/loss must
 * never be conveyed by colour alone, so the sign has to be *in the text*. ASCII
 * `+`/`-` are announced predictably by screen readers, unlike U+2212 MINUS SIGN,
 * which several announce as nothing at all. Components pair the sign with a word
 * ("gain", "loss") where the distinction carries meaning.
 *
 * ## Conventions the engine and math packages already fixed
 *
 *  - Equities and probabilities are **fractions in 0..1**. `formatPercent` multiplies.
 *    That includes `EquitySummary.ruleOfThumb.estimate`, which is a probability like
 *    any other on that contract. It has not always been: `@prl/poker-math` used to
 *    publish it in percentage POINTS while `CoachPanel` rendered it with
 *    `formatPercent`, so a nine-out flush draw reached a learner as **"3,600.0%"** and
 *    a flopped set as "18,000.0%". The producer is the side that changed, because one
 *    contract with two units for the same kind of number is the defect — the second
 *    multiplication was only where it became visible.
 *  - Anything already scaled says so in its NAME and goes through `formatPoints`
 *    instead: `errorPoints`, `halfWidthPoints`. A field whose name carries no unit is
 *    a fraction.
 *  - Chips are integers in the engine, but EV is not, so anything that can hold an
 *    EV takes a decimal count.
 *
 * Nothing here clamps. If an equity arrives as 1.03 the UI shows `103.0%`, because
 * hiding an impossible number hides the bug that produced it — and a formatter that
 * quietly rescued 36 into "36.0%" would have hidden the unit mismatch above for good.
 * Impossible probabilities are kept out at the producer, where they can be refused
 * with a reason, rather than rounded off here where they cannot.
 */

/**
 * Rendered in place of a figure that does not exist. An em dash on its own is
 * ambiguous to a screen reader, so every component that can render this pairs it
 * with real text (see `StatTile`, which supplies an `aria-label`).
 */
export const NOT_AVAILABLE = '—';

/** Raised for arguments that are not numbers at all, which is a caller bug. */
export class FormatError extends Error {
  override readonly name = 'FormatError';
}

/**
 * Inserts thousands separators into a run of digits.
 *
 * Written with `slice` rather than indexed access because `noUncheckedIndexedAccess`
 * makes every `s[i]` a `string | undefined`, and a regex lookahead
 * (`/\B(?=(\d{3})+(?!\d))/g`) is the other common approach but is quietly
 * catastrophic on very long inputs. This loop is O(digits) and obvious.
 */
function groupThousands(digits: string): string {
  const groups: string[] = [];
  let remaining = digits;
  while (remaining.length > 3) {
    groups.unshift(remaining.slice(-3));
    remaining = remaining.slice(0, -3);
  }
  groups.unshift(remaining);
  return groups.join(',');
}

/**
 * `toFixed` plus thousands grouping, with negative zero normalised away.
 *
 * `(-0.4).toFixed(0)` is `"-0"`, and a stack shown as `-0 units` looks like a bug
 * to a learner even though the arithmetic is fine. Anything that rounds to exactly
 * zero loses its sign here.
 */
function formatFixed(value: number, decimals: number): string {
  const rounded = value.toFixed(decimals);
  const unsigned = rounded.startsWith('-') ? rounded.slice(1) : rounded;
  const isNegative = rounded.startsWith('-') && Number(rounded) !== 0;
  const dot = unsigned.indexOf('.');
  const whole = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fraction = dot === -1 ? '' : unsigned.slice(dot);
  return `${isNegative ? '-' : ''}${groupThousands(whole)}${fraction}`;
}

/** Drops a trailing `.00` / `.50` → `.5`, so counts read naturally. */
function trimTrailingZeros(text: string): string {
  if (!text.includes('.')) return text;
  return text.replace(/\.?0+$/, '');
}

function assertNumber(value: number, what: string): void {
  if (typeof value !== 'number') throw new FormatError(`${what} must be a number`);
}

/** True for a value that can actually be rendered as a figure. */
function isRenderable(value: number): boolean {
  return Number.isFinite(value);
}

// ---------------------------------------------------------------------------
// Percentages
// ---------------------------------------------------------------------------

export interface PercentOptions {
  /** Decimal places. One is the default: equity is not precise to two. */
  readonly decimals?: number;
  /** Force a leading `+` on positive values. For surpluses and differences. */
  readonly signed?: boolean;
}

/**
 * A fraction in 0..1 as a percentage: `0.6237` → `"62.4%"`.
 *
 * Hand it a value that is already in percentage points and it renders a hundred times
 * too large, silently, because both are `number` and both are plausible. That is not a
 * hypothetical: it is what put "3,600.0%" on a shipped Coach panel. If a figure needs
 * this function, it is a fraction; if it needs `formatPoints`, its name ends in
 * `Points`. There is no third case.
 *
 * @param fraction pot share / probability, NOT an already-multiplied percentage
 */
export function formatPercent(fraction: number, options: PercentOptions = {}): string {
  assertNumber(fraction, 'fraction');
  if (!isRenderable(fraction)) return NOT_AVAILABLE;
  const decimals = options.decimals ?? 1;
  const body = formatFixed(fraction * 100, decimals);
  const sign = options.signed === true && !body.startsWith('-') && Number(body.replace(/,/g, '')) !== 0;
  return `${sign ? '+' : ''}${body}%`;
}

/**
 * A difference between two percentages, in percentage points.
 *
 * "Points" and "percent" are different units and conflating them is one of the
 * most common ways to misread a confidence interval, so the word is spelled out
 * rather than abbreviated to `pp`.
 */
export function formatPoints(points: number, options: PercentOptions = {}): string {
  assertNumber(points, 'points');
  if (!isRenderable(points)) return NOT_AVAILABLE;
  const decimals = options.decimals ?? 1;
  const body = formatFixed(points, decimals);
  const sign = options.signed === true && !body.startsWith('-') && Number(body.replace(/,/g, '')) !== 0;
  const magnitude = Math.abs(Number(body.replace(/,/g, '')));
  return `${sign ? '+' : ''}${body} ${magnitude === 1 ? 'point' : 'points'}`;
}

// ---------------------------------------------------------------------------
// Chips and units
// ---------------------------------------------------------------------------

export interface UnitsOptions {
  /** Decimal places. Zero by default — table amounts are whole chips. */
  readonly decimals?: number;
}

/**
 * A table amount with no unit word: `1250` → `"1,250"`.
 *
 * Used where the word "units" already appears in a nearby label (a stack column,
 * a pot readout) and repeating it on every row would be noise. Anywhere the
 * amount stands alone, use `formatUnits` so the word is present — the product
 * guardrails require "units" to be visible, never a bare number that could read
 * as currency.
 */
export function formatChips(chips: number, options: UnitsOptions = {}): string {
  assertNumber(chips, 'chips');
  if (!isRenderable(chips)) return NOT_AVAILABLE;
  return formatFixed(chips, options.decimals ?? 0);
}

/** A table amount with its unit word: `1250` → `"1,250 units"`, `1` → `"1 unit"`. */
export function formatUnits(units: number, options: UnitsOptions = {}): string {
  assertNumber(units, 'units');
  if (!isRenderable(units)) return NOT_AVAILABLE;
  const decimals = options.decimals ?? 0;
  const body = formatFixed(units, decimals);
  const isOne = Math.abs(Number(body.replace(/,/g, ''))) === 1;
  return `${body} ${isOne ? 'unit' : 'units'}`;
}

/**
 * A change in units, with an explicit sign: `120` → `"+120 units"`.
 *
 * Zero is rendered unsigned (`"0 units"`): `"+0"` invites the reading that
 * something was won. The sign is the *only* thing distinguishing a gain from a
 * loss in the string, which is deliberate — it means a component can render this
 * with no colour at all and still be understood.
 */
export function formatSignedUnits(delta: number, options: UnitsOptions = {}): string {
  assertNumber(delta, 'delta');
  if (!isRenderable(delta)) return NOT_AVAILABLE;
  const decimals = options.decimals ?? 0;
  const body = formatFixed(delta, decimals);
  const numeric = Number(body.replace(/,/g, ''));
  const isOne = Math.abs(numeric) === 1;
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${body} ${isOne ? 'unit' : 'units'}`;
}

// ---------------------------------------------------------------------------
// Odds
// ---------------------------------------------------------------------------

/**
 * A pot-odds ratio as words: `3.5` → `"3.5 to 1"`, `null` → `"no cost to continue"`.
 *
 * Words rather than `3.5:1` because a colon is announced inconsistently — some
 * screen readers say "three point five colon one", some say nothing at all.
 *
 * The ratio is `pot / toCall`, so a free continuation has no "X to 1" form at all.
 * `@prl/poker-math` and `@prl/contracts` report that as `null` — the one value JSON
 * can carry for it, and the reason this parameter is nullable — and it is a real
 * situation rather than an error, so it gets a sentence instead of a number. It used
 * to arrive as `Infinity`, which `JSON.stringify` turns into `null` on the way to the
 * browser; that mismatch is fixed at the source and `Infinity` is no longer a value
 * this function is expected to see. If one turns up it is a live division by zero
 * somewhere, which is a bug rather than a free call, so it renders as not-available
 * rather than being dressed up as one.
 */
export function formatOdds(ratio: number | null, options: { readonly decimals?: number } = {}): string {
  if (ratio === null) return 'no cost to continue';
  assertNumber(ratio, 'ratio');
  if (Number.isNaN(ratio)) return NOT_AVAILABLE;
  if (!isRenderable(ratio) || ratio < 0) return NOT_AVAILABLE;
  return `${trimTrailingZeros(formatFixed(ratio, options.decimals ?? 1))} to 1`;
}

// ---------------------------------------------------------------------------
// Uncertainty
// ---------------------------------------------------------------------------

export interface ConfidenceIntervalOptions {
  /** Interval level as a fraction. `@prl/poker-math` always reports 0.95. */
  readonly level?: number;
  readonly decimals?: number;
}

/**
 * A sampled figure with its error bar: `"62.4% ± 0.8 points (95% interval)"`.
 *
 * `halfWidthPoints === null` means the caller has no interval to show. It does NOT
 * mean the figure is exact, so this never says "exact" — it says the interval is
 * missing, and lets the panel above it explain why. That distinction is the whole
 * reason this function exists rather than string concatenation at each call site:
 * a Monte Carlo number rendered without its interval is the single most misleading
 * thing this UI could do.
 */
export function formatConfidenceInterval(
  fraction: number,
  halfWidthPoints: number | null,
  options: ConfidenceIntervalOptions = {},
): string {
  assertNumber(fraction, 'fraction');
  const decimals = options.decimals ?? 1;
  const centre = formatPercent(fraction, { decimals });
  if (halfWidthPoints === null) return `${centre} (no interval reported)`;
  assertNumber(halfWidthPoints, 'halfWidthPoints');
  if (!isRenderable(halfWidthPoints)) return `${centre} (no interval reported)`;
  const level = options.level ?? 0.95;
  const levelText = isRenderable(level) ? `${trimTrailingZeros(formatFixed(level * 100, 1))}%` : '';
  const spread = formatPoints(Math.abs(halfWidthPoints), { decimals });
  return levelText === '' ? `${centre} ± ${spread}` : `${centre} ± ${spread} (${levelText} interval)`;
}

// ---------------------------------------------------------------------------
// Stack-to-pot ratio
// ---------------------------------------------------------------------------

export const SPR_BANDS = ['unknown', 'committed', 'low', 'medium', 'high', 'deep'] as const;
export type SprBand = (typeof SPR_BANDS)[number];

export interface SprDescription {
  readonly band: SprBand;
  readonly value: number;
  /** Short label for a stat tile: `"2.4 — low"`. */
  readonly label: string;
  /** One sentence on what the band means. Descriptive, never prescriptive. */
  readonly meaning: string;
}

/**
 * Classifies a stack-to-pot ratio into a band with a plain-language meaning.
 *
 * Returns a structure rather than a string because the band is also a styling
 * hook (`data-band`), and re-deriving it from the label in the component would be
 * a second definition of the same thresholds.
 *
 * The thresholds are this app's own convention, stated as a convention. There is
 * no universally agreed SPR taxonomy, so every sentence below describes *how much
 * room is left* and none of them tells the reader what to do — claiming otherwise
 * would breach the "never claim universal optimality" guardrail.
 */
export function describeSpr(spr: number): SprDescription {
  assertNumber(spr, 'spr');
  if (!isRenderable(spr) || spr < 0) {
    return {
      band: 'unknown',
      value: spr,
      label: 'not defined',
      meaning:
        'SPR is the effective stack divided by the pot, so it has no value until there are chips in the middle.',
    };
  }
  const shown = trimTrailingZeros(formatFixed(spr, 1));
  if (spr < 1) {
    return {
      band: 'committed',
      value: spr,
      label: `${shown} — committed`,
      meaning:
        'Below 1 the pot is already larger than the stack behind it, so any bet is effectively a decision about the whole stack.',
    };
  }
  if (spr < 4) {
    return {
      band: 'low',
      value: spr,
      label: `${shown} — low`,
      meaning:
        'Between 1 and 4 a bet and a raise puts the stacks in, so the commitment decision usually arrives on this street.',
    };
  }
  if (spr < 8) {
    return {
      band: 'medium',
      value: spr,
      label: `${shown} — medium`,
      meaning: 'Between 4 and 8 there is room for roughly two streets of betting before the stacks are in.',
    };
  }
  if (spr < 15) {
    return {
      band: 'high',
      value: spr,
      label: `${shown} — high`,
      meaning:
        'Between 8 and 15 several streets of choices remain, so position and implied odds carry more of the decision.',
    };
  }
  return {
    band: 'deep',
    value: spr,
    label: `${shown} — deep`,
    meaning:
      'At 15 and above the stacks are deep relative to the pot, so most of the money is still decided on later streets.',
  };
}

// ---------------------------------------------------------------------------
// Indices
// ---------------------------------------------------------------------------

/** Two digits: `01`, `02`, … The design system's numbered-system motif is fixed-width. */
const INDEX_DIGITS = 2;

/**
 * A position as a zero-padded index: `1` → `"01"`.
 *
 * The numbering motif appears in several places — panel headers, the process spine, hand
 * phases, lesson steps, assumption rows, radar axes — and it only reads as a *system* when
 * every one of them pads to the same width. Hence one function rather than a `padStart` at
 * each call site, each with its own idea of how wide.
 *
 * Positions are 1-based, because these are read as ordinals by a human. A fractional value
 * truncates towards zero. A negative index keeps its sign (`-1` → `"-01"`) rather than being
 * silently flipped: an index below one is a caller bug, and hiding it would hide the bug.
 */
export function formatIndex(position: number, options: { readonly digits?: number } = {}): string {
  assertNumber(position, 'position');
  if (!isRenderable(position)) return NOT_AVAILABLE;
  const digits = options.digits ?? INDEX_DIGITS;
  const whole = Math.trunc(position);
  const sign = whole < 0 ? '-' : '';
  return `${sign}${String(Math.abs(whole)).padStart(digits, '0')}`;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/**
 * A count with the right form of its noun: `pluralise(1, 'out')` → `"1 out"`.
 *
 * English pluralisation is not solvable in a helper, and pretending otherwise
 * produces "2 flushs". So the rule here is deliberately dumb — append `s` — and
 * every irregular case passes an explicit plural. `pluralise(3, 'penny', 'pence')`.
 *
 * The magnitude decides the form, so `-1` takes the singular ("-1 unit"), which is
 * what English does.
 */
export function pluralise(count: number, singular: string, plural?: string): string {
  assertNumber(count, 'count');
  if (typeof singular !== 'string' || singular === '') {
    throw new FormatError('pluralise needs a non-empty singular noun');
  }
  const many = plural ?? `${singular}s`;
  if (!isRenderable(count)) return `${NOT_AVAILABLE} ${many}`;
  const word = Math.abs(count) === 1 ? singular : many;
  const body = Number.isInteger(count) ? formatFixed(count, 0) : trimTrailingZeros(formatFixed(count, 2));
  return `${body} ${word}`;
}
