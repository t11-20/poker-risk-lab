'use client';

/**
 * The Lab's one promised input, the assumed fold frequency after deciding. It re-prices only the
 * rows that read a fold frequency with the Coach's own formulas (`repriceAtFoldEquity`). It never
 * re-grades the recorded verdict. Where no row reads one, or the rows do not reproduce to a millionth
 * of a unit, the reason replaces the control. A native range with `aria-valuetext` and a polite status.
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
  // Unreachable, but a refusal is never rendered as figures.
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
            // Focus first. A focused control that becomes disabled drops the caret to <html> in Chrome.
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
