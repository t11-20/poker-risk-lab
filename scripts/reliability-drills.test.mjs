#!/usr/bin/env node
/**
 * Tests for the reliability-drill suite's own judgement.
 *
 * Run with:  node --test scripts/reliability-drills.test.mjs
 * Also run by:  pnpm run test:scripts
 *
 * ## What these exist to prevent
 *
 * A failure-injection suite is a machine for producing green ticks about disasters, and every
 * one of those ticks is a claim somebody will quote. The drills themselves cannot be run here —
 * they spawn servers and stop containers — but everything that turns an observation into a
 * VERDICT is pure, lives in `scripts/drills/invariants.mjs`, and is tested below. The four
 * specific defects being guarded against:
 *
 * 1. **A hidden-information scanner that finds nothing.** The most valuable assertion in the
 *    suite is "nothing the client received named a deck, a salt or a cursor", and a scanner with
 *    a typo in its key list makes that sentence true of every run for ever. So every forbidden
 *    key is fed to it and asserted to fire, and the one salt a client is legitimately allowed to
 *    hold — a `RevealedCard` proof for a card that is already public — is asserted NOT to.
 *
 * 2. **A chip ledger that cannot see a missing chip.** Conservation is the assertion that would
 *    catch a corrupted settlement after a crash, so a fabricated ledger with one chip created
 *    and one destroyed is fed to it, and both are asserted to be found. The real per-view
 *    sequence measured from a live hand is pinned alongside, because the settled view counts its
 *    chips differently (see `chipLedger`) and the first version of that function reported chip
 *    creation on every hand that finished.
 *
 * 3. **A skip that quietly passes.** The suite's exit-code contract says a drill that could not
 *    run fails the run unless it was named in `--exclude`. That rule is one `??` away from
 *    inverting, and a suite that silently skips is a suite that lies, so it is pinned here.
 *
 * 4. **Routes drifting out from under the harness.** The harness cannot import `@prl/contracts`,
 *    so its route table is a copy — and `scripts/load-test.mjs` has already shipped one of those
 *    with three wrong paths that no test noticed. Every path is cross-checked against the
 *    manifest in `apps/api/test/wiring.test.ts`, which is itself written out by hand rather than
 *    derived from the router.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Checked by breaking each one on purpose while writing them:
 *
 *   - the secret scanner: one entry was deleted from `FORBIDDEN_KEYS` in the implementation and
 *     this file failed with `"shuffleCursor" reached a client and the scanner said nothing`. The
 *     list here is written out rather than imported, so it cannot shrink in step with the thing
 *     it checks.
 *   - the chip ledger: the `settled` branch was removed from the implementation, and three of
 *     these tests failed — the positive control (a real hand, which the double-counted pot makes
 *     look like chip creation) and the settlement-corruption control (whose one missing chip the
 *     double-count now hides). The mid-hand creation control still fired. That is the pair
 *     needed: one test proves the checker detects corruption, another proves it does not invent
 *     it, and a third proves the corruption it detects is not masked.
 *   - the exit-code contract: `runPassed` is asserted false for a skip and true for the same
 *     list with the skip removed, so an implementation that treated skip as success fails.
 *   - the route table: `ROUTES.joinRoom` was pointed at `/api/v1/rooms/:roomId/join` and the
 *     cross-check failed by name. It also asserts it read a non-empty manifest and compared a
 *     non-empty set, so a manifest that stopped being found would fail rather than pass
 *     vacuously.
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

/**
 * Every key `scanForSecrets` must refuse, written out here rather than imported.
 *
 * Importing the module's own list would make this test a restatement of the implementation: it
 * would pass for any list, including an empty one. Written out, deleting an entry from the
 * implementation fails this test.
 */
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
    // The shape `RevealedCard` actually has on the wire, cards included: `Card` is a NUMBER in
    // the engine, so a socket frame carries integers and a REST body carries notation.
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

  /**
   * POSITIVE CONTROL for the showdown clause: a genuine showdown, whose `result.showdowns`
   * names the seat whose cards are visible. This is the shape `redactFor` produces at
   * `street: 'complete'` for a hand that went to the end, and it must stay silent — a checker
   * that fired here would fire on every finished hand and be turned off within a week.
   */
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
   * NEGATIVE CONTROL for the second clause of the rule.
   *
   * The documented rule is "once the street is complete, only the cards of seats that SHOWED
   * DOWN". The implementation carried only the first clause, so any non-null `holeCards` on a
   * completed view passed. The test that used to sit here asserted `[]` against a completed
   * view with no `result` at ALL — vacuous twice over: it neither supplied a showdown list nor
   * could have distinguished a checker that read one from a checker that did not, and it
   * pinned the gap in place.
   *
   * This is the leak the clause exists to catch, and it is the worst kind: a hand that ends by
   * folding produces an EMPTY showdown list by construction, so a folder's cards reaching the
   * table tells every observer whether they were bluffing.
   *
   * Confirmed to fail against the old code: with the `showedDown` set removed from
   * `visibleCardCheck`, this case returns `[]` and the assertion below fails with
   * `findings.length` 0, while the two positive controls still pass.
   */
  it('fires when a completed hand exposes the cards of a seat that folded', () => {
    const view = {
      street: 'complete',
      viewerSeat: 0,
      // A fold-out: the hand finished, and nobody tabled anything.
      result: { showdowns: [] },
      seats: [seat(0, { holeCards: [1, 2], isSelf: true }), seat(1, { holeCards: [3, 4] })],
    };
    const findings = visibleCardCheck(view, 'view');
    assert.equal(findings.length, 1, "a folder's cards on a completed hand must be a finding");
    assert.match(findings[0], /seat 1 exposed hole cards on a completed hand it did NOT show down in/);
  });

  it('fires for the seat that did not show, and stays quiet for the one that did', () => {
    // A river call between three seats where one had already folded. Distinguishes a checker
    // that reads the showdown list from one that fires on every completed view.
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

  /**
   * A completed view carrying opponent cards and NO showdown list cannot justify them.
   *
   * `redactFor` populates `result` on every `street: 'complete'` view, so this shape means
   * either a serialiser that dropped the field or a frame that was assembled somewhere else —
   * and "I cannot tell whether this was shown, therefore it is fine" is precisely the reasoning
   * that produced the original gap.
   */
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
   * A real hand, measured.
   *
   * Captured from a live two-seat table during `ws-disconnect-mid-hand`: 200 units a seat, blinds
   * of 1 and 2, a check-down to a river the small blind won. The last row is the one that matters
   * — at `street: complete` the pot has been paid into the stacks and `committedTotal` is NOT
   * zeroed, so stacks plus commitments is 404 for a hand in which no chip was ever created.
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
    // Five board cards plus two showdown seats is nine; ten is one card nobody was shown.
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
  /** A verbatim excerpt of this service's own `GET /metrics`, captured during `pool-exhaustion`. */
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
    // The distinction the pool drill depends on: a metric nobody feeds and a metric reading zero
    // look identical on a graph and mean completely different things.
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
    // The single most dangerous line in the suite: `create database` cannot be parameterised, and
    // the same helper is used by `dropScratchDatabase`. A name that slipped through here would be
    // a `drop database` aimed at whatever it named.
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
  /**
   * Cross-checked against `apps/api/test/wiring.test.ts`, which writes its manifest out by hand
   * rather than deriving it from the router — so a route that moves breaks a test there, and a
   * harness pointing at the old path breaks here.
   */
  it('names only paths the API is asserted to serve', () => {
    const source = readFileSync(join(REPO_ROOT, 'apps', 'api', 'test', 'wiring.test.ts'), 'utf8');
    const manifest = new Set([...source.matchAll(/url:\s*'(\/api\/v1[^']*)'/g)].map((match) => match[1]));
    assert.ok(manifest.size > 12, `only ${manifest.size} routes were read from the wiring manifest`);

    let checked = 0;
    for (const [name, path] of Object.entries(ROUTES)) {
      // `/metrics` is served by `app.ts` outside the versioned prefix and is deliberately absent
      // from the feature-route manifest.
      if (!path.startsWith('/api/v1')) continue;
      checked += 1;
      assert.ok(manifest.has(path), `ROUTES.${name} is "${path}", which the API does not serve`);
    }
    assert.ok(checked > 8, `only ${checked} routes were cross-checked`);
  });
});

// ---------------------------------------------------------------------------
// The database password never travels in argv
// ---------------------------------------------------------------------------

/**
 * `psql` runs inside the Postgres container over `docker exec`, and the password used to be
 * passed as `-e PGPASSWORD=<secret>` — in the argument vector. `/proc/<pid>/cmdline` is
 * world-readable on Linux, so for the life of every one of those execs any user on the host
 * could read the database password out of `ps`. It also reaches process accounting and any `ps`
 * output somebody pastes into a bug report.
 *
 * `scripts/backup.mjs` already did this correctly (`'-e', 'PGPASSWORD'` bare, with the value in
 * the child's environment) and says why above its `toolCommand`. This is the same shape.
 *
 * ## Would this fail against the old code?
 *
 * Yes — checked by running it against the previous argv. `assert.equal(withSecret, [])` failed
 * with `[ '-e', 'PGPASSWORD=pa55w0rd-in-argv' ]`, naming the exact element. The password used
 * here is a distinctive literal so a partial match cannot hide it.
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
    // The positive control for the assertion above: an implementation that simply DROPPED the
    // password would also pass "not in argv", and would then fail to authenticate. This pins
    // that the secret is still delivered, by the other route.
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

// ---------------------------------------------------------------------------
// A drill that cannot start its server must not leak the child
// ---------------------------------------------------------------------------

/**
 * `startServer` waits up to thirty seconds for the API's own listening line, and the child it
 * spawned is `detached: true` — its own process group, unreachable from the rejection, which
 * carries a message and not a pid.
 *
 * The registration used to sit AFTER that await, so it ran only when the start succeeded. A
 * server that never printed a listening address left a live API process holding a port and a
 * pool of database connections for as long as the machine stayed up, and the next run failed
 * somewhere that had nothing to do with the cause. The file header promises every drill cleans
 * up after itself INCLUDING ON FAILURE; that was the one case where it did not.
 *
 * ## Would this fail against the old code?
 *
 * Yes, and it was confirmed that way: with the `cleanups.push` moved back below the await, the
 * first assertion fails with `cleanups.length` 0 — the drill context finished with nothing
 * registered and the stub child never stopped.
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
    /** A server that spawns and then never reports a listening address, exactly as the real one. */
    const neverListens = async (options) => {
      options.onSpawn({
        stop: () => {
          stopped += 1;
          return Promise.resolve();
        },
      });
      // The await is what made the old ordering wrong: anything after it is not reached.
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
    // The positive control. A context that registered nothing would pass the assertion above's
    // sibling only by accident, and a context that registered twice would kill a healthy server
    // twice during teardown.
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
      // A stub that records nothing: this case is about what `drillContext` FORWARDS, and the
      // ledger's contents are asserted by the two cases above.
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
