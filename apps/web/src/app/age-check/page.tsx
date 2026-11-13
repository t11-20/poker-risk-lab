/**
 * `/age-check`, the age gate's screen and the proxy's redirect target. A route, not an overlay, so
 * there is no focus trap or scroll lock and the blocked page is not in the DOM. With the gate off it
 * still renders and says so, which keeps it reachable by `scripts/a11y-audit.mjs`. `robots` is not
 * overridden, for the reason written out on `/terms`.
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

/** A value may be an array, and `?next=/a&next=//evil.test` is how an open redirect arrives. */
interface AgeCheckPageProps {
  readonly searchParams: Promise<{ readonly [key: string]: string | string[] | undefined }>;
}

function first(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

export default async function AgeCheckPage({ searchParams }: AgeCheckPageProps): Promise<ReactElement> {
  const params = await searchParams;
  const config = readAgeGateConfig();
  // Also validated in the proxy, which guards the redirect. This guards a link and a hidden input.
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
