'use client';

/**
 * The decision timeline: a street-by-street spine with one marker per action, used to scrub a
 * finished hand.
 *
 * ============================================================================
 * THE KEYBOARD MODEL, AND WHY IT IS THIS ONE
 * ============================================================================
 *
 * The markers are a **single composite widget with one tab stop** — a roving `tabindex`, where
 * exactly one marker is `tabindex="0"` (the selected one) and every other is `tabindex="-1"`.
 * Arrow keys move between them.
 *
 * The obvious alternative is to leave every marker in the tab order. It was rejected: a
 * ten-decision hand would put ten tab stops between the timeline and the analysis below it, and a
 * reader using the keyboard to reach the Coach panel would have to press Tab ten times to get past
 * a control they were not using. The roving pattern is what the ARIA authoring practices prescribe
 * for exactly this shape, and it is why a native `<select>` is one tab stop rather than one per
 * option.
 *
 * **Activation follows focus.** Arrowing onto a marker scrubs the replay immediately; there is no
 * separate Enter to commit. That is right here for two reasons. Scrubbing is free and reversible —
 * nothing is submitted, nothing is spent — so the cost of an unwanted move is one more arrow press.
 * And a scrubber whose focus and selection can disagree has two cursors, which is a state a reader
 * has to hold in their head for no benefit. (Where activation-follows-focus is wrong is when
 * activating is expensive or destructive, and neither applies.)
 *
 * The full key map, all of it native `<button>` behaviour plus the handler below:
 *
 * | Key                  | Effect                                              |
 * | -------------------- | --------------------------------------------------- |
 * | `→` / `↓`            | next decision                                       |
 * | `←` / `↑`            | previous decision                                   |
 * | `Home` / `End`       | first / last decision                               |
 * | `PageDown`           | first decision of the next street                   |
 * | `PageUp`             | first decision of the previous street               |
 * | `Enter` / `Space`    | select (native button activation; also works)       |
 * | `Tab`                | leaves the timeline entirely                        |
 *
 * Both axes are bound because the spine is horizontal on a wide screen and wraps to a vertical
 * stack on a narrow one. A reader whose arrow key depends on the viewport width would be a reader
 * who has to look before they press.
 *
 * ## Why focus is moved synchronously in the handler
 *
 * Every marker is in the DOM at all times, so the node to focus already exists when the key is
 * pressed. Calling `.focus()` in the handler needs no effect, no layout read and no dependency
 * array — and it keeps focus movement caused by the *reader* strictly separate from state changes
 * caused by anything else. Nothing here moves focus in response to a prop change, which is the
 * rule that keeps a live region from stealing a caret.
 *
 * ## Semantics
 *
 * `role="group"` with a label, and `aria-current="step"` on the selected marker. Not a `tablist`:
 * a tab list implies one panel per tab, and there is one panel here for all of them. Not a
 * `radiogroup` either — a radio group is a form value, and nothing here is submitted.
 * `aria-current="step"` is the attribute for "the current step of a process", which is exactly what
 * a scrub position in a replay is.
 *
 * Each marker's accessible name is a whole sentence — "step 5 of 11, flop, you called 65 units" —
 * because a marker announced as "65" tells a screen-reader user nothing about where they are. The
 * visible text is the compressed form; the sentence is in a visually-hidden span.
 *
 * ## Never colour alone
 *
 * A marker belonging to the reader carries a filled shape, the word "you" in its accessible name,
 * and a `▸` glyph. A marker with an analysis attached carries a `+` glyph and says so in its name.
 * Both would survive the stylesheet being thrown away.
 */

import { formatIndex } from '@prl/ui';
import { type KeyboardEvent, type ReactElement, useRef } from 'react';

export interface TimelineMarker {
  /** Index into the replay's steps. */
  readonly index: number;
  /** Street key, so the marker can be grouped and `PageUp`/`PageDown` can jump. */
  readonly street: string;
  /** Compressed visible text, e.g. `CALL 65` or `END`. */
  readonly short: string;
  /** The whole sentence a screen reader gets. */
  readonly description: string;
  /** True for the reader's own decision. */
  readonly isViewer: boolean;
  /** True when the server returned an analysis for this decision. */
  readonly hasAnalysis: boolean;
  /** True for the terminal frame, which is a position rather than an action. */
  readonly isTerminal: boolean;
}

export interface TimelineStreet {
  readonly key: string;
  readonly label: string;
  readonly position: number;
  readonly markerIndexes: readonly number[];
}

export interface DecisionTimelineProps {
  readonly markers: readonly TimelineMarker[];
  readonly streets: readonly TimelineStreet[];
  readonly activeIndex: number;
  readonly onSelect: (index: number) => void;
  /** Id of a node describing the control, wired up with `aria-describedby`. */
  readonly instructionsId: string;
  readonly className?: string;
}

