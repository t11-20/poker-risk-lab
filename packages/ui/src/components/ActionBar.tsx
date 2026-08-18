'use client';

/**
 * The decision controls: fold, check, call, bet, raise — with a bet sizer that cannot produce an
 * illegal amount.
 *
 * ## The invariant: no out-of-range value can leave this component
 *
 * `LegalAction` carries `minTo` and `maxTo` straight from the engine's `legalActions()`, and the
 * server re-derives and re-validates the same bounds on arrival — a client is never the authority
 * on what is legal. This component's job is to make the illegal value *unreachable in the control*,
 * so a learner never meets a rejection they could not have predicted.
 *
 * It is enforced in one place rather than four, and that place is `../bet-sizing.ts` — pulled out of
 * this file precisely so the invariant can be unit-tested, since JSX cannot be run under
 * `node:test` in this repo. Every control writes to a *draft string*, and the amount that actually
 * gets sent is always `resolveDraft(draft, bounds)`. So:
 *
 *   - typing `9999` submits `maxTo`, not `9999`
 *   - typing `1` when the minimum raise is `200` submits `200`
 *   - dragging, presets and typing all pass through the same clamp
 *   - if the bounds change under the component (a new street, a new bet level), the clamp re-runs
 *     on the next render and the value follows — no effect, no stale state, no "reset on prop
 *     change" dance
 *
 * The draft is a *string*, not a number, on purpose. Clamping on every keystroke makes the field
 * unusable: type `5` on the way to `500` and it snaps to the minimum before the second digit lands.
 * The string is what the reader is typing; the clamped number is what the button will send. They
 * are allowed to disagree while the field has focus — which is why the readout always shows the
 * number that will actually be sent, and why blur normalises the text back to it.
 *
 * ## Every button prints its cost, and announces it
 *
 * A player must never have to work out what a button will cost them, and they must never have to
 * read a *different* button to find out. So each action carries two things:
 *
 *   - a visible cost line in tabular figures (`0 units`, `50 units`, `250 units`) — tabular so the
 *     five costs form a column that can be compared at a glance rather than five ragged strings;
 *   - an `aria-label` that states the action and its cost as a sentence ("call 50 units",
 *     "raise to 300 units, 250 units out of your stack"). Without it a screen reader announces the
 *     two spans as one run-together string, and for fold and check it would announce a bare `0`.
 *
 * `formatUnits` supplies the word "units" every time. A bare number could read as currency, and
 * these are free, resettable and valueless.
 *
 * ## Sizer before buttons
 *
 * The sizer comes first in the DOM, so the visual order and the keyboard order are both "choose a
 * size, then choose what to do". Most poker clients put the buttons first, which means a keyboard
 * user tabs past the commit button to reach the size control.
 *
 * ## Accessibility
 *
 *  - The slider is paired with a number input. A slider alone cannot express an exact amount, and
 *    the exact amount is the entire point of a bet sizer. Both are native controls, so the
 *    platform's keyboard handling (arrows, Home/End, PageUp/PageDown) is intact — a `div`-based
 *    slider would have to reimplement all of it, and would get it wrong.
 *  - `accent-color` styles the native range track rather than replacing it.
 *  - Every control is a real `<button>` or `<input>` at or above the 44px target floor, reachable
 *    in one tab sequence.
 *  - Presets use `aria-pressed`, and the pressed one also shows a check glyph and heavier weight,
 *    so the selection is not signalled by colour alone.
 *  - The allowed range is stated as visible text and referenced by `aria-describedby` from both
 *    inputs, instead of being discoverable only by hitting the end of the slider.
 *  - The sizer is a `<fieldset>` with a `<legend>`, so its controls are announced as one group, and
 *    `disabled` on the fieldset disables all of them at once.
 */

import { type ReactElement, useId, useState } from 'react';
import {
  clampBetTo,
  presetTotal,
  resolveDraft,
  resolveSizedAction,
  SIZING_PRESETS,
  type SizedAction,
} from '../bet-sizing.ts';
import { cx } from '../cx.ts';
import { formatChips, formatUnits } from '../format.ts';
import type { LegalAction, TableAction } from '../view-types.ts';

export interface ActionBarProps {
  /** From `PlayerView.legalActions`. Empty when it is not this seat's turn. */
  readonly legalActions: readonly LegalAction[];
  /** Called with an action whose amount is already clamped to the legal bounds. */
  readonly onAct: (action: TableAction) => void;
  /** `PlayerView.potTotal` — everything in the middle, this street included. */
  readonly pot: number;
  /** `PlayerView.amountToCall`. Zero when nothing is owed. */
  readonly toCall: number;
  /** This seat's commitment so far this street. `to` amounts are totals, not increments. */
  readonly committedThisStreet: number;
  /** Disables every control, e.g. while an action is in flight. */
  readonly disabled?: boolean;
  /** Shown when there are no legal actions. */
  readonly idleText?: string;
  readonly className?: string;
}

