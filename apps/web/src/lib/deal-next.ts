/**
 * Whether "Deal the next hand" is on offer, and whether it can be pressed. The connection card and the
 * decision band both draw it from this, so two controls of one name cannot disagree.
 */

export interface DealNextInput {
  /** The socket is live. */
  readonly live: boolean;
  /** "Deal me in" is seating and dealing, and a second deal must not be sent beside it. */
  readonly dealingIn: boolean;
  readonly seated: boolean;
  readonly betweenHands: boolean;
  readonly outOfUnits: boolean;
}

/** Null where the control is not drawn at all. */
export function dealNextState(input: DealNextInput): { readonly disabled: boolean } | null {
  if (!input.live || input.dealingIn || !input.seated) return null;
  return { disabled: !input.betweenHands || input.outOfUnits };
}
