/**
 * Holds a view to the hole-card rule `redactFor` publishes about its own output. `holeCards` is non-null
 * only for the recipient's own seat or a seat in a completed hand's `result.showdowns`.
 * It removes nothing. The leaked frame is already in the network panel (and, on `/review`, in the RSC
 * payload), so a client redactor would only hide the evidence. It is a detector, not a boundary.
 * It runs at the socket ingress, not in `Seat.tsx`, because `COMPLETED_HAND_VIEW` (the demo fixture)
 * shows cards with `result: null` and a renderer check would refuse it.
 * Review payloads get `checkReviewHoleCardEntitlement`, enforced in a test only, because the viewer's
 * seat there is a heuristic (`findViewerSeat`) and replays copy shown cards into every step.
 */

/** What one pass over a view found. */
export interface HoleCardEntitlement {
  /** Unentitled seats in order. A non-numeric index is reported as `-1` so it cannot buy an exemption. */
  readonly unentitled: readonly number[];
  readonly seatsExamined: number;
  /** Seats that carried a pair, entitled or not. A sweep of nothing is not a pass; tests assert this. */
  readonly seatsWithCards: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only for `street === 'complete'` with a real array; a null `result` exempts nobody. */
function shownSeats(view: Record<string, unknown>): ReadonlySet<unknown> {
  if (view['street'] !== 'complete') return new Set();
  const result = view['result'];
  if (!isRecord(result)) return new Set();
  const showdowns = result['showdowns'];
  if (!Array.isArray(showdowns)) return new Set();
  return new Set(showdowns.map((entry: unknown) => (isRecord(entry) ? entry['seat'] : undefined)));
}

/**
 * Own seat requires both `isSelf === true` and `seat === viewerSeat`, stricter than the smoke test.
 * Never throws. A non-view reports zero examined, which callers tell apart from a clean sweep.
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
    // Both null and undefined mean no cards. Written out because biome sets `noDoubleEquals`.
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
 * `HandReviewSeat` has no `isSelf` and the response has no `viewerSeat`, so the caller supplies it.
 * `viewerSeat: null` narrows the exemption to `showedDown` alone, which is the safe direction.
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
 * Phrased around what the server did, so the reader looks in the right repository.
 * Seat numbers are the wire's, 0-based, for grepping server logs.
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
