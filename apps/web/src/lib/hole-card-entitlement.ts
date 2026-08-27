/**
 * The one question this client asks about the CONTENT of a view: does the server's own hole-card
 * rule hold in the frame it just sent?
 *
 * ## The residual this closes
 *
 * `docs/VERIFICATION.md` §12 carried this row after the hidden-information sweep of 2026-08-27:
 * hole-card redaction has one boundary, `redactFor` on the server; `isSeatView` in
 * `table-socket.ts` accepted `holeCards` on any seat, `Seat.tsx` draws a non-null pair face-up, and
 * **no test in `apps/web` would have failed if the API leaked**. The three "a card the server hid
 * stays hidden" tests in `a11y-contracts.test.ts` are regexes over source text and only ask what
 * this app does when `holeCards === null` — the case where there is nothing to leak.
 *
 * ## Why this is NOT a client-side redactor, which is what the row proposed and what would be wrong
 *
 * Dropping cards the client decides it should not have would not prevent a disclosure. It would
 * only prevent an honest reader from *seeing* one:
 *
 *   - On `/play` the leaked frame has already arrived. It is in the browser's network panel and in
 *     the argument to `JSON.parse` before any component decides anything.
 *   - On `/review/[handId]` it is worse: `HandReplay` is a client component and the page passes it
 *     the whole `HandReviewResponse` as a prop, so the payload — `seats[].holeCards` included — is
 *     serialised into the RSC flight payload and is in the page source. A component that declined
 *     to draw a card would be declining to draw something the reader can already read with
 *     View Source.
 *
 * The party a hole-card leak harms is the opponent at the table, and the party that RECEIVES the
 * leak is the one who benefits from it. A redactor therefore defends against exactly the person who
 * does not need defending, and it does it by hiding the evidence from the only people who would
 * have reported the bug. That is why this module removes nothing.
 *
 * `docs/THREAT-MODEL.md` T1 point 4 already said so, in one sentence, before any of this existed:
 * **"Client-side filtering of privileged data is not a control at all."** This module does not
 * contradict that. It is a smoke detector, not a lock — everything below decides whether a defect
 * is visible, and nothing below decides who can see a card.
 *
 * ## What it does instead, and why that is not a second boundary
 *
 * `packages/poker-engine/src/redact.ts` states an invariant about its own output, on `SeatView`:
 *
 *     `holeCards` above is non-null for exactly `isSelf || showed down`, so this flag and that
 *     field always agree.
 *
 * `isSelf`, `viewerSeat`, `street` and `result.showdowns` are all published in the same view, and
 * `redactFor` takes every one of them from the ONE resolved seat (`viewerFor`) that decides
 * `maySeeCards`. So evaluating that rule here is not a second implementation of a policy — it is
 * the server's own published fields being held to the server's own published promise. The two can
 * disagree only if `redactFor` contradicts its own header, which is precisely the defect worth
 * catching. Nothing here needs knowledge the client does not already hold.
 *
 * `scripts/smoke-test.mjs` computes the same predicate (`unentitledHoleCardSeats`) over the wire
 * against a deployment, and its header carries the incident that shaped it: a stub API that served
 * an opponent's cards in the `street: 'complete'` frame of a hand nobody showed down, over which
 * the whole smoke run went green. That check inspects the API response directly and is unaffected
 * by anything in this file — a client that refuses a frame cannot blind a checker that reads the
 * bytes. This is the same rule, one hop later, in the one place `verify` can reach without a
 * deployment.
 *
 * ## The exemption, exactly
 *
 * A seat may carry cards when it is the recipient's own seat — `isSelf === true` **and**
 * `seat === viewerSeat`, because `redactFor` derives both from the same `viewerFor` result and
 * `isSelf` cannot be true without the indices matching — or when the hand is `complete` and the
 * seat appears in `result.showdowns`. Anything else is unentitled whatever the street says: a hand
 * that ends by folding produces an empty showdown list, and that is the ordinary case rather than
 * the exotic one.
 *
 * Requiring both halves of "own seat" is stricter than the smoke test's `isSelf === true ||
 * seat === viewerSeat`, and deliberately: over the wire that script must survive a field being
 * renamed away, whereas anything reaching here has already been through `isPlayerView`, which
 * requires `isSelf` to be a boolean and `viewerSeat` to be a seat index or null. Strictness that
 * cannot false-positive is free.
 *
 * ## Why it reads `unknown` rather than `PlayerView`
 *
 * Because the caller in `table-socket.ts` runs it on a frame that has been shape-checked and is
 * still, in every sense that matters, something a server said. Typing the parameter as `PlayerView`
 * would make the check look like a statement about a value the compiler had vouched for, and it is
 * the opposite of that. It also lets `test/hole-card-entitlement.test.ts` run the same predicate
 * over `buildHandReplay`'s reconstructed views, which are ordinary objects.
 *
 * ## `/review/[handId]` gets a different rule, and gets it in a test rather than at runtime
 *
 * Three measurements decided that, all taken on 2026-08-27.
 *
 * **1. The live rule does not hold over a replay, and should not.** `buildHandReplay` reconstructs
 * one `PlayerView` per decision and copies each seat's `holeCards` into every step, so a hand that
 * reached showdown draws the opponent's cards from step one — which `HandReplay` states on screen
 * ("Seats the server disclosed"), because a replay that showed them without saying why would invite
 * the reader to think the analysis had known them. Those reconstructed views carry no `result`, so
 * `checkHoleCardEntitlement` over `buildHandReplay(REVIEW_HAND_SHOWDOWN)` reports seat 2 unentitled
 * at **all eleven steps**, and it is right by its own rule and wrong about the product. The rule
 * for a review is the payload's own: `showedDown === true`, or the viewer's seat. That is
 * `checkReviewHoleCardEntitlement` below, and it is what `test/hole-card-entitlement.test.ts`
 * holds the review path to.
 *
 * **2. Refusing at runtime could not prevent the disclosure anyway.** The page hands the whole
 * `HandReviewResponse` to `HandReplay`, a client component, so it is in the flight payload before
 * any check could run. See the section above.
 *
 * **3. The viewer's seat is a heuristic here.** `HandReviewResponse` has no `viewerSeat`;
 * `findViewerSeat` recovers it from the seat owning an analysed decision, else the single human
 * seat, else the seat whose net matches `heroNet`, and returns `null` when none of the three
 * settles it. A legitimate review of a hand the reader folded out of would then read as a leak of
 * their own cards. Enforcing on a heuristic would break a working page over the server's honesty.
 *
 * Fixing that properly is `viewerSeat` on `HandReviewResponse`, which is a contract change;
 * `lib/hand-replay.ts`'s header already reports the same three missing fields for the same reason.
 *
 * ## One thing this check would refuse that is not a leak
 *
 * `COMPLETED_HAND_VIEW` in `src/fixtures/table.ts` — the settled demo the `/play?state=complete`
 * screen draws, and the one `test:ax`, `test:layout` and `design:contrast` all walk — is
 * `street: 'complete'` with `result: null` and three seats' cards visible, two of them not the
 * viewer's. It is hand-written demo data that never went through `redactFor`, so it does not carry
 * the `result.showdowns` that would justify what it shows, and `COMPLETED_HAND_SUMMARY` says in
 * prose what the missing field would have said in data ("Three hands were shown"). Nothing leaks:
 * the cards are invented. But it is why this check sits at the socket's ingress and not in the
 * renderer — a check in `Seat.tsx` or `PokerTable.tsx` would refuse the product's own demo screen
 * on its first run.
 */

