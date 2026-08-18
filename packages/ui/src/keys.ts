/**
 * Stable React keys for lists that carry no identifier of their own.
 *
 * Most of what this package renders is arrays of primitives that the server built:
 * assumption sentences, limitation sentences, card integers, teaching notes. None
 * of them has an id, and several of them can legitimately repeat — two seats can
 * hold the same *displayed* value, a formatted figure can appear twice, and a
 * face-down card row is the same placeholder N times over.
 *
 * `key={index}` is the obvious answer and it is banned here (Biome's
 * `noArrayIndexKey`), for a good reason: when a list is reordered or spliced,
 * index keys make React reuse the wrong DOM node, which in this UI would mean a
 * card animating into the wrong slot or an input keeping a value from a different
 * row.
 *
 * So keys are derived from the *content*, with an occurrence counter appended so
 * duplicates stay distinct: `["ace", "ace"]` becomes `["ace#0", "ace#1"]`. Two
 * identical values in the same position across renders therefore get the same key,
 * which is exactly the reconciliation behaviour wanted.
 *
 * This lives in a `.ts` file rather than inline in each component so the index
 * arithmetic is in one place, away from JSX, and so it is unit-testable — JSX
 * cannot be run under `node:test` in this repo, but this can.
 */

export interface Keyed<T> {
  /** Unique within the returned array, and stable for a given input array. */
  readonly key: string;
  readonly value: T;
}

/**
 * Pairs each item with a content-derived key.
 *
 * @param items the list to render
 * @param prefix namespaces the keys, so two `withKeys` calls in one component
 *   cannot collide if they happen to contain the same strings
 */
export function withKeys<T>(items: readonly T[], prefix: string): Keyed<T>[] {
  const seen = new Map<string, number>();
  const out: Keyed<T>[] = [];
  for (const value of items) {
    // `String(value)` is right for the primitives this is used with. Objects would
    // all collapse to "[object Object]" and then be distinguished only by the
    // occurrence counter — i.e. index keys again — so callers with objects should
    // key on a field of their own instead.
    const base = `${prefix}:${String(value)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.push({ key: `${base}#${count}`, value });
  }
  return out;
}
