/**
 * The Telegram adapter: long polling and four Bot API methods, over `fetch`, no library.
 *
 * Everything that decides anything is in `step`. This file turns an update into an `Event`, and
 * an `Outgoing` into a request: `sendMessage`, `editMessageText`, `answerCallbackQuery`, and
 * `getUpdates` to receive. `fetch` is injected, so `test/telegram.test.ts` asserts every request
 * shape without a network or a token.
 *
 * ## Private chats only
 *
 * An update from any chat whose `type` is not `private` is dropped without a reply, buttons
 * included. A group is where one reader's table would become a shared surface, and ADR 0010 rules
 * out both a shared table among strangers and any channel between users.
 *
 * ## Every press is answered exactly once
 *
 * Telegram shows a spinner on a pressed button until `answerCallbackQuery` is called for it. The
 * answer goes first, carrying the toast if `step` produced one and nothing otherwise, so the
 * button stops spinning before any edit lands.
 *
 * ## Updates are handled one at a time
 *
 * `step` is synchronous and the requests are awaited in order, so two presses never interleave on
 * one session. The cost is that every chat waits behind every other chat's requests; for a first
 * slice that is the right trade against a per-chat queue. Sessions live in a `Map` in memory and
 * are lost on restart, which `/about` tells the reader.
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

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  readonly status: number;
  json(): Promise<unknown>;
}>;

export class TelegramError extends Error {
  override readonly name = 'TelegramError';
  readonly status: number;
  readonly description: string;
  readonly retryAfterSeconds: number | null;
  constructor(method: string, status: number, description: string, retryAfterSeconds: number | null) {
    // The method and Telegram's own description only. The URL carries the token and is never
    // part of a message that could reach a log.
    super(`${method} failed with ${status}: ${description}`);
    this.status = status;
    this.description = description;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface TelegramApi {
  call(method: string, body: Record<string, unknown>): Promise<unknown>;
}

export function telegramApi(token: string, fetchFn: Fetch): TelegramApi {
  return {
    async call(method, body) {
      const response = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        result?: unknown;
        description?: string;
        parameters?: { retry_after?: number };
      };
      if (payload.ok !== true) {
        throw new TelegramError(
          method,
          response.status,
          payload.description ?? 'no description',
          payload.parameters?.retry_after ?? null,
        );
      }
      return payload.result;
    },
  };
}

/**
 * Fills Telegram's "/" menu from `COMMANDS`, once at start-up. A menu is a convenience: a refusal
 * is logged and polling goes ahead, and a token Telegram rejects is still caught by `poll`.
 */
export async function registerCommands(api: TelegramApi, log: (line: string) => void): Promise<void> {
  const commands = Object.entries(COMMANDS).map(([command, { description }]) => ({ command, description }));
  try {
    await api.call('setMyCommands', { commands });
  } catch (error) {
    log(`setMyCommands failed (${errorText(error)}); the "/" menu is unchanged`);
  }
}

/** The parts of a Telegram `Update` this adapter reads. Anything else is ignored. */
interface Update {
  readonly update_id: number;
  readonly message?: {
    readonly chat: { readonly id: number; readonly type: string };
    readonly text?: string;
  };
  readonly callback_query?: {
    readonly id: string;
    readonly data?: string;
    readonly message?: {
      readonly message_id: number;
      readonly chat: { readonly id: number; readonly type: string };
    };
  };
}

export const TABLE_CLOSED =
  'Something went wrong at this table, so it has been closed. Send /start to deal a fresh one.';

export interface Chats {
  readonly sessions: Map<number, Session>;
}

export function newChats(): Chats {
  return { sessions: new Map() };
}

/** One update, start to finish. Returns without a request for anything outside a private chat. */
export async function handleUpdate(
  update: Update,
  chats: Chats,
  api: TelegramApi,
  deps: Deps,
): Promise<void> {
  const message = update.message;
  if (message !== undefined) {
    if (message.chat.type !== 'private' || message.text === undefined) return;
    await run(chats, message.chat.id, eventOfText(message.text), api, deps, null);
    return;
  }
  const query = update.callback_query;
  const anchor = query?.message;
  if (query === undefined || anchor === undefined || anchor.chat.type !== 'private') return;
  await run(chats, anchor.chat.id, { kind: 'button', data: query.data ?? '' }, api, deps, {
    queryId: query.id,
    messageId: anchor.message_id,
  });
}

