/**
 * Table types projected out of the `@prl/contracts` wire message, so they cannot drift from it and a
 * protocol change fails to compile here. Not imported from `@prl/poker-engine`, whose graph carries
 * the shuffler and deck secrets that must never reach a browser.
 */

import type { WsAction, WsState } from '@prl/contracts';

/** Redacted for one recipient. Never contains a hidden card. */
export type PlayerView = NonNullable<WsState['view']>;

export type SeatView = PlayerView['seats'][number];

/** Carries the exact bounds the server will accept. */
export type LegalAction = PlayerView['legalActions'][number];

/** Main pot at index 0, side pots above it. */
export type PotLayer = PlayerView['pots'][number];

/** The betting round, plus the two terminal phases. */
export type Street = PlayerView['street'];

export type SeatStatus = SeatView['status'];

/** `to` is a total street commitment ("raise to 300"), not an increment. `ActionBar` shows both. */
export type TableAction = WsAction['action'];

/** In the order they are offered. */
export type ActionName = TableAction['type'];