/** What one pass over a view found. */
export interface HoleCardEntitlement {
  /**
   * The seats carrying cards the recipient was not entitled to, in the order they appear.
   *
   * A seat whose index is not a number is reported as `-1`: an unentitled pair with an unreadable
   * seat number is still an unentitled pair, and dropping it would let a malformed index buy an
   * exemption.
   */
  readonly unentitled: readonly number[];
  /** Seats examined at all. */
  readonly seatsExamined: number;
  /**
   * Seats that carried a hole-card pair, entitled or not.
   *
   * Here because a sweep of nothing is not a pass: `unentitled.length === 0` is also what a view
   * with no seats, or a serialiser that dropped every `holeCards`, produces. A test asserting this
   * check works has to assert it had something to work on, and the number has to come from the
   * function rather than from the test's own reading of its own fixture.
   */
  readonly seatsWithCards: number;
}

/** `typeof value === 'object'` with `null` and arrays excluded, as a narrowing. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The seats named in a completed hand's showdown list.
 *
 * Built only for `street === 'complete'`, and only from an actual array. A completed frame whose
 * `result` is null — which is what a server that stopped populating it would send — exempts
 * nobody, so the check gets stricter rather than evaporating.
 */
function shownSeats(view: Record<string, unknown>): ReadonlySet<unknown> {
  if (view['street'] !== 'complete') return new Set();
  const result = view['result'];
  if (!isRecord(result)) return new Set();
  const showdowns = result['showdowns'];
  if (!Array.isArray(showdowns)) return new Set();
  return new Set(showdowns.map((entry: unknown) => (isRecord(entry) ? entry['seat'] : undefined)));
}

