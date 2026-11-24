/**
 * The guided tour's steps, its one storage key and its state, apart from React so `node --test` can
 * drive them. `GuidedTour` renders the state and `TourButton` opens it, through `tourStore`.
 *
 * It opens by itself on `/lab`, at most once a page load, and never moves focus when it does. The key
 * is written only when the reader presses Skip or Close, so a reader who never answered it, or put it
 * away with Escape, sees it again on their next load of `/lab`. Storage that throws reads as
 * "unreadable", and the tour then stays shut rather than reappear on every load; the "How to use"
 * button still opens it.
 */

export const TOUR_DISMISSED_KEY = 'prl.tour.dismissed';

/** The only page the tour opens on by itself. */
export const TOUR_FIRST_VISIT_PATH = '/lab';

/**
 * A first visit below this width opens compact. The five steps are 462px at 390px and that is
 * what pushes the Lab down. Read once, where the open is dispatched, and kept until the guide
 * closes: a rotation must not unmount the control that has focus.
 */
export const TOUR_COMPACT_QUERY = '(width < 640px)';

/** The spot editor, which holds three steps' targets. With no query it opens a blank spot. */
export const SPOT_EDITOR_HREF = '/lab/spots/edit';

export type TourStepId = 'pick-scenario' | 'hand-board' | 'run' | 'result' | 'review';

export interface TourStep {
  /** Also the target's `data-tour` value. */
  readonly id: TourStepId;
  readonly title: string;
  /** One sentence. */
  readonly text: string;
  /** Where "Show me" goes when the target is not on this page. */
  readonly href: string | null;
  /** One sentence, shown when the target is not on the page. */
  readonly missing: string;
}

const IN_THE_EDITOR = 'This part is in the spot editor, which has not finished loading yet.';

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'pick-scenario',
    title: 'Pick a scenario',
    text: 'Choose a spot from the Lab list to practise one decision.',
    href: TOUR_FIRST_VISIT_PATH,
    missing: 'The scenario list is not showing here, so clear the filters to bring it back.',
  },
  {
    id: 'hand-board',
    title: 'Set your hand and board',
    text: 'Choose your two cards and the shared cards on the table.',
    href: SPOT_EDITOR_HREF,
    missing: IN_THE_EDITOR,
  },
  {
    id: 'run',
    title: 'Run it',
    text: 'The numbers work themselves out again each time you change a card.',
    href: SPOT_EDITOR_HREF,
    missing: IN_THE_EDITOR,
  },
  {
    id: 'result',
    title: 'Read the result',
    text: 'Compare how often you win with what a call costs you.',
    href: SPOT_EDITOR_HREF,
    missing: IN_THE_EDITOR,
  },
  {
    id: 'review',
    title: 'Review the hand',
    text: 'Open a hand you played and step through each decision again.',
    href: '/review',
    missing: 'There are no hands to review yet, so finish a hand at a table first.',
  },
];

export function tourStep(id: TourStepId): TourStep {
  const step = TOUR_STEPS.find((candidate) => candidate.id === id);
  if (step === undefined) throw new Error(`no tour step ${id}`);
  return step;
}

/** A getter, because reading `window.localStorage` itself throws when storage is blocked. */
export type TourStorage = () => Pick<Storage, 'getItem' | 'setItem'>;

export type DismissalRead = 'dismissed' | 'not-dismissed' | 'unreadable';

export function readTourDismissal(storage: TourStorage): DismissalRead {
  try {
    return storage().getItem(TOUR_DISMISSED_KEY) === null ? 'not-dismissed' : 'dismissed';
  } catch {
    return 'unreadable';
  }
}

