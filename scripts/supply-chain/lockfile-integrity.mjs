/**
 * Minimal reader for a pnpm lockfile.
 *
 * A full YAML parser is deliberately avoided: adding a YAML dependency to the
 * code that audits dependencies inverts the trust relationship. The lockfile is
 * machine-generated and has a fixed shape, so a line-oriented reader is both
 * sufficient and auditable.
 *
 * ## Why this reads *structure* and not just text
 *
 * `dep-shapes.mjs` used to answer "was anything acquired from somewhere other
 * than the registry?" with six regexes over the raw lockfile text. Four of them
 * were anchored to the start of a line (`/^\s*repo:/`, `/^\s*commit:/`, …) and
 * pnpm writes `resolution:` as an *inline flow mapping on one line*, so those
 * four could never match. The two unanchored ones looked for `git+ssh://` and
 * `https://….tgz`, and pnpm records a git dependency as
 * `repo: github.com/owner/repo` — no scheme — and a directory dependency with no
 * URL at all. Fed a lockfile containing a real pnpm-format git resolution and a
 * real pnpm-format directory resolution, **0 of the 6 patterns matched**. The
 * gate the threat model names against the campaign's delivery Pattern B could
 * not fail.
 *
 * So the resolution is parsed into an object and the *keys* are inspected. A
 * pattern cannot silently stop matching a shape it never looks at as text.
 *
 * Shapes being parsed (lockfileVersion 9.0 / 10.0 / 11.0):
 *
 *   packages:
 *
 *     '@fastify/error@4.2.0':
 *       resolution: {integrity: sha512-AAA==}
 *       engines: {node: '>=20'}
 *
 *     fastify@5.11.3:
 *       resolution: {integrity: sha512-BBB==}
 *
 *     gitdep@github.com/attacker/evil:
 *       resolution: {commit: 9f1a…, repo: github.com/attacker/evil, type: git}
 *
 *     outside@file:../../../evil:
 *       resolution: {directory: ../../../evil, type: directory}
 *
 * Block-style resolutions (`resolution:` on its own line, keys indented beneath)
 * are accepted too. pnpm does not emit them, but a hand-edited lockfile can
 * contain them and a checker that only understands the generator's preferred
 * style is a checker an attacker formats their way past.
 */

/**
 * Splits the body of a YAML flow mapping on top-level commas, respecting quotes
 * and nesting. `integrity: sha512-A==, tarball: https://x/y.tgz` → two entries.
 *
 * @param {string} inner
 * @returns {string[]}
 */
function splitFlowEntries(inner) {
  const entries = [];
  let depth = 0;
  /** @type {string|null} */
  let quote = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) {
      entries.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(inner.slice(start));
  return entries.map((e) => e.trim()).filter((e) => e.length > 0);
}

/** Strips one layer of matching surrounding quotes. */
function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === "'" || first === '"') && trimmed[trimmed.length - 1] === first) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Parses the body of an inline flow mapping into a plain object.
 *
 * @param {string} inner e.g. `integrity: sha512-A==, tarball: https://x/y.tgz`
 * @returns {Record<string, string>}
 */
export function parseFlowMapping(inner) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const entry of splitFlowEntries(inner)) {
    const colon = entry.indexOf(':');
    if (colon < 0) continue;
    const key = unquote(entry.slice(0, colon));
    if (key === '') continue;
    out[key] = unquote(entry.slice(colon + 1));
  }
  return out;
}

/**
 * Splits a lockfile package key (`name@version`, with an optional peer suffix)
 * into its parts. Returns null for a key that is not in that shape.
 *
 * @param {string} key
 * @returns {{name: string, version: string} | null}
 */
export function splitPackageKey(key) {
  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  return {
    name: key.slice(0, at),
    // Strip the peer-dependency suffix, e.g. `react-dom@19.2.8(react@19.2.8)`.
    version: key.slice(at + 1).replace(/\(.*\)$/, ''),
  };
}

/**
 * @typedef {object} LockPackage
 * @property {string} name
 * @property {string} version
 * @property {string} key            the raw lockfile key, peer suffix included
 * @property {string|null} integrity
 * @property {string|null} tarball
 * @property {Record<string, string>|null} resolution  every key pnpm recorded,
 *   or null when the entry declared no resolution at all
 */

/**
 * @typedef {object} LockImporterDependency
 * @property {string} importer   workspace-relative path, e.g. `.` or `apps/api`
 * @property {string} section    dependencies | devDependencies | optionalDependencies
 * @property {string} name
 * @property {string} specifier  what the manifest asked for
 * @property {string} version    what pnpm resolved it to
 */

/**
 * The `packages:` section, keyed by `name@version`.
 *
 * @param {string} lockText
 * @returns {Map<string, LockPackage>}
 */
