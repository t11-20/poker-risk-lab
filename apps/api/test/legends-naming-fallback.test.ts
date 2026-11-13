/**
 * The Legends fallback fixture in apps/web obeys the naming guardrail. Attributed real-person names
 * are an explicit server-side opt-in (`PRL_LEGEND_NAMING`), and the fixture renders whenever the API
 * is down, so it must never carry an attributed name.
 * `apps/web` is a different TypeScript program, so the fixture is imported at runtime by URL and
 * narrowed with type guards.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROFILES, resolveNamingMode } from '@prl/poker-ai';

const WEB_FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src', 'fixtures');

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
    // In archetype mode display name, short label and archetype name are one string.
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
        // Comments may explain why the attributed path was removed.
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
        for (const [pattern, what] of banned) {
          if (pattern.test(line)) offenders.push(`${file}:${index + 1}: ${what} — ${trimmed}`);
        }
      });
    }
    assert.deepEqual(offenders, [], 'attributed naming must be a server-side, opt-in decision only');
  });
});
