/**
 * The assertions every reliability drill makes about what it saw, as pure functions.
 *
 * `pnpm run test:drills` breaks a running system on purpose. That is only worth doing if the
 * evidence collected while it is broken is checked by something more exacting than a human
 * reading a log, so every claim the suite makes reduces to one of the functions below:
 *
 *   - `chipLedger`      — no chips were created or destroyed while the failure was happening;
 *   - `settledHandCheck` — the hand that survived the failure settled to a zero-sum ledger;
 *   - `scanForSecrets`  — nothing the client received named a deck, a salt or a cursor;
 *   - `visibleCardCheck` — no client saw more cards than the rules let it see;
 *   - `recoveryBound`   — the recovery actually finished, and the measured bound is stated.
 *
 * ## Why these are here and not inline in the drills
 *
 * Two reasons, and the second is the important one. First, a drill that inlines its assertions
 * cannot be tested, and an untested assertion is a comfort rather than a check — see the
 * negative controls in `scripts/reliability-drills.test.mjs`, every one of which feeds a real
 * violation to the function below that must catch it. Second, sixteen drills asserting chip
 * conservation sixteen slightly different ways is sixteen chances for one of them to assert
 * something weaker than it looks. There is one definition of each property here and every
 * drill uses it.
 *
 * ## What these functions deliberately do NOT do
 *
 * They do not talk to a network, a database, a clock or a child process; they take data that a
 * drill already collected and return findings. Nothing here throws on a violation either — a
 * drill that stopped at the first failure would hide the other fifteen things that also went
 * wrong during the same outage, which is precisely the information an incident needs. Every
 * function returns an array of human-readable strings, empty meaning "nothing found".
 *
 * If this file were removed, the drills would still break things and would report success on
 * the strength of nothing having thrown.
 */

/**
 * Object keys that must never appear anywhere in anything a client receives.
 *
 * These are the field names of the server's own secrets, spelled exactly as the source spells
 * them: `DeckSecret` in `packages/poker-engine/src/commitment.ts` is `{ deck, salts }`, the
 * shuffle's read position is a cursor, and the session and CSRF secrets are stored as digests
 * whose field names are below. Matching on the KEY rather than on the value is what makes this
 * check meaningful: a leak is a field that got serialised, and the field arrives with its name.
 *
 * Matched case-insensitively against the key with `_` and `-` removed, so `hole_card_salt`,
 * `holeCardSalt` and `HOLECARDSALT` are one entry.
 */
const FORBIDDEN_KEYS = new Set([
  'deck',
  'deckorder',
  'decksecret',
  'salt',
  'salts',
  'saltbytes',
  'holecardsalt',
  'cursor',
  'deckcursor',
  'shufflecursor',
  'secret',
  'sessionsecret',
  'sessiontoken',
  'csrfsecret',
  'password',
  'passphrase',
  'privatekey',
]);

/**
 * The one salt a client is allowed to hold, and the shape it has to arrive in.
 *
 * `RevealedCard` (commitment.ts) is `{ index, card, saltHex, proof }` and it is published on
 * purpose: a Merkle proof nobody can check is not a proof, so the salt of a card that has
 * ALREADY become public travels with it. The salt of an unrevealed position has no path to a
 * client and must not acquire one.
 *
 * So `saltHex` is permitted only inside an object carrying the other three fields of a
 * `RevealedCard`. A bare `saltHex`, or one attached to something that is not a proof, is a
 * finding. The check is on the shape rather than on the field name alone, because "we send a
 * salt but only sometimes" is exactly the rule that decays into "we send a salt".
 *
 * `card` is accepted as a number OR a string, and that is not laziness. `Card` in
 * `packages/poker-engine/src/cards.ts` is a number, and the two transports serialise it
 * differently: a WebSocket `state` frame carries the engine's `PlayerView` as it is, so its
 * cards arrive as integers, while `HandSummary.board` over REST is notation. Requiring a string
 * made this function reject every genuine socket proof — which it did, loudly, the first time
 * this suite ran a hand to showdown.
 */
function isRevealedCard(node) {
  const card = node?.['card'];
  return (
    typeof node === 'object' &&
    node !== null &&
    !Array.isArray(node) &&
    typeof node['index'] === 'number' &&
    (typeof card === 'string' || typeof card === 'number') &&
    Array.isArray(node['proof'])
  );
}

