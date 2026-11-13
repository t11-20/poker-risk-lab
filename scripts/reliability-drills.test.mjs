#!/usr/bin/env node
/**
 * Tests for the pure verdict functions in `scripts/drills/invariants.mjs`, the exit-code rule, the
 * harness route table, the psql argv and the cleanup ordering. Each negative control was checked by
 * breaking the implementation. Deleting `shuffleCursor` from `FORBIDDEN_KEYS` failed with
 * `"shuffleCursor" reached a client and the scanner said nothing`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analysisDrills } from './drills/analysis-drills.mjs';
import { databaseDrills } from './drills/database-drills.mjs';
import {
  createScratchDatabase,
  dropScratchDatabase,
  histogramBucket,
  metricValue,
  parseDsn,
  psqlCommand,
  ROUTES,
} from './drills/harness.mjs';
import {
  chipLedger,
  logLine,
  recoveryBound,
  scanForSecrets,
  scanTextForSecrets,
  settledHandCheck,
  visibleCardCheck,
} from './drills/invariants.mjs';
import { processDrills } from './drills/process-drills.mjs';
import { protocolDrills } from './drills/protocol-drills.mjs';
import { drillContext, runPassed, selectDrills } from './reliability-drills.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Written out, not imported, so deleting an entry from the implementation fails this test. */
const FORBIDDEN = [
  'deck',
  'deckOrder',
  'deckSecret',
  'salt',
  'salts',
  'saltBytes',
  'holeCardSalt',
  'cursor',
  'deckCursor',
  'shuffleCursor',
  'secret',
  'sessionSecret',
  'sessionToken',
  'csrfSecret',
  'password',
  'passphrase',
  'privateKey',
];

describe('the hidden-information scanner', () => {
  it('fires on every field name a client must never receive', () => {
    let scanned = 0;
    for (const key of FORBIDDEN) {
      const findings = scanForSecrets({ type: 'state', view: { [key]: 'anything at all' } }, 'frame');
      scanned += 1;
      assert.equal(
        findings.length,
        1,
        `"${key}" reached a client and the scanner said nothing: ${JSON.stringify(findings)}`,
      );
      assert.match(findings[0], new RegExp(key, 'i'));
    }
    assert.ok(scanned > 12, `only ${scanned} forbidden keys were exercised; the list must not shrink`);
  });

  it('finds a forbidden key however deeply it is buried, and names its path', () => {
    const findings = scanForSecrets({ a: [{ b: { c: [{ salts: [1, 2, 3] }] } }] }, 'deep');
    assert.equal(findings.length, 1);
    assert.match(findings[0], /a\[0\]\.b\.c\[0\]\.salts/);
  });

  it('separates the two spellings of the same key', () => {
    assert.equal(scanForSecrets({ hole_card_salt: 'x' }).length, 1);
    assert.equal(scanForSecrets({ 'deck-order': [] }).length, 1);
  });

  it('permits the salt of a card that is already public, in a real proof', () => {
    // `Card` is a number in the engine, so a socket frame carries integers and REST carries notation.
    const reveal = {
      commitment: { algorithm: 'sha256', root: 'a'.repeat(64), context: 'hand_x' },
      complete: false,
      cards: [
        { index: 3, card: 51, saltHex: 'b'.repeat(64), proof: ['c'.repeat(64)] },
        { index: 4, card: 'Ah', saltHex: 'd'.repeat(64), proof: [] },
      ],
    };
    assert.deepEqual(scanForSecrets(reveal, 'reveal'), []);
  });

  it('fires on a salt that is not attached to a proof', () => {
    const findings = scanForSecrets({ result: { saltHex: 'b'.repeat(64) } }, 'frame');
    assert.equal(findings.length, 1);
    assert.match(findings[0], /RevealedCard/);
  });

  it('refuses to recurse for ever, and says so', () => {
    const cyclic = { name: 'root' };
    cyclic.self = cyclic;
    assert.deepEqual(scanForSecrets(cyclic, 'cyclic'), []);
    let deep = { end: true };
    for (let level = 0; level < 60; level++) deep = { down: deep };
    const findings = scanForSecrets(deep, 'deep');
    assert.equal(findings.length, 1);
    assert.match(findings[0], /gave up at depth/);
  });
});

