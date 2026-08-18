/**
 * Class-name joining, and the type that lets a component set a CSS custom property.
 *
 * Both are three lines and both exist to stop the same three lines being written
 * eleven times with a slightly different edge case each time.
 */

import type { CSSProperties } from 'react';

/**
 * Joins class names, dropping anything falsy.
 *
 * Accepts `false`/`null`/`undefined` so callers can write
 * `cx('prl-card', faceDown && 'prl-card--face-down')` without a ternary. The empty
 * string is dropped too, which matters because `className={cx(...)}` on an element
 * with no classes should not emit `class=""`.
 */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  const kept: string[] = [];
  for (const part of parts) {
    if (typeof part === 'string' && part !== '') kept.push(part);
  }
  return kept.join(' ');
}

/**
 * A `style` object that may also carry CSS custom properties.
 *
 * React's `CSSProperties` comes from `csstype`, which lists only known properties, so
 * `style={{ '--prl-seat-x': '50%' }}` is a type error even though it works perfectly
 * at runtime. The usual workarounds are `as any` (banned here) or
 * `as unknown as CSSProperties` (also banned). Intersecting with an index signature
 * over `--${string}` keys is neither: it is a real type, it still rejects typos in
 * ordinary property names, and the result stays assignable to `CSSProperties`.
 *
 * Custom properties are how this package does dynamic geometry — a seat's place on
 * the ellipse, a bar segment's share. Values are computed from props only, so they
 * are identical on the server and in the browser and cannot cause a hydration
 * mismatch.
 */
export type StyleWithVars = CSSProperties & Record<`--${string}`, string | number>;
