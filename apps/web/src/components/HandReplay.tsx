'use client';

/**
 * The hand replay: a scrubbable reconstruction of a finished hand, with the analysis for each of the
 * reader's own decisions.
 *
 * The only state here is the step index. Each step's `PlayerView` is rebuilt on the server by
 * `src/lib/hand-replay.ts`, so no engine code reaches the browser bundle. An opponent's decision gets
 * an explanation, not an analysis, because a report needs their two cards, which are sealed or belong
 * to another learner.
 *
 * Motion follows section 5.4 and collapses under reduced motion. Focus moves only to rescue the caret
 * when a transport button disables itself at either end of the hand.
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
import { netWord } from '../lib/net-words.ts';
import {
  automaticAside,
  automaticSentence,
  markerActor,
  markerShort,
  openingStepIndex,
  stepCounter,
} from '../lib/replay-steps.ts';
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

/** "folded", "raised to 60 units", "called 20 units": the verb and the amount, with no actor. */
function actionPhrase(step: ReplayStep): string {
  const decision = step.decision;
  if (decision === null) return '';
  const verb = ACTION_VERB[decision.action] ?? decision.action;
  const amount =
    decision.action === 'raise' && decision.to !== null
      ? ` ${formatUnits(decision.to)}`
      : decision.amountPaid > 0
        ? ` ${formatUnits(decision.amountPaid)}`
        : '';
  return `${verb}${amount}`;
}

/** The whole sentence a screen reader gets for a marker, and the one the live region carries. */
function markerDescription(step: ReplayStep, names: Readonly<Record<number, string>>): string {
  const decision = step.decision;
  if (decision === null) return 'End of the hand: final stacks and the settled pot.';
  const who = step.isViewerDecision ? 'you' : (names[decision.seat] ?? `seat ${decision.seat + 1}`);
  const automatic = automaticSentence(step);
  const analysis = step.analysis === null ? '' : ' An analysis is attached to this decision.';
  return `${decision.street}: ${who} ${actionPhrase(step)}.${automatic}${analysis}`;
}

/**
 * Who did what, for the transport. Not a live region, because J6.2 fails a step announced twice.
 * "To act:" because a step is positioned before its decision, with the bet not yet in.
 */
function stepHeadline(step: ReplayStep, names: Readonly<Record<number, string>>): string {
  if (step.decision === null) return 'The hand is over.';
  const automatic = automaticAside(step);
  return `To act: ${markerActor(step, names) ?? ''} — ${actionPhrase(step)}${automatic}.`;
}

/**
 * A glyph plus words visually hidden below 600px, so the name stays "Previous decision" (J6.5 finds
 * it) while the row fits one line at 360px.
 */
function TransportLabel({ glyph, words }: { readonly glyph: string; readonly words: string }): ReactElement {
  return (
    <>
      <span className="prl-replay__step-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="prl-replay__step-words">{words}</span>
    </>
  );
}

