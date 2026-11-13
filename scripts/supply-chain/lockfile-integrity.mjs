/**
 * Minimal line-oriented reader for a pnpm lockfile (lockfileVersion 9.0 to 11.0). No YAML
 * dependency, because the code that audits dependencies must not add one.
 *
 * Resolutions are parsed into objects and their keys inspected. `dep-shapes.mjs` once used six
 * regexes over the text, and 0 of 6 matched a real pnpm git or directory resolution, because pnpm
 * writes `resolution:` as a one-line flow mapping and a git repo with no scheme. Block-style
 * resolutions are accepted too, since a hand-edited lockfile can use them.
 */

/**
 * Splits a flow mapping body on top-level commas, respecting quotes and nesting.
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
 * Splits `name@version` (optional peer suffix) into parts, or null for any other shape.
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
 * @param {string} lockText
 * @returns {Map<string, LockPackage>}
 */
export function parseLockPackages(lockText) {
  return parseLockfile(lockText).packages;
}

/**
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

  let section = /** @type {'packages'|'importers'|null} */ (null);

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
