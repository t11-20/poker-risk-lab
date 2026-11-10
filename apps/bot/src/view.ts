/**
 * What a reader sees and can press: the table text, the result text, and the buttons.
 *
 * Plain text, no Telegram `parse_mode`. Every string here is a template filled with numbers and
 * names this process chose, so there is nothing to escape, and a MarkdownV2 message that misses
 * one `.` or `-` is refused with a 400 rather than delivered.
 *
 * ## A button is exactly one entry of the engine's legal set
 *
 * `actionButtons` reads `view.legalActions` and nothing else. Fold, check and call are offered
 * when the engine offers them. A bet or raise is offered at preset sizes, each clamped into the
 * engine's own `[minTo, maxTo]` and deduplicated, so a size the engine would refuse cannot be drawn.
 *
 * ## Callback data names the moment it was drawn for
 *
 * An action button carries the hand id and the `actionSequence` of the view it was drawn from. A
 * press is applied only if both still match, which is the web's `expectedSequence` rule: a stale
 * or double-pressed button is answered with a toast and changes nothing. Telegram caps
 * `callback_data` at 64 bytes, and `encodePress` refuses anything longer rather than letting
 * Telegram reject the whole message.
 */

import type { GlossaryEntry } from '@prl/contracts';
import type { Action, LegalAction, PlayerView, SeatIndex, SeatView } from '@prl/poker-engine';
import { rankIndexOf, suitIndexOf } from '@prl/poker-engine';
import { type CoachReading, coachLine, units } from './coach.ts';
import type { DecisionAction } from './learn.ts';
import { nameOf, READER_SEAT, type Table } from './table.ts';

export interface Button {
  readonly label: string;
  readonly data: string;
}

/** Everything a button can mean. The wire form is `encodePress`/`decodePress`, and only that. */
export type Press =
  | { readonly kind: 'play' }
  | { readonly kind: 'about' }
  | { readonly kind: 'menu' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'act'; readonly handId: string; readonly sequence: number; readonly action: Action }
  | { readonly kind: 'why'; readonly handId: string; readonly sequence: number }
  | { readonly kind: 'next'; readonly handId: string }
  /** The topic list. */
  | { readonly kind: 'quizzes' }
  | { readonly kind: 'topic'; readonly topic: string }
  /** Starts a run of the quiz with this id. Ids rather than positions: see `wireOf`. */
  | { readonly kind: 'quiz'; readonly quizId: string }
  /** A multiple-choice option, by index into `options`. */
  | { readonly kind: 'choose'; readonly at: QuizMoment; readonly option: number }
  | { readonly kind: 'decide'; readonly at: QuizMoment; readonly action: DecisionAction }
  /** Shows a numeric question's computed figure without an answer. */
  | { readonly kind: 'reveal'; readonly at: QuizMoment }
  | { readonly kind: 'onward'; readonly at: QuizMoment }
  /** A page of the lesson list, in reading order. */
  | { readonly kind: 'lessons'; readonly page: number }
  /** Opens a lesson at its first page, as a new message. */
  | { readonly kind: 'lesson'; readonly lessonId: string }
  /** Another page of a lesson, in the same message. Numbered from 0; the last is the key takeaways. */
  | { readonly kind: 'lessonPage'; readonly lessonId: string; readonly page: number }
  /** How to use `/define`. */
  | { readonly kind: 'glossary' }
  | { readonly kind: 'term'; readonly id: string };

/**
 * The question a quiz button was drawn for: the run and the position in it. A run is a fresh tag
 * from `Deps.newTag`, so a button from an earlier run of the same quiz, or from before a restart,
 * names a run the session is not in.
 */
export interface QuizMoment {
  readonly run: string;
  readonly position: number;
}

export const CALLBACK_DATA_MAX_BYTES = 64;

export function termButton(entry: GlossaryEntry): Button {
  return { label: entry.term, data: encodePress({ kind: 'term', id: entry.id }) };
}

/** Two to a row: a term can be thirty characters, and a phone shows about two of those across. */
export function inPairs(buttons: readonly Button[]): Button[][] {
  const rows: Button[][] = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  return rows;
}

