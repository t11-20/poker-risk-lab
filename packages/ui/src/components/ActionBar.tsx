'use client';

/**
 * The decision controls (fold, check, call, bet, raise), with a bet sizer that cannot send an illegal
 * amount. The server re-validates, but a learner should never meet a rejection they could not predict.
 *
 * Every control writes a text draft, and the amount sent is always `resolveDraft(draft, bounds)` from
 * `../bet-sizing.ts`, where the clamp is unit-tested. The draft is text so that typing `5` on the way
 * to `500` does not snap to the minimum. It is stamped with the bounds it was typed against
 * (`draftForBounds`), so a draft from an earlier street cannot outlive its spot. It carries `badInput`
 * because a number input sanitises unparseable text to `''`.
 *
 * Each button shows its amount, if any, and has an `aria-label` sentence with the action and its amount
 * in units. Without it a screen reader runs the spans together and reads a bare figure.
 * The sizer comes first in the DOM, so tab order is "choose a size, then act". Presets use
 * `aria-pressed` plus a check glyph, so selection is not signalled by colour alone.
 */

import {
  type ReactElement,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  type BetDraft,
  clampBetTo,
  clampedFrom,
  draftForBounds,
  isAllInAt,
  isDraftMalformed,
  offeredPresets,
  presetTotal,
  pressedPreset,
  resolveDraft,
  resolveSizedAction,
  type SizedAction,
  type StampedDraft,
  sizedButtonText,
} from '../bet-sizing.ts';
import { cx } from '../cx.ts';
import { useFocusRescue } from '../focus-rescue.ts';
import { foldPress, spotSignature } from '../fold-guard.ts';
import { formatChips, formatUnits } from '../format.ts';
import type { LegalAction, TableAction } from '../view-types.ts';

export interface ActionBarProps {
  /** From `PlayerView.legalActions`. Empty when it is not this seat's turn. */
  readonly legalActions: readonly LegalAction[];
  /** Called with an action whose amount is already clamped to the legal bounds. */
  readonly onAct: (action: TableAction) => void;
  /** `PlayerView.potTotal`, everything in the middle including this street. */
  readonly pot: number;
  readonly toCall: number;
  /** This street so far. `to` amounts are totals, not increments. */
  readonly committedThisStreet: number;
  /**
   * Disables every control. It also parks the caret on an in-flight line and returns it afterwards;
   * see the focus block in `ActionBar`.
   */
  readonly disabled?: boolean;
  readonly idleText?: string;
  /** Drawn beside the idle line, such as the next deal once a hand is over. */
  readonly idleAction?: ReactNode;
  /** Drawn between the price and the sizer, and above the idle line (`HandGlance` on a phone). */
  readonly context?: ReactNode;
  readonly className?: string;
}

interface ActionButtonProps {
  readonly label: string;
  /** A second line only when it adds something, such as "All in" or "60 more". */
  readonly cost?: string;
  /** The whole button as one sentence for assistive tech. Always states the cost. */
  readonly spoken: string;
  readonly primary?: boolean;
  readonly disabled: boolean;
  readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
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
      {cost === undefined || cost === '' ? null : <span className="prl-action-btn__cost">{cost}</span>}
    </button>
  );
}

/**
 * Fold, the one key that can ask before it acts (`../fold-guard.ts`). Armed, it is the same button
 * relabelled, so the caret stays put and the new name is read where focus already is.
 */
function FoldButton(props: {
  readonly canCheck: boolean;
  readonly armed: boolean;
  readonly disabled: boolean;
  readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}): ReactElement {
  const { canCheck, armed, disabled, onClick } = props;
  const verb = armed ? 'fold anyway' : 'fold';
  return (
    <ActionButton
      label={armed ? 'Fold anyway' : 'Fold'}
      spoken={
        canCheck
          ? `${verb}, costs ${formatUnits(0)} and gives up the hand, though checking is free`
          : `fold, costs ${formatUnits(0)} and gives up the hand`
      }
      disabled={disabled}
      onClick={onClick}
    />
  );
}

interface BetSizerProps {
  readonly sized: SizedAction;
  /** The clamped amount that will be sent. */
  readonly to: number;
  /** What the reader typed, possibly mid-edit and unclamped. Null before then. */
  readonly draft: BetDraft | null;
  readonly pot: number;
  readonly toCall: number;
  readonly committedThisStreet: number;
  readonly disabled: boolean;
  readonly onDraft: (next: BetDraft) => void;
}