/** False when storage refused, and the tour is then shut for this page load only. */
export function rememberTourDismissal(storage: TourStorage): boolean {
  try {
    storage().setItem(TOUR_DISMISSED_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/** Skip and Close answer the guide and are remembered. Escape only puts it away for this page load. */
export function closeTour(store: TourStore, storage: TourStorage, how: 'button' | 'escape'): void {
  if (how === 'button') rememberTourDismissal(storage);
  store.dispatch({ type: 'close' });
}

/**
 * Not when the address has a fragment: the panel mounts after the browser has scrolled to it, and at
 * 360px its height would push the part the link pointed at off the screen.
 */
export function opensByItself(
  pathname: string,
  read: DismissalRead,
  alreadyOpened: boolean,
  hasFragment = false,
): boolean {
  return pathname === TOUR_FIRST_VISIT_PATH && read === 'not-dismissed' && !alreadyOpened && !hasFragment;
}

export interface TourState {
  readonly open: boolean;
  /** Decides the close button's word: a tour nobody asked for is skipped, one they asked for closed. */
  readonly opener: 'first-visit' | 'button' | null;
  readonly step: TourStepId | null;
  /** Whether the shown step's target was found on the page. */
  readonly found: 'shown' | 'missing' | null;
  /** The path a "Show me" navigation is heading to, so arriving there keeps the step. */
  readonly awaiting: string | null;
  /** Bumped by every "Show me", so showing the same step again reveals it again. */
  readonly shown: number;
  /** Bumped when the panel should take focus. A first-visit open never bumps it. */
  readonly focusRequest: number;
  /** Set by any opening or closing, so this page load never opens it by itself a second time. */
  readonly settled: boolean;
  /**
   * Chosen when the guide opens and kept until it closes. A resize must not change it: the step
   * list or the "Show steps" button would unmount under focus, and Escape would miss the panel.
   */
  readonly compact: boolean;
  /** A compact guide's steps stay hidden until the reader asks. Reset when the guide closes. */
  readonly stepsExpanded: boolean;
}

export const INITIAL_TOUR_STATE: TourState = {
  open: false,
  opener: null,
  step: null,
  found: null,
  awaiting: null,
  shown: 0,
  focusRequest: 0,
  settled: false,
  compact: false,
  stepsExpanded: false,
};

export type TourAction =
  | { readonly type: 'open-first-visit'; readonly narrow: boolean }
  | { readonly type: 'open-from-button' }
  | { readonly type: 'close' }
  | { readonly type: 'set-steps-expanded'; readonly expanded: boolean }
  | { readonly type: 'show'; readonly step: TourStepId; readonly awaiting: string | null }
  | { readonly type: 'found' | 'missing'; readonly step: TourStepId }
  | { readonly type: 'navigated'; readonly pathname: string };

/**
 * Compactness is fixed while the guide stays open, so a resize cannot unmount a focused control.
 * "How to use" and "Show me" never open it compact; a guide already open keeps the choice it opened with.
 */
function compactnessOnOpen(state: TourState, compact: boolean): Pick<TourState, 'compact' | 'stepsExpanded'> {
  if (state.open) return { compact: state.compact, stepsExpanded: state.stepsExpanded };
  return { compact, stepsExpanded: false };
}

export function tourReducer(state: TourState, action: TourAction): TourState {
  switch (action.type) {
    case 'open-first-visit':
      if (state.open || state.settled) return state;
      return {
        ...state,
        open: true,
        opener: 'first-visit',
        compact: action.narrow,
        stepsExpanded: false,
        settled: true,
      };
    case 'open-from-button':
      return {
        ...state,
        open: true,
        opener: state.open ? state.opener : 'button',
        ...compactnessOnOpen(state, false),
        focusRequest: state.focusRequest + 1,
        settled: true,
      };
    case 'set-steps-expanded':
      if (!state.open || state.stepsExpanded === action.expanded) return state;
      return { ...state, stepsExpanded: action.expanded };
    case 'close':
      return { ...INITIAL_TOUR_STATE, focusRequest: state.focusRequest, settled: true };
    case 'show':
      return {
        ...state,
        open: true,
        opener: state.opener ?? 'button',
        ...compactnessOnOpen(state, false),
        step: action.step,
        found: null,
        awaiting: action.awaiting,
        shown: state.shown + 1,
        settled: true,
      };
    case 'found':
    case 'missing':
      if (state.step !== action.step) return state;
      return { ...state, found: action.type === 'found' ? 'shown' : 'missing' };
    case 'navigated':
      if (state.awaiting === action.pathname) return { ...state, awaiting: null };
      // Opened by itself and never used, so it stays on the Lab. The key is not written: it was not answered.
      if (state.opener === 'first-visit' && state.shown === 0) {
        return { ...INITIAL_TOUR_STATE, focusRequest: state.focusRequest, settled: true };
      }
      // Somewhere the reader went on their own, so the outline would point at nothing they chose.
      return { ...state, step: null, found: null, awaiting: null };
    default:
      return state;
  }
}

export interface TourStore {
  readonly getSnapshot: () => TourState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispatch: (action: TourAction) => void;
}

/** A store outside React, so the header's button and the panel below it share one state. */
export function createTourStore(initial: TourState = INITIAL_TOUR_STATE): TourStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch: (action) => {
      const next = tourReducer(state, action);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

export const tourStore: TourStore = createTourStore();
