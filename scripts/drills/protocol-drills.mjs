/**
 * The drills that abuse the wire protocol: rubbish frames, repeated actions, and actions
 * submitted against a spot that has already moved on.
 *
 * ## Why these are drills and not only unit tests
 *
 * `apps/api/test/ws-router.test.ts` already drives the router with a fake sink and covers the
 * oversized frame, the duplicate `actionId` and the stale sequence. It cannot cover any of the
 * following, because none of them exist above the socket:
 *
 *   - a BINARY frame. The router is handed bytes by `hub.ts`'s `toBytes`, and a unit test that
 *     passes a string never exercises the decode;
 *   - a frame larger than the `ws` library's own `maxPayload`, which is refused by the library
 *     before the router sees it and produces a completely different close code (1009, not 4429);
 *   - what the process does afterwards. Every case here re-probes the server and, at the end,
 *     plays a real hand, because "rejected the frame" and "still able to serve" are two claims
 *     and only the first has ever been tested.
 *
 * ## The property that binds all three
 *
 * A malformed, repeated or stale submission must change nothing. So each drill records the
 * table's committed chips before and after the abuse and compares them, rather than trusting the
 * error code it was sent — an error code is what the server SAYS it did, and the ledger is what
 * it did.
 */

import { randomUUID } from 'node:crypto';
import {
  actOn,
  dealHand,
  newReport,
  playHandToCompletion,
  ROUTES,
  Session,
  seatWithBot,
  sleep,
  TableClient,
} from './harness.mjs';
import {
  chipLedger,
  logLine,
  scanForSecrets,
  scanTextForSecrets,
  settledHandCheck,
  visibleCardCheck,
} from './invariants.mjs';

/** `WS_LIMITS.maxMessageBytes` in @prl/contracts. See `harness.mjs` on why it is copied. */
const MAX_MESSAGE_BYTES = 8 * 1024;
/** `LIBRARY_PAYLOAD_CEILING` in `ws/hub.ts`: four times ours, enforced by the `ws` library. */
const LIBRARY_PAYLOAD_CEILING = MAX_MESSAGE_BYTES * 4;
/** `WS_CLOSE.rateLimited` — what the router closes an oversending socket with. */
const WS_RATE_LIMITED = 4429;
/** `WS_CLOSE.protocolMismatch`. */
const WS_PROTOCOL_MISMATCH = 4400;
/** RFC 6455's "message too big", which is the LIBRARY's answer, not the protocol's. */
const WS_MESSAGE_TOO_BIG = 1009;

/** Every frame this client received, scanned for anything it should never have been sent. */
function scanFrames(client, label, findings) {
  for (const [index, entry] of client.frames.entries()) {
    findings.push(...scanForSecrets(entry.frame, `${label} frame ${index}`));
    if (entry.frame?.type === 'state') {
      findings.push(...visibleCardCheck(entry.frame.view, `${label} frame ${index}`));
    }
  }
}

/**
 * An error frame must carry a contract code and the contract's own wording, and nothing else.
 *
 * The specific leak this guards against is an internal message reaching the wire: `errors.ts`
 * keeps `logDetail` for the log and sends `ERROR_MESSAGES[code]`, and the failure mode when that
 * inverts is a client being told which file threw.
 */
function checkErrorFrame(frame, label, findings) {
  const message = frame?.error?.message ?? '';
  if (/\.ts|node_modules|at async|Error:|ECONNREFUSED|select |insert /i.test(message)) {
    findings.push(`${label}: the error frame carried an internal detail: ${message.slice(0, 120)}`);
  }
  findings.push(...scanForSecrets(frame, label));
}

// ---------------------------------------------------------------------------
// 10. Malformed WebSocket traffic
// ---------------------------------------------------------------------------

