/**
 * The drills that kill, restart or half-deploy the process while a learner is at a table.
 *
 * `apps/api/test/shutdown.test.ts` only drains empty tables. These signal a process holding chips
 * in a pot and check, through a SECOND process on the same database, that the money survived and
 * that the client was told 4503 rather than seeing a dropped network. One API process at a time,
 * so rolling deploys and load balancer draining are not exercised.
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  actOn,
  dealHand,
  eventsSince,
  freePort,
  measureUntil,
  newReport,
  playHandToCompletion,
  REPO_ROOT,
  ROUTES,
  Session,
  seatWithBot,
  sleep,
  TableClient,
} from './harness.mjs';
import {
  chipLedger,
  logLine,
  recoveryBound,
  scanForSecrets,
  scanTextForSecrets,
  settledHandCheck,
  visibleCardCheck,
} from './invariants.mjs';

/**
 * `WS_CLOSE.serverShuttingDown` in @prl/contracts, written out because this suite may not import
 * the workspace. `apps/web/src/lib/table-socket.ts` keys its "restarting" state on it.
 */
const WS_SERVER_SHUTTING_DOWN = 4503;

const READY_BUDGET_MS = 20_000;

const LEARNER_SEAT = 0;

/** All checks in one place, so no drill can quietly omit the hole-card check. */
function scanClient(client, label, findings) {
  for (const [index, entry] of client.frames.entries()) {
    findings.push(...scanForSecrets(entry.frame, `${label} frame ${index}`));
    if (entry.frame?.type === 'state') {
      findings.push(...visibleCardCheck(entry.frame.view, `${label} frame ${index}`));
    }
  }
  for (const entry of client.session.transcript) {
    findings.push(...scanForSecrets(entry.body, `${label} ${entry.label}`));
  }
}

/** Roots and proof nodes are public 64-hex values, like a salt, so only those this client saw pass. */
function publishedHashes(client) {
  const allowed = new Set();
  const collect = (node, depth) => {
    if (depth > 30 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const entry of node) collect(entry, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'commitmentRoot' || key === 'root') && typeof value === 'string') allowed.add(value);
      if (key === 'proof' && Array.isArray(value)) for (const hash of value) allowed.add(hash);
      if (key === 'saltHex' && typeof value === 'string') allowed.add(value);
      collect(value, depth + 1);
    }
  };
  for (const entry of client.frames) collect(entry.frame, 0);
  return allowed;
}

function roomPath(roomId) {
  return ROUTES.room.replace(':roomId', roomId);
}

function memberUnits(room) {
  const members = Array.isArray(room?.members) ? room.members : [];
  return members.reduce((total, member) => total + (typeof member.stack === 'number' ? member.stack : 0), 0);
}

