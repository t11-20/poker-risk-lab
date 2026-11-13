'use client';

/**
 * The difficulty a reader has TICKED, carried to every Play link on the page before they submit —
 * and to "Start a match" above the picker (`LegendQuickStart.tsx`), whose hidden field and setting
 * sentence follow it the same way.
 *
 * ## The defect
 *
 * `DifficultyPicker` is a GET form and deliberately does not navigate on `change` (WCAG 3.2.2 —
 * see its header; that reason stands). So the setting only changed when "Apply setting" was
 * pressed, and on `/legends` that button is the last thing in the picker: y=1790 on a 360px phone,
 * below three option blocks. Measured on the running build: tapping "Expert" gave it the accent
 * border and the checked dot, and all twelve "Play this style" links still read
 * `difficulty=educational` — a reader who picked Expert and pressed Play was dealt an Educational
 * match, with the Coach they had chosen to give up still on screen.
 *
 * ## Why the links follow the radio, rather than the radio moving next to the links
 *
 * Moving the choice onto each card would be twelve copies of a three-way control, and moving it to
 * the pre-deal panel on `/play` would put it after the reader has already chosen who to play. The
 * picker is in the right place; what was wrong is that its state reached nothing until a submit.
 * Following the ticked radio is not a change of context — nothing navigates, nothing moves focus,
 * no content appears — so 3.2.2 is not engaged, and "Apply setting" keeps its job of putting the
 * choice in the address bar.
 *
 * ## Without JavaScript
 *
 * Every link is server-rendered with the difficulty from the URL, which is the setting the page
 * actually has, so before hydration and with scripts off the links are what they always were —
 * correct for the applied setting — and the picker's note says the setting applies on submit.
 * `ScopedDifficultyNote` changes that sentence only once this code is running, because only then is
 * the new one true.
 *
 * The ticked state is read from the DOM, not mirrored from props: the radios are uncontrolled
 * (`defaultChecked`), and after Back the browser may restore a different tick than the URL says.
 * The mount effect reads whatever is ticked so a restored Expert is not shown under Educational links.
 */

import type { LegendDifficulty } from '@prl/contracts';
import Link from 'next/link';
import {
  type ChangeEvent,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { DIFFICULTIES, legendMatchHref, profileHref } from '@/lib/legend-links.ts';
import { coachWords } from '@/lib/legend-match-copy.ts';

/** The radio group's `name`. Same string as `DIFFICULTY_PARAM` in `DifficultyPicker.tsx`. */
const DIFFICULTY_NAME = 'difficulty';

interface Scope {
  /** What is ticked now, or null until the reader (or the browser's restore) has ticked something. */
  readonly chosen: LegendDifficulty | null;
}

/** `undefined` outside a scope, which is how a link or a note knows nothing is following it. */
const ScopeContext = createContext<Scope | undefined>(undefined);

function asDifficulty(value: string): LegendDifficulty | null {
  return DIFFICULTIES.find((difficulty) => difficulty === value) ?? null;
}

/**
 * `display: contents` (`.prl-legend-scope` in `legends.css`), so the wrapper is not a box: the
 * page's grid gap still falls between the picker and the profiles exactly as it did.
 */
export function LegendDifficultyScope({ children }: { readonly children: ReactNode }): ReactElement {
  const root = useRef<HTMLDivElement | null>(null);
  const [chosen, setChosen] = useState<LegendDifficulty | null>(null);

  useEffect(() => {
    const ticked = root.current?.querySelector<HTMLInputElement>(
      `input[type="radio"][name="${DIFFICULTY_NAME}"]:checked`,
    );
    if (ticked) setChosen(asDifficulty(ticked.value));
  }, []);

  const onChange = (event: ChangeEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.type !== 'radio' || target.name !== DIFFICULTY_NAME || !target.checked) return;
    setChosen(asDifficulty(target.value));
  };

  return (
    <div className="prl-legend-scope" onChange={onChange} ref={root}>
      <ScopeContext.Provider value={{ chosen }}>{children}</ScopeContext.Provider>
    </div>
  );
}

/** The ticked difficulty inside a scope, else the one the server rendered with. */
function useDifficulty(fallback: LegendDifficulty): LegendDifficulty {
  return useContext(ScopeContext)?.chosen ?? fallback;
}

export interface LegendLinkProps {
  readonly profileId: string;
  readonly archetypeName: string;
  /** The applied setting, from the URL. What the link says until the reader ticks another. */
  readonly difficulty: LegendDifficulty;
  readonly className: string;
  readonly children: ReactNode;
}

/**
 * "Play this style", following the ticked setting. The visually-hidden suffix follows too, so a
 * screen-reader user is told the setting the link will actually start.
 */
export function LegendPlayLink(props: LegendLinkProps): ReactElement {
  const difficulty = useDifficulty(props.difficulty);
  return (
    <Link className={props.className} href={legendMatchHref(props.profileId, difficulty)}>
      {props.children}
      <span className="prl-visually-hidden">{`: ${props.archetypeName}, ${difficulty} setting`}</span>
    </Link>
  );
}

/** "Full profile", carrying the ticked setting, because the profile page's own Play link reads it. */
export function LegendProfileLink(props: LegendLinkProps): ReactElement {
  const difficulty = useDifficulty(props.difficulty);
  return (
    <Link className={props.className} href={profileHref(props.profileId, difficulty)}>
      {props.children}
      <span className="prl-visually-hidden">{`: ${props.archetypeName}`}</span>
    </Link>
  );
}

/**
 * The picker's note: `children` (the no-script sentence) until this code is running inside a scope,
 * then `following`. Two sentences because each is true in exactly one of the two cases.
 */
export function ScopedDifficultyNote({
  following,
  children,
}: {
  readonly following: string;
  readonly children: ReactNode;
}): ReactElement {
  const inScope = useContext(ScopeContext) !== undefined;
  const [running, setRunning] = useState(false);
  useEffect(() => setRunning(true), []);
  return <>{inScope && running ? following : children}</>;
}

/** Just enough of a `LegendDifficultyDto` to name it: no description crosses to the client. */
export interface SettingName {
  readonly id: LegendDifficulty;
  readonly label: string;
  readonly coachAvailable: boolean;
}

/**
 * The "Start a match" form's `difficulty` field. A hidden input that follows the tick exactly as the
 * Play links do, so the form above the picker and the cards below it can never start two different
 * settings. Without a scope, or before hydration, it is the applied setting — the one the visible
 * sentence beside it names.
 */
export function ScopedDifficultyInput({
  name,
  difficulty,
}: {
  readonly name: string;
  readonly difficulty: LegendDifficulty;
}): ReactElement {
  return <input name={name} type="hidden" value={useDifficulty(difficulty)} />;
}

/** The setting the form will start, by name and by what it does to the Coach, following the tick. */
export function ScopedSettingName({
  settings,
  difficulty,
}: {
  readonly settings: readonly SettingName[];
  readonly difficulty: LegendDifficulty;
}): ReactElement {
  const chosen = useDifficulty(difficulty);
  const setting = settings.find((candidate) => candidate.id === chosen);
  // A deployment whose difficulties list lacks the ticked id still gets the id, never a blank.
  return <>{setting === undefined ? chosen : `${setting.label}, ${coachWords(setting.coachAvailable)}`}</>;
}
