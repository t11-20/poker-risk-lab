/**
 * Stable React keys for lists with no identifier of their own. Index keys are banned
 * (`noArrayIndexKey`), so keys come from content plus an occurrence counter: `["ace#0", "ace#1"]`.
 */

export interface Keyed<T> {
  /** Unique within the returned array, and stable for a given input array. */
  readonly key: string;
  readonly value: T;
}

/** `prefix` namespaces the keys, so two calls in one component cannot collide. */
export function withKeys<T>(items: readonly T[], prefix: string): Keyed<T>[] {
  const seen = new Map<string, number>();
  const out: Keyed<T>[] = [];
  for (const value of items) {
    // Primitives only. Objects collapse to "[object Object]", which is index keys again.
    const base = `${prefix}:${String(value)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.push({ key: `${base}#${count}`, value });
  }
  return out;
}
