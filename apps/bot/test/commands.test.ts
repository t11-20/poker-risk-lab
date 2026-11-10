import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { COMMANDS, NEW_SESSION, step } from '../src/step.ts';
import { registerCommands, type TelegramApi, TelegramError } from '../src/telegram.ts';
import { encodePress } from '../src/view.ts';
import { testDeps } from './helpers.ts';

const UNKNOWN = 'Use the buttons, or send /start for the menu.';

/** Telegram's own limits for `BotCommand`: 1-32 of [a-z0-9_], and a description of 3-256. */
const COMMAND_NAME = /^[a-z0-9_]{1,32}$/;

describe('the command table', () => {
  test('lists the commands a reader needs, and each one is answered rather than refused', () => {
    const names = Object.keys(COMMANDS);
    assert.deepEqual(names, ['start', 'learn', 'quiz', 'define', 'about']);
    for (const name of names) {
      const { out } = step(NEW_SESSION, { kind: 'command', name, args: '' }, testDeps(1));
      assert.ok(out.length > 0, `/${name} sent nothing`);
      for (const message of out) {
        assert.ok(!('text' in message) || message.text !== UNKNOWN, `/${name} was answered as unknown`);
      }
    }
  });

  test('fits what setMyCommands accepts', () => {
    for (const [name, { description }] of Object.entries(COMMANDS)) {
      assert.match(name, COMMAND_NAME);
      assert.ok(description.length >= 3 && description.length <= 256, `/${name}: ${description.length}`);
    }
  });

  test('still answers the spellings that are not listed', () => {
    for (const [alias, target] of [
      ['help', 'about'],
      ['menu', 'start'],
    ] as const) {
      const viaAlias = step(NEW_SESSION, { kind: 'command', name: alias, args: '' }, testDeps(1)).out;
      const direct = step(NEW_SESSION, { kind: 'command', name: target, args: '' }, testDeps(1)).out;
      assert.deepEqual(viaAlias, direct, `/${alias}`);
    }
  });

  test('refuses a name it only inherits, and keeps a hand in progress (REGRESSION)', () => {
    // From review on #12: the table was a plain object, so `/constructor` found
    // Object.prototype.constructor, `.run` threw, and the Telegram adapter treats any throw from
    // `step` as a broken table and deletes the chat's session mid-hand.
    const dealt = step(NEW_SESSION, { kind: 'button', data: encodePress({ kind: 'play' }) }, testDeps(1));
    assert.ok(dealt.session.table !== null, 'the fixture deals a hand');
    for (const name of ['constructor', 'tostring', 'valueof', 'hasownproperty']) {
      const { session, out } = step(dealt.session, { kind: 'command', name, args: '' }, testDeps(1));
      assert.deepEqual(out, [{ kind: 'send', text: UNKNOWN, buttons: [] }], `/${name}`);
      assert.equal(session, dealt.session, `/${name} changed the session`);
    }
  });

  test('refuses a command it does not have', () => {
    const { out } = step(NEW_SESSION, { kind: 'command', name: 'deal', args: '' }, testDeps(1));
    assert.deepEqual(out, [{ kind: 'send', text: UNKNOWN, buttons: [] }]);
  });
});

describe('registerCommands', () => {
  test('sends the whole table to setMyCommands, in order', async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const api: TelegramApi = {
      call: (method, body) => {
        calls.push({ method, body });
        return Promise.resolve(true);
      },
    };
    await registerCommands(api, () => undefined);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call !== undefined);
    assert.equal(call.method, 'setMyCommands');
    const sent = call.body['commands'] as { command: string }[];
    assert.deepEqual(
      sent.map((entry) => entry.command),
      Object.keys(COMMANDS),
    );
  });

  test('logs a refusal and lets the bot start anyway', async () => {
    const lines: string[] = [];
    const api: TelegramApi = {
      call: () => Promise.reject(new TelegramError('setMyCommands', 400, 'Bad Request', null)),
    };
    await registerCommands(api, (line) => lines.push(line));
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /setMyCommands failed/);
  });
});
