/**
 * The glossary, one page so find-in-page sees every term. Lessons and `seeAlso` link to
 * `/learn/glossary#<id>`, so `GlossaryBrowser` starts unfiltered. A filtered-out entry has no element
 * to scroll to.
 */

import { Callout } from '@prl/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { GlossaryBrowser } from '@/components/GlossaryBrowser.tsx';
import { LEARN_PATH, loadGlossary } from '@/lib/learn-data.ts';

export const metadata: Metadata = {
  title: 'Glossary',
  description:
    'Every term the lessons use, in plain language first and jargon second, with the formula where ' +
    'there is one and cross-references to the related ideas.',
};

export default async function GlossaryPage(): Promise<ReactElement> {
  const glossary = await loadGlossary();

  return (
    <div className="prl-learn-page">
      <header className="prl-learn-page__head">
        <p className="prl-learn-page__eyebrow">
          <Link className="prl-learn-lesson__back" href={LEARN_PATH}>
            Curriculum
          </Link>
          <span aria-hidden="true"> / </span>
          <span className="prl-label">Reference</span>
        </p>
        <h1 className="prl-display-2">Glossary</h1>
        <p className="prl-learn-page__lead">
          The plain-language version first, the jargon second. Where a term has a formula it is printed with
          the definition, because a definition that describes an equation without showing it is asking you to
          take it on trust.
        </p>
        <p className="prl-learn-page__lead">
          No figure here is a computed one. A formula is the definition of a quantity; the quantity itself is
          worked out inside a lesson or at a table, from the situation in front of you.
        </p>
      </header>

      {glossary.source === 'fixture' && glossary.fallbackReason !== null ? (
        <Callout tone="warning" title="These definitions are the bundled copy">
          {glossary.fallbackReason}
        </Callout>
      ) : null}

      <GlossaryBrowser entries={glossary.data.entries} />
    </div>
  );
}
