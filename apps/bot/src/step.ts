/**
 * The chat client's whole behaviour, with no transport in it.
 *
 * `step(session, event, deps)` takes one thing the reader did and returns the next session and
 * the messages to send. Telegram and the terminal are adapters over this function and nothing
 * else, so a test drives exactly what a reader drives.
 *
 * ## One message per hand, edited in place
 *
 * A hand is posted once (`send`) and every later state of it is an `edit`. An edit always targets
 * the message whose button was pressed, which is the only message a press can come from, so the
 * core never needs to know a transport's message ids. A new hand is a new message, which leaves
 * the previous result readable above it.
 *
 * ## A press is applied only to the moment it was drawn for
 *
 * Every hand-scoped button carries the hand id and the `actionSequence` it was drawn from
 * (`view.ts`). If either no longer matches, the press is answered with `STALE` and the session is
 * returned unchanged, which is what makes a double press idempotent: the first press advances the
 * sequence, so the second no longer matches.
 *
 * ## It only ever replies
 *
 * Every outgoing message answers an event from the reader. There is no timer, no reminder, and no
 * path that writes to a chat on its own (guardrail §8), and there is nothing that carries one
 * reader's text to anybody else (ADR 0010).
 */

import type { GlossaryEntry } from '@prl/contracts';
import { UNIVERSAL_DISCLAIMER } from '@prl/poker-ai';
import { BettingRuleError, type HandState, validateAction } from '@prl/poker-engine';
import { type CoachFn, type CoachReading, coachWhy, readCoach } from './coach.ts';
import { entryById, entryText, lookup, normalise, seeAlsoOf } from './define.ts';
import { GONE, onQuizPress, onQuizText, onQuizzes, onTopic, startQuiz } from './quiz.ts';
import {
  canDeal,
  type Dealer,
  dealNext,
  newTable,
  READER_SEAT,
  readerActs,
  readerView,
  resetUnits,
  STARTING_STACK,
  settle,
  type Table,
} from './table.ts';
import {
  actionButtons,
  type Button,
  decodePress,
  encodePress,
  type Press,
  resultText,
  tableText,
} from './view.ts';

export type Event =
  /** `/define pot odds` is `{ name: 'define', args: 'pot odds' }`. */
  | { readonly kind: 'command'; readonly name: string; readonly args: string }
  | { readonly kind: 'button'; readonly data: string }
  | { readonly kind: 'text'; readonly text: string };

export type Outgoing =
  | { readonly kind: 'send'; readonly text: string; readonly buttons: readonly (readonly Button[])[] }
  /** Replaces the message whose button was pressed. Only ever produced for a `button` event. */
  | { readonly kind: 'edit'; readonly text: string; readonly buttons: readonly (readonly Button[])[] }
  /** A short notice on the press itself. Changes no message. */
  | { readonly kind: 'toast'; readonly text: string };

/**
 * Where the reader is. A phase per state the table can be in, so "a Coach reading for a hand that
 * is over" or "a result with nobody to act" cannot be built.
 */
export type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'deciding'; readonly state: HandState; readonly coach: CoachReading }
  | { readonly kind: 'over'; readonly state: HandState }
  /**
   * A question of a quiz run, being asked or answered. `quiz` and `position` index the content,
   * which does not change while the process runs; `run` is a fresh tag per run (see `quiz.ts`).
   */
  | {
      readonly kind: 'quiz';
      readonly run: string;
      readonly quiz: number;
      readonly position: number;
      readonly stage: 'asking' | 'answered';
    };

export interface Session {
  /** Lazily created on the first hand, so `/start` costs nothing but a menu. */
  readonly table: Table | null;
  readonly phase: Phase;
  /** Increments on every change, and only on a change: a refused press leaves it where it was. */
  readonly revision: number;
}

export interface Deps extends Dealer {
  readonly coach: CoachFn;
  /** A fresh table tag. Random outside tests; see `Table.tag`. */
  readonly newTag: () => string;
}

export interface StepResult {
  readonly session: Session;
  readonly out: readonly Outgoing[];
}

