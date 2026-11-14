/**
 * What both `migrate.mjs` and the schema guard take a migration file to be. Imports nothing but
 * `node:crypto`, because the runner is run from checkouts whose workspace packages are not built.
 */

import { createHash } from 'node:crypto';

/** The group is the number `migrate.mjs` orders by. A file it cannot order is one it will not apply. */
export const FILE_NAME_PATTERN = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/** The checksum the ledger records. A BOM or CRLF line endings are not an edit. */
export function migrationChecksum(contents: string): string {
  const normalised = contents.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return `sha256:${createHash('sha256').update(normalised, 'utf8').digest('hex')}`;
}
