/**
 * The Legends naming guardrail, asserted where the web app falls back.
 *
 * ## Why an API test asserts a web fixture
 *
 * `PRL_LEGEND_NAMING` is a deployer's decision with legal consequences: unset means archetype names,
 * and attributed real-person names are an explicit opt-in (`resolveNamingMode` in
 * `@prl/poker-ai/labelling` — "the safe mode is the one you get by not thinking about it"). The
 * server honours that. The bundled fixture the Legends screens fall back to did not: it hard-coded
 * `namingMode: 'attributed'` and six real people's names, so an operator who never set the variable
 * shipped attributed identities on every page load where the profile service was unreachable — which,
 * while every request 404'd on the wrong path, was every page load.
 *
 * Repairing the paths does not close that. A fixture is by definition what renders when the API is
 * not answering, so an offline render path that *can* display an attributed name will display one
 * during the next outage regardless of configuration. The guardrail therefore has to hold in the
 * fixture itself, and this asserts that it does.
 *
 * `apps/web` has no test runner of its own and cannot be imported statically from here — its
 * `tsconfig.json` is a different program with `rootDir` elsewhere and DOM lib types — so the fixture
 * is loaded at runtime by URL and narrowed explicitly. Nothing typed `any` escapes `readFixture`.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROFILES, resolveNamingMode } from '@prl/poker-ai';

const WEB_FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src', 'fixtures');

/** Only what this file asserts on. Deliberately narrower than `LegendProfilesResponse`. */
interface FixtureDisclosure {
  readonly displayName: string;
  readonly archetypeName: string;
  readonly attributed: boolean;
  readonly disclaimers: readonly string[];
  readonly shortLabel: string;
}

interface FixtureProfile {
  readonly id: string;
  readonly disclosure: FixtureDisclosure;
}

interface FixtureResponse {
  readonly namingMode: string;
  readonly profiles: readonly FixtureProfile[];
}

function isDisclosure(value: unknown): value is FixtureDisclosure {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<FixtureDisclosure>;
  return (
    typeof candidate.displayName === 'string' &&
    typeof candidate.archetypeName === 'string' &&
    typeof candidate.attributed === 'boolean' &&
    Array.isArray(candidate.disclaimers) &&
    typeof candidate.shortLabel === 'string'
  );
}

function isProfile(value: unknown): value is FixtureProfile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<FixtureProfile>;
  return typeof candidate.id === 'string' && isDisclosure(candidate.disclosure);
}

/**
 * The bundled profiles response, loaded from the web app and narrowed.
 *
 * The dynamic import is what keeps this file inside its own TypeScript program; the type guards are
 * what stop that from becoming an untyped read.
 */
async function readFixture(): Promise<FixtureResponse> {
  const module: unknown = await import(pathToFileURL(join(WEB_FIXTURES, 'legends.ts')).href);
  assert.ok(typeof module === 'object' && module !== null, 'the legends fixture module did not load');
  const exported = (module as Record<string, unknown>)['LEGEND_PROFILES_FIXTURE'];
  assert.ok(typeof exported === 'object' && exported !== null, 'LEGEND_PROFILES_FIXTURE is not exported');
  const { namingMode, profiles } = exported as { namingMode?: unknown; profiles?: unknown };
  assert.equal(typeof namingMode, 'string', 'the fixture publishes no namingMode');
  assert.ok(Array.isArray(profiles) && profiles.length > 0, 'the fixture publishes no profiles');
  for (const profile of profiles)
    assert.ok(isProfile(profile), 'a fixture profile is not the shape asserted');
  return { namingMode: String(namingMode), profiles: profiles as readonly FixtureProfile[] };
}

/** Every `.ts`/`.tsx` file under a directory, recursively. */
function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('the Legends fallback obeys the naming guardrail', () => {
  it('defaults to archetype naming, the same default the server resolves', () => {
    // Stated as an equality rather than as a literal, so the fixture cannot be "corrected" to a mode
    // the server would never choose by default.
    assert.equal(resolveNamingMode({}), 'archetype');
  });

  it('bundles a response in archetype mode', async () => {
    const fixture = await readFixture();
    assert.equal(
      fixture.namingMode,
      resolveNamingMode({}),
      'the bundled fallback overrides PRL_LEGEND_NAMING for every deployment that renders it',
    );
  });

  it('carries no attributed profile', async () => {
    const fixture = await readFixture();
    const attributed = fixture.profiles.filter((profile) => profile.disclosure.attributed);
    assert.deepEqual(
      attributed.map((profile) => profile.id),
      [],
      'these profiles claim an attributed identity in a fallback nobody opted into',
    );
  });

  it('shows the archetype name and nothing else as the identity', async () => {
    const fixture = await readFixture();
    // In attributed mode the server builds `"<real name> (modelled style)"` and puts the archetype
    // name beneath it. In archetype mode display name, short label and archetype name are one string,
    // so any divergence here is an attributed rendering that survived.
    const wrong = fixture.profiles
      .filter(
        (profile) =>
          profile.disclosure.displayName !== profile.disclosure.archetypeName ||
          profile.disclosure.shortLabel !== profile.disclosure.archetypeName,
      )
      .map(
        (profile) => `${profile.id}: ${profile.disclosure.displayName} / ${profile.disclosure.shortLabel}`,
      );
    assert.deepEqual(wrong, []);
  });

  it('names only profiles the server also ships, so a fallback link survives a reload', async () => {
    const fixture = await readFixture();
    const served = new Set(PROFILES.map((profile) => profile.naming.id));
    const unknown = fixture.profiles.map((profile) => profile.id).filter((id) => !served.has(id));
    assert.deepEqual(unknown, [], 'these fixture profiles do not exist on the server');
  });

  it('has no attributed naming material anywhere in apps/web/src/fixtures', () => {
    // The behavioural assertions above cover what the fixture currently exports. This covers what a
    // future edit could reach for: the builder, the disclaimer and the suffix that together turn a
    // profile into a claim about a person have no business in a tree the app renders offline.
    const banned: readonly (readonly [RegExp, string])[] = [
      [/namingMode:\s*'attributed'/, 'a fixture declaring attributed mode'],
      [/attributed:\s*true/, 'a disclosure claiming an attributed identity'],
      [/modelled style/, 'the attributed display-name suffix'],
      [/attributedName/, 'an attributed-name field'],
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles(WEB_FIXTURES)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        // Comments are how this file's own reasoning is recorded; a sentence explaining why the
        // attributed path was removed is not the attributed path.
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
        for (const [pattern, what] of banned) {
          if (pattern.test(line)) offenders.push(`${file}:${index + 1}: ${what} — ${trimmed}`);
        }
      });
    }
    assert.deepEqual(offenders, [], 'attributed naming must be a server-side, opt-in decision only');
  });
});
