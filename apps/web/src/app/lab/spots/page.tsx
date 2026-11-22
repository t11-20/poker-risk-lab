/**
 * The player's own spots, which live in this browser, so the list is read on the client. The "start
 * from a scenario" form is a plain GET to the editor, so it works before the page has hydrated.
 */

import { scenarios } from '@prl/content';
import type { Metadata } from 'next';
import type { ReactElement } from 'react';
import { SpotList } from '../../../components/SpotList.tsx';
import '../../../styles/page.css';
import '../../../styles/lab.css';
import '../../../styles/spot-editor.css';

export const metadata: Metadata = {
  title: 'Your spots',
  description:
    'Spots you have set up yourself, saved in this browser, and the scenarios you can start one from.',
};

export default function SpotsPage(): ReactElement {
  const all = scenarios();
  const titles: Record<string, string> = {};
  for (const scenario of all) titles[scenario.id] = scenario.title;

  return (
    <div className="prl-container prl-lab-page">
      <header className="prl-page-head">
        <p className="prl-eyebrow">
          <a className="prl-crumb" href="/lab">
            Scenario Lab
          </a>
        </p>
        <h1 className="prl-display-2 prl-page-head__title">Your spots</h1>
        <p className="prl-page-head__standfirst">
          Spots you set up yourself: your cards, the board, the stacks and the bet. They are saved in this
          browser and nowhere else.
        </p>
      </header>

      <p className="prl-btn-row">
        <a className="prl-btn prl-btn--primary" href="/lab/spots/edit">
          New spot
        </a>
      </p>

      <SpotList titles={titles} />

      <form className="prl-spot-start" action="/lab/spots/edit" method="get">
        <h2 className="prl-spot-start__title">Start from a scenario</h2>
        <div className="prl-field">
          <label className="prl-field__label" htmlFor="prl-spot-start-from">
            Scenario
          </label>
          <select className="prl-select" id="prl-spot-start-from" name="from" defaultValue={all[0]?.id}>
            {all.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.title}
              </option>
            ))}
          </select>
        </div>
        <button className="prl-btn prl-btn--secondary" type="submit">
          Edit a copy
        </button>
      </form>
    </div>
  );
}