interface ActionButtonProps {
  readonly label: string;
  /** The cost as a figure, drawn under the label in tabular numerals. */
  readonly cost: string;
  /** The whole button as one sentence, for assistive tech. Always states the cost. */
  readonly spoken: string;
  readonly primary?: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}

function ActionButton(props: ActionButtonProps): ReactElement {
  const { label, cost, spoken, primary = false, disabled, onClick } = props;
  return (
    <button
      type="button"
      className={cx('prl-action-btn', primary && 'prl-action-btn--primary')}
      disabled={disabled}
      aria-label={spoken}
      onClick={onClick}
    >
      <span className="prl-action-btn__label">{label}</span>
      <span className="prl-action-btn__cost">{cost}</span>
    </button>
  );
}

interface BetSizerProps {
  readonly sized: SizedAction;
  /** The clamped amount that will be sent. */
  readonly to: number;
  /** What the number field shows, which may be mid-edit and therefore unclamped. */
  readonly numberValue: string;
  readonly pot: number;
  readonly toCall: number;
  readonly committedThisStreet: number;
  readonly disabled: boolean;
  readonly onDraft: (next: string) => void;
}

function BetSizer(props: BetSizerProps): ReactElement {
  const { sized, to, numberValue, pot, toCall, committedThisStreet, disabled, onDraft } = props;
  const rangeId = useId();
  const numberId = useId();
  const boundsId = useId();

  const { bounds } = sized;
  const isBet = sized.kind === 'bet';
  const stackBehind = bounds.max - committedThisStreet;
  const cost = to - committedThisStreet;
  const remainingAfter = bounds.max - to;
  const isAllIn = to >= bounds.max && bounds.max > bounds.min;

  return (
    <fieldset className="prl-sizer" disabled={disabled}>
      <legend className="prl-sizer__legend">{isBet ? 'How much to bet' : 'How much to raise to'}</legend>

      <div className="prl-sizer__presets">
        {SIZING_PRESETS.map((preset) => {
          // Derived from the engine's own bounds, never from an invented maximum: `presetTotal`
          // clamps into `[minTo, maxTo]`, so a preset can never propose an amount the server did
          // not offer. On a short stack several presets collapse onto all-in, which is correct.
          const target = presetTotal(preset, { bounds, pot, toCall, committedThisStreet });
          return (
            <button
              key={preset.id}
              type="button"
              className="prl-preset"
              aria-pressed={target === to}
              onClick={() => onDraft(String(target))}
            >
              <span aria-hidden="true" className="prl-preset__mark">
                ✓
              </span>
              {preset.label}
              <span className="prl-visually-hidden">{` — ${formatUnits(target)} total`}</span>
            </button>
          );
        })}
      </div>

      <div className="prl-sizer__controls">
        <label className="prl-visually-hidden" htmlFor={rangeId}>
          {isBet ? 'Bet size slider' : 'Raise size slider'}
        </label>
        <input
          id={rangeId}
          className="prl-range prl-sizer__slider"
          type="range"
          min={bounds.min}
          max={bounds.max}
          step={1}
          value={to}
          aria-describedby={boundsId}
          onChange={(event) => onDraft(event.currentTarget.value)}
        />
        <span className="prl-sizer__field">
          <label className="prl-sizer__field-label" htmlFor={numberId}>
            {isBet ? 'Bet to' : 'Raise to'}
          </label>
          <input
            id={numberId}
            className="prl-sizer__number"
            type="number"
            inputMode="numeric"
            min={bounds.min}
            max={bounds.max}
            step={1}
            value={numberValue}
            aria-describedby={boundsId}
            onChange={(event) => onDraft(event.currentTarget.value)}
            // Normalising on blur is what makes the typed text and the clamped value agree again
            // once the field is left.
            onBlur={() => onDraft(String(to))}
          />
        </span>
      </div>

      <p className="prl-sizer__bounds" id={boundsId}>
        {`Allowed range ${formatChips(bounds.min)} to ${formatChips(bounds.max)} units. Presets are a fraction of the pot after your call.`}
      </p>

      <div className="prl-sizer__readout">
        <p className="prl-sizer__readout-line">
          {'Total commitment this street: '}
          <span className="prl-sizer__readout-value">{formatUnits(to)}</span>
        </p>
        <p className="prl-sizer__readout-line">
          {'Out of your stack: '}
          <span className="prl-sizer__readout-value">{formatUnits(cost)}</span>
          {` of ${formatUnits(stackBehind)}, leaving ${formatUnits(remainingAfter)} behind`}
          {isAllIn ? ' — this is all in.' : '.'}
        </p>
      </div>
    </fieldset>
  );
}

