'use client';

/**
 * The one input the Scenario Lab promises: the assumed fold frequency, changed after deciding.
 *
 * ## Why it exists
 *
 * The nav calls the Lab "change one input, watch the maths move", and every scenario's assumptions
 * say the fold frequency behind its bet and raise rows "is an input you can change, not something
 * measured". After a decision the page offered no control of any kind. Measured at commit 308fadf:
 * the reveal held one button ("Choose again") and links.
 *
 * ## What it changes, and what it deliberately does not
 *
 * It re-prices the candidate rows that read a fold frequency, in the browser, with
 * `repriceAtFoldEquity` — the Coach's own `evOfBet`/`evOfRaise` over the report already on the
 * page — and lists every row with its analysed figure beside the new one. Rows that read none
 * (fold, check, call) are listed as not moving, and equity is stated as not moving, because a
 * reader who watches the call row stay put has learned what the fold assumption is and is not.
 *
 * It does NOT re-grade the verdict above it or touch the full analysis below. The verdict is the
 * one the server recorded, judged at the analysed frequency, and a panel that silently re-scored a
 * recorded decision as a slider moved would be the defect `ScenarioStage` was fixed for.
 *
 * ## Where it is not offered
 *
 * `repriceAtFoldEquity` answers `unavailable` with a reason for a report with no row that reads a
 * fold frequency (the five Lab scenarios facing an all-in offer fold and call only) and for any
 * report whose rows it cannot reproduce to a millionth of a unit. The control is then replaced by
 * that reason, rather than by figures that only look like the analysis's.
 *
 * ## Accessibility
 *
 * A native range input, so arrows, Page Up/Down and Home/End work and are announced by the
 * platform; `aria-valuetext` makes the announcement "20% fold frequency" rather than a bare
 * number. The summary of what moved is a polite status region, so it is read once the reader
 * pauses rather than interrupting each step. The reset is a real button, disabled at the analysed
 * value, and it moves focus to the slider before it disables itself: a focused control that becomes
 * disabled leaves the caret on `<html>` (measured in Chrome 151 for `ActionBar`'s Fold).
 */

import type { CoachReport } from '@prl/contracts';
import { repriceAtFoldEquity } from '@prl/poker-math';
import { Button, formatSignedUnits, formatUnits, Panel } from '@prl/ui';
import { type ReactElement, useId, useRef, useState } from 'react';
import {
  type Formatters,
  percentText,
  repricingSummary,
  rowChangeText,
  rowName,
} from '../lib/fold-equity-lab.ts';

const FORMAT: Formatters = {
  units: (value) => formatUnits(value),
  signed: (value) => formatSignedUnits(value, { decimals: 1 }),
};

export function FoldEquityControl({ report }: { readonly report: CoachReport }): ReactElement | null {
  const analysed = repriceAtFoldEquity(report, Number.NaN);
  const analysedPercent = analysed.kind === 'available' ? Math.round(analysed.analysedFoldEquity * 100) : 0;
  const [percent, setPercent] = useState(analysedPercent);
  const sliderId = useId();
  const hintId = useId();
  const sliderRef = useRef<HTMLInputElement>(null);

  if (analysed.kind === 'unavailable') {
    return (
      <Panel title="The fold assumption" eyebrow="Your input" index={5} headingLevel={2}>
        <p className="prl-prose">{`There is no fold frequency to change in this scenario. ${analysed.reason}`}</p>
      </Panel>
    );
  }

  const repriced = repriceAtFoldEquity(report, percent / 100);
  // Unreachable — the same report was reproducible a line above — but a refusal is never rendered
  // as figures.
  if (repriced.kind === 'unavailable') return null;
  const equity = report.equity.heroEquity;

  return (
    <Panel title="Change the fold assumption" eyebrow="Your input" index={5} headingLevel={2}>
      <p className="prl-prose">
        {`The bet and raise rows assume the opponent folds ${percentText(repriced.analysedFoldEquity)} of the time. Somebody chose that figure; nothing measured it. Move it and those rows are re-priced here with the same formulas the analysis used. Your equity, ${(equity * 100).toFixed(1)}%, does not move: it depends on the cards and the range, not on how often anyone folds.`}
      </p>

      <div className="prl-fold-input">
        <label className="prl-fold-input__label" htmlFor={sliderId}>
          Assumed fold frequency
          <span className="prl-fold-input__value" aria-hidden="true">
            {`${percent}%`}
          </span>
        </label>
        <input
          id={sliderId}
          ref={sliderRef}
          className="prl-range prl-fold-input__slider"
          type="range"
          min={0}
          max={100}
          step={1}
          value={percent}
          aria-valuetext={`${percent}% fold frequency`}
          aria-describedby={hintId}
          onChange={(event) => setPercent(Number(event.currentTarget.value))}
        />
        <p className="prl-note" id={hintId}>
          {`0% means the opponent never folds; 100% means they always do. The analysis used ${analysedPercent}%.`}
        </p>
        <Button
          className="prl-fold-input__reset"
          variant="secondary"
          size="sm"
          disabled={percent === analysedPercent}
          onClick={() => {
            // Focus first, then disable. The button disables itself on the render this click causes,
            // and a focused control that becomes disabled drops the caret to <html> in Chrome — the
            // defect ActionBar and "Choose again" were both fixed for. The slider is what was reset.
            sliderRef.current?.focus();
            setPercent(analysedPercent);
          }}
        >
          {`Back to the analysed ${analysedPercent}%`}
        </Button>
      </div>

      <p className="prl-fold-input__summary" role="status" aria-live="polite">
        {repricingSummary(repriced, FORMAT)}
      </p>

      <ul className="prl-fold-input__rows">
        {repriced.rows.map((row) => (
          <li key={`${row.action}-${row.to ?? 'na'}`} className="prl-fold-input__row">
            <span className="prl-fold-input__row-name">{rowName(row, FORMAT)}</span>
            <span className="prl-fold-input__row-value">{rowChangeText(row, FORMAT)}</span>
          </li>
        ))}
      </ul>

      <p className="prl-note">
        {`The verdict above was judged at the analysed ${analysedPercent}%, and it is the one recorded; this control does not change it. The full analysis below is also at ${analysedPercent}%.`}
      </p>
    </Panel>
  );
}
