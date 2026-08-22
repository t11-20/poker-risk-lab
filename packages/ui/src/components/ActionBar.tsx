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
 * The draft is *text*, not a number, on purpose. Clamping on every keystroke makes the field
 * unusable: type `5` on the way to `500` and it snaps to the minimum before the second digit lands.
 * The string is what the reader is typing; the clamped number is what the button will send. They
 * are allowed to disagree while the field has focus — which is why the readout always shows the
 * number that will actually be sent, and why blur normalises the text back to it.
 *
 * It carries `badInput` alongside the text because on an `<input type="number">` the text is not
 * enough to know what is in the field: the browser sanitises anything it cannot parse to `''`, so
 * letters on screen and an empty field are indistinguishable from the value alone. See `BetDraft`.
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
 *  - The number field carries a real invalid state: `aria-invalid` plus a visible correction that
 *    `aria-describedby` names FIRST, ahead of the range. The state is read from
 *    `event.target.validity.badInput` and could not have been derived from the value — a number
 *    input reports `value === ''` for text it failed to parse, so a check written against the
 *    draft can never fire, and the field would sit there looking empty while the reader looks at
 *    their own letters. That silent version is the "clamp without marking the field" the audit
 *    named on the quiz's numeric answer, and this is the same control in the shared package.
 *  - The sizer is a `<fieldset>` with a `<legend>`, so its controls are announced as one group, and
 *    `disabled` on the fieldset disables all of them at once.
 */

