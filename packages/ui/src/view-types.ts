/**
 * The table types this package renders, derived from the wire contract.
 *
 * ## Why these are derived rather than imported directly
 *
 * `PlayerView` and `SeatView` are defined in `@prl/poker-engine/src/redact.ts` —
 * that is the hidden-information boundary, and it is the right definition to build
 * against. But this package does not depend on `@prl/poker-engine`, deliberately:
 *
 *  - Its dependencies are `@prl/contracts` and `@prl/poker-math` only, and adding a
 *    dependency to this repo is release-blocking (Biome's `noUndeclaredDependencies`
 *    would reject the import anyway).
 *  - More importantly, the browser has no business linking against the rules
 *    engine. The engine module graph contains the shuffler, the deck commitment and
 *    `HandState` — the very types that must never reach a client. Pulling it in for
 *    a type would put all of it one careless `import` away from the bundle.
 *
 * `@prl/contracts` already carries the redacted view, because `WsState.view` is
 * literally "the authoritative table state, redacted for this recipient". So the
 * types below are *projected out of the protocol message the client actually
 * receives*. That is a stronger guarantee than re-declaring the shapes by hand:
 * these cannot drift from the wire, and there is no second definition to keep in
 * sync. If the protocol changes, this package fails to compile.
 *
 * Re-declaring them structurally was the alternative and was rejected: a hand-copied
 * interface silently keeps compiling after the contract changes, which is precisely
 * how a UI ends up reading a field the server stopped sending.
 */

import type { WsAction, WsState } from '@prl/contracts';

/** The redacted table state for one recipient. Never contains a hidden card. */
export type PlayerView = NonNullable<WsState['view']>;

/** One seat as this recipient is allowed to see it. */
export type SeatView = PlayerView['seats'][number];

/** A legal action with the exact bounds the server will accept. */
export type LegalAction = PlayerView['legalActions'][number];

/** A pot layer — main pot at index 0, side pots above it. */
export type PotLayer = PlayerView['pots'][number];

/** The betting round, plus the two terminal phases. */
export type Street = PlayerView['street'];

/** A seat's participation state in the current hand. */
export type SeatStatus = SeatView['status'];

/**
 * A decision, in exactly the shape the WebSocket `action` message carries.
 *
 * `to` is a TOTAL street commitment ("raise **to** 300"), not an increment. The
 * engine chose that convention because "raise 300" is ambiguous, and the UI has to
 * honour it: `ActionBar` therefore shows both the total and the chips it costs, so
 * a learner is never guessing which number the control means.
 */
export type TableAction = WsAction['action'];

/** Action names, in the order they are offered. */
export type ActionName = TableAction['type'];