describe('the text scanner, for the things that are not JSON', () => {
  it('fires on a 64-hex value that is not a published hash', () => {
    const line = `{"msg":"dealt","hash":"${'f'.repeat(64)}"}`;
    assert.equal(scanTextForSecrets(line, 'log').length, 1);
  });

  it('stays quiet for a commitment root the client was legitimately shown', () => {
    const root = 'e'.repeat(64);
    assert.deepEqual(scanTextForSecrets(`root=${root}`, 'log', new Set([root])), []);
  });

  it('fires on a run of card notations long enough to be a deck fragment', () => {
    assert.equal(scanTextForSecrets('AhKdQs2c3h4s5d', 'log').length, 1);
    assert.deepEqual(scanTextForSecrets('board AhKdQs', 'log'), []);
  });
});

describe('the structural hole-card check', () => {
  const seat = (index, overrides) => ({
    seat: index,
    stack: 100,
    committedTotal: 0,
    holeCards: null,
    isSelf: false,
    ...overrides,
  });

  it('accepts a view in which only the viewer holds cards', () => {
    const view = {
      street: 'flop',
      viewerSeat: 0,
      seats: [seat(0, { holeCards: [1, 2], isSelf: true }), seat(1)],
    };
    assert.deepEqual(visibleCardCheck(view, 'view'), []);
  });

  it('fires when an opponent holds cards during play', () => {
    const view = {
      street: 'turn',
      viewerSeat: 0,
      seats: [seat(0, { holeCards: [1, 2], isSelf: true }), seat(1, { holeCards: [3, 4] })],
    };
    const findings = visibleCardCheck(view, 'view');
    assert.equal(findings.length, 1);
    assert.match(findings[0], /seat 1 exposed hole cards on street "turn"/);
  });

  /** Positive control. A checker that fired on every finished hand would be turned off. */
  it('accepts opponent cards at a completed showdown that names the seat', () => {
    const view = {
      street: 'complete',
      viewerSeat: 0,
      result: {
        showdowns: [
          { seat: 0, score: 1234 },
          { seat: 1, score: 999 },
        ],
      },
      seats: [seat(0, { holeCards: [1, 2], isSelf: true }), seat(1, { holeCards: [3, 4] })],
    };
    assert.deepEqual(visibleCardCheck(view, 'view'), []);
  });

  /**
   * Negative control for the showdown clause. A fold-out has an empty showdown list, so a folder's
   * cards on a completed view are a leak. With the `showedDown` set removed from `visibleCardCheck`
   * this returned `[]`.
   */
  it('fires when a completed hand exposes the cards of a seat that folded', () => {
    const view = {
      street: 'complete',
      viewerSeat: 0,
      result: { showdowns: [] },
      seats: [seat(0, { holeCards: [1, 2], isSelf: true }), seat(1, { holeCards: [3, 4] })],
    };
    const findings = visibleCardCheck(view, 'view');
    assert.equal(findings.length, 1, "a folder's cards on a completed hand must be a finding");
    assert.match(findings[0], /seat 1 exposed hole cards on a completed hand it did NOT show down in/);
  });

  it('fires for the seat that did not show, and stays quiet for the one that did', () => {
    // Distinguishes a checker that reads the showdown list from one that fires on every completed view.
    const view = {
      street: 'complete',
      viewerSeat: 0,
      result: { showdowns: [{ seat: 1, score: 500 }] },
      seats: [
        seat(0, { holeCards: [1, 2], isSelf: true }),
        seat(1, { holeCards: [3, 4] }),
        seat(2, { holeCards: [5, 6] }),
      ],
    };
    const findings = visibleCardCheck(view, 'view');
    assert.equal(findings.length, 1, 'exactly the seat that did not show down');
    assert.match(findings[0], /seat 2 exposed hole cards on a completed hand/);
  });

  /** `redactFor` sets `result` on every complete view, so missing it cannot justify opponent cards. */
  it('fires when a completed view carries opponent cards with no showdown list at all', () => {
    const view = {
      street: 'complete',
      viewerSeat: 0,
      seats: [seat(0, { holeCards: [1, 2], isSelf: true }), seat(1, { holeCards: [3, 4] })],
    };
    const findings = visibleCardCheck(view, 'view');
    assert.equal(findings.length, 1);
    assert.match(findings[0], /showdown seats: none/);
  });

  it('fires when isSelf and viewerSeat disagree', () => {
    const view = {
      street: 'flop',
      viewerSeat: 1,
      seats: [seat(0, { holeCards: [1, 2], isSelf: true })],
    };
    const findings = visibleCardCheck(view, 'view');
    assert.equal(findings.length, 1);
    assert.match(findings[0], /isSelf but viewerSeat is 1/);
  });
});