export function encodePress(press: Press): string {
  const data = wireOf(press);
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > CALLBACK_DATA_MAX_BYTES) {
    throw new Error(`callback data "${data}" is ${bytes} bytes; Telegram allows ${CALLBACK_DATA_MAX_BYTES}`);
  }
  return data;
}

function wireOf(press: Press): string {
  switch (press.kind) {
    case 'play':
      return 'p';
    case 'about':
      return 'i';
    case 'menu':
      return 'm';
    case 'reset':
      return 'z';
    case 'act':
      return `a:${press.handId}:${press.sequence}:${actionCode(press.action)}`;
    case 'why':
      return `w:${press.handId}:${press.sequence}`;
    case 'next':
      return `n:${press.handId}`;
    case 'quizzes':
      return 'q';
    // Content ids on the presses that start something, because those carry no run tag: an index
    // would silently name a different quiz or term after a deploy that reordered the content.
    // In-run presses use positions, which the run tag scopes. The longest id ships at 33 bytes.
    // A lesson page names its lesson by id for the same reason, and needs no run tag: see `lesson.ts`.
    case 'topic':
      return `qt:${press.topic}`;
    case 'quiz':
      return `qs:${press.quizId}`;
    case 'choose':
      return `qa:${momentCode(press.at)}:${press.option}`;
    case 'decide':
      return `qd:${momentCode(press.at)}:${press.action === 'fold' ? 'f' : 'c'}`;
    case 'reveal':
      return `qr:${momentCode(press.at)}`;
    case 'onward':
      return `qn:${momentCode(press.at)}`;
    case 'lessons':
      return `ll:${press.page}`;
    case 'lesson':
      return `lo:${press.lessonId}`;
    case 'lessonPage':
      return `lp:${press.lessonId}:${press.page}`;
    case 'glossary':
      return 'd';
    case 'term':
      return `g:${press.id}`;
  }
}

function momentCode(at: QuizMoment): string {
  return `${at.run}:${at.position}`;
}

function actionCode(action: Action): string {
  switch (action.type) {
    case 'fold':
      return 'f';
    case 'check':
      return 'k';
    case 'call':
      return 'c';
    case 'bet':
      return `b${action.to}`;
    case 'raise':
      return `r${action.to}`;
  }
}

const HAND_ID = '[A-Za-z0-9_-]{1,24}-\\d{1,6}';
const MOMENT = '([A-Za-z0-9_-]{1,24}):(\\d{1,3})';
const PATTERNS = {
  act: new RegExp(`^a:(${HAND_ID}):(\\d{1,6}):(f|k|c|b\\d{1,9}|r\\d{1,9})$`),
  why: new RegExp(`^w:(${HAND_ID}):(\\d{1,6})$`),
  next: new RegExp(`^n:(${HAND_ID})$`),
  topic: /^qt:([a-z0-9-]{1,60})$/,
  quiz: /^qs:([a-z0-9-]{1,60})$/,
  choose: new RegExp(`^qa:${MOMENT}:(\\d)$`),
  decide: new RegExp(`^qd:${MOMENT}:(f|c)$`),
  reveal: new RegExp(`^qr:${MOMENT}$`),
  onward: new RegExp(`^qn:${MOMENT}$`),
  term: /^g:([a-z0-9-]{1,60})$/,
  lessons: /^ll:(\d{1,2})$/,
  // 57 is the longest id whose `lp:<id>:<two digits>` still fits in 64 bytes, so anything this
  // decodes, `encodePress` can write back.
  lesson: /^lo:([a-z0-9-]{1,57})$/,
  lessonPage: /^lp:([a-z0-9-]{1,57}):(\d{1,2})$/,
};

function momentOf(match: RegExpExecArray): QuizMoment {
  return { run: match[1] ?? '', position: Number(match[2]) };
}

/**
 * Parses callback data, or returns null for anything this process did not write.
 *
 * Callback data comes back from Telegram, which got it from a message this process sent, but a
 * client can send any string it likes, so it is parsed as untrusted input at this boundary.
 */