export const sigtermIdle = {
  name: 'sigterm-idle',
  title: 'API SIGTERM while idle',
  async run(ctx) {
    const report = newReport();
    const server = await ctx.startServer();

    const session = new Session(server.origin, ctx.webOrigin, 'Idle drill');
    const health = await session.request(ROUTES.health);
    const ready = await session.request(ROUTES.ready);
    if (health.status !== 200) report.failures.push(`/health answered ${health.status} before the signal`);
    if (ready.status !== 200) report.failures.push(`/ready answered ${ready.status} before the signal`);

    const exit = await server.signal('SIGTERM');
    report.measurements.shutdownMs = Math.round(exit.elapsedMs);
    report.measurements.exitCode = exit.code;

    if (exit.code !== 0) report.failures.push(`exited ${String(exit.code)} rather than 0`);
    if (exit.signal !== null) report.failures.push(`died by ${exit.signal} rather than exiting itself`);
    const budget = server.graceMs / 3;
    if (exit.elapsedMs > budget) {
      report.failures.push(
        `took ${Math.round(exit.elapsedMs)} ms to stop, over the ${Math.round(budget)} ms budget ` +
          `(a third of the ${server.graceMs} ms grace)`,
      );
    }

    const output = server.output();
    const complete = logLine(output, /shutdown complete/);
    const timedOut = logLine(output, /shutdown timed out/);
    if (!complete.found) report.failures.push('the process never logged "shutdown complete"');
    else report.evidence.push({ label: 'clean stop', text: complete.line });
    if (timedOut.found) report.failures.push(`the drain hit its deadline: ${timedOut.line}`);

    // The port must refuse, not hang. A socket that accepts and never answers stalls a load balancer.
    const afterwards = await session.request(ROUTES.ready);
    if (afterwards.status !== 0) {
      report.failures.push(`/ready answered ${afterwards.status} after the process exited`);
    } else {
      report.observations.push(
        `the port refuses connections once the process is gone (${afterwards.transportError})`,
      );
    }

    const replacement = await ctx.startServer();
    const readyIn = await measureUntil(async () => {
      const probe = await new Session(replacement.origin, ctx.webOrigin, 'Recovery probe').request(
        ROUTES.ready,
      );
      return probe.status === 200;
    }, READY_BUDGET_MS);
    report.measurements.replacementReadyMs = readyIn === null ? null : Math.round(readyIn);
    report.failures.push(...recoveryBound('a replacement process', readyIn, READY_BUDGET_MS));
    await replacement.stop();

    report.failures.push(...scanTextForSecrets(output, 'the API log'));
    report.observations.push(`stopped in ${Math.round(exit.elapsedMs)} ms with exit code 0`);
    return report;
  },
};