export const malformedWsTraffic = {
  name: 'malformed-ws-traffic',
  title: 'Malformed WebSocket traffic: oversized frames, bad JSON, unknown types, wrong version, binary',
  async run(ctx) {
    const report = newReport();
    const server = await ctx.startServer();
    const session = new Session(server.origin, ctx.webOrigin, 'Malformed drill');
    await session.createGuest();
    const table = await seatWithBot(session, { name: 'Malformed traffic' });

    /** A socket of its own for each case, so one close cannot mask the next case's behaviour. */
    const freshClient = async (options = {}) => {
      const client = new TableClient(session, table.roomId);
      await client.connect(options);
      return client;
    };

    // --- an oversized frame the ROUTER refuses ---
    {
      const client = await freshClient();
      const filler = 'x'.repeat(MAX_MESSAGE_BYTES);
      client.sendRaw(JSON.stringify({ type: 'ping', nonce: filler }));
      const code = await client.waitForClose(8_000);
      report.measurements.oversizedCloseCode = code;
      if (code !== WS_RATE_LIMITED) {
        report.failures.push(
          `a ${MAX_MESSAGE_BYTES}+ byte frame closed the socket with ${String(code)}, not ${WS_RATE_LIMITED}`,
        );
      } else {
        report.observations.push(`an oversized frame is dropped unparsed and the socket closed ${code}`);
      }
      scanFrames(client, 'oversized', report.failures);
    }

    // --- a frame larger than the library's own ceiling ---
    {
      const client = await freshClient();
      client.sendRaw(JSON.stringify({ type: 'ping', nonce: 'y'.repeat(LIBRARY_PAYLOAD_CEILING) }));
      const code = await client.waitForClose(8_000);
      report.measurements.libraryCeilingCloseCode = code;
      if (code === null) {
        report.failures.push('a frame beyond the library ceiling left the socket open');
      } else if (code !== WS_MESSAGE_TOO_BIG && code !== WS_RATE_LIMITED) {
        report.failures.push(
          `a frame beyond the library ceiling closed with ${code}; expected ${WS_MESSAGE_TOO_BIG} ` +
            `(the library's memory guard) or ${WS_RATE_LIMITED} (ours)`,
        );
      } else {
        report.observations.push(
          `a frame beyond the ${LIBRARY_PAYLOAD_CEILING}-byte ceiling closed with ${code}`,
        );
      }
    }

    // --- invalid JSON, an unknown type, and binary garbage: rejected, socket kept ---
    const softCases = [
      { label: 'invalid JSON', payload: '{"type":"ping", "nonce":' },
      {
        label: 'an unknown message type',
        payload: JSON.stringify({ type: 'launchMissile', requestId: '1' }),
      },
      {
        label: 'a known type with the wrong shape',
        payload: JSON.stringify({ type: 'sit', seat: 'front row' }),
      },
      { label: 'binary garbage', payload: new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80, 0x7f, 0xc0]) },
      { label: 'an empty frame', payload: '' },
    ];
    for (const testCase of softCases) {
      const client = await freshClient();
      const before = client.errors.length;
      client.sendRaw(testCase.payload);
      const answered = await client.waitForFrame((f) => f.type === 'error', 5_000);
      if (answered === null) {
        report.failures.push(`${testCase.label} produced neither an error frame nor a close`);
      } else {
        if (answered.error?.code !== 'invalid_request') {
          report.failures.push(
            `${testCase.label} was answered "${String(answered.error?.code)}", not invalid_request`,
          );
        } else {
          report.observations.push(`${testCase.label} answered invalid_request with the socket kept open`);
        }
        checkErrorFrame(answered, testCase.label, report.failures);
      }
      if (client.closed) {
        report.warnings.push(
          `${testCase.label} closed the socket (${client.closeCode}) rather than answering`,
        );
      }
      if (client.errors.length - before > 1) {
        report.warnings.push(`${testCase.label} produced ${client.errors.length - before} error frames`);
      }
      client.close();
    }

    // --- the wrong protocol version ---
    {
      const client = new TableClient(session, table.roomId);
      await client.connect({ protocolVersion: 999, expectWelcome: false });
      const code = await client.waitForClose(8_000);
      report.measurements.protocolMismatchCloseCode = code;
      if (code !== WS_PROTOCOL_MISMATCH) {
        report.failures.push(
          `hello with protocolVersion 999 closed with ${String(code)}, not ${WS_PROTOCOL_MISMATCH}`,
        );
      } else {
        report.observations.push(`a client speaking version 999 is closed with ${WS_PROTOCOL_MISMATCH}`);
      }
      if (client.welcomed) report.failures.push('a client speaking the wrong version was welcomed anyway');
    }

    // --- and the table is untouched by any of it ---
    const survivor = await freshClient();
    const health = await session.request(ROUTES.health);
    if (health.status !== 200) report.failures.push(`/health answered ${health.status} after the abuse`);
    const dealt = await dealHand(survivor, 20_000);
    if (dealt === null) {
      report.failures.push('the table would not deal a hand after the malformed traffic');
    } else {
      const played = await playHandToCompletion(survivor, { budgetMs: 40_000 });
      if (!played.completed)
        report.failures.push(`the table stalled after the malformed traffic: ${played.reason}`);
      else report.observations.push('a full hand plays out after every malformed case');
    }
    const ledger = chipLedger(survivor.views);
    report.failures.push(...ledger.findings);
    scanFrames(survivor, 'survivor', report.failures);
    survivor.close();
    table.client.close();

    const rejected = logLine(server.output(), /frame did not match|invalid|websocket/i);
    if (rejected.found) report.evidence.push({ label: 'the server noticed', text: rejected.line });
    report.failures.push(...scanTextForSecrets(server.output(), 'the API log'));
    return report;
  },
};