export function parseLockPackages(lockText) {
  return parseLockfile(lockText).packages;
}

/**
 * The whole lockfile, as much of it as the gates need.
 *
 * @param {string} lockText
 * @returns {{lockfileVersion: string|null, packages: Map<string, LockPackage>, importers: LockImporterDependency[]}}
 */
export function parseLockfile(lockText) {
  /** @type {Map<string, LockPackage>} */
  const packages = new Map();
  /** @type {LockImporterDependency[]} */
  const importers = [];
  const lines = lockText.split('\n');

  const lockfileVersion = /^lockfileVersion:\s*'?([\d.]+)'?/m.exec(lockText)?.[1] ?? null;

  /** Which top-level section we are inside. */
  let section = /** @type {'packages'|'importers'|null} */ (null);

  // --- `packages:` accumulator ---------------------------------------------
  /** @type {string|null} */
  let packageKey = null;
  /** @type {Record<string, string>|null} */
  let resolution = null;
  let inResolutionBlock = false;

  const flushPackage = () => {
    if (packageKey !== null) {
      const split = splitPackageKey(packageKey);
      if (split) {
        packages.set(`${split.name}@${split.version}`, {
          name: split.name,
          version: split.version,
          key: packageKey,
          integrity: resolution?.['integrity'] ?? null,
          tarball: resolution?.['tarball'] ?? null,
          resolution,
        });
      }
    }
    packageKey = null;
    resolution = null;
    inResolutionBlock = false;
  };

  // --- `importers:` accumulator --------------------------------------------
  /** @type {string|null} */
  let importerPath = null;
  /** @type {string|null} */
  let importerSection = null;
  /** @type {string|null} */
  let depName = null;
  /** @type {{specifier: string|null, version: string|null}} */
  let depFields = { specifier: null, version: null };

  const flushImporterDep = () => {
    if (depName !== null && importerPath !== null && importerSection !== null) {
      importers.push({
        importer: importerPath,
        section: importerSection,
        name: depName,
        specifier: depFields.specifier ?? '',
        version: depFields.version ?? '',
      });
    }
    depName = null;
    depFields = { specifier: null, version: null };
  };

  for (const line of lines) {
    // A key in column 0 ends whichever section we were in.
    if (/^[A-Za-z]/.test(line)) {
      flushPackage();
      flushImporterDep();
      importerPath = null;
      importerSection = null;
      if (line.startsWith('packages:')) section = 'packages';
      else if (line.startsWith('importers:')) section = 'importers';
      else section = null;
      continue;
    }

    if (section === 'packages') {
      // Package entry: exactly two spaces of indentation, then a key ending in ':'.
      const entry = /^ {2}(?!\s)('?)(.+?)\1:\s*$/.exec(line);
      if (entry) {
        flushPackage();
        packageKey = entry[2] ?? null;
        continue;
      }
      if (packageKey === null) continue;

      const inline = /^ {4}resolution:\s*\{(.*)\}\s*$/.exec(line);
      if (inline) {
        resolution = parseFlowMapping(inline[1] ?? '');
        inResolutionBlock = false;
        continue;
      }
      if (/^ {4}resolution:\s*$/.test(line)) {
        resolution = {};
        inResolutionBlock = true;
        continue;
      }
      if (inResolutionBlock) {
        const kv = /^ {6,}([A-Za-z_][\w.-]*):\s*(.*)$/.exec(line);
        if (kv && resolution !== null) {
          const key = kv[1];
          if (key !== undefined) resolution[key] = unquote(kv[2] ?? '');
          continue;
        }
        // Anything else closes the block mapping.
        inResolutionBlock = false;
      }
      continue;
    }

    if (section === 'importers') {
      const importerEntry = /^ {2}(?!\s)('?)(.+?)\1:\s*$/.exec(line);
      if (importerEntry) {
        flushImporterDep();
        importerPath = importerEntry[2] ?? null;
        importerSection = null;
        continue;
      }
      const sectionEntry = /^ {4}(?!\s)([A-Za-z]+):\s*$/.exec(line);
      if (sectionEntry) {
        flushImporterDep();
        importerSection = sectionEntry[1] ?? null;
        continue;
      }
      const depEntry = /^ {6}(?!\s)('?)(.+?)\1:\s*$/.exec(line);
      if (depEntry) {
        flushImporterDep();
        depName = depEntry[2] ?? null;
        continue;
      }
      const field = /^ {8}(specifier|version):\s*(.*)$/.exec(line);
      if (field && depName !== null) {
        const key = field[1];
        if (key === 'specifier') depFields.specifier = unquote(field[2] ?? '');
        else depFields.version = unquote(field[2] ?? '');
      }
    }
  }
  flushPackage();
  flushImporterDep();

  return { lockfileVersion, packages, importers };
}