export function decodePress(data: string): Press | null {
  if (data === 'p') return { kind: 'play' };
  if (data === 'i') return { kind: 'about' };
  if (data === 'm') return { kind: 'menu' };
  if (data === 'z') return { kind: 'reset' };
  const act = PATTERNS.act.exec(data);
  if (act !== null) {
    const [, handId = '', sequence = '', code = ''] = act;
    return { kind: 'act', handId, sequence: Number(sequence), action: actionOfCode(code) };
  }
  const why = PATTERNS.why.exec(data);
  if (why !== null) return { kind: 'why', handId: why[1] ?? '', sequence: Number(why[2]) };
  const next = PATTERNS.next.exec(data);
  if (next !== null) return { kind: 'next', handId: next[1] ?? '' };
  if (data === 'q') return { kind: 'quizzes' };
  if (data === 'd') return { kind: 'glossary' };
  const topic = PATTERNS.topic.exec(data);
  if (topic !== null) return { kind: 'topic', topic: topic[1] ?? '' };
  const quiz = PATTERNS.quiz.exec(data);
  if (quiz !== null) return { kind: 'quiz', quizId: quiz[1] ?? '' };
  const choose = PATTERNS.choose.exec(data);
  if (choose !== null) return { kind: 'choose', at: momentOf(choose), option: Number(choose[3]) };
  const decide = PATTERNS.decide.exec(data);
  if (decide !== null)
    return { kind: 'decide', at: momentOf(decide), action: decide[3] === 'f' ? 'fold' : 'call' };
  const reveal = PATTERNS.reveal.exec(data);
  if (reveal !== null) return { kind: 'reveal', at: momentOf(reveal) };
  const onward = PATTERNS.onward.exec(data);
  if (onward !== null) return { kind: 'onward', at: momentOf(onward) };
  const term = PATTERNS.term.exec(data);
  if (term !== null) return { kind: 'term', id: term[1] ?? '' };
  return decodeLessonPress(data);
}

function decodeLessonPress(data: string): Press | null {
  const lessons = PATTERNS.lessons.exec(data);
  if (lessons !== null) return { kind: 'lessons', page: Number(lessons[1]) };
  const lesson = PATTERNS.lesson.exec(data);
  if (lesson !== null) return { kind: 'lesson', lessonId: lesson[1] ?? '' };
  const page = PATTERNS.lessonPage.exec(data);
  if (page !== null) return { kind: 'lessonPage', lessonId: page[1] ?? '', page: Number(page[2]) };
  return null;
}

function actionOfCode(code: string): Action {
  if (code === 'f') return { type: 'fold' };
  if (code === 'k') return { type: 'check' };
  if (code === 'c') return { type: 'call' };
  const to = Number(code.slice(1));
  return code.startsWith('b') ? { type: 'bet', to } : { type: 'raise', to };
}

/** Fractions of the pot after a call, as street totals. Then the engine's minimum and all-in. */
const SIZE_PRESETS: readonly { readonly label: string; readonly potFraction: number }[] = [
  { label: '½ pot', potFraction: 0.5 },
  { label: 'Pot', potFraction: 1 },
];

/** One row per kind of decision: fold / check-or-call, then the sizes. */
export function actionButtons(view: PlayerView): Button[][] {
  const own = view.seats.find((seat) => seat.isSelf);
  if (own === undefined) return [];
  const at = (action: Action, label: string): Button => ({
    label,
    data: encodePress({ kind: 'act', handId: view.handId, sequence: view.actionSequence, action }),
  });
  const passive: Button[] = [];
  const sizes: Button[] = [];
  for (const legal of view.legalActions) {
    if (legal.type === 'fold') passive.push(at({ type: 'fold' }, 'Fold'));
    if (legal.type === 'check') passive.push(at({ type: 'check' }, 'Check'));
    if (legal.type === 'call')
      passive.push(at({ type: 'call' }, `Call ${view.amountToCall.toLocaleString('en-US')}`));
    if (legal.type === 'bet' || legal.type === 'raise') {
      for (const size of sizesFor(legal, view, own))
        sizes.push(at({ type: legal.type, to: size.to }, size.label));
    }
  }
  return sizes.length === 0 ? [passive] : [passive, sizes];
}

