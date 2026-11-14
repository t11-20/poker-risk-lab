'use client';

/**
 * Carries the TICKED difficulty to every Play link and to "Start a match" before the picker is
 * submitted. The picker's Apply button sits far below on a phone, and a reader who ticked Expert would
 * be dealt Educational. Following the radio moves no focus and navigates nowhere, so WCAG 3.2.2 is not
 * engaged. Without scripts the links keep the URL's applied setting. The tick is read from the DOM
 * on mount because after Back the browser may restore a tick the URL does not carry.
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
import {
  knownDifficulty,
  legendMatchHref,
  MATCH_DIFFICULTY_PARAM,
  MATCH_PROFILE_PARAM,
  profileHref,
} from '@/lib/legend-links.ts';
import { coachWords } from '@/lib/legend-match-copy.ts';

interface Scope {
  readonly chosen: LegendDifficulty | null;
  readonly opponent: string | null;
}

/** `undefined` outside a scope. */
const ScopeContext = createContext<Scope | undefined>(undefined);

/** `display: contents` in `legends.css`, so the page's grid gap is unchanged. */
export function LegendDifficultyScope({ children }: { readonly children: ReactNode }): ReactElement {
  const root = useRef<HTMLDivElement | null>(null);
  const [chosen, setChosen] = useState<LegendDifficulty | null>(null);
  const [opponent, setOpponent] = useState<string | null>(null);

  useEffect(() => {
    const ticked = root.current?.querySelector<HTMLInputElement>(
      `input[type="radio"][name="${MATCH_DIFFICULTY_PARAM}"]:checked`,
    );
    if (ticked) setChosen(knownDifficulty(ticked.value));
    // After Back the browser may restore a different opponent too.
    const select = root.current?.querySelector<HTMLSelectElement>(`select[name="${MATCH_PROFILE_PARAM}"]`);
    if (select) setOpponent(select.value);
  }, []);

  const onChange = (event: ChangeEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (target instanceof HTMLSelectElement && target.name === MATCH_PROFILE_PARAM) {
      setOpponent(target.value);
      return;
    }
    if (!(target instanceof HTMLInputElement)) return;
    if (target.type !== 'radio' || target.name !== MATCH_DIFFICULTY_PARAM || !target.checked) return;
    setChosen(knownDifficulty(target.value));
  };

  return (
    <div className="prl-legend-scope" onChange={onChange} ref={root}>
      <ScopeContext.Provider value={{ chosen, opponent }}>{children}</ScopeContext.Provider>
    </div>
  );
}

function useDifficulty(fallback: LegendDifficulty): LegendDifficulty {
  return useContext(ScopeContext)?.chosen ?? fallback;
}

export interface LegendLinkProps {
  readonly profileId: string;
  readonly archetypeName: string;
  readonly difficulty: LegendDifficulty;
  readonly className: string;
  readonly children: ReactNode;
}

export function LegendPlayLink(props: LegendLinkProps): ReactElement {
  const difficulty = useDifficulty(props.difficulty);
  return (
    <Link className={props.className} href={legendMatchHref(props.profileId, difficulty)}>
      {props.children}
      <span className="prl-visually-hidden">{`: ${props.archetypeName}, ${difficulty} setting`}</span>
    </Link>
  );
}

/** Carries the setting because the profile page's own Play link reads it. */
export function LegendProfileLink(props: LegendLinkProps): ReactElement {
  const difficulty = useDifficulty(props.difficulty);
  return (
    <Link className={props.className} href={profileHref(props.profileId, difficulty)}>
      {props.children}
      <span className="prl-visually-hidden">{`: ${props.archetypeName}`}</span>
    </Link>
  );
}

/** `children` is the no-script sentence, shown until this code runs inside a scope. */
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

/** No description crosses to the client. */
export interface SettingName {
  readonly id: LegendDifficulty;
  readonly label: string;
  readonly coachAvailable: boolean;
}

/** Follows the tick like the Play links, so the form and the cards never start different settings. */
export function ScopedDifficultyInput({
  name,
  difficulty,
}: {
  readonly name: string;
  readonly difficulty: LegendDifficulty;
}): ReactElement {
  return <input name={name} type="hidden" value={useDifficulty(difficulty)} />;
}

export function ScopedSettingName({
  settings,
  difficulty,
}: {
  readonly settings: readonly SettingName[];
  readonly difficulty: LegendDifficulty;
}): ReactElement {
  const chosen = useDifficulty(difficulty);
  const setting = settings.find((candidate) => candidate.id === chosen);
  // An unknown id renders the id, never a blank.
  return <>{setting === undefined ? chosen : `${setting.label}, ${coachWords(setting.coachAvailable)}`}</>;
}

/**
 * Carries the "Start a match" opponent through the picker's own GET form, which otherwise reloads
 * with the first profile selected. `initial` is the URL's opponent. Renders nothing when there is none.
 * With scripts off a newly picked opponent is not carried, and the select visibly shows what is dealt.
 */
export function ScopedOpponentInput({ initial }: { readonly initial: string | null }): ReactElement | null {
  const opponent = useContext(ScopeContext)?.opponent ?? initial;
  return opponent === null ? null : <input name={MATCH_PROFILE_PARAM} type="hidden" value={opponent} />;
}
