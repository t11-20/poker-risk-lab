/**
 * `@prl/contracts` — the wire contract shared by `apps/api` and `apps/web`.
 *
 * Zero runtime dependencies beyond types from `@prl/poker-engine`. Nothing here
 * performs I/O; it is types, JSON Schemas and constants only, so both sides of the
 * wire are compiled against exactly the same definition.
 */

export * from './api-paths.ts';
export * from './api-types.ts';
export * from './content-types.ts';
export * from './errors.ts';
export * from './legends.ts';
export * from './schemas.ts';
export * from './ws-protocol.ts';
