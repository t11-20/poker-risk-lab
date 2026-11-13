/** `pnpm --filter @prl/bot start`: the Telegram bot, by long polling. */

import { topPercentRange } from '@prl/poker-math';
import { EXIT_CONFIG_INVALID, readBotConfig } from './config.ts';
import { productionDeps } from './deps.ts';
import { poll, registerCommands, telegramApi } from './telegram.ts';

const config = readBotConfig(process.env);
if (!config.ok) {
  console.error(config.problem);
  process.exit(EXIT_CONFIG_INVALID);
}
const { token } = config;
// No line this process writes may carry the token.
const log = (line: string): void => console.error(line.split(token).join('<token>'));

// The preflop strength table takes 3,034 ms cold. Build it before the first update.
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