export const sigtermMidHand = {
  name: 'sigterm-mid-hand',
  title: 'API SIGTERM during an ACTIVE hand',
  async run(ctx) {
    const report = newReport();
    const server = await ctx.startServer();
    const session = new Session(server.origin, ctx.webOrigin, 'Mid-hand drill');
    await session.createGuest();

    const table = await seatWithBot(session, { name: 'Mid-hand SIGTERM' });
    const startingStack = 200;
    const seats = 2;
    const started = await dealHand(table.client);
    if (started === null) {
      report.failures.push('the table never dealt a hand, so nothing was interrupted');
      return report;
    }

    // Act once, so there is money in the pot and `actionSequence` is past zero.
    const view = await table.client.waitForTurn(20_000);
    if (view === null) {
      report.failures.push('the server never offered a decision, so the hand was not under way');
      return report;
    }
    actOn(table.client, view);
    await sleep(400);

    const committedBefore = (table.client.lastView?.seats ?? []).reduce(
      (total, seat) => total + (seat.committedTotal ?? 0),
      0,
    );
    if (committedBefore <= 0) {
      report.failures.push('no chips were committed, so this run did not interrupt a live pot');
    } else {
      report.observations.push(`${committedBefore} units were in the pot when SIGTERM was sent`);
    }
    report.measurements.potAtSignal = committedBefore;

    const exit = await server.signal('SIGTERM');
    report.measurements.shutdownMs = Math.round(exit.elapsedMs);
    report.measurements.exitCode = exit.code;
    if (exit.code !== 0) report.failures.push(`exited ${String(exit.code)} with a hand in progress`);
    const budget = server.graceMs / 2;
    if (exit.elapsedMs > budget) {
      report.failures.push(`took ${Math.round(exit.elapsedMs)} ms to stop, over the ${budget} ms budget`);
    }

    const closeCode = await table.client.waitForClose(5_000);
    report.measurements.closeCode = closeCode;
    if (closeCode !== WS_SERVER_SHUTTING_DOWN) {
      report.failures.push(
        `the table socket closed with ${String(closeCode)}, not ${WS_SERVER_SHUTTING_DOWN} ` +
          '(the client cannot tell a deploy from a lost network)',
      );
    } else {
      report.observations.push(
        `the socket was closed with ${WS_SERVER_SHUTTING_DOWN} (server shutting down)`,
      );
    }

    const output = server.output();
    const closing = logLine(output, /closing websockets for shutdown/);
    if (closing.found) report.evidence.push({ label: 'sockets drained', text: closing.line });
    else report.warnings.push('the log did not say it was closing websockets');
    const complete = logLine(output, /shutdown complete/);
    if (!complete.found) report.failures.push('the process never logged "shutdown complete"');
    else report.evidence.push({ label: 'clean stop', text: complete.line });

    const ledger = chipLedger(table.client.views);
    report.failures.push(...ledger.findings);
    report.measurements.chipsInPlay = ledger.totals.at(-1) ?? null;
    scanClient(table.client, 'mid-hand client', report.failures);
    report.failures.push(...scanTextForSecrets(output, 'the API log', publishedHashes(table.client)));

    const replacement = await ctx.startServer();
    const recovered = new Session(replacement.origin, ctx.webOrigin, 'Recovery');
    // The same cookies, so this is the same learner returning.
    recovered.cookies = new Map(session.cookies);
    recovered.csrfToken = session.csrfToken;
    recovered.userId = session.userId;

    const readyIn = await measureUntil(async () => {
      const probe = await recovered.request(ROUTES.ready);
      return probe.status === 200;
    }, READY_BUDGET_MS);
    report.failures.push(...recoveryBound('the replacement process', readyIn, READY_BUDGET_MS));
    report.measurements.replacementReadyMs = readyIn === null ? null : Math.round(readyIn);

    const reconnect = new TableClient(recovered, table.roomId);
    const reconnectedIn = await measureUntil(async () => {
      try {
        await reconnect.connect();
        return true;
      } catch {
        return false;
      }
    }, READY_BUDGET_MS);
    report.measurements.reconnectMs = reconnectedIn === null ? null : Math.round(reconnectedIn);
    report.failures.push(...recoveryBound('the table socket', reconnectedIn, READY_BUDGET_MS));

    const room = await recovered.request(roomPath(table.roomId));
    const units = memberUnits(room.body?.room ?? room.body);
    report.measurements.unitsAfterRestart = units;
    if (units !== startingStack * seats) {
      report.failures.push(
        `the room's seats hold ${units} units after the restart; ${startingStack * seats} were bought in`,
      );
    } else {
      report.observations.push(`every unit survived the restart: ${units} across ${seats} seats`);
    }

    const abandoned = logLine(replacement.output(), /interrupted/i);
    if (abandoned.found) report.evidence.push({ label: 'interrupted hand reconciled', text: abandoned.line });

    const dealt = await dealHand(reconnect, 20_000);
    if (dealt === null) {
      report.failures.push('the recovered table would not deal a new hand');
    } else {
      const played = await playHandToCompletion(reconnect, { budgetMs: 40_000 });
      if (!played.completed) {
        report.failures.push(`the recovered table stalled: ${played.reason}`);
      } else {
        report.observations.push(`a full hand played out after the restart (${played.actions} actions)`);
        const listed = await recovered.request(`${ROUTES.hands}?roomId=${table.roomId}`);
        const first = listed.body?.hands?.[0];
        if (first === undefined) {
          report.failures.push('the recovered hand was not written to the hand history');
        } else {
          const review = await recovered.request(ROUTES.hand.replace(':handId', first.id));
          report.failures.push(...settledHandCheck(review.body, 'the hand played after the restart'));
          report.observations.push(`the settled hand balances to zero (pot ${first.potTotal})`);
        }
      }
    }
    scanClient(reconnect, 'reconnected client', report.failures);
    reconnect.close();
    await replacement.stop();
    return report;
  },
};

