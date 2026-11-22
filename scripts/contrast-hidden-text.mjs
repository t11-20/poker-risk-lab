/**
 * Whether a box paints none of its text: the visually hidden idiom, and its other spellings. Runs in the
 * page, stringified into `check-contrast.mjs`, so it reads only its arguments: a computed style and the
 * box's border rect. A false `true` is the unsafe direction, because the gate then skips visible text.
 */
export function hidesItsText(style, box) {
  const inset = /^inset\(([^)]*)\)/u.exec(style.clipPath ?? '');
  if (inset !== null) {
    const lengths = inset[1]
      .split(/\s+round\s+/u)[0]
      .trim()
      .split(/\s+/u);
    const [top, right = top, bottom = top, left = right] = lengths;
    const share = (value, extent) => {
      const number = Number.parseFloat(value);
      if (Number.isNaN(number)) return 0;
      if (value.endsWith('%')) return number / 100;
      return extent > 0 ? number / extent : 1;
    };
    if (share(top, box.height) + share(bottom, box.height) >= 1) return true;
    if (share(left, box.width) + share(right, box.width) >= 1) return true;
  }
  // `clip` applies only to an absolutely positioned box; on any other it is ignored.
  const positioned = style.position === 'absolute' || style.position === 'fixed';
  if (positioned && style.clip === 'rect(0px, 0px, 0px, 0px)') return true;
  // `overflow` does not clip an inline box or one with no box at all.
  if (style.display === 'contents' || style.display === 'inline') return false;
  return box.width <= 2 && box.height <= 2 && style.overflow === 'hidden';
}