/** `deck_secret` and `deckSecret` are the same key for the purposes of this scan. */
function normaliseKey(key) {
  return key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
}

/**
 * Walks a decoded JSON value looking for a field that should never have been serialised.
 *
 * @param {unknown} value the decoded frame, response body or log record
 * @param {string} label what this value is, so a finding names its source
 * @returns {string[]} one line per finding, empty when nothing was found
 *
 * Depth is bounded because this runs over data a drill collected from a server that is in the
 * middle of failing, and a cyclic or pathologically deep structure must produce a finding
 * rather than a stack overflow inside the checker.
 */
export function scanForSecrets(value, label = 'payload') {
  const findings = [];
  const seen = new Set();

  const walk = (node, path, depth) => {
    if (depth > 40) {
      findings.push(`${label}: gave up at depth 40 under ${path}; this structure is not a protocol frame`);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const [index, entry] of node.entries()) walk(entry, `${path}[${index}]`, depth + 1);
      return;
    }

    for (const [key, entry] of Object.entries(node)) {
      const here = path === '' ? key : `${path}.${key}`;
      const normalised = normaliseKey(key);
      if (FORBIDDEN_KEYS.has(normalised)) {
        findings.push(`${label}: forbidden field "${key}" at ${here}`);
      } else if (normalised === 'salthex' && !isRevealedCard(node)) {
        findings.push(
          `${label}: "saltHex" at ${here} is not part of a RevealedCard proof ` +
            '(no index/card/proof beside it), so it reveals a position nobody can verify',
        );
      }
      walk(entry, here, depth + 1);
    }
  };

  walk(value, '', 0);
  return findings;
}

/**
 * The same scan over raw text, for the things that are not JSON.
 *
 * A server log line is the case this exists for: `logging.ts` redacts by field name, and a
 * message string that has had a deck interpolated into it carries no field name at all. Two
 * patterns are enough to catch that, and both are deliberately narrow so a run does not drown
 * in false positives from ordinary prose:
 *
 *   - a 64-hex-character run that is NOT a commitment root or a proof node. Root and proof
 *     hashes are published, so those are excluded by the caller passing them in `allowed`;
 *   - a run of six or more card notations in a row, which is more cards than any legitimate
 *     view contains (five board cards plus a pair of hole cards never appear as one unbroken
 *     sequence in this protocol's JSON, because they live in different fields).
 *
 * @param {string} text
 * @param {string} label
 * @param {ReadonlySet<string>} allowed hex strings that are legitimately public
 */
export function scanTextForSecrets(text, label = 'text', allowed = new Set()) {
  const findings = [];
  for (const match of text.matchAll(/\b[0-9a-f]{64}\b/g)) {
    const hex = match[0];
    if (allowed.has(hex)) continue;
    findings.push(`${label}: a 64-hex-character value appeared that is not a published root or proof node`);
    break;
  }
  const cardRun = /(?:[2-9TJQKA][cdhs]){6,}/;
  if (cardRun.test(text)) {
    findings.push(`${label}: six or more consecutive card notations appeared, which is a deck fragment`);
  }
  return findings;
}

/**
 * Every card any one recipient can legitimately see, against what the frame actually contains.
 *
 * The rule, from `redactFor` in `packages/poker-engine/src/redact.ts`: a recipient sees their
 * own two cards, the board, and — only once the street is `complete` — the cards of seats that
 * showed down. Anything else is null. So the count of non-null hole-card pairs in a view is
 * checked directly, and every pair is checked against who it belongs to.
 *
 * This is the structural half of the hidden-information check and `scanForSecrets` is the
 * lexical half. Both are needed: a leak that reuses the protocol's own field names (an
 * opponent's `holeCards` populated during play) has no forbidden key in it at all, and a leak
 * that invents a field has no seat attached to it.
 *
 * @param {unknown} view a `PlayerView`, or null between hands
 * @param {string} label
 */
