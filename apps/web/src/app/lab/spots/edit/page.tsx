/**
 * The spot editor. `?from=<scenario>` opens a copy of a built-in (or the saved edit of it), `?id=<spot>`
 * opens one of the player's own, and no query starts a blank spot. The spot itself lives in browser
 * storage, so the page renders the editor and the client reads storage after hydration.
 */

import type { Metadata } from 'next';
import type { ReactElement } from 'react';
import { type EditorTarget, SpotEditor } from '../../../../components/SpotEditor.tsx';
import { builtInOriginals } from '../../../../lib/spot-originals.ts';
import '../../../../styles/page.css';
import '../../../../styles/lab.css';
import '../../../../styles/spot-editor.css';

export const metadata: Metadata = {
  title: 'Spot editor',
  description:
    'Set your own cards, stacks, pot and bet, and see the equity and risk numbers worked out as you go.',
};

interface EditorPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined): string | null {
  const one = Array.isArray(value) ? value[0] : value;
  return one === undefined || one === '' ? null : one;
}

export default async function SpotEditorPage({ searchParams }: EditorPageProps): Promise<ReactElement> {
  const query = await searchParams;
  const id = first(query['id']);
  const from = first(query['from']);
  // An unknown `from` still goes to the editor, which may hold a saved edit of a built-in now gone.
  const target: EditorTarget =
    id !== null ? { mode: 'id', id } : from !== null ? { mode: 'from', scenarioId: from } : { mode: 'new' };

  return (
    <div className="prl-container prl-lab-page">
      <header className="prl-page-head">
        <p className="prl-eyebrow">
          <a className="prl-crumb" href="/lab">
            Scenario Lab
          </a>
          {' · '}
          <a className="prl-crumb" href="/lab/spots">
            Your spots
          </a>
        </p>
        <h1 className="prl-display-2 prl-page-head__title">Spot editor</h1>
        <p className="prl-page-head__standfirst">
          Pick your cards and the board, set the stacks and the bet you face, and the numbers update as you
          go. Spots save in this browser only.
        </p>
      </header>
      <SpotEditor target={target} originals={builtInOriginals()} />
    </div>
  );
}