describe('the chip ledger', () => {
  /**
   * Captured from `ws-disconnect-mid-hand`: 200 a seat, blinds 1 and 2. At `complete` the pot is in
   * the stacks and `committedTotal` is not zeroed, so stacks plus commitments is 404.
   */
  const REAL_HAND = [
    { label: 'r4', street: 'preflop', stacks: [199, 198], committed: [1, 2] },
    { label: 'r5', street: 'preflop', stacks: [198, 198], committed: [2, 2] },
    { label: 'r10', street: 'river', stacks: [198, 198], committed: [2, 2] },
    { label: 'r12', street: 'complete', stacks: [202, 198], committed: [2, 2] },
  ].map((row) => ({
    label: row.label,
    view: {
      street: row.street,
      potTotal: row.committed.reduce((total, value) => total + value, 0),
      seats: row.stacks.map((stack, index) => ({
        seat: index,
        stack,
        committedTotal: row.committed[index],
      })),
    },
  }));

  it('accepts a real hand, settled view included', () => {
    const { findings, totals } = chipLedger(REAL_HAND);
    assert.deepEqual(findings, [], 'a hand in which nothing went wrong must produce no findings');
    assert.deepEqual(totals, [400, 400, 400, 400]);
  });

  it('fires when a chip is created', () => {
    const corrupted = structuredClone(REAL_HAND);
    corrupted[2].view.seats[0].stack = 199;
    const { findings } = chipLedger(corrupted);
    assert.ok(
      findings.some((entry) => /created 1/.test(entry)),
      findings.join(' | '),
    );
  });

  it('fires when a chip is destroyed at settlement', () => {
    const corrupted = structuredClone(REAL_HAND);
    corrupted[3].view.seats[0].stack = 201;
    const { findings } = chipLedger(corrupted);
    assert.ok(
      findings.some((entry) => /destroyed 1/.test(entry)),
      findings.join(' | '),
    );
  });

  it('fires when the pot disagrees with what the seats committed', () => {
    const corrupted = structuredClone(REAL_HAND);
    corrupted[1].view.potTotal = 5;
    const { findings } = chipLedger(corrupted);
    assert.ok(
      findings.some((entry) => /potTotal 5 does not equal the 4/.test(entry)),
      findings.join(' | '),
    );
  });

  it('ignores the frames between hands, where the view is null', () => {
    const { findings, totals } = chipLedger([{ label: 'between', view: null }, ...REAL_HAND]);
    assert.deepEqual(findings, []);
    assert.equal(totals.length, 4);
  });
});