// ---------------------------------------------------------------------------
// 11. Duplicate actions
// ---------------------------------------------------------------------------

export const duplicateActions = {
  name: 'duplicate-actions',
  title: 'The same action submitted twice',
  async run(ctx) {
    const report = newReport();
    const server = await ctx.startServer();
    const session = new Session(server.origin, ctx.webOrigin, 'Duplicate drill');
    await session.createGuest();
    const table = await seatWithBot(session, { name: 'Duplicate actions' });
    const client = table.client;

    if ((await dealHand(client)) === null) {
      report.failures.push('the table never dealt a hand');
      return report;
    }
    const view = await client.waitForTurn(20_000);
    if (view === null) {
      report.failures.push('the server never offered a decision');
      return report;
    }

    const committedBefore = view.seats.reduce((total, seat) => total + (seat.committedTotal ?? 0), 0);
    const stackBefore = view.seats.find((seat) => seat.isSelf)?.stack ?? null;

    // The first submission, kept so the second is byte-for-byte the same retry a client makes
    // when it never saw the answer to the first.
    const first = actOn(client, view);
    const firstAck = await client.waitForFrame(
      (f) => f.type === 'ack' && f.requestId === first.requestId,
      10_000,
    );
    if (firstAck === null) {
      report.failures.push('the first submission was never acknowledged');
      return report;
    }
    if (firstAck.deduplicated === true) {
      report.failures.push('the FIRST submission came back deduplicated, which cannot be right');
    }
    report.measurements.appliedSequence = firstAck.appliedSequence ?? null;

    const retryRequestId = randomUUID();
    client.send({
      type: 'action',
      actionId: first.actionId,
      expectedSequence: first.expectedSequence,
      action: first.action,
      requestId: retryRequestId,
    });
    const secondAck = await client.waitForFrame(
      (f) => (f.type === 'ack' || f.type === 'error') && f.requestId === retryRequestId,
      10_000,
    );

    if (secondAck === null) {
      report.failures.push('the retry was neither acknowledged nor refused');
    } else if (secondAck.type === 'error') {
      report.failures.push(
        `the retry was refused "${String(secondAck.error?.code)}"; a retry after a dropped response ` +
          'is the case actionId exists for and must not be an error',
      );
    } else if (secondAck.deduplicated !== true) {
      report.failures.push(
        'the retry was acknowledged WITHOUT deduplicated: true, so it may have applied twice',
      );
    } else {
      report.observations.push('the retry returned the original outcome with deduplicated: true');
      if (secondAck.appliedSequence !== firstAck.appliedSequence) {
        report.failures.push(
          `the retry reported sequence ${String(secondAck.appliedSequence)} against the original's ` +
            `${String(firstAck.appliedSequence)}`,
        );
      }
    }

    // The ledger is the real check: the same action applied twice would have moved the chips twice.
    await sleep(300);
    const afterViews = client.views.filter((entry) => entry.view?.handId === view.handId);
    const ledger = chipLedger(afterViews);
    report.failures.push(...ledger.findings);
    const latest = client.lastView;
    if (latest !== null && latest.handId === view.handId) {
      const self = latest.seats.find((seat) => seat.isSelf);
      const paidOnce = (stackBefore ?? 0) - (self?.stack ?? 0);
      const committedNow = latest.seats.reduce((total, seat) => total + (seat.committedTotal ?? 0), 0);
      report.measurements.paidByTheSubmitter = paidOnce;
      report.measurements.committedBefore = committedBefore;
      report.measurements.committedAfter = committedNow;
      // A doubled call shows up as the submitter having paid twice the amount they owed.
      const owed = view.amountToCall ?? 0;
      if (owed > 0 && paidOnce > owed) {
        report.failures.push(
          `the submitter paid ${paidOnce} for an action that cost ${owed}: it applied twice`,
        );
      } else {
        report.observations.push(`the submitter paid ${paidOnce} for an action costing ${owed}`);
      }
    }

    const played = await playHandToCompletion(client, { budgetMs: 40_000 });
    if (!played.completed)
      report.failures.push(`the hand did not complete after the retry: ${played.reason}`);
    const listed = await session.request(`${ROUTES.hands}?roomId=${table.roomId}`);
    const summary = listed.body?.hands?.[0];
    if (summary !== undefined) {
      const review = await session.request(ROUTES.hand.replace(':handId', summary.id));
      report.failures.push(...settledHandCheck(review.body, 'the hand containing the duplicate'));
      report.observations.push(`the settled hand balances to zero (pot ${summary.potTotal})`);
    }
    scanFrames(client, 'duplicate drill', report.failures);
    client.close();
    return report;
  },
};

