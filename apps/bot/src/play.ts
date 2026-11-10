/** `pnpm --filter @prl/bot play`: a table in this terminal, on the production dependencies. */

import { createInterface } from 'node:readline';
import { productionDeps } from './deps.ts';
import { runTerminal } from './terminal.ts';

const lines = createInterface({ input: process.stdin, terminal: false });
await runTerminal({ lines, write: (text) => process.stdout.write(text) }, productionDeps());
lines.close();
