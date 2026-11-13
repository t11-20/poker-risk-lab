'use client';

/**
 * The three-variant button. The default is `secondary` because a default primary is how a view ends up
 * with six of them. Text on the accent fill is `--prl-text-on-accent`, never white (2.07:1, §2.4).
 * No `href` (links go through `next/link`), no spinner (it changes the width under the cursor), no
 * icon-only mode (§12). `type` defaults to `button`, because an unspecified type inside a form submits it.
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