// ---------------------------------------------------------------------------
// 12. Out-of-order actions
// ---------------------------------------------------------------------------

export const outOfOrderActions = {
  name: 'out-of-order-actions',
  title: 'Actions submitted against a spot that has already moved on',
  async run(ctx) {
    const report = newReport();
    const server = await ctx.startServer();
    const session = new Session(server.origin, ctx.webOrigin, 'Out-of-order drill');
    await session.createGuest();
    const table = await seatWithBot(session, { name: 'Out-of-order actions' });
    const client = table.client;

    if ((await dealHand(client)) === null) {
      report.failures.push('the table never dealt a hand');
      return report;
    }

    // The stale case has to be submitted while it is still this seat's turn, because
    // `LiveTable.submit` checks whose turn it is BEFORE it checks the sequence — so a stale
    // submission sent out of turn would be answered `not_your_turn` and would prove nothing
    // about the sequence guard at all. The first decision of a hand is at sequence 0, where
    // "one behind" is not expressible, so the drill acts once and waits for the next turn.
    let view = await client.waitForTurn(20_000);
    if (view === null) {
      report.failures.push('the server never offered a decision');
      return report;
    }
    if (view.actionSequence === 0) {
      // The transcript index is recorded BEFORE acting, so the wait below returns the next
      // decision rather than re-matching the one just acted on. Without it the drill submits
      // against a spot it has already left, the server answers `not_your_turn` — correctly — and
      // the sequence guard goes untested while the report claims otherwise.
      const mark = client.frames.length;
      actOn(client, view);
      view = await client.waitForTurn(30_000, mark);
    }
    if (view === null) {
      report.warnings.push('the hand ended before a second decision, so no stale case could be submitted');
      return report;
    }
    if (view.actionSequence === 0) {
      report.warnings.push('the second decision was still at sequence 0, so only the future case ran');
    }

    const current = view.actionSequence;
    const beforeCommitted = view.seats.reduce((total, seat) => total + (seat.committedTotal ?? 0), 0);
    const cases = [];
    if (current > 0) cases.push({ label: 'a sequence the hand has left behind', sequence: current - 1 });
    cases.push({ label: 'a sequence the hand has not reached', sequence: current + 3 });

    for (const testCase of cases) {
      const requestId = randomUUID();
      client.send({
        type: 'action',
        actionId: randomUUID(),
        expectedSequence: testCase.sequence,
        action: { type: 'fold' },
        requestId,
      });
      const answer = await client.waitForFrame(
        (f) => (f.type === 'error' || f.type === 'ack') && f.requestId === requestId,
        10_000,
      );
      if (answer === null) {
        report.failures.push(`${testCase.label} was neither refused nor acknowledged`);
        continue;
      }
      if (answer.type === 'ack') {
        report.failures.push(
          `${testCase.label} (${testCase.sequence} against ${current}) was APPLIED; the contract has ` +
            'stale_action_sequence for exactly this',
        );
        continue;
      }
      if (answer.error?.code !== 'stale_action_sequence') {
        report.failures.push(
          `${testCase.label} was refused "${String(answer.error?.code)}", not stale_action_sequence`,
        );
      } else {
        report.observations.push(
          `${testCase.label} (${testCase.sequence} against ${current}) -> stale_action_sequence`,
        );
      }
      checkErrorFrame(answer, testCase.label, report.failures);
    }
    report.measurements.staleCasesTried = cases.length;

    // Nothing moved: a refused submission must not have folded the hand or paid a chip.
    await sleep(250);
    const after = client.lastView;
    if (after !== null && after.handId === view.handId) {
      const nowCommitted = after.seats.reduce((total, seat) => total + (seat.committedTotal ?? 0), 0);
      if (nowCommitted !== beforeCommitted) {
        report.failures.push(
          `the pot moved from ${beforeCommitted} to ${nowCommitted} while only stale actions were sent`,
        );
      } else {
        report.observations.push(`the pot is unchanged at ${nowCommitted} after every stale submission`);
      }
      if (after.street === 'complete' && cases.length > 0) {
        report.failures.push('a stale fold ended the hand, so the sequence guard did not hold');
      }
    }

    // The hand is still playable, and its record still balances.
    const played = await playHandToCompletion(client, { budgetMs: 40_000 });
    if (!played.completed) report.failures.push(`the hand did not complete afterwards: ${played.reason}`);
    else report.observations.push('the hand played on normally after the stale submissions');

    const ledger = chipLedger(client.views);
    report.failures.push(...ledger.findings);
    scanFrames(client, 'out-of-order drill', report.failures);
    report.failures.push(...scanTextForSecrets(server.output(), 'the API log'));
    client.close();
    return report;
  },
};

export const protocolDrills = [malformedWsTraffic, duplicateActions, outOfOrderActions];
