/**
 * The Telegram adapter: long polling and four Bot API methods over an injected `fetch`. All decisions
 * are in `step`.
 * Only private chats are served. ADR 0010 rules out a shared table and any channel between users.
 * Every press is answered once with `answerCallbackQuery`, before any edit, to stop the spinner.
 * Updates run one at a time so two presses never interleave on a session. Sessions live in memory
 * and are lost on restart, which `/about` says.
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
    // Never the URL, which carries the token.
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

/** A refusal is logged and polling goes ahead. `poll` still catches a rejected token. */
export async function registerCommands(api: TelegramApi, log: (line: string) => void): Promise<void> {
  const commands = Object.entries(COMMANDS).map(([command, { description }]) => ({ command, description }));
  try {
    await api.call('setMyCommands', { commands });
  } catch (error) {
    log(`setMyCommands failed (${errorText(error)}); the "/" menu is unchanged`);
  }
}

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
    // The opponent models may have seen part of the hand and refuse it twice, so a retry would
    // throw for ever. Fail closed and drop the table.
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
 * Telegram refuses a message over 4,096 characters. Assumptions may not be cut, so a long send splits
 * at line breaks with the buttons last. 4,000 leaves room for Telegram counting UTF-16 units.
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
    // A 400 for an edit that changes nothing means the message already says it.
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

export type PollExit = { readonly kind: 'stopped' } | { readonly kind: 'refused'; readonly reason: string };

const LONG_POLL_SECONDS = 30;

/**
 * A 401 (bad token) or 409 (webhook set, or another poller) stops the loop so the caller exits 78.
 * Anything else retries after a pause, honouring `retry_after` on a 429.
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
