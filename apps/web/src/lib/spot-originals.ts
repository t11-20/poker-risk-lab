/**
 * Every built-in scenario as an editable draft, for the editor's "Reset to original" and the spot
 * list's titles. Server-only, because `@prl/content` reads its bundle from disk and must stay out of
 * the browser; the drafts reach the client as props.
 */

import { scenarios } from '@prl/content';
import type { BuiltInOriginal } from '../components/SpotEditor.tsx';
import { draftFromScenario } from './spot-convert.ts';

export function builtInOriginals(): Readonly<Record<string, BuiltInOriginal>> {
  const out: Record<string, BuiltInOriginal> = {};
  for (const scenario of scenarios()) {
    const draft = draftFromScenario(scenario);
    if (draft !== null) out[scenario.id] = { title: scenario.title, draft };
  }
  return out;
}
