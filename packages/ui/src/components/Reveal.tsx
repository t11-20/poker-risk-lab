'use client';

/**
 * `useReveal` wrapped in a `<div>`. Use the hook directly where an extra `<div>` would be invalid.
 * The stylesheet must hide only `[data-revealed='false']`, so content is visible by default. The expiry
 * animation in `components.css` is bound to that selector, so anything still hidden after
 * `--prl-dur-count` resolves itself. Never nest reveals, because an inner one may never intersect.
 * Never use it for anything a reader needs in order to act (§5.1).
 */

import type { ReactElement, ReactNode } from 'react';
import { cx, type StyleWithVars } from '../cx.ts';
import { useReveal } from '../motion/useReveal.ts';

export interface RevealProps {
  readonly children: ReactNode;
  /** Fraction of the element that must be in view. Defaults to a fifth. */
  readonly threshold?: number;
  readonly stagger?: number;
  readonly className?: string;
}

export function Reveal(props: RevealProps): ReactElement {
  const { children, threshold, stagger, className } = props;
  const { ref, revealed } = useReveal<HTMLDivElement>(threshold === undefined ? {} : { threshold });
  const style: StyleWithVars | undefined =
    stagger === undefined ? undefined : { '--prl-reveal-index': stagger };

  return (
    <div
      ref={ref}
      className={cx('prl-reveal', className)}
      data-revealed={revealed ? 'true' : 'false'}
      style={style}
    >
      {children}
    </div>
  );
}