export const wsDisconnectMidHand = {
  name: 'ws-disconnect-mid-hand',
  title: 'WebSocket disconnect mid-hand',
  async run(ctx) {
    const report = newReport();
    const server = await ctx.startServer();
    const session = new Session(server.origin, ctx.webOrigin, 'Disconnect drill');
    await session.createGuest();

    const table = await seatWithBot(session, { name: 'Disconnect mid-hand' });
    if ((await dealHand(table.client)) === null) {
      report.failures.push('the table never dealt a hand');
      return report;
    }
    const view = await table.client.waitForTurn(20_000);
    if (view === null) {
      report.failures.push('the server never offered a decision');
      return report;
    }
    const handId = view.handId;
    actOn(table.client, view);
    await sleep(400);

    const before = table.client.lastView;
    table.client.terminate();
    await table.client.waitForClose(5_000);
    report.observations.push('the socket was dropped mid-hand without a shutdown handshake');

    const health = await session.request(ROUTES.health);
    if (health.status !== 200) {
      report.failures.push(`the API answered ${health.status} on /health after a client vanished`);
    }

    const reconnect = new TableClient(session, table.roomId);
    const backIn = await measureUntil(async () => {
      try {
        await reconnect.connect();
        return true;
      } catch {
        return false;
      }
    }, 15_000);
    report.measurements.reconnectMs = backIn === null ? null : Math.round(backIn);
    report.failures.push(...recoveryBound('reconnecting to the table', backIn, 15_000));

    const resumed = await reconnect.waitForFrame((f) => f.type === 'state' && f.view !== null, 10_000);
    if (resumed === null) {
      report.failures.push('the reconnected socket was never sent the table state');
    } else if (resumed.view.handId !== handId) {
      report.failures.push(
        `the reconnected socket was shown hand ${String(resumed.view.handId)}, not the hand ` +
          `${String(handId)} that was in progress`,
      );
    } else {
      report.observations.push('the reconnected socket resumed the same hand, whole, with no delta protocol');
    }

    const ledger = chipLedger([...table.client.views, ...reconnect.views]);
    report.failures.push(...ledger.findings);
    report.measurements.chipsInPlay = ledger.totals.at(-1) ?? null;
    if (before !== null && resumed !== null) {
      const wasCommitted = before.seats.reduce((total, seat) => total + (seat.committedTotal ?? 0), 0);
      const nowCommitted = resumed.view.seats.reduce((total, seat) => total + (seat.committedTotal ?? 0), 0);
      if (nowCommitted < wasCommitted) {
        report.failures.push(
          `the pot shrank across the reconnect: ${wasCommitted} committed before, ${nowCommitted} after`,
        );
      }
    }

    const played = await playHandToCompletion(reconnect, { budgetMs: 40_000 });
    if (!played.completed)
      report.failures.push(`the hand never finished after the reconnect: ${played.reason}`);
    else report.observations.push('the interrupted hand played through to a settled result');

    scanClient(table.client, 'dropped client', report.failures);
    scanClient(reconnect, 'reconnected client', report.failures);
    report.failures.push(...scanTextForSecrets(server.output(), 'the API log', publishedHashes(reconnect)));
    reconnect.close();
    return report;
  },
};

