/**
 * Which "On this page" entry is current. Pure, so `node --test` checks it without a DOM (ADR 0008).
 *
 * The active heading is the last one whose top has passed the line under the header band, because
 * "topmost visible" reads ahead and "nearest the middle" flickers.
 */

/** `tops` are fresh `getBoundingClientRect().top` reads, in document order; `null` for a missing heading. */
export function activeHeading(
  ids: readonly string[],
  tops: readonly (number | null)[],
  line: number,
): string | null {
  let active = ids[0] ?? null;
  ids.forEach((id, index) => {
    const top = tops[index];
    if (top !== null && top !== undefined && top <= line) active = id;
  });
  return active;
}

/**
 * A root of everything above `line`, so a heading's intersection flips exactly when its top crosses
 * the line, in either direction and even across a jump. Observing the viewport only fired on entering
 * or leaving it, so scrolling up left the previous section current for about a screen.
 */
export function aboveLineRootMargin(viewportHeight: number, documentHeight: number, line: number): string {
  const above = Math.ceil(Math.max(documentHeight, viewportHeight));
  const below = Math.max(0, Math.floor(viewportHeight - line));
  return `${String(above)}px 0px ${String(-below)}px 0px`;
}