export function visibleCardCheck(view, label = 'view') {
  if (view === null || typeof view !== 'object') return [];
  const findings = [];
  const seats = Array.isArray(view['seats']) ? view['seats'] : [];
  const street = view['street'];
  const complete = street === 'complete';
  const viewerSeat = view['viewerSeat'];

  for (const seat of seats) {
    if (seat === null || typeof seat !== 'object') continue;
    const cards = seat['holeCards'];
    if (cards === null || cards === undefined) continue;
    const isSelf = seat['isSelf'] === true;
    const seatIndex = seat['seat'];
    if (isSelf) {
      if (seatIndex !== viewerSeat) {
        findings.push(
          `${label}: seat ${String(seatIndex)} is flagged isSelf but viewerSeat is ${String(viewerSeat)}`,
        );
      }
      continue;
    }
    if (!complete) {
      findings.push(
        `${label}: seat ${String(seatIndex)} exposed hole cards on street "${String(street)}" ` +
          `to viewer seat ${String(viewerSeat)}`,
      );
    }
  }
  return findings;
}

/**
 * Chip conservation across a sequence of views of ONE hand.
 *
 * The quantity that must not move is `sum(stack) + sum(committedTotal)` over the seats dealt
 * into the hand: a chip is either in front of a player or in the pot, and an action moves it
 * from one to the other. A hand that creates a chip shows up as this total rising, one that
 * destroys a chip as it falling, and a pot awarded incorrectly as it changing at the moment of
 * settlement — which is the specific corruption a mid-hand crash could produce and the reason
 * this is measured across the failure rather than only at the end.
 *
 * `potTotal` is checked against the same seats' `committedTotal` in every view, because the
 * pot is built from the commitments (`buildPots`) and a disagreement between the two means the
 * side-pot construction lost or invented a chip even though every stack still looks right.
 *
 * ## The settled view counts its chips differently, and that is not an exemption
 *
 * At `street === 'complete'` the pot has been paid into the stacks and `committedTotal` is NOT
 * zeroed — it stays as the record of what each seat put in during the hand. Measured on a real
 * heads-up hand: river `stacks 198,198 committed 2,2` (total 400), complete `stacks 202,198
 * committed 2,2` (total 404). Adding the commitments to the settled stacks therefore double-counts
 * the pot, and a checker that did it would report chip creation on every hand that ever finished —
 * which is exactly what the first run of this suite did.
 *
 * So the settled view is checked against the SAME baseline using stacks alone. That is a stronger
 * statement rather than a weaker one: it says every chip that went into the pot came back out to
 * somebody, which is the property a mid-hand crash could break.
 *
 * @param {readonly {label: string, view: unknown}[]} samples views in the order they arrived
 * @returns {{findings: string[], totals: number[]}}
 */
export function chipLedger(samples) {
  const findings = [];
  const totals = [];
  let baseline = null;
  let baselineLabel = '';

  for (const sample of samples) {
    const view = sample.view;
    if (view === null || typeof view !== 'object') continue;
    const seats = Array.isArray(view['seats']) ? view['seats'] : [];
    if (seats.length === 0) continue;

    let stacks = 0;
    let committed = 0;
    let malformed = false;
    for (const seat of seats) {
      const stack = seat?.['stack'];
      const total = seat?.['committedTotal'];
      if (typeof stack !== 'number' || typeof total !== 'number') {
        malformed = true;
        continue;
      }
      stacks += stack;
      committed += total;
    }
    if (malformed) {
      findings.push(`${sample.label}: a seat had a non-numeric stack or committedTotal`);
      continue;
    }

    const settled = view['street'] === 'complete';
    const potTotal = view['potTotal'];
    if (typeof potTotal !== 'number') {
      findings.push(`${sample.label}: potTotal was not a number`);
    } else if (potTotal !== committed) {
      // True in both phases, for different reasons: during play the pot IS the commitments, and
      // at completion `committedTotal` is the historical record of the pot that was played for.
      // A disagreement means the side-pot construction lost or invented a chip even though every
      // stack still looks right.
      findings.push(
        `${sample.label}: potTotal ${potTotal} does not equal the ${committed} committed by the seats`,
      );
    }

    const total = settled ? stacks : stacks + committed;
    totals.push(total);
    if (baseline === null) {
      baseline = total;
      baselineLabel = sample.label;
      continue;
    }
    if (total !== baseline) {
      findings.push(
        `${sample.label}: chips in play are ${total}, but ${baselineLabel} had ${baseline} ` +
          `(${total > baseline ? 'created' : 'destroyed'} ${Math.abs(total - baseline)})`,
      );
      // Re-baseline so one corruption produces one finding rather than one per later frame.
      baseline = total;
      baselineLabel = sample.label;
    }
  }

  return { findings, totals };
}