/**
 * Holds one view to `redactFor`'s own hole-card rule. See the module header for the whole argument.
 *
 * Never throws and never mutates: a value that is not a view at all reports nothing unentitled and
 * nothing examined, which is the honest answer for `view: null` — the frame the server sends
 * between hands — and which a caller distinguishes from a clean sweep by `seatsWithCards`.
 */
export function checkHoleCardEntitlement(view: unknown): HoleCardEntitlement {
  if (!isRecord(view)) return { unentitled: [], seatsExamined: 0, seatsWithCards: 0 };
  const seats = view['seats'];
  if (!Array.isArray(seats)) return { unentitled: [], seatsExamined: 0, seatsWithCards: 0 };

  const shown = shownSeats(view);
  const viewerSeat = view['viewerSeat'];
  const unentitled: number[] = [];
  let seatsWithCards = 0;

  for (const entry of seats) {
    if (!isRecord(entry)) continue;
    const holeCards = entry['holeCards'];
    // `null` and `undefined` both mean "no cards were sent", which is the safe state. Written out
    // rather than as `== null` because `biome.json` sets `noDoubleEquals`; the intent is the idiom
    // `scripts/smoke-test.mjs` documents, where the strict form would have reported a leak against
    // a serialiser that drops nulls.
    if (holeCards === null || holeCards === undefined) continue;
    seatsWithCards += 1;
    const index = entry['seat'];
    const isOwnSeat = entry['isSelf'] === true && index === viewerSeat;
    if (isOwnSeat || shown.has(index)) continue;
    unentitled.push(typeof index === 'number' ? index : -1);
  }

  return { unentitled, seatsExamined: seats.length, seatsWithCards };
}

/**
 * The same question asked of a `HandReviewResponse`, whose seats obey a different rule.
 *
 * `HandReviewSeat` is `{seat, displayName, isBot, startingStack, net, holeCards, showedDown}` — no
 * `isSelf`, no `viewerSeat` on the response — so the two halves of the exemption are `showedDown`,
 * which the server asserts per seat, and the viewer's own seat, which the caller has to supply
 * because nothing on the wire carries it. `scripts/smoke-test.mjs`'s `auditReviewSeats` reads the
 * same two fields and takes the viewer's seat from the live socket, which is the only place it is
 * authoritative; a caller here has only `findViewerSeat`'s recovery, which is why this is a check a
 * test runs and not a check the page runs. See the module header.
 *
 * Passing `viewerSeat: null` narrows the exemption to `showedDown` alone rather than widening it to
 * everything, which is the safe direction and is what makes a null recovery report the viewer's own
 * cards instead of quietly exempting every seat.
 */
export function checkReviewHoleCardEntitlement(
  review: unknown,
  viewerSeat: number | null,
): HoleCardEntitlement {
  if (!isRecord(review)) return { unentitled: [], seatsExamined: 0, seatsWithCards: 0 };
  const seats = review['seats'];
  if (!Array.isArray(seats)) return { unentitled: [], seatsExamined: 0, seatsWithCards: 0 };

  const unentitled: number[] = [];
  let seatsWithCards = 0;
  for (const entry of seats) {
    if (!isRecord(entry)) continue;
    const holeCards = entry['holeCards'];
    if (holeCards === null || holeCards === undefined) continue;
    seatsWithCards += 1;
    const index = entry['seat'];
    if (entry['showedDown'] === true) continue;
    if (viewerSeat !== null && index === viewerSeat) continue;
    unentitled.push(typeof index === 'number' ? index : -1);
  }
  return { unentitled, seatsExamined: seats.length, seatsWithCards };
}

/**
 * The refusal, as a sentence a developer can act on without opening this file.
 *
 * Shared by the frame rejection and the console line so the two cannot drift, and phrased around
 * what the server did rather than around what this client decided: the client is not the thing that
 * went wrong here, and a message that reads like a client-side validation failure sends the reader
 * of it to the wrong repository.
 *
 * Seat numbers here are the WIRE's, 0-based, because the audience is somebody about to grep the
 * server's logs for them. `dataRefusalSentence` in `use-live-table.ts` prints the same seats 1-based
 * for the person at the table, which is what every other seat number that page shows them is.
 */
export function describeUnentitledSeats(seats: readonly number[]): string {
  const named = seats.map((seat) => (seat < 0 ? 'a seat with an unreadable index' : `seat ${seat}`));
  const list =
    named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  return (
    `the view carried hole cards for ${list}, which is neither this recipient's own seat nor a seat ` +
    'that showed down in a completed hand — so the server contradicted the rule redactFor states ' +
    'about its own output, and this frame was refused rather than rendered'
  );
}