export const silentTcpDuringDrain = {
  name: 'silent-tcp-during-drain',
  title: 'Raw TCP connections that say nothing, open at the signal and during the drain',
  async run(ctx) {
    const report = newReport();
    const server = await ctx.startServer();

    const openSilent = () =>
      new Promise((done, fail) => {
        const socket = connect(server.port, '127.0.0.1');
        socket.setNoDelay(true);
        socket.once('connect', () => done(socket));
        socket.once('error', fail);
      });

    // One before the signal and one during the drain, which is what a health probe produces in a deploy.
    const early = await openSilent();
    report.observations.push(
      'a connection was open, accepted, and had sent nothing at the instant of SIGTERM',
    );
    const exiting = server.signal('SIGTERM');
    await sleep(120);
    let late = null;
    try {
      late = await openSilent();
      report.observations.push('a connection opened DURING the drain and sent nothing');
    } catch (error) {
      report.observations.push(`a connection opened during the drain was refused (${error.code ?? 'error'})`);
    }

    const exit = await exiting;
    report.measurements.shutdownMs = Math.round(exit.elapsedMs);
    report.measurements.exitCode = exit.code;
    early.destroy();
    late?.destroy();

    if (exit.code !== 0) {
      report.failures.push(
        `exited ${String(exit.code)}: a silent TCP connection held the drain open, which is the ` +
          'defect `trackConnections`/`isDrainBlocking` exist to prevent',
      );
    }
    const budget = server.graceMs / 2;
    if (exit.elapsedMs > budget) {
      report.failures.push(
        `took ${Math.round(exit.elapsedMs)} ms to stop against a ${budget} ms budget: the drain waited ` +
          'for a connection that owed it nothing',
      );
    } else {
      report.observations.push(`stopped in ${Math.round(exit.elapsedMs)} ms despite the silent connections`);
    }
    const timedOut = logLine(server.output(), /shutdown timed out/);
    if (timedOut.found) report.failures.push(`the drain hit its deadline: ${timedOut.line}`);
    const complete = logLine(server.output(), /shutdown complete/);
    if (complete.found) report.evidence.push({ label: 'clean stop', text: complete.line });
    return report;
  },
};

