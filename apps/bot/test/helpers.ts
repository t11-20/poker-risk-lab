import { createDeterministicRandomForTests, type LegalAction } from '@prl/poker-engine';
import { type CoachFn, coachReportFor } from '../src/coach.ts';
import { type Deps, type Outgoing, type Session, type StepResult, step } from '../src/step.ts';
import { type Button, decodePress } from '../src/view.ts';

const NO_COACH: CoachFn = () => {
  throw new Error('the Coach is not under test here');
};

/** Scripted dealing and decisions: the same seed plays the same hands. */
export function testDeps(seed: number, coach: CoachFn = NO_COACH): Deps {
  let hand = 0;
  let tags = 0;
  return {
    dealRandom: () => {
      hand += 1;
      return createDeterministicRandomForTests(seed * 1_000 + hand);
    },
    decisionRandom: (seat) => createDeterministicRandomForTests(seed * 1_000 + 500 + seat),
    coach,
    newTag: () => {
      tags += 1;
      return `t${seed}x${tags}`;
    },
  };
}

export const realCoach: CoachFn = coachReportFor;

/** The one message a step produced that is not a toast. */
export function message(result: StepResult): Extract<Outgoing, { kind: 'send' | 'edit' }> {
  const found = result.out.filter((out) => out.kind !== 'toast');
  if (found.length !== 1) throw new Error(`expected one message, got ${found.length}`);
  return found[0] as Extract<Outgoing, { kind: 'send' | 'edit' }>;
}

export function buttonsOf(result: StepResult): readonly Button[] {
  return message(result).buttons.flat();
}

export function find(buttons: readonly Button[], label: RegExp): Button {
  const button = buttons.find((entry) => label.test(entry.label));
  if (button === undefined) throw new Error(`no button matching ${label} in ${buttons.map((b) => b.label)}`);
  return button;
}

/** The engine action buttons only, without Why?. */
export function actionButtonsOf(result: StepResult): readonly Button[] {
  return buttonsOf(result).filter((button) => decodePress(button.data)?.kind === 'act');
}

/** Picks a reader action: call or check when there is one, otherwise the first button. */
export function passiveChoice(buttons: readonly Button[], pick: number): Button {
  const passive = buttons.filter((button) => /^(Check|Call)/.test(button.label));
  const pool = passive.length > 0 && pick % 4 !== 0 ? passive : buttons;
  return pool[pick % pool.length] as Button;
}

export function press(session: Session, button: Button, deps: Deps): StepResult {
  return step(session, { kind: 'button', data: button.data }, deps);
}

export function legalSummary(legal: readonly LegalAction[]): string {
  return legal
    .map((entry) => `${entry.type}${entry.minTo === undefined ? '' : `[${entry.minTo},${entry.maxTo}]`}`)
    .join(' ');
}
