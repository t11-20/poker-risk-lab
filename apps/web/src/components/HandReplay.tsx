'use client';

/**
 * The hand replay: a scrubbable reconstruction of a finished hand, with the analysis for each of the
 * reader's own decisions.
 *
 * ## What this component owns, and what it does not
 *
 * It owns exactly one piece of state: which step is being looked at. Everything else — the seat
 * plates, the pot, the board, the position labels — arrives as a finished `PlayerView` per step,
 * reconstructed on the server by `src/lib/hand-replay.ts`. That split is deliberate and it is a
 * bundle decision: the reconstruction needs `@prl/poker-engine` for card parsing, and the engine's
 * module graph is the shuffler and the deck commitment, which have no business in a browser bundle.
 * Doing it server-side means this file imports no engine at all.
 *
 * ## Why the analysis for an opponent's decision is a paragraph rather than an empty panel
 *
 * The server analyses the requesting reader's own decisions and nothing else, and it is worth being
 * clear that this is a *rule*, not a gap. A Coach report needs the acting player's two cards. For
 * anybody else those cards are either sealed forever — they folded and never showed, and whether
 * they were bluffing is the information the game is played over — or they belong to a different
 * learner. The alternatives are both worse than silence: inventing a holding would produce a
 * confident-looking report about a spot that never existed, and rendering an empty panel would read
 * as a bug and invite somebody to "fix" it by leaking.
 *
 * So an opponent's step gets a short, non-apologetic explanation of the rule. It is not framed as a
 * limitation, because it is not one.
 *
 * ## Motion
 *
 * Two things move, both within the rules of section 5.4. The step panel is keyed on the step index,
 * so changing steps replays a `transform`/`opacity` keyframe — nothing that triggers layout. The
 * pot, the reader's stack and the equity count up through `Metric`'s `countUp`, which writes the
 * final value to the DOM immediately and animates a visually-hidden copy, so a screen reader never
 * reads a number mid-count. Both collapse to nothing under `prefers-reduced-motion` via the duration
 * tokens, and the replay is fully usable with every animation off — the numbers are simply there.
 *
 * ## Announcements
 *
 * A polite live region carries the step change. Focus is never moved by this component *except* to
 * rescue it: the timeline moves focus in response to the reader's own key press and nothing else,
 * and a scrub that yanked the caret would make the replay unusable with a keyboard.
 *
 * The exception is the transport pair, and it is a real defect rather than a hypothetical one.
 * "Previous decision" is `disabled` at step 0 and "Next decision" is `disabled` at the last step, so
 * a keyboard reader stepping through a hand with Enter loses focus the moment they reach either end:
 * the browser blurs a control that becomes disabled, and there is nothing to blur it to but
 * `<body>`. Having read a whole hand they are silently returned to the top of the document. The
 * effect below moves the caret to whichever of the two survived, and only when the browser has in
 * fact given up on it — the same two conditions `ActionBar` uses in `@prl/ui` for the same reason.
 */

import type { HandReviewResponse } from '@prl/contracts';
import {
  Button,
  browserAbandonedFocus,
  CoachPanel,
  formatUnits,
  Metric,
  Panel,
  PokerTable,
  pluralise,
} from '@prl/ui';
import { type ReactElement, useEffect, useId, useRef, useState } from 'react';
import type { HandReplay as Replay, ReplayStep } from '../lib/hand-replay.ts';
import { CommitmentVerifier } from './CommitmentVerifier.tsx';
import { DecisionTimeline, type TimelineMarker, type TimelineStreet } from './DecisionTimeline.tsx';

export interface HandReplayProps {
  readonly review: HandReviewResponse;
  readonly replay: Replay;
}

/** Past tense, because a replay describes what happened rather than what is on offer. */
const ACTION_VERB: Readonly<Record<string, string>> = {
  fold: 'folded',
  check: 'checked',
  call: 'called',
  bet: 'bet',
  raise: 'raised to',
};

/** The compressed label on a marker. Amounts are what left the stack, which is what a reader tracks. */
function markerShort(step: ReplayStep): string {
  const decision = step.decision;
  if (decision === null) return 'END';
  const word = decision.action.toUpperCase();
  if (decision.action === 'raise' && decision.to !== null) return `${word} ${decision.to}`;
  if (decision.amountPaid > 0) return `${word} ${decision.amountPaid}`;
  return word;
}

