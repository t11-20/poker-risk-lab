/**
 * Imports `learn.css` once for the section, so its cascade position does not depend on the route a
 * reader arrived on. It renders no element of its own.
 */

import type { ReactElement, ReactNode } from 'react';
import '@/styles/learn.css';

export default function LearnLayout({ children }: { readonly children: ReactNode }): ReactElement {
  return <>{children}</>;
}
