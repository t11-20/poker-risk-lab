/**
 * The terminal adapter: the same `step` as Telegram, with buttons numbered.
 *
 * It exists so a person, a test and a transcript can play without Telegram. It honours the same
 * contract the Telegram adapter does: `edit` replaces the message whose button was pressed, which
 * here is always the latest message that has buttons, because that is the only one a number can
 * press.
 */

import {
  COMMANDS,
  type Deps,
  type Event,
  eventOfText,
  NEW_SESSION,
  type Outgoing,
  type Session,
  step,
} from './step.ts';
import type { Button } from './view.ts';

export interface TerminalIo {
  readonly lines: AsyncIterable<string>;
  readonly write: (text: string) => void;
}

export async function runTerminal(io: TerminalIo, deps: Deps): Promise<Session> {
  let session = NEW_SESSION;
  let live: readonly (readonly Button[])[] = [];
  const apply = (event: Event): void => {
    const result = step(session, event, deps);
    session = result.session;
    for (const out of result.out) live = render(io, out, live);
  };
  const commands = Object.keys(COMMANDS)
    .map((name) => `/${name}`)
    .join(', ');
  io.write(
    `Type a number to press a button, or a command: ${commands}, or /quit. ` +
      "To send a number as a message instead, as a quiz answer, start it with a quote: '2\n",
  );
  apply({ kind: 'command', name: 'start', args: '' });
  for await (const raw of io.lines) {
    const line = raw.trim();
    io.write(`> ${line}\n`);
    if (line === '/quit') break;
    // A bare number presses a button here, which Telegram never confuses with typing. A quiz
    // answer of 2 next to two buttons needs a way to be typed, and this is it.
    if (line.startsWith("'")) {
      apply({ kind: 'text', text: line.slice(1) });
      continue;
    }
    if (line.startsWith('/')) {
      apply(eventOfText(line));
      continue;
    }
    const button = /^\d+$/.test(line) ? live.flat()[Number(line) - 1] : undefined;
    if (button === undefined) {
      apply({ kind: 'text', text: line });
      continue;
    }
    apply({ kind: 'button', data: button.data });
  }
  return session;
}

function render(io: TerminalIo, out: Outgoing, live: readonly (readonly Button[])[]): typeof live {
  if (out.kind === 'toast') {
    io.write(`(notice) ${out.text}\n`);
    return live;
  }
  const rule = out.kind === 'edit' ? '----- message edited -----' : '----- new message -----';
  io.write(`${rule}\n${out.text}\n`);
  if (out.buttons.length === 0) return live;
  let index = 0;
  for (const row of out.buttons) {
    const labels = row.map((button, column) => `[${index + column + 1}] ${button.label}`);
    index += row.length;
    io.write(`${labels.join('   ')}\n`);
  }
  return out.buttons;
}
