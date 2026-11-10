/** `pnpm --filter @prl/bot start`: the Telegram bot, by long polling. */

import { topPercentRange } from '@prl/poker-math';
import { EXIT_CONFIG_INVALID, readBotConfig } from './config.ts';
import { productionDeps } from './deps.ts';
import { poll, registerCommands, telegramApi } from './telegram.ts';

const config = readBotConfig(process.env);
if (!config.ok) {
  // No logger exists yet, and a process that dies silently is the alternative.
  console.error(config.problem);
  process.exit(EXIT_CONFIG_INVALID);
}
const { token } = config;
// Belt to `TelegramError`'s braces: no line this process writes may carry the credential.
const log = (line: string): void => console.error(line.split(token).join('<token>'));

// The Coach's `top:40` range needs the preflop strength table, which the API measured at 3,034 ms
// to build cold. Built here, before the first update, so the first reader does not wait for it.
const warmStart = Date.now();
topPercentRange(40);
log(`coach range table ready in ${Date.now() - warmStart} ms`);

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

const api = telegramApi(token, fetch);
await registerCommands(api, log);

const exit = await poll({
  api,
  deps: productionDeps(),
  log,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  shouldStop: () => false,
});
if (exit.kind === 'refused') {
  log(`Telegram refused this bot: ${exit.reason}`);
  process.exit(EXIT_CONFIG_INVALID);
}
