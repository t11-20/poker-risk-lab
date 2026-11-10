import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { STALE } from '../src/step.ts';
import {
  type Chats,
  eventOfText,
  handleUpdate,
  MESSAGE_LIMIT,
  newChats,
  poll,
  splitForChat,
  TABLE_CLOSED,
  type TelegramApi,
  TelegramError,
  telegramApi,
} from '../src/telegram.ts';
import { CALLBACK_DATA_MAX_BYTES } from '../src/view.ts';
import { realCoach, testDeps } from './helpers.ts';

interface Call {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/** A fake Bot API: records every call, answers like Telegram, and numbers sent messages. */
function fakeApi(): { api: TelegramApi; calls: Call[] } {
  const calls: Call[] = [];
  let nextId = 100;
  return {
    calls,
    api: {
      call: (method, body) => {
        calls.push({ method, body });
        if (method !== 'sendMessage') return Promise.resolve(true);
        nextId += 1;
        return Promise.resolve({ message_id: nextId });
      },
    },
  };
}

const PRIVATE = { id: 42, type: 'private' };

function text(update: number, body: string, chat = PRIVATE) {
  return { update_id: update, message: { chat, text: body } };
}

function tap(update: number, data: string, messageId: number, chat = PRIVATE) {
  return {
    update_id: update,
    callback_query: { id: `q${update}`, data, message: { message_id: messageId, chat } },
  };
}

type Keyboard = { text: string; callback_data: string }[][];

function keyboardOf(call: Call | undefined): Keyboard {
  const markup = call?.body['reply_markup'] as { inline_keyboard: Keyboard } | undefined;
  return markup?.inline_keyboard ?? [];
}

function dataFor(call: Call | undefined, label: RegExp): string {
  const button = keyboardOf(call)
    .flat()
    .find((entry) => label.test(entry.text));
  if (button === undefined) throw new Error(`no ${label} button`);
  return button.callback_data;
}

describe('requests', () => {
  test('the HTTP request is a JSON POST to the method, and a refusal keeps the token out of the error', async () => {
    const seen: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] =
      [];
    // prl-allow-secret: a made-up token of the @BotFather shape, never issued
    const token = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123';
    const api = telegramApi(token, (url, init) => {
      seen.push({ url, init });
      const payload = { ok: false, description: 'Bad Request: chat not found' };
      return Promise.resolve({ status: 400, json: () => Promise.resolve(payload) });
    });
    await assert.rejects(api.call('sendMessage', { chat_id: 1, text: 'x' }), (error: unknown) => {
      assert.ok(error instanceof TelegramError);
      assert.equal(error.status, 400);
      assert.ok(!error.message.includes(token), 'the token is not in the error');
      return true;
    });
    assert.equal(seen[0]?.url, `https://api.telegram.org/bot${token}/sendMessage`);
    assert.equal(seen[0]?.init.method, 'POST');
    assert.equal(seen[0]?.init.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(seen[0]?.init.body ?? ''), { chat_id: 1, text: 'x' });
  });

  test('/start sends one plain-text message with an inline keyboard', async () => {
    const { api, calls } = fakeApi();
    await handleUpdate(text(1, '/start'), newChats(), api, testDeps(1));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'sendMessage');
    assert.equal(calls[0]?.body['chat_id'], 42);
    assert.equal(calls[0]?.body['parse_mode'], undefined, 'plain text: nothing to escape, nothing to reject');
    assert.deepEqual(
      keyboardOf(calls[0])
        .flat()
        .map((button) => button.text),
      ['Play a hand', 'About', 'Reset units'],
    );
  });

  test('a press is answered first, then edits the message it was pressed on', async () => {
    const { api, calls } = fakeApi();
    const chats = newChats();
    const deps = testDeps(4);
    await handleUpdate(text(1, '/start'), chats, api, deps);
    await handleUpdate(tap(2, dataFor(calls[0], /^Play a hand$/), 101), chats, api, deps);
    assert.deepEqual(
      calls.slice(1).map((call) => call.method),
      ['answerCallbackQuery', 'sendMessage'],
    );
    assert.deepEqual(calls[1]?.body, { callback_query_id: 'q2' });
    const table = calls[2];
    const fold = dataFor(table, /^Fold$|^Check$/);
    await handleUpdate(tap(3, fold, 102), chats, api, deps);
    assert.deepEqual(
      calls.slice(3).map((call) => call.method),
      ['answerCallbackQuery', 'editMessageText'],
    );
    assert.equal(calls[4]?.body['message_id'], 102);
    assert.equal(calls[4]?.body['chat_id'], 42);
    assert.equal(typeof calls[4]?.body['text'], 'string');

    // The same button again: a toast on the press, and no message touched.
    await handleUpdate(tap(4, fold, 102), chats, api, deps);
    assert.deepEqual(calls.slice(5), [
      { method: 'answerCallbackQuery', body: { callback_query_id: 'q4', text: STALE } },
    ]);
  });