export const restartWithActiveRooms = {
  name: 'restart-with-active-rooms',
  title: 'Restart with active rooms, and all twelve AI Legend profiles rehydrating',
  async run(ctx) {
    const report = newReport();
    const server = await ctx.startServer();
    const session = new Session(server.origin, ctx.webOrigin, 'Legends drill');
    await session.createGuest();

    // The server's own list, so a new Legend is covered without editing this drill.
    const listed = await session.request('/api/v1/legends/profiles');
    const profileIds = (listed.body?.profiles ?? []).map((profile) => profile.id).filter(Boolean);
    report.measurements.profilesDeclared = profileIds.length;
    if (profileIds.length === 0) {
      report.failures.push('GET /legends/profiles returned no profiles, so nothing could be covered');
      return report;
    }

    // At most five opponents fit at a table.
    const rooms = [];
    for (let index = 0; index < profileIds.length; index += 5) {
      const group = profileIds.slice(index, index + 5);
      const created = await session.request(ROUTES.legendMatches, {
        method: 'POST',
        body: {
          profileIds: group,
          difficulty: 'realistic',
          startingStack: 200,
          smallBlind: 1,
          bigBlind: 2,
        },
      });
      if (!created.ok) {
        report.failures.push(`creating a Legends match for ${group.join(', ')} failed: ${created.status}`);
        return report;
      }
      rooms.push({ roomId: created.body.roomId, profiles: group });
    }
    report.observations.push(
      `${profileIds.length} Legend profiles seated across ${rooms.length} rooms before the restart`,
    );

    const first = rooms[0];
    const client = new TableClient(session, first.roomId);
    await client.connect();
    const sitId = `sit-${Date.now()}`;
    client.send({ type: 'sit', seat: LEARNER_SEAT, requestId: sitId });
    await client.waitForFrame((f) => f.type === 'ack' && f.requestId === sitId, 10_000);
    const dealt = await dealHand(client, 20_000);
    if (dealt === null) report.warnings.push('the Legends table did not deal before the restart');
    const decision = await client.waitForTurn(20_000);
    if (decision !== null) actOn(client, decision);
    await sleep(400);

    const unitsBefore = [];
    for (const room of rooms) {
      const body = await session.request(roomPath(room.roomId));
      unitsBefore.push(memberUnits(body.body?.room ?? body.body));
    }

    const exit = await server.signal('SIGTERM');
    report.measurements.exitCode = exit.code;
    if (exit.code !== 0) report.failures.push(`the process exited ${String(exit.code)} with live rooms`);

    const replacement = await ctx.startServer();
    const recovered = new Session(replacement.origin, ctx.webOrigin, 'Recovered');
    recovered.cookies = new Map(session.cookies);
    recovered.csrfToken = session.csrfToken;
    recovered.userId = session.userId;

    const restored = new Set();
    for (const [index, room] of rooms.entries()) {
      // `RoomRegistry.ensureOpen` reopens a room only when it is requested, so this read is the recovery.
      const body = await recovered.request(roomPath(room.roomId));
      if (!body.ok) {
        report.failures.push(`room ${room.roomId} could not be read after the restart: ${body.status}`);
        continue;
      }
      const summary = body.body?.room ?? body.body;
      for (const member of summary?.members ?? []) {
        if (member.isBot === true && typeof member.botProfile === 'string') restored.add(member.botProfile);
      }
      const units = memberUnits(summary);
      if (units !== unitsBefore[index]) {
        report.failures.push(
          `room ${room.roomId} held ${unitsBefore[index]} units before the restart and ${units} after`,
        );
      }
    }

    const missing = profileIds.filter((id) => !restored.has(id));
    report.measurements.profilesRestored = restored.size;
    if (missing.length > 0) {
      report.failures.push(
        `${missing.length} Legend profile(s) did not survive the restart: ${missing.join(', ')}`,
      );
    } else {
      report.observations.push(`all ${restored.size} Legend profiles came back with their own identity`);
    }

    const unrecoverable = logLine(replacement.output(), /bot seat could not be restored/);
    if (unrecoverable.found) {
      report.failures.push(`a seat came back inert: ${unrecoverable.line}`);
    }

    // Only a bot acting on its own proves the runner came back. An inert seat waits for the turn clock.
    const reconnect = new TableClient(recovered, first.roomId);
    await reconnect.connect();
    const eventsFrom = reconnect.events.length;
    const dealtAgain = await dealHand(reconnect, 20_000);
    if (dealtAgain === null) {
      report.failures.push('the recovered Legends table would not deal');
    } else {
      const played = await playHandToCompletion(reconnect, { budgetMs: 60_000 });
      const timeouts = eventsSince(reconnect, eventsFrom, 'seatTimedOut');
      // `wasAutomatic` marks a turn-clock fold, which is what an inert seat produces. A restored bot
      // is an `action` from a non-learner seat. Asserting on `wasAutomatic` passed with every bot dead.
      const botActions = eventsSince(reconnect, eventsFrom, 'action').filter(
        (event) => event.seat !== LEARNER_SEAT,
      );
      report.measurements.opponentActionsAfterRestart = botActions.length;
      report.measurements.forcedActionsAfterRestart = eventsSince(reconnect, eventsFrom, 'action').filter(
        (event) => event.wasAutomatic === true,
      ).length;
      if (!played.completed) report.failures.push(`the recovered Legends table stalled: ${played.reason}`);
      if (timeouts.length > 0) {
        report.failures.push(
          `${timeouts.length} seat(s) timed out after the restart, which is what an inert bot seat ` +
            'looks like from the outside',
        );
      }
      if (botActions.length === 0) {
        report.failures.push(
          'no opponent seat acted after the restart, so the rows came back but no bot runner did',
        );
      } else {
        report.observations.push(`${botActions.length} opponent actions after the restart, none forced`);
      }
    }

    scanClient(reconnect, 'recovered Legends client', report.failures);
    reconnect.close();
    client.close();
    await replacement.stop();
    return report;
  },
};

/**
 * `next start`, not `next dev`, which would measure the compiler. A missing `apps/web/.next` is a
 * skip with the fix, because this suite must not run a repo-wide build.
 */