/** The whole sentence a screen reader gets for a marker. */
function markerDescription(step: ReplayStep, names: Readonly<Record<number, string>>): string {
  const decision = step.decision;
  if (decision === null) return 'End of the hand: final stacks and the settled pot.';
  const who = step.isViewerDecision ? 'you' : (names[decision.seat] ?? `seat ${decision.seat + 1}`);
  const verb = ACTION_VERB[decision.action] ?? decision.action;
  const amount =
    decision.action === 'raise' && decision.to !== null
      ? ` ${formatUnits(decision.to)}`
      : decision.amountPaid > 0
        ? ` ${formatUnits(decision.amountPaid)}`
        : '';
  const automatic = decision.wasAutomatic ? ' The clock ran out and the server acted.' : '';
  const analysis = step.analysis === null ? '' : ' An analysis is attached to this decision.';
  return `${decision.street}: ${who} ${verb}${amount}.${automatic}${analysis}`;
}

function buildMarkers(replay: Replay): readonly TimelineMarker[] {
  return replay.steps.map((step) => ({
    index: step.index,
    street: step.decision === null ? 'settled' : step.decision.street,
    short: markerShort(step),
    description: markerDescription(step, replay.seatNames),
    isViewer: step.isViewerDecision,
    hasAnalysis: step.analysis !== null,
    isTerminal: step.decision === null,
  }));
}

function buildStreets(replay: Replay): readonly TimelineStreet[] {
  return replay.streets.map((street) => ({
    key: street.key,
    label: street.label,
    position: street.position,
    markerIndexes: street.stepIndexes,
  }));
}

/**
 * The three figures above the table: the pot, the reader's stack, and their equity.
 *
 * All three count up on a step change through `Metric`'s `countUp`, which writes the final value to
 * the DOM immediately and animates a visually-hidden copy — so a screen reader never reads a number
 * mid-count, and the count is skipped outright under `prefers-reduced-motion`.
 *
 * The equity tile is the one that can be absent, and it says why rather than showing a dash. An
 * opponent's decision has no equity figure because it has no analysis, and that is a rule rather
 * than a gap.
 */
function StepMetrics({ step }: { readonly step: ReplayStep }): ReactElement {
  const analysis = step.analysis;
  const seat = step.view.seats.find((candidate) => candidate.isSelf);
  const interval =
    analysis === null || analysis.equity.confidenceHalfWidthPoints === null
      ? undefined
      : `± ${analysis.equity.confidenceHalfWidthPoints.toFixed(2)} points`;
  const method =
    analysis === null
      ? undefined
      : `${analysis.equity.method === 'monte-carlo' ? 'Monte Carlo sampling' : 'Exact enumeration'}, ${pluralise(
          analysis.equity.trials,
          analysis.equity.method === 'monte-carlo' ? 'trial' : 'board',
        )}.`;

  return (
    <div className="prl-replay__metrics">
      <Metric label="Pot" value={step.view.potTotal} format="units" countUp size="md" />
      {seat === undefined ? null : (
        <Metric label="Your stack" value={seat.stack} format="units" countUp size="md" />
      )}
      {analysis === null ? (
        <Metric
          label="Your equity"
          value={Number.NaN}
          format="percent"
          size="md"
          // `null` rather than the default "%": `formatPercent` renders a non-finite value as an em
          // dash, and "— %" reads as a broken figure where "—" reads as an absent one. The note
          // beneath carries the reason, so the unit has no work left to do.
          unit={null}
          note="Computed for your own decisions only — see the panel below."
        />
      ) : (
        <Metric
          label="Your equity"
          value={analysis.equity.heroEquity}
          format="percent"
          countUp
          size="md"
          {...(interval === undefined ? {} : { interval })}
          {...(method === undefined ? {} : { note: method })}
        />
      )}
    </div>
  );
}

/** One settled seat. The sign is in the digits AND in the word, so the colour is the third signal. */
function ResultRow({
  name,
  isBot,
  net,
}: {
  readonly name: string;
  readonly isBot: boolean;
  readonly net: number;
}): ReactElement {
  const sign = net > 0 ? 'positive' : net < 0 ? 'negative' : 'neutral';
  return (
    <div className="prl-replay__result-row">
      <dt>{`${name}${isBot ? ' (bot)' : ''}`}</dt>
      <dd data-sign={sign}>
        {`${net > 0 ? '+' : ''}${formatUnits(net)} `}
        <span className="prl-replay__result-word">{net > 0 ? 'gained' : net < 0 ? 'lost' : 'level'}</span>
      </dd>
    </div>
  );
}