describe('the settled-hand check', () => {
  const review = () => ({
    hand: { board: ['Ah', 'Kd', 'Qs', '2c', '3h'], potTotal: 4 },
    reveal: { complete: false, cards: [] },
    seats: [
      { seat: 0, startingStack: 200, net: 2, showedDown: true },
      { seat: 1, startingStack: 200, net: -2, showedDown: true },
    ],
  });

  it('accepts a hand whose nets sum to zero', () => {
    assert.deepEqual(settledHandCheck(review(), 'review'), []);
  });

  it('fires when chips were created', () => {
    const broken = review();
    broken.seats[0].net = 3;
    const findings = settledHandCheck(broken, 'review');
    assert.ok(
      findings.some((entry) => /nets sum to 1.*chips were created/.test(entry)),
      findings.join(' | '),
    );
  });

  it('fires when a seat finishes owing chips it never had', () => {
    const broken = review();
    broken.seats[0].net = -201;
    broken.seats[1].net = 201;
    const findings = settledHandCheck(broken, 'review');
    assert.ok(
      findings.some((entry) => /below zero/.test(entry)),
      findings.join(' | '),
    );
  });

  it('fires on a full-deck reveal attached to an ordinary hand', () => {
    const broken = review();
    broken.reveal.complete = true;
    const findings = settledHandCheck(broken, 'review');
    assert.ok(
      findings.some((entry) => /COMPLETE deck reveal/.test(entry)),
      findings.join(' | '),
    );
  });

  it('fires when more proofs are published than cards became public', () => {
    const broken = review();
    // Board plus two showdown seats is nine cards. Ten is one card nobody was shown.
    broken.reveal.cards = Array.from({ length: 10 }, (_unused, index) => ({
      index,
      card: index,
      saltHex: 'a'.repeat(64),
      proof: [],
    }));
    const findings = settledHandCheck(broken, 'review');
    assert.ok(
      findings.some((entry) => /10 proofs, but only 9/.test(entry)),
      findings.join(' | '),
    );
  });

  it('refuses a review with no seats rather than passing it', () => {
    const findings = settledHandCheck({ seats: [] }, 'review');
    assert.equal(findings.length, 1);
    assert.match(findings[0], /proves nothing/);
  });
});

describe('recovery bounds and log evidence', () => {
  it('distinguishes "never recovered" from "recovered slowly"', () => {
    assert.match(recoveryBound('the pool', null, 500)[0], /never recovered/);
    assert.match(recoveryBound('the pool', 900, 500)[0], /over the 500 ms budget/);
    assert.deepEqual(recoveryBound('the pool', 100, 500), []);
  });

  it('quotes the matching log line rather than summarising it', () => {
    const log = 'one\n{"msg":"shutdown complete","reason":"SIGTERM"}\nthree';
    const found = logLine(log, /shutdown complete/);
    assert.equal(found.found, true);
    assert.equal(found.line, '{"msg":"shutdown complete","reason":"SIGTERM"}');
    assert.equal(logLine(log, /shutdown timed out/).found, false);
  });
});

describe('the exposition reader', () => {
  /** Verbatim `GET /metrics` excerpt captured during `pool-exhaustion`. */
  const SCRAPE = `# HELP prl_db_probe_duration_seconds Time for the readiness probe.
# TYPE prl_db_probe_duration_seconds histogram
prl_db_probe_duration_seconds_bucket{le="0.001"} 2
prl_db_probe_duration_seconds_bucket{le="0.05"} 5
prl_db_probe_duration_seconds_bucket{le="+Inf"} 6
prl_db_probe_duration_seconds_sum 3.3269
prl_db_probe_duration_seconds_count 6
# TYPE prl_db_pool_max gauge
prl_db_pool_max 2
`;

  it('reads a bare gauge, a histogram bucket and a count', () => {
    assert.equal(metricValue(SCRAPE, 'prl_db_pool_max'), 2);
    assert.equal(metricValue(SCRAPE, 'prl_db_probe_duration_seconds_count'), 6);
    assert.equal(histogramBucket(SCRAPE, 'prl_db_probe_duration_seconds', '0.05'), 5);
  });

  it('answers null for a series that is absent, and not zero', () => {
    const absent = metricValue(SCRAPE, 'prl_worker_tasks_total');
    assert.equal(absent, null);
    assert.notEqual(absent, 0);
  });

  it('does not confuse a series with one that shares its prefix', () => {
    assert.equal(metricValue(SCRAPE, 'prl_db_probe_duration_seconds'), null);
  });
});

