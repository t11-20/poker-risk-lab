'use client';

/**
 * The three-variant button: `primary`, `secondary`, `ghost`.
 *
 * ## What the variants mean, and why the default is `secondary`
 *
 *  - **primary** — accent fill with `--prl-text-on-accent` text and the signature chamfer on
 *    its top-right corner. Roughly **one per view**: an accent that appears on six buttons
 *    stops meaning "this matters". That is why it is not the default — a default primary is
 *    how a view ends up with six of them.
 *  - **secondary** — transparent with a meaningful hairline. The workhorse.
 *  - **ghost** — text only, for a tertiary action inside dense content.
 *
 * Text on an accent fill is `--prl-text-on-accent` (ink-900) and never white: white on
 * `accent-500` measures 2.07:1, a hard fail, against 9.39:1 for ink-900 (§2.4). That is a
 * stylesheet rule, but it is the reason this component has no "invert" or "light text" option
 * to get it wrong with.
 *
 * ## What this component deliberately does not do
 *
 *  - **No `href`.** A button that is really a link is a link, and the app's links go through
 *    `next/link`, which this package cannot import. Style one with the `.prl-btn` classes.
 *  - **No loading spinner.** The design system has no spinner: a data fetch draws skeleton
 *    blocks at the real content's dimensions (§8). A button that swaps its label for a spinner
 *    also changes its own width, which moves the thing under the reader's cursor.
 *  - **No icon-only mode.** Labels are words here (§12). Where space is genuinely tight, the
 *    caller passes a glyph plus a `.prl-visually-hidden` label and owns that decision.
 *
 * The 44×44 minimum target comes from `--prl-target-min` in the stylesheet, exceeding WCAG
 * 2.2's 24×24 floor because these actions are consequential and often taken one-handed.
 *
 * Every other button attribute — `disabled`, `onClick`, `aria-*`, `form` — passes straight
 * through, so this never becomes the reason a caller cannot reach a native feature. `type`
 * defaults to `button`: an unspecified `type` inside a form submits it, which is the most
 * common accidental-submit bug in React.
 */

import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import { cx } from '../cx.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

type NativeButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type' | 'children'>;

export interface ButtonProps extends NativeButtonProps {
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly type?: 'button' | 'submit' | 'reset';
  readonly className?: string;
}

const VARIANT_CLASS: Readonly<Record<ButtonVariant, string>> = {
  primary: 'prl-btn--primary',
  secondary: 'prl-btn--secondary',
  ghost: 'prl-btn--ghost',
};

const SIZE_CLASS: Readonly<Record<ButtonSize, string>> = {
  sm: 'prl-btn--sm',
  md: 'prl-btn--md',
  lg: 'prl-btn--lg',
};

export function Button(props: ButtonProps): ReactElement {
  const { children, variant = 'secondary', size = 'md', type = 'button', className, ...rest } = props;
  return (
    <button
      {...rest}
      type={type}
      className={cx('prl-btn', VARIANT_CLASS[variant], SIZE_CLASS[size], className)}
      data-variant={variant}
      data-size={size}
    >
      {children}
    </button>
  );
}