async function run(
  chats: Chats,
  chatId: number,
  event: Event,
  api: TelegramApi,
  deps: Deps,
  press: { readonly queryId: string; readonly messageId: number } | null,
): Promise<void> {
  let result: ReturnType<typeof step>;
  try {
    result = step(chats.sessions.get(chatId) ?? NEW_SESSION, event, deps);
  } catch (error) {
    // A step that threw may have fed the bots' opponent models part of a hand, and those models
    // refuse to be fed the same hand twice, so retrying the press would throw again for ever.
    // Fail closed: drop the table and say so, rather than leave the reader on buttons that
    // cannot work.
    chats.sessions.delete(chatId);
    result = {
      session: NEW_SESSION,
      out: [{ kind: 'send', text: TABLE_CLOSED, buttons: [] }],
    };
    if (press !== null) await api.call('answerCallbackQuery', { callback_query_id: press.queryId });
    for (const out of result.out) await deliver(api, chatId, out, null);
    throw error;
  }
  chats.sessions.set(chatId, result.session);
  if (press !== null) {
    const toast = result.out.find((out) => out.kind === 'toast');
    await api.call('answerCallbackQuery', {
      callback_query_id: press.queryId,
      ...(toast === undefined ? {} : { text: toast.text }),
    });
  }
  for (const out of result.out) await deliver(api, chatId, out, press?.messageId ?? null);
}

/**
 * Telegram refuses a message over 4,096 characters. A preflop Why? against five opponents states
 * each opponent's range in full, about 650 characters apiece, and measured over 5,000 characters.
 * The assumptions may not be cut (CoachPanel's rule), so a long send is split at line breaks into
 * consecutive messages, with the buttons on the last. 4,000 leaves room for Telegram counting
 * UTF-16 units differently from what a reader sees.
 */
export const MESSAGE_LIMIT = 4_000;

export function splitForChat(text: string, limit = MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    for (let start = 0; start < Math.max(1, line.length); start += limit) {
      const piece = line.slice(start, start + limit);
      const candidate = current === '' ? piece : `${current}\n${piece}`;
      if (candidate.length <= limit) {
        current = candidate;
        continue;
      }
      chunks.push(current);
      current = piece;
    }
  }
  chunks.push(current);
  return chunks;
}

async function deliver(
  api: TelegramApi,
  chatId: number,
  out: Outgoing,
  messageId: number | null,
): Promise<void> {
  if (out.kind === 'toast') return;
  if (out.kind === 'send' || messageId === null) {
    const chunks = splitForChat(out.text);
    for (const [index, chunk] of chunks.entries()) {
      const last = index === chunks.length - 1;
      await api.call('sendMessage', { chat_id: chatId, text: chunk, ...(last ? markup(out.buttons) : {}) });
    }
    return;
  }
  try {
    await api.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: out.text,
      // An edit with no buttons must still say so, or the old buttons stay on the message.
      reply_markup: { inline_keyboard: keyboard(out.buttons) },
    });
  } catch (error) {
    // Telegram refuses an edit that changes nothing with a 400. The message already says what the
    // edit would have said, so that refusal is the outcome being asked for.
    if (error instanceof TelegramError && error.description.includes('message is not modified')) return;
    throw error;
  }
}

function keyboard(buttons: readonly (readonly Button[])[]): { text: string; callback_data: string }[][] {
  return buttons.map((row) => row.map((button) => ({ text: button.label, callback_data: button.data })));
}

function markup(buttons: readonly (readonly Button[])[]): Record<string, unknown> {
  return buttons.length === 0 ? {} : { reply_markup: { inline_keyboard: keyboard(buttons) } };
}

export interface PollOptions {
  readonly api: TelegramApi;
  readonly deps: Deps;
  readonly log: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  /** Stops the loop after the current request. */
  readonly shouldStop: () => boolean;
}

/** Why the loop stopped: only a refusal that no retry can fix stops it. */
export type PollExit = { readonly kind: 'stopped' } | { readonly kind: 'refused'; readonly reason: string };

const LONG_POLL_SECONDS = 30;

/**
 * Long polling until stopped or refused.
 *
 * A 401 (the token is wrong or revoked) and a 409 (a webhook is set, or another process is
 * polling the same bot) cannot be fixed by retrying, so they stop the loop for the caller to exit
 * 78. Anything else is retried after a pause, honouring Telegram's `retry_after` on a 429.
 */
export async function poll(options: PollOptions): Promise<PollExit> {
  const chats = newChats();
  let offset = 0;
  while (!options.shouldStop()) {
    let updates: Update[];
    try {
      updates = (await options.api.call('getUpdates', {
        offset,
        timeout: LONG_POLL_SECONDS,
        allowed_updates: ['message', 'callback_query'],
      })) as Update[];
    } catch (error) {
      if (error instanceof TelegramError && (error.status === 401 || error.status === 409)) {
        return { kind: 'refused', reason: error.message };
      }
      const wait =
        error instanceof TelegramError && error.retryAfterSeconds !== null
          ? error.retryAfterSeconds * 1000
          : 5_000;
      options.log(`getUpdates failed (${errorText(error)}); retrying in ${wait} ms`);
      await options.sleep(wait);
      continue;
    }
    for (const update of updates) {
      // Advanced before handling, so an update that throws is not fetched and retried for ever.
      offset = update.update_id + 1;
      try {
        await handleUpdate(update, chats, options.api, options.deps);
      } catch (error) {
        options.log(`update ${update.update_id} failed: ${errorText(error)}`);
      }
    }
  }
  return { kind: 'stopped' };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