/** The street word for the transport: "Preflop", "Flop", or "Settled" for the terminal frame. */
function stepStreet(step: ReplayStep): string {
  const key = step.decision === null ? 'settled' : step.decision.street;
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function buildMarkers(replay: Replay): readonly TimelineMarker[] {
  return replay.steps.map((step) => ({
    index: step.index,
    street: step.decision === null ? 'settled' : step.decision.street,
    actor: markerActor(step, replay.seatNames),
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

/** Pot, stack and equity. An opponent's step has no equity, and the tile says why instead of a dash. */
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
          // `null`, because "— %" reads as a broken figure and the note carries the reason.
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
        <span className="prl-replay__result-word">{netWord(net)}</span>
      </dd>
    </div>
  );
}

export function HandReplay({ review, replay }: HandReplayProps): ReactElement {
  // Opens on the reader's first decision, computed from props so hydration agrees.
  const [stepIndex, setStepIndex] = useState(() => openingStepIndex(replay));
  const instructionsId = useId();
  /** The transport row. `Button` takes no ref, so the rescue queries this row's two buttons. */
  const transportRef = useRef<HTMLDivElement | null>(null);
  /** Which transport control the reader last pressed, so a scrub from the timeline moves nothing. */
  const pressed = useRef<'previous' | 'next' | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `stepIndex` is the TRIGGER, not a value read here — the effect asks the DOM what survived rather than deriving anything from the index. Without it, focus is never rescued at either end of the hand.
  useEffect(() => {
    const which = pressed.current;
    pressed.current = null;
    if (which === null) return;
    const row = transportRef.current;
    if (row === null) return;
    // Chrome blurs a newly disabled button after this effect runs, so the caret may still be on it
    // (measured 2026-08-27, J6.5) or already on the document. Both cases rescue to the survivor.
    // If this row grows a third control or remounts, use `ActionBar`'s focus tracking instead.
    const active = document.activeElement;
    const caretOnDisabledControl =
      active instanceof HTMLButtonElement && active.disabled && row.contains(active);
    if (!browserAbandonedFocus() && !caretOnDisabledControl) return;
    row.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [stepIndex]);

  const markers = buildMarkers(replay);
  const streets = buildStreets(replay);
  const total = replay.steps.length;
  // Clamped, because a shorter `steps` could arrive under a stale index.
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
  const counter = stepCounter(step, replay);
  // Named on screen, so the reader knows why an opponent's cards show from step one.
  const shownSeats = review.seats
    .filter((seat) => seat.showedDown && seat.holeCards !== null && seat.seat !== replay.viewerSeat)
    .map((seat) => seat.displayName);

  return (
    <div className="prl-replay">
      <p className="prl-note" id={instructionsId}>
        Use the left and right arrow keys to step through the hand one decision at a time, Page Up and Page
        Down to jump a street, and Home or End for the first and last. The replay opens on your own first
        decision; Home goes back to the start of the hand. The table, the pot and the analysis all follow the
        marker you are on.
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
          className="prl-replay__step-button"
          disabled={step.index === 0}
          onClick={() => {
            pressed.current = 'previous';
            setStepIndex(step.index - 1);
          }}
        >
          <TransportLabel glyph="‹" words="Previous decision" />
        </Button>
        {/* Plain text, not a live region. J6.2 fails a step announced from two places. */}
        <div className="prl-replay__now">
          <p className="prl-replay__position">
            <span className="prl-label">{counter.label}</span>
            <span className="prl-replay__position-value">{counter.value}</span>
            {step.decision === null ? null : (
              <span className="prl-label prl-replay__street">{stepStreet(step)}</span>
            )}
          </p>
          <p className="prl-replay__headline">{stepHeadline(step, replay.seatNames)}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="prl-replay__step-button"
          disabled={step.index === total - 1}
          onClick={() => {
            pressed.current = 'next';
            setStepIndex(step.index + 1);
          }}
        >
          <TransportLabel glyph="›" words="Next decision" />
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

        {/* The terminal frame only. For a decision the transport headline says it. */}
        {step.decision === null ? (
          <p className="prl-replay__caption">
            {review.hand.endedByFold
              ? 'It ended with everybody folding, so no cards were shown.'
              : 'It went to a showdown, so the hands that were shown are visible above.'}
          </p>
        ) : null}
      </div>

      {analysis !== null ? (
        <CoachPanel report={analysis} title="Your decision, analysed" />
      ) : step.decision === null ? (
        <Panel title="How the hand settled" eyebrow="Result" headingLevel={2}>
          <dl className="prl-replay__result">
            {review.seats.map((seat) => (
              <ResultRow
                key={seat.seat}
                // The replay's names, so the reader's seat is "You" as on the table.
                name={replay.seatNames[seat.seat] ?? seat.displayName}
                isBot={seat.isBot}
                net={seat.net}
              />
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
