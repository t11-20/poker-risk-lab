/**
 * Imports `legends.css` once for every `/legends` route, after the root layout's stylesheets. It
 * renders no element of its own.
 */

import type { ReactElement, ReactNode } from 'react';
import '@/styles/legends.css';

export default function LegendsLayout({ children }: { readonly children: ReactNode }): ReactElement {
  return <>{children}</>;
}
