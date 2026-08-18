'use client';

/**
 * Wraps content that should arrive as the reader scrolls to it.
 *
 * This is `useReveal` with a `<div>` around it — nothing more. It exists so the common case
 * needs no hook wiring, and the hook stays exported for the cases this cannot serve: a
 * revealed `<li>` inside a `<ul>`, or a revealed `<section>` that owns its own heading, where
 * an extra `<div>` would be invalid or would break a grid.
 *
 * ## The division of labour with the stylesheet
 *
 * This component publishes state and nothing else: `data-revealed="true" | "false"`. The
 * stylesheet owns the appearance, and it must express the *hidden* state as
 * `[data-revealed='false']` rather than styling `.prl-reveal` bare — a rule with a real
 * consequence, since it means content is visible by default and only ever hidden by a class
 * that is actively tracking a live observer.
 *
 * That selector is also what makes the stylesheet's DEADLINE safe. `components.css` attaches an
 * expiry animation to the same `[data-revealed='false']` rule, so any element still hidden after
 * `--prl-dur-count` resolves itself whether or not this component ever runs again; and because the
 * animation is bound to the hidden selector, flipping the attribute removes it along with the
 * hidden state, leaving the transition free to run. Read the comment there before changing either.
 *
 * ## Do not nest one of these inside another
 *
 * A reveal inside a hidden reveal is unreachable: the outer element resolves on its own schedule
 * and the inner one is measured against a viewport it may never intersect. Every call site was
 * checked when this note was written and none nest — the three home-page reveals that share a
 * `top` are the three module cards in one row, which is a grid, not a nesting. Keep it that way:
 * a section either reveals as a whole or its children do, never both.
 *
 * Only `transform` and `opacity` may be animated here (§5.4). No height, no blur, no
 * `getBoundingClientRect`, no scroll listener.
 *
 * ## Staggering
 *
 * `stagger` sets `--prl-reveal-index` as a unitless number, for CSS to multiply by a duration
 * token: `transition-delay: calc(var(--prl-reveal-index, 0) * var(--prl-dur-deal-stagger))`.
 * The delay therefore lives in the token system rather than as a literal in a component, and
 * it collapses to nothing under reduced motion along with every other duration.
 *
 * ## What this must never be used for
 *
 * Anything a reader needs in order to *act*. A reveal answers "is this new information?"
 * (§5.1); an action bar, a price, or a Coach figure during a decision is not new information,
 * it is the thing being decided, and it is present from the first paint.
 */

import type { ReactElement, ReactNode } from 'react';
import { cx, type StyleWithVars } from '../cx.ts';
import { useReveal } from '../motion/useReveal.ts';

export interface RevealProps {
  readonly children: ReactNode;
  /** Fraction of the element that must be in view. Defaults to a fifth. */
  readonly threshold?: number;
  /** Position in a staggered group, starting at 0. */
  readonly stagger?: number;
  readonly className?: string;
}

export function Reveal(props: RevealProps): ReactElement {
  const { children, threshold, stagger, className } = props;
  // `exactOptionalPropertyTypes` rejects `{ threshold: undefined }`, so the options object is
  // built rather than spread with a possibly-absent value.
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
