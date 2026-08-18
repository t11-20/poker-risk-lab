/**
 * Minimal reader for the `packages:` section of a pnpm lockfile.
 *
 * A full YAML parser is deliberately avoided: adding a YAML dependency to the
 * code that audits dependencies inverts the trust relationship. The lockfile's
 * `packages:` section has a fixed, machine-generated shape, so a line-oriented
 * reader is both sufficient and auditable.
 *
 * Shape being parsed (lockfileVersion 9.0 / 10.0 / 11.0):
 *
 *   packages:
 *
 *     '@fastify/error@4.2.0':
 *       resolution: {integrity: sha512-AAA==}
 *       engines: {node: '>=20'}
 *
 *     fastify@5.11.3:
 *       resolution: {integrity: sha512-BBB==}
 */

/**
 * @param {string} lockText
 * @returns {Map<string, {name: string, version: string, integrity: string|null, tarball: string|null}>}
 *          keyed by `name@version`
 */
export function parseLockPackages(lockText) {
  const result = new Map();
  const lines = lockText.split('\n');

  let inPackages = false;
  /** @type {string|null} */
  let currentKey = null;

  for (const line of lines) {
    // A top-level key (column 0, ends with ':') ends the packages section.
    if (/^[A-Za-z]/.test(line)) {
      inPackages = line.startsWith('packages:');
      currentKey = null;
      continue;
    }
    if (!inPackages) continue;

    // Package entry: exactly two spaces of indentation, then a key ending in ':'.
    const entry = /^ {2}(?!\s)('?)(.+?)\1:\s*$/.exec(line);
    if (entry) {
      currentKey = entry[2] ?? null;
      continue;
    }
    if (!currentKey) continue;

    const res = /^ {4}resolution:\s*\{(.+)\}\s*$/.exec(line);
    if (!res) continue;
    const inner = res[1] ?? '';
    const integrity = /integrity:\s*([^,}\s]+)/.exec(inner)?.[1] ?? null;
    const tarball = /tarball:\s*([^,}\s]+)/.exec(inner)?.[1] ?? null;

    const at = currentKey.lastIndexOf('@');
    if (at > 0) {
      const name = currentKey.slice(0, at);
      // Strip the peer-dependency suffix, e.g. `react-dom@19.2.8(react@19.2.8)`.
      const version = currentKey.slice(at + 1).replace(/\(.*\)$/, '');
      result.set(`${name}@${version}`, { name, version, integrity, tarball });
    }
    currentKey = null;
  }
  return result;
}
