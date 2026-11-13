import type { CSSProperties } from 'react';

/** Drops falsy parts and `''`, so an element with no classes emits no `class=""`. */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  const kept: string[] = [];
  for (const part of parts) {
    if (typeof part === 'string' && part !== '') kept.push(part);
  }
  return kept.join(' ');
}

/**
 * A `style` that may carry custom properties, which `csstype` rejects. A real type, not a banned
 * cast, and it still catches typos in ordinary properties.
 */
export type StyleWithVars = CSSProperties & Record<`--${string}`, string | number>;
