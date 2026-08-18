/**
 * The legends segment's layout. Its only job is to bring in the feature's stylesheet once.
 *
 * Four routes sit under `/legends` — the selector, a profile, the comparison and the worked hand
 * review — and all four use the same `.prl-legend-*` classes. Importing the stylesheet here rather
 * than in each page means one inclusion, one place to change, and a cascade position that is
 * predictable: the root layout's imports (`@prl/ui/styles.css`, then `globals.css`) resolve first,
 * so every token and every component rule exists before a rule in `legends.css` can reference or
 * override one.
 *
 * It renders no element of its own. A wrapper `<div>` here would be a box in the middle of every
 * legends page that no route asked for, and the `<main>` landmark already belongs to the root
 * layout.
 */

import type { ReactElement, ReactNode } from 'react';
import '@/styles/legends.css';

export default function LegendsLayout({ children }: { readonly children: ReactNode }): ReactElement {
  return <>{children}</>;
}