  test('every callback_data across played hands fits in 64 bytes, and every message under the limit', async () => {
    const { api, calls } = fakeApi();
    const chats = newChats();
    const deps = testDeps(8, realCoach);
    await handleUpdate(text(1, '/start'), chats, api, deps);
    let update = 1;
    let target = 101;
    let data = dataFor(calls[0], /^Play a hand$/);
    for (let presses = 0; presses < 40; presses += 1) {
      const before = calls.length;
      update += 1;
      await handleUpdate(tap(update, data, target), chats, api, deps);
      const sent = calls.slice(before).filter((call) => call.method !== 'answerCallbackQuery');
      const last = sent[sent.length - 1];
      if (last?.method === 'sendMessage')
        target = 100 + calls.filter((call) => call.method === 'sendMessage').length;
      const why = keyboardOf(last)
        .flat()
        .find((button) => button.text === 'Why?');
      if (why !== undefined && presses % 3 === 0) {
        update += 1;
        await handleUpdate(tap(update, why.callback_data, target), chats, api, deps);
      }
      const next = keyboardOf(last)
        .flat()
        .find((button) => /^(Check|Call|Deal the next hand|Reset units|Play a hand)/.test(button.text));
      if (next === undefined) break;
      data = next.callback_data;
    }
    const buttons = calls.flatMap((call) => keyboardOf(call).flat());
    assert.ok(buttons.length > 30, `checked ${buttons.length} buttons`);
    for (const button of buttons) {
      const bytes = Buffer.byteLength(button.callback_data, 'utf8');
      assert.ok(bytes <= CALLBACK_DATA_MAX_BYTES, `${button.callback_data} is ${bytes} bytes`);
    }
    const texts = calls.flatMap((call) => (typeof call.body['text'] === 'string' ? [call.body['text']] : []));
    for (const body of texts) assert.ok(body.length <= MESSAGE_LIMIT, `a ${body.length}-character message`);
  });

  test('a long send is split at line breaks, buttons on the last part, nothing lost', () => {
    const long = Array.from({ length: 200 }, (_, index) => `line ${index} ${'x'.repeat(40)}`).join('\n');
    const parts = splitForChat(long);
    assert.ok(parts.length > 1);
    for (const part of parts) assert.ok(part.length <= MESSAGE_LIMIT);
    assert.equal(parts.join('\n'), long);
  });

  test('"message is not modified" is not an error; other refusals are', async () => {
    for (const [description, fails] of [
      ['Bad Request: message is not modified', false],
      ['Bad Request: chat not found', true],
    ] as const) {
      const chats: Chats = newChats();
      const deps = testDeps(4);
      const { api: recording, calls } = fakeApi();
      await handleUpdate(text(1, '/start'), chats, recording, deps);
      await handleUpdate(tap(2, dataFor(calls[0], /^Play a hand$/), 101), chats, recording, deps);
      const refusing: TelegramApi = {
        call: (method, body) => {
          if (method === 'editMessageText') {
            return Promise.reject(new TelegramError(method, 400, description, null));
          }
          return recording.call(method, body);
        },
      };
      const pressed = handleUpdate(tap(3, dataFor(calls[2], /^Fold$|^Check$/), 102), chats, refusing, deps);
      if (fails) await assert.rejects(pressed, TelegramError);
      else await pressed;
    }
  });

  test('a step that throws closes the table and tells the reader, instead of failing the same way for ever', async () => {
    const { api, calls } = fakeApi();
    const chats = newChats();
    const deps = testDeps(4);
    await handleUpdate(text(1, '/start'), chats, api, deps);
    const broken = {
      ...deps,
      dealRandom: () => {
        throw new Error('dealer exploded');
      },
    };
    await assert.rejects(
      handleUpdate(tap(2, dataFor(calls[0], /^Play a hand$/), 101), chats, api, broken),
      /exploded/,
    );
    assert.deepEqual(
      calls.slice(1).map((call) => call.method),
      ['answerCallbackQuery', 'sendMessage'],
    );
    assert.equal(calls[2]?.body['text'], TABLE_CLOSED);
    assert.equal(chats.sessions.has(42), false);
  });
});

describe('who the bot answers', () => {
  test('group, supergroup and channel updates get no request at all, buttons included', async () => {
    const { api, calls } = fakeApi();
    const chats = newChats();
    for (const type of ['group', 'supergroup', 'channel']) {
      const chat = { id: -100, type };
      await handleUpdate(text(1, '/start', chat), chats, api, testDeps(1));
      await handleUpdate(text(2, 'hello everyone', chat), chats, api, testDeps(1));
      await handleUpdate(tap(3, 'p', 5, chat), chats, api, testDeps(1));
    }
    assert.deepEqual(calls, []);
    assert.equal(chats.sessions.size, 0, 'no session was created for a group');
  });

  test('commands are read with or without the bot name; other text is text', () => {
    assert.deepEqual(eventOfText('/start'), { kind: 'command', name: 'start' });
    assert.deepEqual(eventOfText('/About@prl_bot'), { kind: 'command', name: 'about' });
    assert.deepEqual(eventOfText('hello'), { kind: 'text', text: 'hello' });
  });
});

describe('the poll loop', () => {
  test('a 401 or a 409 stops it as a refusal; anything else is retried', async () => {
    for (const status of [401, 409]) {
      const exit = await poll({
        api: {
          call: (method) => Promise.reject(new TelegramError(method, status, 'no', null)),
        },
        deps: testDeps(1),
        log: () => undefined,
        sleep: async () => undefined,
        shouldStop: () => false,
      });
      assert.equal(exit.kind, 'refused', `status ${status}`);
    }

    const waits: number[] = [];
    const { api, calls } = fakeApi();
    let polls = 0;
    const exit = await poll({
      api: {
        call: (method, body) => {
          if (method !== 'getUpdates') return api.call(method, body);
          polls += 1;
          if (polls === 1) return Promise.reject(new TelegramError(method, 429, 'Too Many Requests', 3));
          if (polls === 2) return Promise.reject(new Error('fetch failed'));
          if (polls === 3) return Promise.resolve([text(7, '/start')]);
          assert.equal(body['offset'], 8, 'the offset moved past the handled update');
          return Promise.resolve([]);
        },
      },
      deps: testDeps(1),
      log: () => undefined,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      shouldStop: () => polls >= 4,
    });
    assert.equal(exit.kind, 'stopped');
    assert.deepEqual(waits, [3_000, 5_000], 'retry_after honoured, then the default pause');
    assert.equal(calls.filter((call) => call.method === 'sendMessage').length, 1);
  });
});
