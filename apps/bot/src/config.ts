/** Bad configuration stops the process with exit 78 (`EX_CONFIG`). No message contains the token. */

export const EXIT_CONFIG_INVALID = 78;

/** `<bot id>:<secret>`. Shape only. The poll loop refuses on a 401. */
const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

export type BotConfig =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly problem: string };

export function readBotConfig(env: Readonly<Record<string, string | undefined>>): BotConfig {
  const token = env['TELEGRAM_BOT_TOKEN']?.trim() ?? '';
  if (token === '') {
    return {
      ok: false,
      problem:
        'TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather in Telegram, then put ' +
        'TELEGRAM_BOT_TOKEN=<token> in the repository .env (gitignored) and run again. ' +
        'To play without Telegram: pnpm --filter @prl/bot play',
    };
  }
  if (!TOKEN_SHAPE.test(token)) {
    return {
      ok: false,
      problem:
        'TELEGRAM_BOT_TOKEN does not look like a @BotFather token (<digits>:<secret>). ' +
        'Check for a stray quote or a truncated paste; the value is not printed here.',
    };
  }
  return { ok: true, token };
}