export function HandReplay({ review, replay }: HandReplayProps): ReactElement {
  const [stepIndex, setStepIndex] = useState(0);
  const instructionsId = useId();
  /**
   * The transport row, so the rescue below can find whichever button is still enabled.
   *
   * A `ref` on the buttons themselves would be tidier and is not available: `Button` in `@prl/ui` is
   * a plain function component that does not declare one, and adding it there is a change to a
   * shared package for a problem this container owns. Querying inside a row that holds exactly two
   * buttons is unambiguous.
   */
  const transportRef = useRef<HTMLDivElement | null>(null);
  /** Which transport control the reader last pressed, so a scrub from the timeline moves nothing. */
  const pressed = useRef<'previous' | 'next' | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `stepIndex` is the TRIGGER, not a value read here — the effect asks the DOM what survived rather than deriving anything from the index. Without it, focus is never rescued at either end of the hand.
  useEffect(() => {
    const which = pressed.current;
    pressed.current = null;
    if (which === null) return;
    // Only when the browser has actually dropped focus, which is what it does to a control that
    // becomes disabled. If the pressed button is still enabled it still has the caret.
    //
    const row = transportRef.current;
    if (row === null) return;
    // Two ways the caret is lost, and this used to test only the first — which is the one that has
    // not happened yet when this runs.
    //
    // Measured 2026-08-27 by instrumenting this effect and walking the transport to the end: on
    // every press, including the last, `browserAbandonedFocus()` was **false**. Chrome had not
    // moved focus yet. It blurs a control that becomes `disabled` AFTER React's effect, so at this
    // instant `document.activeElement` is still the button the reader pressed, now disabled. A
    // probe taken later in the same run found `BODY`. The old guard therefore returned early every
    // single time and the rescue never ran once — a reader who had just stepped through fifteen
    // decisions was returned to the top of the document, which is exactly what J6.5 says.
    //
    // `ActionBar`'s `browserAbandonedFocus` is still the right test for the state AFTER the blur
    // (it learned that Chrome can land on `<html>` rather than `<body>`), so it is kept for that
    // case. What is added is the case before: the caret is on a disabled control inside this row.
    // Either way the reader cannot be told where they are, and either way the answer is the
    // transport control that survived.
    const active = document.activeElement;
    const caretOnDisabledControl =
      active instanceof HTMLButtonElement && active.disabled && row.contains(active);
    if (!browserAbandonedFocus() && !caretOnDisabledControl) return;
    row.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [stepIndex]);

  const markers = buildMarkers(replay);
  const streets = buildStreets(replay);
  const total = replay.steps.length;
  // Clamped rather than trusted: `steps` is a prop, and a shorter one arriving under a stale index
  // would index past the end. `?? steps[0]` keeps the component total.
  const step = replay.steps[Math.min(stepIndex, total - 1)] ?? replay.steps[0];

  if (step === undefined) {
    return (
      <p className="prl-empty">
        This hand has no recorded actions, so there is nothing to replay. That happens when a hand was
        abandoned before anybody acted.
      </p>
    );
  }

  const analysis = step.analysis;
  // Seats the server disclosed. Named on screen, because a replay that shows an opponent's cards
  // from step one without saying why invites the reader to think the analysis knew them too.
  const shownSeats = review.seats
    .filter((seat) => seat.showedDown && seat.holeCards !== null && seat.seat !== replay.viewerSeat)
    .map((seat) => seat.displayName);

  return (
    <div className="prl-replay">
      <p className="prl-note" id={instructionsId}>
        Use the left and right arrow keys to step through the hand one decision at a time, Page Up and Page
        Down to jump a street, and Home or End for the first and last. The table, the pot and the analysis all
        follow the marker you are on.
      </p>

      <DecisionTimeline
        markers={markers}
        streets={streets}
        activeIndex={step.index}
        onSelect={setStepIndex}
        instructionsId={instructionsId}
      />

      <div className="prl-replay__transport" ref={transportRef}>
        <Button
          variant="secondary"
          size="sm"
          disabled={step.index === 0}
          onClick={() => {
            pressed.current = 'previous';
            setStepIndex(step.index - 1);
          }}
        >
          Previous decision
        </Button>
        <p className="prl-replay__position">
          <span className="prl-label">Step</span>
          <span className="prl-replay__position-value">{`${step.index + 1} / ${total}`}</span>
        </p>
        <Button
          variant="secondary"
          size="sm"
          disabled={step.index === total - 1}
          onClick={() => {
            pressed.current = 'next';
            setStepIndex(step.index + 1);
          }}
        >
          Next decision
        </Button>
      </div>

      {/* Polite, and never focused. The sentence is the same one the marker announces. */}
      <div className="prl-live-region" role="status" aria-live="polite">
        {`Step ${step.index + 1} of ${total}. ${markerDescription(step, replay.seatNames)} Pot ${formatUnits(
          step.view.potTotal,
        )}.`}
      </div>

      {replay.potDerivationDisagrees ? (
        <div className="prl-error" role="note">
          <p className="prl-error__title">
            <span aria-hidden="true">! </span>
            Error — the reconstruction disagrees with the recorded pot
          </p>
          <p>
            The stacks and street commitments on this table are rebuilt from the action log, and at least one
            step of that rebuild did not add up to the pot the server recorded. The pot figure below is the
            server&rsquo;s and is right; treat the per-seat stacks as unreliable for this hand.
          </p>
        </div>
      ) : null}

      {/* Keyed on the step, so a change replays the transform/opacity keyframe. */}
      <div className="prl-replay__stage" key={step.index}>
        <StepMetrics step={step} />

        <PokerTable
          view={step.view}
          seatNames={replay.seatNames}
          title={`Hand ${review.hand.handNumber} — ${step.decision === null ? 'settled' : step.decision.street}`}
        />

        {shownSeats.length === 0 ? null : (
          <p className="prl-replay__caption">
            {`${shownSeats.join(' and ')} ${shownSeats.length === 1 ? 'showed' : 'showed'} at the end of this hand, so ${
              shownSeats.length === 1 ? 'their cards are' : 'those cards are'
            } visible from the first step of the replay rather than appearing at the showdown — the server has already disclosed them, and hiding them again would be theatre. The analysis does NOT use them: it models every opponent with one stated range, because a range is what you had to decide against at the time.`}
          </p>
        )}

        <p className="prl-replay__caption">
          {step.decision === null
            ? `The hand is over. ${
                review.hand.endedByFold
                  ? 'It ended with everybody folding, so no cards were shown.'
                  : 'It went to a showdown, so the hands that were shown are visible above.'
              }`
            : `About to act: ${markerDescription(step, replay.seatNames)}`}
        </p>
      </div>

      {analysis !== null ? (
        <CoachPanel report={analysis} title="Your decision, analysed" />
      ) : step.decision === null ? (
        <Panel title="How the hand settled" eyebrow="Result" headingLevel={2}>
          <dl className="prl-replay__result">
            {review.seats.map((seat) => (
              <ResultRow key={seat.seat} name={seat.displayName} isBot={seat.isBot} net={seat.net} />
            ))}
          </dl>
          <p className="prl-note">
            Net is the change across the whole hand, blinds included. The sign is in the number and the word
            beside it, so it does not depend on noticing a colour.
          </p>
        </Panel>
      ) : step.isViewerDecision ? (
        <Panel title="No analysis for this decision" eyebrow="Coach" headingLevel={2}>
          <p className="prl-prose">
            This is one of your own decisions, so the server was willing to analyse it, but it did not return
            a report. A review analyses a bounded number of decisions per hand and refuses any spot it cannot
            reconstruct exactly — a replayed pot that disagrees with the recorded one, a street with a board
            that does not match it, or more opponents than the Coach models. It reports nothing rather than a
            figure it does not stand behind.
          </p>
        </Panel>
      ) : (
        <Panel title="Analysis is only for your own decisions" eyebrow="Coach" headingLevel={2}>
          <p className="prl-prose">
            {`This decision belongs to ${
              replay.seatNames[step.decision.seat] ?? `seat ${step.decision.seat + 1}`
            }, and it is not analysed — by design, not because something is missing.`}
          </p>
          <p className="prl-prose">
            An analysis needs the acting player&rsquo;s two cards. For anybody but you those cards are either
            sealed for good, because they folded and never showed, or they belong to another learner. Whether
            a player who folded was bluffing or holding a monster is the information the whole game is played
            over, and the server will not disclose it after the hand any more than during it.
          </p>
          <p className="prl-prose">
            Picking a plausible hand out of a range and analysing that instead would produce a
            confident-looking report about a spot that never happened. Step to one of your own markers — they
            carry a <span aria-hidden="true">▸</span> and a <span aria-hidden="true">+</span> on the timeline
            — to see a real one.
          </p>
        </Panel>
      )}

      <CommitmentVerifier
        commitmentRoot={review.commitmentRoot}
        commitmentContext={review.commitmentContext}
        reveal={review.reveal}
        serverVerification={review.verification}
      />
    </div>
  );
}