describe('the scratch-database guard', () => {
  it('refuses to create anything not named prl_drills_*', async () => {
    // `create database` cannot be parameterised and `dropScratchDatabase` uses the same check, so a
    // name that slipped through would aim `drop database` at it.
    for (const name of ['poker_risk_lab', 'postgres', 'prl_drills', 'prl_drills_x; drop database y']) {
      await assert.rejects(
        () => createScratchDatabase('container', 'postgresql://u:p@h:1/db', name),
        /must be named prl_drills/,
        `"${name}" was not refused`,
      );
    }
  });

  it('refuses to drop anything not named prl_drills_*, without throwing', async () => {
    const result = await dropScratchDatabase('container', 'postgresql://u:p@h:1/db', 'poker_risk_lab');
    assert.equal(result.code, 1);
    assert.equal(result.stderr, 'refused');
  });

  it('parses a DSN without mangling a percent-encoded password', () => {
    const parts = parseDsn('postgresql://poker:p%40ss%2Fword@127.0.0.1:5432/poker_risk_lab');
    assert.equal(parts.user, 'poker');
    assert.equal(parts.password, 'p@ss/word');
    assert.equal(parts.database, 'poker_risk_lab');
    assert.equal(parts.port, '5432');
    assert.match(parts.withDatabase('prl_drills_1'), /\/prl_drills_1$/);
  });
});

describe('the drill registry and the exit-code contract', () => {
  const ALL = [...processDrills, ...protocolDrills, ...analysisDrills, ...databaseDrills];

  it('declares every drill exactly once, with a name and a title', () => {
    const names = ALL.map((drill) => drill.name);
    assert.equal(new Set(names).size, names.length, `duplicate drill name in ${names.join(', ')}`);
    assert.ok(names.length >= 16, `only ${names.length} drills are registered`);
    for (const drill of ALL) {
      assert.equal(typeof drill.title, 'string');
      assert.ok(drill.title.length > 10, `${drill.name} has no useful title`);
      assert.equal(typeof drill.run, 'function');
    }
  });

  it('selects by --only and removes by --exclude', () => {
    assert.deepEqual(
      selectDrills(ALL, { only: ['sigterm-idle'], exclude: [] }).map((drill) => drill.name),
      ['sigterm-idle'],
    );
    assert.equal(selectDrills(ALL, { only: [], exclude: [] }).length, ALL.length);
    assert.equal(
      selectDrills(ALL, { only: [], exclude: ['sigterm-idle'] }).some(
        (drill) => drill.name === 'sigterm-idle',
      ),
      false,
    );
    assert.deepEqual(selectDrills(ALL, { only: ['sigterm-idle'], exclude: ['sigterm-idle'] }), []);
  });

  it('fails the run for a drill that could not run', () => {
    const skipped = [{ status: 'pass' }, { status: 'skip' }];
    assert.equal(runPassed(skipped), false, 'a skipped drill must fail the run');
    assert.equal(runPassed([{ status: 'pass' }, { status: 'pass' }]), true);
    assert.equal(runPassed([{ status: 'fail' }]), false);
    assert.equal(runPassed([]), true);
  });
});