/**
 * Bet or raise totals for the presets, clamped to the engine's bounds, deduplicated by total.
 *
 * A preset is a fraction of the pot as it will stand after the reader calls, added on top of the
 * call: `committed + toCall + f × (pot + toCall)`. That is the usual "pot-sized raise", and it is
 * a street TOTAL because the engine's `to` is one ("raise to", `Action` in the engine's types).
 */
function sizesFor(legal: LegalAction, view: PlayerView, own: SeatView): { to: number; label: string }[] {
  const minTo = legal.minTo;
  const maxTo = legal.maxTo;
  if (minTo === undefined || maxTo === undefined) return [];
  const verb = legal.type === 'bet' ? 'Bet' : 'Raise to';
  const afterCall = own.committedThisStreet + view.amountToCall;
  const candidates = [
    { to: minTo, label: legal.type === 'bet' ? 'Bet' : 'Min raise to' },
    ...SIZE_PRESETS.map((preset) => ({
      to: Math.round(afterCall + preset.potFraction * (view.potTotal + view.amountToCall)),
      label: `${preset.label}: ${verb.toLowerCase()}`,
    })),
  ];
  const seen = new Set<number>();
  const sizes: { to: number; label: string }[] = [];
  for (const candidate of candidates) {
    const to = Math.min(maxTo, Math.max(minTo, candidate.to));
    if (to === maxTo || seen.has(to)) continue;
    seen.add(to);
    sizes.push({ to, label: `${candidate.label} ${to.toLocaleString('en-US')}` });
  }
  if (!seen.has(maxTo)) sizes.push({ to: maxTo, label: `All-in ${maxTo.toLocaleString('en-US')}` });
  return sizes.sort((left, right) => left.to - right.to);
}

const SUIT_SYMBOLS = ['♣', '♦', '♥', '♠'] as const;
const RANK_TEXT = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;

/** `A♥`, `10♠`. The suit is a symbol and never a colour alone (guardrail §6). */
export function cardText(card: number): string {
  return `${RANK_TEXT[rankIndexOf(card)] ?? '?'}${SUIT_SYMBOLS[suitIndexOf(card)] ?? '?'}`;
}

export function cardsText(cards: readonly number[]): string {
  return cards.map(cardText).join(' ');
}

const STREET_WORDS: Readonly<Record<PlayerView['street'], string>> = {
  preflop: 'Preflop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
  showdown: 'Showdown',
  complete: 'Hand over',
};

function seatLine(table: Table, seat: SeatView): string {
  const parts = [seat.position ?? '-', nameOf(table, seat.seat), units(seat.stack)];
  if (seat.committedThisStreet > 0)
    parts.push(`in front ${seat.committedThisStreet.toLocaleString('en-US')}`);
  if (seat.status === 'folded') parts.push('folded');
  if (seat.status === 'allIn') parts.push('all-in');
  if (seat.isToAct) parts.push('to act');
  return parts.join(' · ');
}

/**
 * A seat as a line of prose names it: "BB Patient Technician", or "You".
 *
 * The position is part of the name because the web's lineup seats two bots of one profile, and in
 * a transcript of a played hand "Patient Technician folds, Patient Technician checks" was two
 * different seats with nothing to tell them apart. Positions are unique within a hand.
 */
function who(table: Table, view: PlayerView, seat: SeatIndex): string {
  if (seat === READER_SEAT) return 'You';
  const position = view.seats.find((entry) => entry.seat === seat)?.position;
  return position == null ? nameOf(table, seat) : `${position} ${nameOf(table, seat)}`;
}