export const NEW_SESSION: Session = { table: null, phase: { kind: 'idle' }, revision: 0 };

export const STALE = 'That button is from an earlier moment in the hand.';

const MENU_TEXT =
  'Poker Risk Lab: a play-money No-Limit Hold’em table for learning probability, risk and expected ' +
  'value. Six-handed, you against five bots, with the Coach beside every decision. Between hands, ' +
  'practise a quiz, or look a term up with /define.\n\n' +
  'Units are free and have no value anywhere. The opponents are modelled styles, not real people: ' +
  'see About.';

const ABOUT_TEXT = [
  'About this bot',
  '',
  'You play six-handed No-Limit Hold’em at 5/10 against five bots, starting with 1,000 units each. ' +
    'Your units carry from hand to hand; Reset units puts every seat back to 1,000, at any time ' +
    'between hands, as often as you like.',
  '',
  'Units are play money for learning. They are free, they cannot be bought, sold, transferred or ' +
    'cashed out, and they have no value inside or outside this bot.',
  '',
  UNIVERSAL_DISCLAIMER,
  '',
  'The Coach line under the table is a computed estimate with its method and interval. Why? shows ' +
    'one reading of the spot, the assumptions it rests on, and what would change it.',
  '',
  'Quizzes and the glossary are the same material as the web app’s lessons. A quiz is not scored: ' +
    'each answer opens the reasoning, and nothing you answer is kept.',
  '',
  'This bot only answers you: it never messages first and sends no reminders. It plays one-on-one ' +
    'only and ignores group chats. Your table lives in memory, so a restart of the bot ends it and ' +
    'starts you fresh.',
].join('\n');

const UNKNOWN = 'Use the buttons, or send /start for the menu.';

const GLOSSARY_TEXT =
  'Send /define and a term to read its glossary entry, for example /define pot odds. Capitals and ' +
  'punctuation do not matter. If no entry has that name, the nearest names are offered instead.';

/** Starting points for a reader on a phone, who would rather press than type. */
const GLOSSARY_EXAMPLES = ['pot-odds', 'equity', 'expected-value', 'outs', 'variance'] as const;

function menuButtons(): Button[][] {
  return [
    [
      { label: 'Play a hand', data: encodePress({ kind: 'play' }) },
      { label: 'Practise a quiz', data: encodePress({ kind: 'quizzes' }) },
    ],
    [
      { label: 'Glossary', data: encodePress({ kind: 'glossary' }) },
      { label: 'About', data: encodePress({ kind: 'about' }) },
    ],
    [{ label: 'Reset units', data: encodePress({ kind: 'reset' }) }],
  ];
}

/**
 * What a person typed, as an event. A command is `/word`, with an optional `@botname` that
 * Telegram adds in some clients, and everything after it is the command's argument.
 */