import {
  type ReactElement,
  type FocusEvent as ReactFocusEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import {
  type BetDraft,
  clampBetTo,
  isDraftMalformed,
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
  /**
   * Disables every control, e.g. while an action is in flight.
   *
   * Setting this takes the focused control away from whoever was standing on it, so this component
   * also renders somewhere for the caret to go and puts it there. See the focus block in
   * `ActionBar` — the behaviour is part of what this prop means, not a detail of it.
   */
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
  /** What the reader has typed, which may be mid-edit and therefore unclamped. Null before then. */
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

  const { bounds } = sized;
  const isBet = sized.kind === 'bet';
  const stackBehind = bounds.max - committedThisStreet;
  const cost = to - committedThisStreet;
  const remainingAfter = bounds.max - to;
  const isAllIn = to >= bounds.max && bounds.max > bounds.min;

  /**
   * The field is marked invalid when it is holding text this control cannot size a bet with.
   *
   * "Invalid" means the INPUT and never the amount: a legal-but-unwise size is a correct use of
   * this field, and `resolveDraft` clamps an out-of-range number rather than refusing it, so a
   * number outside the bounds is not invalid either — it is a number the sizer has already
   * corrected, and the readout says so.
   *
   * The correction comes FIRST in `aria-describedby`, so a reader who has just been told the
   * field is invalid hears why before hearing the allowed range again. It is rendered only while
   * it applies rather than hidden with CSS: a description that is present but usually irrelevant
   * is read out on every visit to the field.
   */
  const malformed = isDraftMalformed(draft);
  const describedBy = malformed ? `${invalidId} ${boundsId}` : boundsId;

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
          // A slider cannot produce unparseable text, so dragging it also clears the invalid
          // state — which is the point of carrying the flag in the draft rather than beside it.
          onChange={(event) => onDraft({ text: event.currentTarget.value, badInput: false })}
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
            value={draft?.text ?? String(to)}
            aria-describedby={describedBy}
            aria-invalid={malformed ? true : undefined}
            // `validity.badInput` is read here and nowhere else, because here is the only place it
            // can be read. The value has ALREADY been sanitised to '' by the time it arrives, so
            // no later inspection of the draft could recover the fact that anything was typed —
            // and a field that silently reads as empty while the reader is looking at their own
            // letters is exactly the state this markup exists to name.
            onChange={(event) =>
              onDraft({ text: event.target.value, badInput: event.target.validity.badInput })
            }
            // Normalising on blur is what makes the typed text and the clamped value agree again
            // once the field is left. Writing a real number over the field also clears whatever
            // the browser was holding, so the invalid state goes with it.
            onBlur={() => onDraft({ text: String(to), badInput: false })}
          />
        </span>
      </div>

      {malformed ? (
        <p className="prl-field__error prl-sizer__error" id={invalidId}>
          <span aria-hidden="true">{'▲ '}</span>
          {
            'That is not an amount. Type whole units — or use the slider or a preset above, which always set a legal size.'
          }
        </p>
      ) : null}

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

  // One piece of state, not two: the text and whether the browser could parse it are set by the
  // same event and must never be read from different renders. A separate `badInput` flag could
  // outlive the text it described — a preset click clearing the value while the flag stayed true
  // would leave a legal amount marked invalid.
  const [draft, setDraft] = useState<BetDraft | null>(null);

  /**
   * Where focus goes when the controls it was on are taken away, in the TWO ways that happens.
   *
   * ## The first defect: the turn ends
   *
   * Found by `scripts/keyboard-audit.mjs` folding a real hand with the keyboard: pressing Enter on
   * Fold unmounts every button in this bar — correctly, it is no longer this seat's turn — and the
   * browser's only remaining option is to drop focus to `<body>`. A keyboard user who has just
   * acted is therefore returned to the very top of the document, with no announcement, and has to
   * tab past the whole page to get back to the table. A screen-reader user is worse off again:
   * nothing was announced at all, because focus did not land on anything that says something.
   *
   * ## The second defect: the whole round trip before that
   *
   * `disabled` goes true the instant a decision is sent, and a browser blurs the focused element
   * the moment it becomes disabled. So the caret sat on `<body>` for the ENTIRE server round trip —
   * every action, every time — and the rescue above did not cover it, because it fires when
   * `legalActions` goes empty and that only happens when the server's next frame arrives. On a
   * fixture path, where no frame ever arrives, it was permanent.
   *
   * ## What was chosen, and what was rejected
   *
   * **Rejected: `aria-disabled` with a no-op handler.** It is the only option that keeps the caret
   * exactly where the reader put it, and it was very nearly the answer. Two costs sank it. The
   * control then *looks* operable — `:disabled` is what `components.css` styles, and nothing in
   * this repository styles `[aria-disabled]`, so the whole row would keep its enabled colours,
   * hover and pointer while doing nothing; a player pressing Fold twice at a table because it
   * looked live is a worse failure than a lost caret. And a control that is in the tab order but
   * inert makes `disabled` mean two different things to the harnesses that read it.
   *
   * **Rejected: keeping the button focused while disabled.** A disabled control is removed from
   * the accessibility tree by some combinations of browser and screen reader, so the caret would be
   * on a node the reader is told nothing about — the same silence, in a different place.
   *
   * **Chosen: a named place inside the bar, and the reader is put back afterwards.** The controls
   * stay natively `disabled`, so nothing about how they look or how they are read changes. A line
   * mounts while `disabled` holds, carrying `role="group"` and an `aria-label` — measured in Chrome
   * 151 by `TableStage.tsx`: a bare focusable `<div>` computes an EMPTY name, and `group` is the
   * role that can carry one — and the caret goes there, so what the reader hears is where their
   * decision went. When the answer arrives the line unmounts and the caret is returned to the exact
   * control it came from, which is the half that makes this a fix rather than a relocation: a
   * refusal leaves the reader on the button they pressed, ready to press it again.
   *
   * The honest cost: for the length of the round trip the reader is somewhere they did not choose
   * to be, and pressing Tab from it moves on rather than back. That is the price of `disabled`
   * being real, and it is paid on purpose.
   *
   * ## Why the rescue yields for a microtask first
   *
   * A caller may already handle this from outside, and `apps/web/src/components/TableStage.tsx`
   * does: it moves the caret to the acknowledgement that says what became of the decision, which
   * carries more than this bar can know. Effects run child-first inside one commit, so an
   * unconditional rescue here would win that race every time and quietly replace a better
   * destination. `queueMicrotask` runs after the whole passive-effect flush — after any parent's
   * rescue — and the re-check of `document.activeElement` then stands down if anybody else has
   * taken it. No paint happens in between, so nothing is announced twice.
   *
   * ## The guards, which are load-bearing
   *
   * Focus moves only when it was inside this bar to begin with: a table where the opponent acts
   * while the reader is halfway down the Coach panel must not have focus yanked back here, which
   * would be a worse bug than the one being fixed and is how "manage focus" usually goes wrong. And
   * only when the browser has actually given up on focus, so anything that legitimately holds it
   * keeps it.
   *
   * `hadFocus` stays true through a disable or an unmount on purpose. `focusout` fires with a null
   * `relatedTarget` in both cases, and treating that as "focus left the bar" would clear the flag a
   * moment before the effect needs to read it.
   */
  const idleRef = useRef<HTMLParagraphElement>(null);
  const inFlightRef = useRef<HTMLParagraphElement>(null);
  const hadFocus = useRef(false);
  /** The control the reader was on, so it can be given back when the decision comes home. */
  const lastControl = useRef<HTMLElement | null>(null);
  /** True only while the caret is on the in-flight line because this component put it there. */
  const parked = useRef(false);
  const wasActing = useRef(false);
  const wasDisabled = useRef(disabled);
  const acting = legalActions.length > 0;

  const onFocusCapture = (event: ReactFocusEvent<HTMLDivElement>): void => {
    hadFocus.current = true;
    // The in-flight line is not somewhere to be returned to, and arriving there is not the reader
    // choosing to leave it. Everything else inside the bar is both.
    if (event.target === inFlightRef.current) return;
    parked.current = false;
    lastControl.current = event.target;
  };
  const onBlurCapture = (event: ReactFocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;
    // Null means the focused node was removed or disabled, not that the reader went elsewhere.
    if (next !== null && !event.currentTarget.contains(next)) {
      hadFocus.current = false;
      parked.current = false;
    }
  };

  useEffect(() => {
    const left = wasActing.current && !acting;
    wasActing.current = acting;
    if (!left || !hadFocus.current) return;
    // Only when the browser has actually given up on focus. If something else legitimately took it
    // — a Coach panel that re-rendered and restored its own — leave it alone.
    if (document.activeElement !== document.body && document.activeElement !== null) return;
    idleRef.current?.focus();
    hadFocus.current = false;
  }, [acting]);

  useEffect(() => {
    const taken = disabled && !wasDisabled.current;
    const returned = !disabled && wasDisabled.current;
    wasDisabled.current = disabled;

    if (taken) {
      if (!hadFocus.current) return;
      queueMicrotask(() => {
        if (document.activeElement !== document.body && document.activeElement !== null) return;
        inFlightRef.current?.focus();
        parked.current = document.activeElement === inFlightRef.current;
      });
      return;
    }

    if (!returned || !parked.current) return;
    parked.current = false;
    const control = lastControl.current;
    // `isConnected` because the whole row may have been replaced by the server's next frame, in
    // which case the turn is over and the rescue above owns what happens next; and the disabled
    // check because a control that came back still disabled is not somewhere to leave a reader.
    if (control === null || !control.isConnected) return;
    if (control instanceof HTMLButtonElement && control.disabled) return;
    control.focus();
  }, [disabled]);

  const sized = resolveSizedAction(legalActions);
  const canFold = legalActions.some((action) => action.type === 'fold');
  const canCheck = legalActions.some((action) => action.type === 'check');
  const call = legalActions.find((action) => action.type === 'call');

  // The single clamp every path goes through. `draft` is what the reader typed; `to` is what will
  // be sent, and the two cannot disagree at submit time because the button reads `to`.
  const bounds = sized?.bounds ?? { min: 0, max: 0 };
  const to = resolveDraft(draft?.text ?? null, bounds);
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
        {/*
          `tabIndex={-1}` so the effect above can land focus here, and `role="status"` so the same
          sentence is announced whether or not focus arrived. Not in the tab order: a reader tabbing
          past a table that is not theirs to act on should not stop on a line that says so.
        */}
        <p className="prl-action-bar__idle" ref={idleRef} role="status" tabIndex={-1}>
          {idleText}
        </p>
      </div>
    );
  }

  const sizedWord = sized?.kind === 'bet' ? 'Bet to' : 'Raise to';

  return (
    <div
      className={cx('prl-action-bar', className)}
      onBlurCapture={onBlurCapture}
      onFocusCapture={onFocusCapture}
    >
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

      {/*
        The caret's home for the length of the round trip, mounted only while there is one.

        Not always present: a labelled group that is always there sits in every reader's rotor
        announcing an empty container on a table where nothing has been sent. `TableStage` reached
        the same conclusion about its acknowledgement for the same reason.

        It borrows `prl-action-bar__idle`, which is the other line in this bar that exists to be
        landed on and is the one place in `components.css` with a `:focus-visible` ring drawn for
        exactly that — "unlike <main>, this is a place focus arrives at unexpectedly, and a reader
        who has just folded needs to see where they now are". Sharing it means the two lines cannot
        drift apart visually; it costs a class name that says `idle` on a line that is not idle at
        all, and this comment is the whole of the mitigation for that.

        The label and the sentence deliberately do not say the same thing: the label is announced as
        the name of the place the caret arrived at, and the sentence is what is on the screen.
      */}
      {disabled ? (
        // biome-ignore lint/a11y/useSemanticElements: the rule points at <fieldset>, which is for form controls and would bring a required <legend> and a border with it. This is one sentence that the caret is moved to, and `group` is the role ARIA has for a named container of exactly that kind. `TableStage` in apps/web documents the same false positive from the same rule, for the same markup and the same reason.
        <p
          aria-label="Your decision is with the server"
          className="prl-action-bar__idle"
          ref={inFlightRef}
          role="group"
          tabIndex={-1}
        >
          {'Waiting for the server.'}
        </p>
      ) : null}

      <p className="prl-action-bar__note">
        {'Folding costs nothing and gives up any claim on the pot. '}
        {sized?.note ?? ''}
      </p>
    </div>
  );
}