function BetSizer(props: BetSizerProps): ReactElement {
  const { sized, to, draft, pot, toCall, committedThisStreet, disabled, onDraft } = props;
  const rangeId = useId();
  const numberId = useId();
  const boundsId = useId();
  const invalidId = useId();
  const clampedId = useId();

  const { bounds } = sized;
  const isBet = sized.kind === 'bet';
  const remainingAfter = bounds.max - to;
  const isAllIn = isAllInAt(to, bounds);

  /**
   * Invalid means text this control cannot size a bet with, never an out-of-range amount (the clamp
   * corrects those). The correction is first in `aria-describedby` and rendered only while it applies,
   * because a present but irrelevant description is read on every visit to the field.
   */
  const malformed = isDraftMalformed(draft);
  const clamped = clampedFrom(draft, to);
  const describedBy = malformed
    ? `${invalidId} ${boundsId}`
    : clamped !== null
      ? `${clampedId} ${boundsId}`
      : boundsId;
  const context = { bounds, pot, toCall, committedThisStreet };
  const pressed = pressedPreset(context, to);

  return (
    <fieldset className="prl-sizer" disabled={disabled}>
      <legend className="prl-sizer__legend">{isBet ? 'Bet size' : 'Raise size'}</legend>

      <div className="prl-sizer__presets">
        {offeredPresets(context).map((preset) => {
          // `presetTotal` clamps into the engine's bounds, so on a short stack presets collapse onto all-in.
          const target = presetTotal(preset, context);
          return (
            <button
              key={preset.id}
              type="button"
              className="prl-preset"
              aria-pressed={preset.id === pressed}
              onClick={() => onDraft({ text: String(target), badInput: false })}
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
          onChange={(event) => onDraft({ text: event.currentTarget.value, badInput: false })}
        />
        <span className="prl-sizer__field">
          <label className="prl-sizer__field-label" htmlFor={numberId}>
            {isBet ? 'Bet' : 'Raise to'}
          </label>
          <input
            id={numberId}
            className="prl-sizer__number"
            type="number"
            inputMode="numeric"
            min={bounds.min}
            max={bounds.max}
            step={1}
            value={draft?.text ?? String(to)}
            aria-describedby={describedBy}
            aria-invalid={malformed ? true : undefined}
            // `validity.badInput` can only be read here. The value is already sanitised to '' on arrival.
            onChange={(event) =>
              onDraft({ text: event.target.value, badInput: event.target.validity.badInput })
            }
            // Blur writes the clamped value back, which also clears any unparseable text.
            onBlur={() => onDraft({ text: String(to), badInput: false })}
          />
        </span>
      </div>

      {malformed ? (
        <p className="prl-field__error prl-sizer__error" id={invalidId}>
          <span aria-hidden="true">{'▲ '}</span>
          {'Type a whole number, or use the slider or a size button.'}
        </p>
      ) : null}

      {clamped === null ? null : (
        <p className="prl-field__hint prl-sizer__clamped" id={clampedId}>
          {`${clamped > bounds.max ? `${formatChips(clamped)} is over the max` : clamped < bounds.min ? `${formatChips(clamped)} is under the min` : 'Whole numbers only'}, so it will be ${formatChips(to)}${isAllIn ? ', all in' : ''}.`}
        </p>
      )}

      <p className="prl-sizer__bounds" id={boundsId}>
        {`Min ${formatChips(bounds.min)}, max ${formatChips(bounds.max)}`}
      </p>

      {/* One span, because the readout is a flex row and its gap split the label from the figure. */}
      <p className="prl-sizer__readout">
        {isAllIn ? (
          <span className="prl-sizer__readout-value">All in</span>
        ) : (
          <span>
            {'Stack after '}
            <span className="prl-sizer__readout-value">{formatChips(remainingAfter)}</span>
          </span>
        )}
      </p>
    </fieldset>
  );
}

/** The rules behind the buttons, one tap away, so the row itself can stay short. */
function ActionHelp(props: {
  readonly canCheck: boolean;
  readonly canCall: boolean;
  readonly sized: SizedAction | null;
  /** The engine's sentence for an all-in call, when calling takes the whole stack. */
  readonly allInCallNote: string | null;
}): ReactElement {
  const { canCheck, canCall, sized, allInCallNote } = props;
  const bet = sized?.kind === 'bet';
  return (
    <details className="prl-disclose prl-action-help">
      <summary className="prl-disclose__summary">How betting works</summary>
      <ul className="prl-action-help__list">
        <li>
          <strong>Fold</strong>
          {': give up this hand. Chips you have already put in stay in the pot.'}
        </li>
        {canCheck ? (
          <li>
            <strong>Check</strong>
            {': stay in without putting in any more chips.'}
          </li>
        ) : null}
        {canCall ? (
          <li>
            <strong>Call</strong>
            {': match the bet to stay in.'}
            {allInCallNote === null ? null : ` ${allInCallNote}`}
          </li>
        ) : null}
        {sized === null ? null : (
          <li>
            <strong>{bet ? 'Bet' : 'Raise'}</strong>
            {bet
              ? `: put chips in for others to match, from ${formatChips(sized.bounds.min)} up to all your chips.`
              : `: make the bet bigger. "Raise to" is your total for this round, from ${formatChips(sized.bounds.min)} up to all your chips.`}
          </li>
        )}
        {sized === null ? null : (
          <li>
            <strong>The pot buttons</strong>
            {canCall
              ? ': size the raise as a share of the pot after you call.'
              : `: size the ${bet ? 'bet' : 'raise'} as a share of the pot.`}
          </li>
        )}
      </ul>
    </details>
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
    idleAction,
    context,
    className,
  } = props;

  // One state object, so the text, its `badInput` and the bounds it was typed against always come
  // from the same event. A separate flag could outlive the text it described.
  const [stamped, setStamped] = useState<StampedDraft | null>(null);
  /** The spot where Fold was pointer-pressed once beside a free Check. Stamped so it cannot outlive it. */
  const [foldArmedFor, setFoldArmedFor] = useState<string | null>(null);

  /**
   * Focus management for the two ways this bar takes the reader's controls away.
   *
   * When the turn ends every button unmounts and the browser drops focus to `<body>`
   * (`scripts/keyboard-audit.mjs`). The effect on `acting` moves it to the idle line.
   * While a decision is in flight `disabled` blurs the focused button for the whole round trip. The
   * layout effect parks the caret on a `role="status"` line in the row and then returns it to the exact
   * control it came from, so a refusal leaves the reader on the button they pressed.
   *
   * `aria-disabled` was rejected because `components.css` styles only `:disabled`, so the row would look
   * live. The line is a status because Chrome 151 does not report a focused `role="group"` as focused.
   */
  const idleRef = useRef<HTMLParagraphElement>(null);
  const inFlightRef = useRef<HTMLParagraphElement>(null);
  const focus = useFocusRescue();
  const lastControl = useRef<HTMLElement | null>(null);
  /** True only while the caret is on the in-flight line because this component put it there. */
  const parked = useRef(false);
  const wasActing = useRef(false);
  const wasDisabled = useRef(disabled);
  const acting = legalActions.length > 0;

  const onFocusCapture = (event: ReactFocusEvent<HTMLDivElement>): void => {
    focus.onFocusCapture();
    // Landing on the in-flight line is not the reader choosing a control.
    if (event.target === inFlightRef.current) return;
    parked.current = false;
    lastControl.current = event.target;
  };
  const onBlurCapture = (event: ReactFocusEvent<HTMLDivElement>): void => {
    if (focus.onBlurCapture(event)) parked.current = false;
  };

  useEffect(() => {
    const left = wasActing.current && !acting;
    wasActing.current = acting;
    // A timed-out turn checks with the pot unchanged, so the next spot could match a stale arming.
    if (!left) return;
    setFoldArmedFor(null);
    focus.rescue(idleRef.current);
  }, [acting, focus]);

  useLayoutEffect(() => {
    const taken = disabled && !wasDisabled.current;
    const returned = !disabled && wasDisabled.current;
    wasDisabled.current = disabled;

    if (taken) {
      if (!focus.held()) return;
      // Layout, not a microtask, so the rescue cannot lose to Chrome parking the caret on `<html>`.
      // A parent such as TableStage overrides it, since layout effects run child-then-parent.
      inFlightRef.current?.focus({ preventScroll: true });
      parked.current = document.activeElement === inFlightRef.current;
      return;
    }

    if (!returned || !parked.current) return;
    parked.current = false;
    const control = lastControl.current;
    // The row may have been replaced by the next frame, or the control may have come back disabled.
    if (control === null || !control.isConnected) return;
    if (control instanceof HTMLButtonElement && control.disabled) return;
    control.focus({ preventScroll: true });
  }, [disabled, focus]);

  const sized = resolveSizedAction(legalActions);
  const canFold = legalActions.some((action) => action.type === 'fold');
  const canCheck = legalActions.some((action) => action.type === 'check');
  const call = legalActions.find((action) => action.type === 'call');
  const spot = spotSignature(legalActions, toCall, pot, committedThisStreet);
  const foldArmed = foldArmedFor === spot;

  // The single clamp every path goes through. The button reads `to`, so submit cannot disagree with it.
  // `draftForBounds` drops a draft typed against other bounds.
  const bounds = sized?.bounds ?? { min: 0, max: 0 };
  const draft = draftForBounds(stamped, bounds);
  const to = resolveDraft(draft?.text ?? null, bounds);
  const setDraft = (next: BetDraft): void => setStamped({ ...next, bounds });
  const callCost = call?.costAtMin ?? toCall;

  const actFromBar = (action: TableAction): void => {
    focus.claim();
    onAct(action);
  };

  const pressFold = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (foldPress({ canCheck, pointer: event.detail > 0, armed: foldArmed }) === 'arm') {
      setFoldArmedFor(spot);
      return;
    }
    actFromBar({ type: 'fold' });
  };

  const commitSized = (): void => {
    if (sized === null) return;
    // Re-clamped rather than trusted from state, so no path can send an unclamped number.
    const safe = clampBetTo(to, bounds);
    actFromBar(sized.kind === 'bet' ? { type: 'bet', to: safe } : { type: 'raise', to: safe });
  };

  if (legalActions.length === 0) {
    return (
      <div className={cx('prl-action-bar', className)}>
        {context}
        {/* `tabIndex={-1}` lets focus land here without a tab stop. `role="status"` announces it anyway. */}
        <p
          className={cx('prl-action-bar__idle', idleAction !== undefined && 'prl-action-bar__idle--beside')}
          ref={idleRef}
          role="status"
          tabIndex={-1}
        >
          {idleText}
        </p>
        {idleAction === undefined ? null : <div className="prl-action-bar__idle-action">{idleAction}</div>}
      </div>
    );
  }

  return (
    <div
      className={cx('prl-action-bar', className)}
      onBlurCapture={onBlurCapture}
      onFocusCapture={onFocusCapture}
    >
      {/* The amount to call is on the Call button, so the pot is the one figure this line adds. */}
      <p className="prl-action-bar__price">
        <span className="prl-action-bar__price-item">
          <span className="prl-label">Pot</span>
          <span className="prl-action-bar__price-value">{formatChips(pot)}</span>
        </span>
      </p>

      {context}

      {sized === null ? null : (
        <BetSizer
          sized={sized}
          to={to}
          draft={draft}
          pot={pot}
          toCall={toCall}
          committedThisStreet={committedThisStreet}
          disabled={disabled}
          onDraft={setDraft}
        />
      )}

      <div className="prl-action-bar__actions">
        {canFold ? (
          <FoldButton canCheck={canCheck} armed={foldArmed} disabled={disabled} onClick={pressFold} />
        ) : null}

        {canCheck ? (
          <ActionButton
            label="Check"
            spoken={`check, costs ${formatUnits(0)}`}
            disabled={disabled}
            onClick={() => actFromBar({ type: 'check' })}
          />
        ) : null}

        {call === undefined ? null : (
          <ActionButton
            label={`Call ${formatChips(callCost)}`}
            // An all-in call says so (`allInAtMax`). In 3,000 hands, 3,569 of 15,137 call offers were all-in.
            {...(call.allInAtMax ? { cost: 'All in' } : {})}
            spoken={
              call.allInAtMax ? `call ${formatUnits(callCost)}, all in` : `call ${formatUnits(callCost)}`
            }
            disabled={disabled}
            onClick={() => actFromBar({ type: 'call' })}
          />
        )}

        {sized === null ? null : (
          <ActionButton
            {...sizedButtonText(sized.kind, to, bounds, committedThisStreet)}
            primary
            disabled={disabled}
            onClick={commitSized}
          />
        )}
        {/*
          The caret's home during the round trip, mounted only then so an empty status never sits in
          the rotor. It reuses `prl-action-bar__idle` for that class's `:focus-visible` ring.
          It sits inside the sticky action row so a `preventScroll` focus lands on screen. As the next
          block it was off screen at 390x844 (y 1,099 against Fold at 620).
        */}
        {disabled ? (
          <p
            aria-label="Your decision is with the server"
            className="prl-action-bar__idle"
            ref={inFlightRef}
            role="status"
            tabIndex={-1}
          >
            {'Waiting for the server.'}
          </p>
        ) : null}
      </div>

      <div className="prl-action-bar__note">
        {/* Beside a free check, folding throws a hand away for no saving. */}
        {canCheck ? <p className="prl-action-bar__hint">Checking is free.</p> : null}
        <ActionHelp
          canCheck={canCheck}
          canCall={call !== undefined}
          sized={sized}
          allInCallNote={call?.allInAtMax === true ? (call.note ?? null) : null}
        />
      </div>
    </div>
  );
}