export function ActionBar(props: ActionBarProps): ReactElement {
  const {
    legalActions,
    onAct,
    pot,
    toCall,
    committedThisStreet,
    disabled = false,
    idleText = 'Waiting for another player to act.',
    className,
  } = props;

  const [draft, setDraft] = useState<string | null>(null);

  const sized = resolveSizedAction(legalActions);
  const canFold = legalActions.some((action) => action.type === 'fold');
  const canCheck = legalActions.some((action) => action.type === 'check');
  const call = legalActions.find((action) => action.type === 'call');

  // The single clamp every path goes through. `draft` is what the reader typed; `to` is what will
  // be sent, and the two cannot disagree at submit time because the button reads `to`.
  const bounds = sized?.bounds ?? { min: 0, max: 0 };
  const to = resolveDraft(draft, bounds);
  const sizedCost = to - committedThisStreet;
  const isAllIn = sized !== null && to >= bounds.max && bounds.max > bounds.min;
  const callCost = call?.costAtMin ?? toCall;

  const commitSized = (): void => {
    if (sized === null) return;
    // Re-clamped here rather than trusted from state: there must be no path, including a future
    // one, on which an unclamped number reaches `onAct`.
    const safe = clampBetTo(to, bounds);
    onAct(sized.kind === 'bet' ? { type: 'bet', to: safe } : { type: 'raise', to: safe });
  };

  if (legalActions.length === 0) {
    return (
      <div className={cx('prl-action-bar', className)}>
        <p className="prl-action-bar__idle">{idleText}</p>
      </div>
    );
  }

  const sizedWord = sized?.kind === 'bet' ? 'Bet to' : 'Raise to';

  return (
    <div className={cx('prl-action-bar', className)}>
      {/* The price of the decision, in one line, above the controls that act on it. It repeats
          figures the buttons also carry — deliberately: the pot is nowhere else in this component,
          and a player comparing the price with the pot should not have to look in two places. */}
      <p className="prl-action-bar__price">
        <span className="prl-action-bar__price-item">
          <span className="prl-label">In the pot</span>
          <span className="prl-action-bar__price-value">{formatUnits(pot)}</span>
        </span>
        <span className="prl-action-bar__price-item">
          <span className="prl-label">To continue</span>
          <span className="prl-action-bar__price-value">{toCall > 0 ? formatUnits(toCall) : 'nothing'}</span>
        </span>
      </p>

      {sized === null ? null : (
        <BetSizer
          sized={sized}
          to={to}
          numberValue={draft ?? String(to)}
          pot={pot}
          toCall={toCall}
          committedThisStreet={committedThisStreet}
          disabled={disabled}
          onDraft={setDraft}
        />
      )}

      <div className="prl-action-bar__actions">
        {canFold ? (
          <ActionButton
            label="Fold"
            cost={formatUnits(0)}
            spoken={`fold, costs ${formatUnits(0)}, gives up the hand and any claim on the pot`}
            disabled={disabled}
            onClick={() => onAct({ type: 'fold' })}
          />
        ) : null}

        {canCheck ? (
          <ActionButton
            label="Check"
            cost={formatUnits(0)}
            spoken={`check, costs ${formatUnits(0)}, stays in the hand and passes the decision on`}
            disabled={disabled}
            onClick={() => onAct({ type: 'check' })}
          />
        ) : null}

        {call === undefined ? null : (
          <ActionButton
            label="Call"
            cost={formatUnits(callCost)}
            spoken={`call ${formatUnits(callCost)}`}
            disabled={disabled}
            onClick={() => onAct({ type: 'call' })}
          />
        )}

        {sized === null ? null : (
          <ActionButton
            label={`${sizedWord} ${formatChips(to)}`}
            cost={formatUnits(sizedCost)}
            spoken={
              isAllIn
                ? `${sizedWord.toLowerCase()} ${formatUnits(to)}, which is all in: ${formatUnits(sizedCost)} out of your stack`
                : `${sizedWord.toLowerCase()} ${formatUnits(to)}, ${formatUnits(sizedCost)} out of your stack`
            }
            primary
            disabled={disabled}
            onClick={commitSized}
          />
        )}
      </div>

      <p className="prl-action-bar__note">
        {'Folding costs nothing and gives up any claim on the pot. '}
        {sized?.note ?? ''}
      </p>
    </div>
  );
}