async function startWeb(port, apiOrigin) {
  const bin = join(REPO_ROOT, 'apps', 'web', 'node_modules', '.bin', 'next');
  const child = spawn(bin, ['start', '--port', String(port)], {
    cwd: join(REPO_ROOT, 'apps', 'web'),
    env: { ...process.env, NODE_ENV: 'production', PRL_API_ORIGIN: apiOrigin },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  const collect = (chunk) => {
    text += chunk.toString('utf8');
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const up = await measureUntil(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
      return response.status > 0;
    },
    45_000,
    250,
  );

  return {
    child,
    output: () => text,
    startedMs: up,
    stop: async () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
      await sleep(100);
    },
  };
}

export const partialDeployment = {
  name: 'partial-deployment',
  title: 'Partial deployment: API up with the web down, and the web up with the API down',
  async run(ctx) {
    const report = newReport();

    const server = await ctx.startServer();
    const session = new Session(server.origin, ctx.webOrigin, 'Partial deploy');
    const health = await session.request(ROUTES.health);
    const ready = await session.request(ROUTES.ready);
    if (health.status !== 200 || ready.status !== 200) {
      report.failures.push(
        `with no web tier running the API answered /health ${health.status} and /ready ${ready.status}`,
      );
    } else {
      report.observations.push('the API is fully healthy with nothing serving the web origin');
    }
    // The CORS allowlist names an origin, not a reachable service.
    await session.createGuest();
    const rooms = await session.request(ROUTES.rooms);
    if (!rooms.ok)
      report.failures.push(`an authenticated API call failed while the web was down: ${rooms.status}`);
    else report.observations.push('an authenticated API journey completes with the web tier absent');

    const nextBuild = join(REPO_ROOT, 'apps', 'web', '.next', 'BUILD_ID');
    const { existsSync } = await import('node:fs');
    if (!existsSync(nextBuild)) {
      report.skipped =
        'apps/web/.next is not built, so `next start` cannot run. Build it with `pnpm run build` ' +
        '(this suite must not run a repo-wide build itself).';
      return report;
    }

    const deadApiPort = await freePort();
    const webPort = await freePort();
    const web = await startWeb(webPort, `http://127.0.0.1:${deadApiPort}`);
    report.measurements.webStartMs = web.startedMs === null ? null : Math.round(web.startedMs);
    try {
      if (web.startedMs === null) {
        report.failures.push(`the web tier did not answer within 45s. Output:\n${web.output().slice(-800)}`);
        return report;
      }
      // `/` is largely prerendered. `/record` renders through `lib/server-session.ts` and needs the API.
      for (const path of ['/', '/record']) {
        const startedAt = performance.now();
        const response = await fetch(`http://127.0.0.1:${webPort}${path}`, { redirect: 'manual' });
        const body = await response.text();
        const elapsed = performance.now() - startedAt;
        const key = path === '/' ? 'home' : 'record';
        report.measurements[`web_${key}_ms`] = Math.round(elapsed);
        report.measurements[`web_${key}_status`] = response.status;

        if (response.status >= 500) {
          report.failures.push(
            `${path} answered ${response.status} with the API unreachable; a page that cannot reach ` +
              'its API should degrade, not fail',
          );
        } else {
          report.observations.push(
            `${path} answered ${response.status} in ${Math.round(elapsed)} ms with the API down`,
          );
        }
        if (elapsed > 15_000) {
          report.failures.push(`${path} took ${Math.round(elapsed)} ms, so the API call is not bounded`);
        }
        if (/ECONNREFUSED|at async|node_modules|\/Users\//.test(body)) {
          report.failures.push(`${path} exposed an internal error detail (stack, path or errno)`);
        } else {
          report.observations.push(`${path} exposes no stack trace, path or errno`);
        }
        report.failures.push(...scanTextForSecrets(body, `the degraded page ${path}`));
      }
    } finally {
      await web.stop();
    }
    return report;
  },
};

export const processDrills = [
  sigtermIdle,
  sigtermMidHand,
  wsDisconnectMidHand,
  silentTcpDuringDrain,
  restartWithActiveRooms,
  partialDeployment,
];