/**
 * What a settled hand must satisfy, read back from `GET /hands/:id`.
 *
 * `sum(net) === 0` is the whole of chip conservation in one line, and it is the check that
 * survives a restart: the live view is gone, but the durable record of who won and lost is
 * exactly what a learner will read afterwards, and it is what a corrupted settlement would be
 * visible in. `startingStack + net >= 0` catches the other direction — a seat that ended
 * owing chips it never had.
 *
 * The reveal is bounded here too, because a hand review is the one response that legitimately
 * carries salts: at most the five board cards plus two per seat that showed down may appear,
 * and `complete` must be false. A full-deck reveal attached to an ordinary hand would hand the
 * reader every card nobody was ever shown.
 *
 * @param {unknown} review a `HandReviewResponse`
 * @param {string} label
 */
export function settledHandCheck(review, label = 'hand review') {
  const findings = [];
  if (review === null || typeof review !== 'object') return [`${label}: not an object`];

  const seats = Array.isArray(review['seats']) ? review['seats'] : [];
  if (seats.length === 0) return [`${label}: carried no seats, so it proves nothing`];

  let net = 0;
  let showdowns = 0;
  for (const seat of seats) {
    const value = seat?.['net'];
    const start = seat?.['startingStack'];
    if (typeof value !== 'number' || typeof start !== 'number') {
      findings.push(`${label}: seat ${String(seat?.['seat'])} has a non-numeric net or startingStack`);
      continue;
    }
    net += value;
    if (start + value < 0) {
      findings.push(
        `${label}: seat ${String(seat['seat'])} finished on ${start + value} units, which is below zero`,
      );
    }
    if (seat['showedDown'] === true) showdowns += 1;
  }
  if (net !== 0) {
    findings.push(
      `${label}: the nets sum to ${net}, not 0 — ${net > 0 ? 'chips were created' : 'chips were destroyed'}`,
    );
  }

  const board = Array.isArray(review['hand']?.['board']) ? review['hand']['board'] : [];
  const reveal = review['reveal'];
  if (reveal !== null && typeof reveal === 'object') {
    if (reveal['complete'] === true) {
      findings.push(`${label}: the reveal claims to be a COMPLETE deck reveal, which no hand may publish`);
    }
    const cards = Array.isArray(reveal['cards']) ? reveal['cards'] : [];
    const permitted = board.length + showdowns * 2;
    if (cards.length > permitted) {
      findings.push(
        `${label}: the reveal carries ${cards.length} proofs, but only ${permitted} cards became ` +
          `public (${board.length} board + ${showdowns} showdown seats)`,
      );
    }
  }

  findings.push(...scanForSecrets(review, label));
  return findings;
}

/**
 * States a recovery bound, and fails when the recovery did not happen inside it.
 *
 * Every drill has to answer "bounded recovery, with the actual measured bound", and the
 * temptation in a harness is to report the measurement and leave the reader to judge it. That
 * is how a regression arrives unnoticed: 400 ms becomes 40 s and both are "measured". So the
 * budget is declared with the drill and the measurement is checked against it here.
 *
 * `null` for `elapsedMs` means the recovery never completed, which is a different sentence
 * from "it was slow" and is reported as one.
 *
 * @param {string} what
 * @param {number|null} elapsedMs
 * @param {number} budgetMs
 */
export function recoveryBound(what, elapsedMs, budgetMs) {
  if (elapsedMs === null) return [`${what}: never recovered (budget ${budgetMs} ms)`];
  if (elapsedMs > budgetMs) {
    return [`${what}: recovered in ${Math.round(elapsedMs)} ms, over the ${budgetMs} ms budget`];
  }
  return [];
}

/**
 * Whether a body of collected log text contains a line that explains what happened.
 *
 * "Useful logging" is a requirement of every drill, and the only way to check it that is not a
 * matter of opinion is to name the line the operator would search for and assert it is there.
 * The drills quote the matched line in their report, so the evidence is the log's own words
 * rather than this function's summary of them.
 *
 * @param {string} log
 * @param {RegExp} pattern
 * @returns {{found: boolean, line: string}}
 */
export function logLine(log, pattern) {
  for (const line of log.split('\n')) {
    if (pattern.test(line)) return { found: true, line: line.trim() };
  }
  return { found: false, line: '' };
}
