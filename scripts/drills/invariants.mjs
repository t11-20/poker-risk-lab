/**
 * The assertions every reliability drill makes about what it saw, as pure functions.
 *
 * Each one takes data a drill already collected and returns findings as strings, empty meaning
 * nothing found. Nothing throws, so one outage reports every violation rather than the first.
 * The negative controls in `scripts/reliability-drills.test.mjs` feed each a real violation.
 */

/**
 * Field names of the server's own secrets (`DeckSecret` is `{ deck, salts }`). A leak is a field
 * that got serialised, so the key is matched, case-insensitively with `_` and `-` removed.
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
 * `saltHex` is public only inside a `RevealedCard` (`{ index, card, saltHex, proof }`), whose card
 * is already public. `card` is a number on a socket frame and notation over REST, so both pass.
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

function normaliseKey(key) {
  return key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
}

/** Depth is bounded so a cyclic or very deep structure yields a finding, not a stack overflow. */
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
 * The same scan over raw text such as log lines, which `logging.ts` cannot redact by field name.
 * Flags a 64-hex run not in `allowed` (published roots and proof nodes), and six or more card
 * notations in a row, which no legitimate frame contains because board and hole cards are separate.
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
 * Per `redactFor`: a recipient sees its own cards, the board, and only on a `complete` street the
 * cards of seats that showed down. This is the structural half of the hidden-information check.
 */
export function visibleCardCheck(view, label = 'view') {
  if (view === null || typeof view !== 'object') return [];
  const findings = [];
  const seats = Array.isArray(view['seats']) ? view['seats'] : [];
  const street = view['street'];
  const complete = street === 'complete';
  const viewerSeat = view['viewerSeat'];

  // A completed hand shows only the seats in `result.showdowns`. A missing `result` yields an empty
  // set, so a folder's cards on a completed view are a finding. This check once passed any cards on
  // a complete street, which would have leaked whether the folder was bluffing.
  const result = view['result'];
  const showdowns = Array.isArray(result?.['showdowns']) ? result['showdowns'] : [];
  const showedDown = new Set(
    showdowns.filter((entry) => entry !== null && typeof entry === 'object').map((entry) => entry['seat']),
  );

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
      continue;
    }
    if (!showedDown.has(seatIndex)) {
      findings.push(
        `${label}: seat ${String(seatIndex)} exposed hole cards on a completed hand it did NOT ` +
          `show down in (showdown seats: ${showdowns.length === 0 ? 'none' : [...showedDown].join(', ')}) ` +
          `to viewer seat ${String(viewerSeat)}`,
      );
    }
  }
  return findings;
}

/**
 * Chip conservation across views of one hand. During play `sum(stack) + sum(committedTotal)` is
 * constant and `potTotal` equals the commitments.
 *
 * At `complete` the pot is paid into the stacks but `committedTotal` is not zeroed. Measured on a
 * heads-up hand, river 198,198 + 2,2 = 400 and complete 202,198 + 2,2 = 404. So the settled view
 * is compared to the baseline using stacks alone.
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
 * `sum(net) === 0` is chip conservation that survives a restart, and `startingStack + net >= 0`
 * catches a seat that ended owing chips. The reveal may carry at most the board plus two cards per
 * showdown seat, and never `complete`.
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
 * The budget is declared with the drill so a regression from 400 ms to 40 s fails instead of being
 * merely measured. `null` means the recovery never completed.
 */
export function recoveryBound(what, elapsedMs, budgetMs) {
  if (elapsedMs === null) return [`${what}: never recovered (budget ${budgetMs} ms)`];
  if (elapsedMs > budgetMs) {
    return [`${what}: recovered in ${Math.round(elapsedMs)} ms, over the ${budgetMs} ms budget`];
  }
  return [];
}

/** Finds the log line an operator would search for, so the report quotes the log's own words. */
export function logLine(log, pattern) {
  for (const line of log.split('\n')) {
    if (pattern.test(line)) return { found: true, line: line.trim() };
  }
  return { found: false, line: '' };
}
