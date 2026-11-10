import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT_CONFIG_INVALID, readBotConfig } from '../src/config.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const SHAPED = '1234567:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ';

describe('the token', () => {
  test('missing or blank is refused with what to do', () => {
    for (const env of [{}, { TELEGRAM_BOT_TOKEN: '' }, { TELEGRAM_BOT_TOKEN: '   ' }]) {
      const config = readBotConfig(env);
      assert.equal(config.ok, false);
      if (!config.ok) assert.match(config.problem, /TELEGRAM_BOT_TOKEN is not set.*@BotFather.*\.env/s);
    }
  });

  test('a malformed token is refused without printing it', () => {
    const pasted = `"${SHAPED}"`;
    const config = readBotConfig({ TELEGRAM_BOT_TOKEN: pasted });
    assert.equal(config.ok, false);
    if (!config.ok) assert.ok(!config.problem.includes(SHAPED), 'the value is not in the message');
    assert.deepEqual(readBotConfig({ TELEGRAM_BOT_TOKEN: SHAPED }), { ok: true, token: SHAPED });
  });

  test('the bot process exits 78 with the message when the token is missing', () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== 'TELEGRAM_BOT_TOKEN'),
    );
    const run = spawnSync(process.execPath, [MAIN], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, EXIT_CONFIG_INVALID, `exit ${run.status}, stderr: ${run.stderr}`);
    assert.equal(EXIT_CONFIG_INVALID, 78);
    assert.match(run.stderr, /TELEGRAM_BOT_TOKEN is not set/);
    assert.equal(run.stdout, '', 'nothing else ran');
  });
});
