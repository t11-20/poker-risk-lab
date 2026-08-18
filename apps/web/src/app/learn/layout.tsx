/**
 * The Learn section's layout: one job, which is to bring in the section's stylesheet.
 *
 * `src/styles/learn.css` is imported here rather than from each of the three routes so it is
 * fetched once for the section and so the import order is fixed — the app shell's `globals.css`
 * comes from the root layout above this one, and a feature stylesheet imported from three
 * different pages can land in three different places in the cascade depending on which route the
 * reader arrived on.
 *
 * No markup of its own. `<main>` belongs to the root layout, and a wrapper here would either
 * duplicate a landmark or add an element the routes then have to work around. The routes own
 * their own `h1` and their own page frame.
 */

import type { ReactElement, ReactNode } from 'react';
import '@/styles/learn.css';

export default function LearnLayout({ children }: { readonly children: ReactNode }): ReactElement {
  return <>{children}</>;
}
