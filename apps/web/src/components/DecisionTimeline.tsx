'use client';

/**
 * The decision timeline, a street-by-street spine of markers that scrubs a finished hand.
 * One tab stop with a roving `tabindex`, so a ten-decision hand is not ten Tab presses. Selection
 * follows focus because scrubbing is free and reversible. Both arrow axes are bound because the
 * spine wraps vertical on a narrow screen. PageUp and PageDown jump a street.
 * `aria-current="step"`, not a `tablist` (one panel) or `radiogroup` (nothing is submitted).
 * Viewer and analysis markers carry glyphs and words in the name, never colour alone.
 */

import { formatIndex } from '@prl/ui';
import { type KeyboardEvent, type ReactElement, useRef } from 'react';

export interface TimelineMarker {
  readonly index: number;
  readonly street: string;
  /** Null for the terminal frame. Visible, because the action alone never said to whom. */
  readonly actor: string | null;
  readonly short: string;
  readonly description: string;
  readonly isViewer: boolean;
  readonly hasAnalysis: boolean;
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
  readonly instructionsId: string;
  readonly className?: string;
}

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
  readonly register: (index: number, node: HTMLButtonElement | null) => void;
  readonly onSelect: (index: number) => void;
}

function Marker({ marker, total, isActive, register, onSelect }: MarkerProps): ReactElement {
  return (
    <li className="prl-timeline__slot">
      <button
        type="button"
        className="prl-timeline__marker"
        data-viewer={marker.isViewer ? 'true' : 'false'}
        data-analysis={marker.hasAnalysis ? 'true' : 'false'}
        data-terminal={marker.isTerminal ? 'true' : 'false'}
        tabIndex={isActive ? 0 : -1}
        aria-current={isActive ? 'step' : undefined}
        ref={(node) => register(marker.index, node)}
        onClick={() => onSelect(marker.index)}
      >
        <span className="prl-timeline__glyph" aria-hidden="true">
          {marker.isTerminal ? '■' : marker.isViewer ? '▸' : '·'}
        </span>
        {/* Hidden because the visually-hidden sentence below already names the actor. */}
        {marker.actor === null ? null : (
          <span className="prl-timeline__actor" aria-hidden="true">
            {marker.actor}
          </span>
        )}
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
  // Keyed by step index, which need not equal array position once a marker is filtered out.
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
        return;
    }
    event.preventDefault();
  };

  return (
    // A native `<fieldset>` named by `<legend>`, because the markers are form controls.
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