describe('the route table the harness speaks to', () => {
  /** `wiring.test.ts` writes its manifest by hand, so a stale harness path fails here. */
  it('names only paths the API is asserted to serve', () => {
    const source = readFileSync(join(REPO_ROOT, 'apps', 'api', 'test', 'wiring.test.ts'), 'utf8');
    const manifest = new Set([...source.matchAll(/url:\s*'(\/api\/v1[^']*)'/g)].map((match) => match[1]));
    assert.ok(manifest.size > 12, `only ${manifest.size} routes were read from the wiring manifest`);

    let checked = 0;
    for (const [name, path] of Object.entries(ROUTES)) {
      // `/metrics` is outside the versioned prefix and the feature-route manifest.
      if (!path.startsWith('/api/v1')) continue;
      checked += 1;
      assert.ok(manifest.has(path), `ROUTES.${name} is "${path}", which the API does not serve`);
    }
    assert.ok(checked > 8, `only ${checked} routes were cross-checked`);
  });
});

/**
 * `-e PGPASSWORD=<secret>` would put the password in `/proc/<pid>/cmdline`. Against the old argv
 * this failed with `[ '-e', 'PGPASSWORD=pa55w0rd-in-argv' ]`.
 */
describe('the psql invocation', () => {
  const SECRET = 'pa55w0rd-in-argv';
  const DSN = `postgresql://poker:${SECRET}@127.0.0.1:5432/poker_risk_lab`;
  const command = psqlCommand('prl-pg', DSN, 'prl_drills_1', 'select 1');

  it('never puts the password in the argument vector', () => {
    const withSecret = command.args.filter((argument) => String(argument).includes(SECRET));
    assert.deepEqual(withSecret, [], 'the password would be readable in `ps` for the life of the exec');
  });

  it('forwards PGPASSWORD from the environment with a bare -e', () => {
    // Positive control. Dropping the password would also pass "not in argv" and fail to authenticate.
    const at = command.args.indexOf('PGPASSWORD');
    assert.ok(at > 0, `the argv must forward PGPASSWORD by name; got ${command.args.join(' ')}`);
    assert.equal(command.args[at - 1], '-e', 'the bare -e form is what makes docker forward it');
    assert.equal(command.env.PGPASSWORD, SECRET, 'and the value must reach the child');
  });

  it('still speaks to the right container, user, database and statement', () => {
    assert.equal(command.command, 'docker');
    assert.ok(command.args.includes('prl-pg'));
    assert.deepEqual(command.args.slice(-8, -2), [
      '-U',
      'poker',
      '-d',
      'prl_drills_1',
      '-v',
      'ON_ERROR_STOP=1',
    ]);
    assert.equal(command.args.at(-2), '-tAc');
    assert.equal(command.args.at(-1), 'select 1');
  });
});

/**
 * The detached child is unreachable from `startServer`'s rejection. With `cleanups.push` moved back
 * below the await, the first assertion failed with `cleanups.length` 0.
 */
describe('the cleanup ledger a drill is handed', () => {
  const BASE = {
    databaseUrl: 'postgresql://u:p@127.0.0.1:5432/prl_drills_1',
    webOrigin: 'http://127.0.0.1:3000',
    graceMs: 5_000,
    metricsToken: 'token',
  };

  it('registers a spawned API child for cleanup before the start can reject', async () => {
    const cleanups = [];
    let stopped = 0;
    const neverListens = async (options) => {
      options.onSpawn({
        stop: () => {
          stopped += 1;
          return Promise.resolve();
        },
      });
      // Anything after this await was not reached under the old ordering.
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error('the server did not report a listening address in 30s.');
    };

    const scoped = drillContext(BASE, cleanups, neverListens);
    await assert.rejects(() => scoped.startServer(), /did not report a listening address/);

    assert.equal(cleanups.length, 1, 'the child must be registered for cleanup before it can be orphaned');
    for (const fn of cleanups) await fn();
    assert.equal(stopped, 1, 'and running the ledger must actually stop it');
  });

  it('registers exactly one cleanup for a server that DOES start', async () => {
    // Positive control. Registering twice would kill a healthy server twice during teardown.
    const cleanups = [];
    let stopped = 0;
    const starts = (options) => {
      const handle = {
        stop: () => {
          stopped += 1;
          return Promise.resolve();
        },
      };
      options.onSpawn(handle);
      return Promise.resolve({ ...handle, origin: 'http://127.0.0.1:1234' });
    };

    const scoped = drillContext(BASE, cleanups, starts);
    const server = await scoped.startServer();
    assert.equal(server.origin, 'http://127.0.0.1:1234');
    assert.equal(cleanups.length, 1);
    for (const fn of cleanups) await fn();
    assert.equal(stopped, 1);
  });

  it('passes the run settings through, and lets a drill override them', async () => {
    let seen = null;
    const capture = (options) => {
      seen = options;
      // This case checks what `drillContext` forwards. The two cases above check the ledger.
      options.onSpawn({ stop: () => Promise.resolve() });
      return Promise.resolve({});
    };
    const scoped = drillContext(BASE, [], capture);
    await scoped.startServer({ graceMs: 250, env: { LOG_LEVEL: 'debug' } });
    assert.equal(seen.databaseUrl, BASE.databaseUrl);
    assert.equal(seen.metricsToken, 'token');
    assert.equal(seen.graceMs, 250, 'a drill must be able to override a run setting');
    assert.deepEqual(seen.env, { LOG_LEVEL: 'debug' });
    assert.equal(typeof seen.onSpawn, 'function', 'without this the harness cannot register the child');
  });

  it('still lets a drill register its own cleanups', () => {
    const cleanups = [];
    const scoped = drillContext(BASE, cleanups, () => Promise.resolve({}));
    scoped.cleanup(() => Promise.resolve());
    assert.equal(cleanups.length, 1);
  });
});