export function eventOfText(text: string): Event {
  const command = /^\/([A-Za-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (command !== null) {
    return { kind: 'command', name: (command[1] ?? '').toLowerCase(), args: (command[2] ?? '').trim() };
  }
  return { kind: 'text', text };
}

export function step(session: Session, event: Event, deps: Deps): StepResult {
  switch (event.kind) {
    case 'command':
      return onCommand(session, event.name, event.args);
    case 'text':
      return (
        onQuizText(session, event.text) ?? { session, out: [{ kind: 'send', text: UNKNOWN, buttons: [] }] }
      );
    case 'button': {
      const press = decodePress(event.data);
      if (press === null) return { session, out: [{ kind: 'toast', text: STALE }] };
      return onPress(session, press, deps);
    }
  }
}

function onCommand(session: Session, name: string, args: string): StepResult {
  if (name === 'about' || name === 'help')
    return { session, out: [{ kind: 'send', text: ABOUT_TEXT, buttons: [] }] };
  if (name === 'start' || name === 'menu') {
    return { session, out: [{ kind: 'send', text: MENU_TEXT, buttons: menuButtons() }] };
  }
  if (name === 'define') return { session, out: [args === '' ? glossaryHelp() : defineMessage(args)] };
  if (name === 'quiz') return onQuizzes(session);
  return { session, out: [{ kind: 'send', text: UNKNOWN, buttons: [] }] };
}

function termButton(entry: GlossaryEntry): Button {
  return { label: entry.term, data: encodePress({ kind: 'term', id: entry.id }) };
}

/** Two to a row: a term can be thirty characters, and a phone shows about two of those across. */
function inPairs(buttons: readonly Button[]): Button[][] {
  const rows: Button[][] = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  return rows;
}

function glossaryHelp(): Outgoing {
  const examples = GLOSSARY_EXAMPLES.flatMap((id) => {
    const entry = entryById(id);
    return entry === null ? [] : [termButton(entry)];
  });
  return { kind: 'send', text: GLOSSARY_TEXT, buttons: inPairs(examples) };
}

function entryMessage(entry: GlossaryEntry): Outgoing {
  return { kind: 'send', text: entryText(entry), buttons: inPairs(seeAlsoOf(entry).map(termButton)) };
}

function defineMessage(query: string): Outgoing {
  const found = lookup(query);
  if (found.kind === 'found') return entryMessage(found.entry);
  // The reader's text is quoted back only after normalising, so it cannot carry anything the
  // glossary's own names could not: letters, digits and spaces, and no more than a term's length.
  const asked = normalise(query).slice(0, 60);
  if (found.suggestions.length === 0) {
    return {
      kind: 'send',
      text: `There is no glossary entry called "${asked}", and none with a name close to it. ${GLOSSARY_TEXT}`,
      buttons: [],
    };
  }
  return {
    kind: 'send',
    text: `There is no glossary entry called "${asked}". The closest names are below.`,
    buttons: found.suggestions.map((entry) => [termButton(entry)]),
  };
}

function onPress(session: Session, press: Press, deps: Deps): StepResult {
  const { phase } = session;
  switch (press.kind) {
    case 'menu':
      return { session, out: [{ kind: 'send', text: MENU_TEXT, buttons: menuButtons() }] };
    case 'about':
      return { session, out: [{ kind: 'send', text: ABOUT_TEXT, buttons: [] }] };
    case 'play':
      // Mid-hand, "Play a hand" posts the live table again rather than refusing. If an edit ever
      // failed to land, the reader's newest table would carry stale buttons and nothing would
      // reach the current decision; this is the way back, and it changes nothing.
      if (phase.kind === 'deciding' && session.table !== null) {
        return { session, out: [decidingMessage(session.table, phase.state, phase.coach, 'send')] };
      }
      return deal(session, deps);
    case 'next':
      if (phase.kind !== 'over' || phase.state.handId !== press.handId) return refuse(session);
      return deal(session, deps);
    case 'reset':
      return onReset(session);
    case 'why':
      if (phase.kind !== 'deciding' || !drawnFor(phase.state, press.handId, press.sequence)) {
        return refuse(session);
      }
      return { session, out: [{ kind: 'send', text: coachWhy(phase.coach), buttons: [] }] };
    case 'act':
      return onAct(session, press, deps);
    case 'quizzes':
      return onQuizzes(session);
    case 'topic':
      return onTopic(session, press.topic, deps);
    case 'quiz':
      return startQuiz(session, press.quizId, deps);
    case 'choose':
    case 'decide':
    case 'reveal':
    case 'onward':
      return onQuizPress(session, press);
    case 'glossary':
      return { session, out: [glossaryHelp()] };
    case 'term': {
      const entry = entryById(press.id);
      if (entry === null) return { session, out: [{ kind: 'toast', text: GONE }] };
      return { session, out: [entryMessage(entry)] };
    }
  }
}

function onReset(session: Session): StepResult {
  if (session.phase.kind === 'deciding') {
    return { session, out: [{ kind: 'toast', text: 'Finish this hand first, then reset.' }] };
  }
  const table = session.table === null ? null : resetUnits(session.table);
  return {
    session: { ...session, table, revision: session.revision + 1 },
    out: [
      { kind: 'toast', text: 'Units reset.' },
      {
        kind: 'send',
        text: `Every seat is back to ${STARTING_STACK.toLocaleString('en-US')} units.`,
        buttons: [[{ label: 'Play a hand', data: encodePress({ kind: 'play' }) }]],
      },
    ],
  };
}

function onAct(session: Session, press: Extract<Press, { kind: 'act' }>, deps: Deps): StepResult {
  const { phase, table } = session;
  if (phase.kind !== 'deciding' || table === null) return refuse(session);
  if (!drawnFor(phase.state, press.handId, press.sequence)) return refuse(session);
  try {
    // Asked before anything moves. The engine is the authority on legality (ADR 0002), and data
    // this process wrote cannot name an illegal action at a matching sequence, so a refusal here
    // is a forged or corrupted press. Asking first keeps a bot's own failure, later in the same
    // step, from being mistaken for one.
    validateAction(phase.state, READER_SEAT, press.action);
  } catch (error) {
    if (error instanceof BettingRuleError) {
      return { session, out: [{ kind: 'toast', text: 'That action is not available here.' }] };
    }
    throw error;
  }
  const next = readerActs(table, phase.state, press.action, `reader-${press.sequence}`);
  return show({ ...session, revision: session.revision + 1 }, table, next, deps, 'edit');
}

function drawnFor(state: HandState, handId: string, sequence: number): boolean {
  return state.handId === handId && state.actionSequence === sequence;
}

function refuse(session: Session): StepResult {
  return { session, out: [{ kind: 'toast', text: STALE }] };
}

function deal(session: Session, deps: Deps): StepResult {
  const table = session.table ?? newTable(deps.newTag(), deps);
  if (!canDeal(table)) {
    return {
      session: { ...session, table },
      out: [
        {
          kind: 'send',
          text:
            (table.stacks[READER_SEAT] ?? 0) === 0
              ? 'You have no units left. Units are free: Reset units puts every seat back to 1,000.'
              : 'Every bot is out of units. Reset units puts every seat back to 1,000.',
          buttons: [[{ label: 'Reset units', data: encodePress({ kind: 'reset' }) }]],
        },
      ],
    };
  }
  const dealt = dealNext(table, deps);
  return show({ ...session, revision: session.revision + 1 }, dealt.table, dealt.state, deps, 'send');
}

/** The session after `state`, and the one message that shows it. */
function show(
  session: Session,
  table: Table,
  state: HandState,
  deps: Deps,
  how: 'send' | 'edit',
): StepResult {
  const view = readerView(state);
  if (state.street === 'complete') {
    const settled = settle(table, state);
    const buttons: Button[][] = [
      [
        canDeal(settled)
          ? { label: 'Deal the next hand', data: encodePress({ kind: 'next', handId: state.handId }) }
          : { label: 'Reset units', data: encodePress({ kind: 'reset' }) },
        { label: 'Menu', data: encodePress({ kind: 'menu' }) },
      ],
    ];
    return {
      session: { ...session, table: settled, phase: { kind: 'over', state } },
      out: [{ kind: how, text: resultText(settled, view), buttons }],
    };
  }
  if (state.toAct !== READER_SEAT) {
    // `runBots` stops only for the reader's turn or a finished hand. Anything else would post a
    // table with no action buttons; refuse instead, and the adapter closes the table.
    throw new Error(
      `hand ${state.handId} stopped on ${state.street} with seat ${String(state.toAct)} to act`,
    );
  }
  const coach = readCoach(view, `${state.handId}:${state.actionSequence}`, deps.coach);
  return {
    session: { ...session, table, phase: { kind: 'deciding', state, coach } },
    out: [decidingMessage(table, state, coach, how)],
  };
}

function decidingMessage(
  table: Table,
  state: HandState,
  coach: CoachReading,
  how: 'send' | 'edit',
): Outgoing {
  const view = readerView(state);
  const buttons = [
    ...actionButtons(view),
    [
      {
        label: 'Why?',
        data: encodePress({ kind: 'why', handId: state.handId, sequence: state.actionSequence }),
      },
    ],
  ];
  return { kind: how, text: tableText(table, view, coach), buttons };
}
