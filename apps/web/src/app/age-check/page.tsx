/**
 * `/age-check` — the one screen the age gate has, and the route the proxy redirects to.
 *
 * ## Why it is a route and not an overlay
 *
 * An interstitial that renders over the page it is blocking has to trap focus, hide the content
 * behind it from assistive technology, and manage a scroll lock — three mechanisms whose failure
 * modes `MobileNav.tsx` documents at length — and it still leaves the blocked page in the DOM,
 * where a determined reader finds it with the caret. A route has none of that: the reader is
 * somewhere else, the browser's own back button behaves, and the URL says what happened.
 *
 * ## Why the metadata does NOT override `robots`
 *
 * The root layout sets `index: false, follow: false` for the whole app, and this page keeps it.
 * That is a deliberate decision rather than an omission: the surface it belongs to is a set of
 * documents that have not been reviewed by a lawyer, and a search result carrying placeholder
 * legal text under a real operator's name is a worse outcome than not being findable. The same
 * reasoning is written out on `/terms`, and it is the one to revisit — deliberately — once counsel
 * has signed the text off.
 *
 * ## What this route renders when the gate is off
 *
 * The page still exists and still renders, and it says that this deployment has not configured an
 * age check. That is the shipped state (see `src/lib/age-gate.ts` for the argument), and a route
 * that 404s when a feature is unconfigured would hide the very fact a deployer needs to see. It
 * also keeps the page reachable by `scripts/a11y-audit.mjs`, which crawls from links rather than
 * from a route table.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { AgeGate } from '@/components/AgeGate.tsx';
import {
  AGE_GATE_DECLINED_PARAM,
  AGE_GATE_DECLINED_VALUE,
  AGE_GATE_RETURN_PARAM,
  readAgeGateConfig,
  safeReturnPath,
} from '@/lib/age-gate.ts';
import { LEGAL_PATHS } from '@/lib/legal-config.ts';
import '../../styles/page.css';
import '../../styles/legal.css';

export const metadata: Metadata = {
  title: 'Age check',
  description:
    'A self-declared age check, shown only when the operator of this deployment has configured ' +
    'one. Nothing is verified and no date of birth is stored.',
};

/**
 * `searchParams` is a promise in this version of Next and a value may be a string, an array or
 * absent — a URL is allowed to repeat a parameter. Both awkward cases are narrowed by `first`
 * below rather than by a cast, because `?next=/a&next=//evil.test` is exactly the input an open
 * redirect arrives as.
 */
interface AgeCheckPageProps {
  readonly searchParams: Promise<{ readonly [key: string]: string | string[] | undefined }>;
}

/** The first value of a repeated parameter, or null. Never the array, never a join of it. */
function first(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

export default async function AgeCheckPage({ searchParams }: AgeCheckPageProps): Promise<ReactElement> {
  const params = await searchParams;
  const config = readAgeGateConfig();
  // Validated here as well as in the proxy. The proxy sanitises what it redirects TO; this
  // sanitises what is put into a link and a hidden input, and the two are different attack
  // surfaces reached by different requests.
  const returnPath = safeReturnPath(first(params[AGE_GATE_RETURN_PARAM]));
  const declined = first(params[AGE_GATE_DECLINED_PARAM]) === AGE_GATE_DECLINED_VALUE;

  return (
    <div className="prl-container">
      <header className="prl-page-head">
        <p className="prl-label">Age check</p>
        <h1 className="prl-page-head__title prl-display-2">One question before the tables</h1>
        <p className="prl-page-head__standfirst">
          This is a teaching tool with no money in it. The question below is a self-declaration: it checks
          nothing, stores no date of birth, and exists because whoever runs this deployment has decided — or
          has not yet decided — that it should be asked.
        </p>
      </header>

      <AgeGate config={config} declined={declined} returnPath={returnPath} />

      <p className="prl-page-nav">
        <Link href={LEGAL_PATHS.responsibleUse}>Responsible use</Link>
        <Link href={LEGAL_PATHS.privacy}>What is stored about you</Link>
        <Link href={LEGAL_PATHS.terms}>Terms of use</Link>
      </p>
    </div>
  );
}