function actionWords(table: Table, view: PlayerView, seat: SeatIndex, action: Action): string {
  const name = who(table, view, seat);
  const verb = (third: string, second: string): string => `${name} ${seat === READER_SEAT ? second : third}`;
  switch (action.type) {
    case 'fold':
      return verb('folds', 'fold');
    case 'check':
      return verb('checks', 'check');
    case 'call':
      return verb('calls', 'call');
    case 'bet':
      return verb(`bets ${action.to.toLocaleString('en-US')}`, `bet ${action.to.toLocaleString('en-US')}`);
    case 'raise':
      return verb(
        `raises to ${action.to.toLocaleString('en-US')}`,
        `raise to ${action.to.toLocaleString('en-US')}`,
      );
  }
}

/** What happened since the reader last decided, so the bots' moves are legible in one message. */
function recap(table: Table, view: PlayerView): string[] {
  let from = -1;
  for (let index = view.actions.length - 1; index >= 0; index -= 1) {
    if (view.actions[index]?.seat === READER_SEAT) {
      from = index + 1;
      break;
    }
  }
  const since = view.actions.slice(Math.max(0, from));
  if (since.length === 0) return [];
  // One line per street. Run together, "Calling Station calls, Calling Station bets 67" read as
  // two actions on one street when the first was preflop and the second on the flop.
  const lines: string[] = [];
  for (const [index, logged] of since.entries()) {
    const words = actionWords(table, view, logged.seat, logged.action);
    if (since[index - 1]?.street === logged.street) lines[lines.length - 1] += `, ${words}`;
    else lines.push(`${STREET_WORDS[logged.street]}: ${words}`);
  }
  return ['', `${from === -1 ? 'So far' : 'Since your last move'}:`, ...lines.map((line) => `${line}.`)];
}

function header(table: Table, view: PlayerView): string[] {
  const own = view.seats.find((seat) => seat.isSelf);
  return [
    `Hand ${view.handNumber} · ${STREET_WORDS[view.street]} · Pot ${units(view.potTotal)}`,
    `Board: ${view.board.length === 0 ? '(none yet)' : cardsText(view.board)}`,
    `Your cards: ${own?.holeCards == null ? '(none)' : cardsText(own.holeCards)}`,
    '',
    ...view.seats.map((seat) => seatLine(table, seat)),
  ];
}

/** The table at the reader's decision. */
export function tableText(table: Table, view: PlayerView, coach: CoachReading | null): string {
  const lines = header(table, view);
  lines.push(...recap(table, view));
  lines.push('');
  if (view.amountToCall > 0) {
    lines.push(
      `Your turn: ${view.amountToCall.toLocaleString('en-US')} to call into ${units(view.potTotal)}.`,
    );
  } else {
    lines.push('Your turn: nothing to call.');
  }
  if (coach !== null) lines.push('', coachLine(coach));
  return lines.join('\n');
}

/** The table once the hand is over: who won what, and the cards that were actually shown. */
export function resultText(table: Table, view: PlayerView): string {
  const lines = header(table, view);
  lines.push(...recap(table, view));
  const result = view.result;
  if (result === null) return lines.join('\n');
  lines.push('');
  if (result.showdowns.length > 0) {
    lines.push('Shown at showdown:');
    for (const shown of result.showdowns) {
      lines.push(`${who(table, view, shown.seat)}: ${cardsText(shown.holeCards)}, ${shown.description}`);
    }
  } else {
    lines.push('Nobody showed: everyone else folded.');
  }
  for (const award of result.awards) {
    const pot = award.potIndex === 0 ? 'the main pot' : `side pot ${award.potIndex}`;
    const split = award.wasSplit ? ' (split)' : '';
    lines.push(
      `${who(table, view, award.seat)} ${award.seat === READER_SEAT ? 'win' : 'wins'} ${units(award.amount)} from ${pot}${split}.`,
    );
  }
  const net = result.netBySeat[READER_SEAT] ?? 0;
  const stack = view.seats.find((seat) => seat.isSelf)?.stack ?? 0;
  const signed = net > 0 ? `+${net.toLocaleString('en-US')}` : net.toLocaleString('en-US');
  lines.push(`Your result this hand: ${signed} units. You have ${units(stack)}.`);
  return lines.join('\n');
}