/** The first marker of the street before or after the one holding `index`. */
function streetJump(streets: readonly TimelineStreet[], index: number, direction: -1 | 1): number | null {
  const at = streets.findIndex((street) => street.markerIndexes.includes(index));
  if (at < 0) return null;
  const target = streets[at + direction];
  if (target === undefined) return null;
  return target.markerIndexes[0] ?? null;
}

interface MarkerProps {
  readonly marker: TimelineMarker;
  readonly total: number;
  readonly isActive: boolean;
  /** Registers the DOM node so the key handler can focus it without an effect. */
  readonly register: (index: number, node: HTMLButtonElement | null) => void;
  readonly onSelect: (index: number) => void;
}

/**
 * One marker.
 *
 * Extracted from the render loop so the state it carries is legible in one place: the roving tab
 * stop, `aria-current`, three `data-` attributes for the stylesheet, three glyphs, and the whole
 * sentence a screen reader gets. Every one of those is a state that must survive the stylesheet
 * being thrown away, which is easier to audit as a component than as forty lines inside a `.map`.
 */
function Marker({ marker, total, isActive, register, onSelect }: MarkerProps): ReactElement {
  return (
    <li className="prl-timeline__slot">
      <button
        type="button"
        className="prl-timeline__marker"
        data-viewer={marker.isViewer ? 'true' : 'false'}
        data-analysis={marker.hasAnalysis ? 'true' : 'false'}
        data-terminal={marker.isTerminal ? 'true' : 'false'}
        // The roving tab stop. Exactly one marker is reachable with Tab.
        tabIndex={isActive ? 0 : -1}
        aria-current={isActive ? 'step' : undefined}
        ref={(node) => register(marker.index, node)}
        onClick={() => onSelect(marker.index)}
      >
        <span className="prl-timeline__glyph" aria-hidden="true">
          {marker.isTerminal ? '■' : marker.isViewer ? '▸' : '·'}
        </span>
        <span className="prl-timeline__short" aria-hidden="true">
          {marker.short}
        </span>
        {marker.hasAnalysis ? (
          <span className="prl-timeline__analysis-mark" aria-hidden="true">
            +
          </span>
        ) : null}
        <span className="prl-visually-hidden">
          {`Step ${marker.index + 1} of ${total}. ${marker.description}`}
        </span>
      </button>
    </li>
  );
}

export function DecisionTimeline(props: DecisionTimelineProps): ReactElement {
  const { markers, streets, activeIndex, onSelect, instructionsId, className } = props;
  // A map rather than an array, because the key is the step index and an array would need it to
  // also be the array position — true today, and a trap the first time a marker is filtered out.
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const total = markers.length;

  const register = (index: number, node: HTMLButtonElement | null): void => {
    if (node === null) buttons.current.delete(index);
    else buttons.current.set(index, node);
  };

  const move = (next: number | null): void => {
    if (next === null || next === activeIndex) return;
    const clamped = Math.max(0, Math.min(total - 1, next));
    onSelect(clamped);
    // The node already exists — every marker is rendered — so this needs no effect.
    buttons.current.get(clamped)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>): void => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        move(activeIndex + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        move(activeIndex - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(total - 1);
        break;
      case 'PageDown':
        move(streetJump(streets, activeIndex, 1));
        break;
      case 'PageUp':
        move(streetJump(streets, activeIndex, -1));
        break;
      default:
        // Everything else, Tab included, keeps its native behaviour.
        return;
    }
    // Only reached when a key above was handled, so the page never loses a scroll it wanted.
    event.preventDefault();
  };

  return (
    // A native `<fieldset>` rather than `role="group"` on a div. The markers are `<button>`s, which
    // are form controls, so the native grouping element applies — and it carries its own accessible
    // name through `<legend>` with no ARIA at all. One less attribute that can go stale.
    <fieldset
      className={['prl-timeline', className].filter((part) => part !== undefined).join(' ')}
      aria-describedby={instructionsId}
      onKeyDown={onKeyDown}
    >
      <legend className="prl-visually-hidden">Decision timeline</legend>
      <ol className="prl-timeline__streets">
        {streets.map((street) => (
          <li className="prl-timeline__street" key={street.key} data-street={street.key}>
            <p className="prl-timeline__street-head">
              <span className="prl-index prl-timeline__street-index" aria-hidden="true">
                {formatIndex(street.position)}
              </span>
              <span className="prl-timeline__street-name">{street.label}</span>
            </p>
            <ol className="prl-timeline__markers">
              {street.markerIndexes.map((index) => {
                const marker = markers[index];
                if (marker === undefined) return null;
                return (
                  <Marker
                    key={marker.index}
                    marker={marker}
                    total={total}
                    isActive={marker.index === activeIndex}
                    register={register}
                    onSelect={onSelect}
                  />
                );
              })}
            </ol>
          </li>
        ))}
      </ol>
    </fieldset>
  );
}
