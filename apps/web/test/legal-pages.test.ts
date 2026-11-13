/**
 * The three legal documents. Each clause needing counsel carries the marker, the register, the pages
 * and the review document cannot drift apart, and every table `db/migrations` creates is named on
 * `/privacy`. Assertions are over source text, because `apps/web` tests run under `node --test` with no
 * DOM and no JSX transform.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGE_GATE_PATH, readAgeGateConfig } from '../src/lib/age-gate.ts';
import {
  COUNSEL_CLAUSE_IDS,
  COUNSEL_CLAUSES,
  COUNSEL_MARKER,
  COUNSEL_MARKER_EXPLANATION,
  type CounselClauseId,
  counselClausesFor,
  LEGAL_PATHS,
  type LegalPageKey,
  NOT_SUPPLIED,
  PLAY_MONEY_WARNING,
  readLegalDeployment,
} from '../src/lib/legal-config.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');
const REPO = resolve(HERE, '..', '..', '..');

const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

/**
 * Whitespace collapsed, for assertions about sentences, so a formatter reflow cannot fail them.
 * Assertions about code (a constant's name, a clause key) match the raw source.
 */
const flat = (source: string): string => source.replace(/\s+/gu, ' ');

const PAGES: Readonly<Record<LegalPageKey, readonly string[]>> = {
  terms: ['app', 'terms', 'page.tsx'],
  privacy: ['app', 'privacy', 'page.tsx'],
  'responsible-use': ['app', 'responsible-use', 'page.tsx'],
};

const PAGE_KEYS = Object.keys(PAGES) as readonly LegalPageKey[];

const REVIEW_DOC = readFileSync(join(REPO, 'docs', 'production', 'legal-review-requirements.md'), 'utf8');

/** Matches the exact key, so a typo in a clause id is a failure rather than a near miss. */
function rendersClause(source: string, id: CounselClauseId): boolean {
  return source.includes(`COUNSEL_CLAUSES['${id}']`);
}

function clausesRenderedBy(source: string): readonly CounselClauseId[] {
  return COUNSEL_CLAUSE_IDS.filter((id) => rendersClause(source, id));
}

describe('the register itself is well formed', () => {
  it('lists every clause exactly once, in an order the review document can follow', () => {
    assert.ok(COUNSEL_CLAUSE_IDS.length > 5, 'the register must not have quietly emptied itself');
    assert.equal(new Set(COUNSEL_CLAUSE_IDS).size, COUNSEL_CLAUSE_IDS.length, 'no duplicate ids');
    assert.equal(
      COUNSEL_CLAUSE_IDS.length,
      Object.keys(COUNSEL_CLAUSES).length,
      'the ordered list and the record must hold the same clauses',
    );
  });

  it('gives every clause a page, a subject and a question', () => {
    for (const id of COUNSEL_CLAUSE_IDS) {
      const clause = COUNSEL_CLAUSES[id];
      assert.equal(clause.id, id, `${id} must carry its own id`);
      assert.ok(clause.pages.length > 0, `${id} must appear on at least one page`);
      assert.ok(clause.subject.length > 10, `${id} needs a subject`);
      // A question, so an answer is something somebody can be shown to have given.
      assert.ok(clause.question.includes('?'), `${id}'s question must actually ask something`);
      for (const page of clause.pages) {
        assert.ok(PAGE_KEYS.includes(page), `${id} claims an unknown page ${page}`);
      }
    }
  });
});

describe('every clause needing counsel carries the marker on the page it is on', () => {
  for (const page of PAGE_KEYS) {
    it(`${page} renders each clause the register assigns to it`, () => {
      const source = read(...PAGES[page]);
      const expected = counselClausesFor(page);
      assert.ok(expected.length > 0, `${page} should have at least one flagged clause`);
      for (const clause of expected) {
        assert.ok(
          rendersClause(source, clause.id),
          `${page} must render the "${clause.subject}" clause. A clause on the lawyer's list that ` +
            'is missing from the page is a placeholder a reader cannot see is a placeholder.',
        );
      }
    });

    it(`${page} renders no clause the register does not know about`, () => {
      const source = read(...PAGES[page]);
      for (const id of clausesRenderedBy(source)) {
        assert.ok(
          COUNSEL_CLAUSES[id].pages.includes(page),
          `${page} renders ${id}, which the register does not assign to it`,
        );
      }
    });

    it(`${page} shows the marker and explains what it means`, () => {
      const source = read(...PAGES[page]);
      // Both come from `legal-config.ts`, so the three pages cannot use three different words.
      assert.match(source, /COUNSEL_MARKER\b/u, `${page} must render the marker constant`);
      assert.match(
        source,
        /COUNSEL_MARKER_EXPLANATION/u,
        `${page} must explain the marker; an unexplained badge is decoration`,
      );
    });
  }
});

describe('the review document and the pages cannot drift apart', () => {
  it('names every clause in the register', () => {
    assert.ok(COUNSEL_CLAUSE_IDS.length > 5);
    for (const id of COUNSEL_CLAUSE_IDS) {
      assert.ok(
        REVIEW_DOC.includes(id),
        `docs/production/legal-review-requirements.md must list ${id}. A clause marked on a page ` +
          "and absent from the lawyer's list is one nobody will be asked to write.",
      );
    }
  });

  it('quotes the marker a reader will actually see', () => {
    assert.ok(
      REVIEW_DOC.includes(COUNSEL_MARKER),
      'the document has to quote the exact words on the page, or a reviewer cannot search for them',
    );
  });

  it('records that attributed opponent names stay switched off until the review exists', () => {
    // ADR 0011 relies on `archetype` being the default, and this document tells the deployer so.
    assert.match(REVIEW_DOC, /PRL_LEGEND_NAMING/u);
    assert.match(REVIEW_DOC, /archetype/u);
    assert.match(REVIEW_DOC, /must (?:remain|stay) unset/u);
  });

  it('records the jurisdiction question behind the age threshold, and the shipped default', () => {
    assert.match(REVIEW_DOC, /PRL_AGE_GATE\b/u);
    assert.match(REVIEW_DOC, /self-declaration/u);
    assert.match(REVIEW_DOC, /no age gate/u);
  });

  it('names all three documents so a reviewer can find them', () => {
    for (const path of Object.values(LEGAL_PATHS)) {
      assert.ok(REVIEW_DOC.includes(path), `the review document must reference ${path}`);
    }
  });
});

describe('the required disclosures are on the pages', () => {
  it('the responsible-use page states the play-money warning', () => {
    // The sentence most likely to be softened by a copy edit. It is a constant so this can assert on it.
    const source = read(...PAGES['responsible-use']);
    assert.match(source, /PLAY_MONEY_WARNING/u);
    assert.ok(
      PLAY_MONEY_WARNING.includes('does not mean you would play well, or win, for money'),
      'the warning must still say that skill here does not transfer to playing for money',
    );
    assert.ok(
      PLAY_MONEY_WARNING.includes('not evidence of an edge anywhere else'),
      'and that it is not evidence of an edge elsewhere',
    );
  });

  it('the age gate states the same warning, where the decision is actually being made', () => {
    const gate = read('components', 'AgeGate.tsx');
    assert.match(gate, /PLAY_MONEY_WARNING/u);
  });

  /**
   * The import alone satisfies the presence check above, and adding `hidden` to the AgeGate paragraph
   * once left every test passing. These are Next components the `packages/ui` loader cannot compile,
   * so this checks the enclosing element for `hidden`, `aria-hidden`, `display: none` and a falsy guard.
   */
  it('renders the warning in an element a reader can actually see', () => {
    const surfaces: readonly (readonly [string, readonly string[]])[] = [
      ['the age gate', ['components', 'AgeGate.tsx']],
      ['the responsible-use page', [...PAGES['responsible-use']]],
      ['the terms page', [...PAGES.terms]],
    ];
    assert.equal(surfaces.length, 3);

    for (const [name, parts] of surfaces) {
      const source = read(...parts);
      // Collapsed first, because the formatter reflows a long tag across lines.
      const flattened = flat(source);
      const at = flattened.indexOf('{PLAY_MONEY_WARNING}');
      assert.notEqual(at, -1, `${name} imports the warning and never renders it`);
      // 400 characters covers the enclosing tag and the one above it.
      const enclosing = flattened.slice(Math.max(0, at - 400), at);
      const lastTag = enclosing.lastIndexOf('<');
      assert.notEqual(lastTag, -1, `${name}: the warning is not inside an element at all`);
      const window = enclosing.slice(lastTag);

      assert.doesNotMatch(window, /\bhidden\b/u, `${name}: the warning is rendered hidden`);
      assert.doesNotMatch(window, /aria-hidden/u, `${name}: the warning is hidden from the a11y tree`);
      assert.doesNotMatch(window, /display:\s*['"]?none/u, `${name}: the warning is displayed none`);
      // `{false && …}` and `{null && …}` keep the identifier and render nothing.
      assert.doesNotMatch(
        enclosing,
        /\{\s*(?:false|null|undefined|0)\s*&&/u,
        `${name}: the warning is behind a guard that is never true`,
      );
      assert.doesNotMatch(window, /\{\/\*/u, `${name}: the warning is inside a JSX comment`);
    }
  });

  it('the age gate says outright that it verifies nothing', () => {
    const gate = flat(read('components', 'AgeGate.tsx'));
    assert.match(
      gate,
      /self-declaration, not a check/u,
      'the gate must not imply it verified anything. It cannot, and an operator who believes it ' +
        'did is the person this sentence protects.',
    );
    assert.match(gate, /no date of birth is stored/u);
    assert.match(gate, /Nothing is verified/u);
  });

  it('the terms describe what the product is and is not', () => {
    const terms = flat(read(...PAGES.terms));
    assert.match(terms, /not a gambling product/u);
    assert.match(terms, /nothing to buy/u);
    assert.match(terms, /cash anything out/u);
    // The non-impersonation language ADR 0011 requires.
    assert.match(terms, /not real people, not digital copies of anybody, and not endorsed by anyone/u);
  });

  it('the privacy page says what deletion removes, detaches and keeps', () => {
    const privacy = flat(read(...PAGES.privacy));
    for (const word of ['Removed', 'Detached from you', 'Kept, in full']) {
      assert.ok(privacy.includes(word), `the deletion section must state what is ${word}`);
    }
  });

  it('the privacy page describes the browser storage this product actually uses', () => {
    // A key renamed in the source but not on the page leaves the page describing storage that is gone.
    const privacy = read(...PAGES.privacy);
    const timer = read('components', 'SessionDuration.tsx');
    const theme = read('lib', 'theme.ts');
    const onboarding = read('components', 'Onboarding.tsx');
    const keys = [
      'prl.session.startedAt',
      'prl.session.reminderMinutes',
      'prl.session.hidden',
      'prl-theme',
      'prl-booted',
      'prl.learn.onboarding.dismissed',
    ];
    assert.ok(keys.length > 5);
    const sources = `${timer}\n${theme}\n${onboarding}`;
    for (const key of keys) {
      assert.ok(sources.includes(key), `${key} must still exist in the source`);
      assert.ok(privacy.includes(key), `/privacy must name ${key}`);
    }
  });

  it('every field the pages can be missing renders as a visible gap, never as a plausible default', () => {
    // The unconfigured deployment is the shipped one, so this is the state most readers see.
    const deployment = readLegalDeployment({});
    assert.equal(deployment.configured, false);
    assert.equal(deployment.operator, null);
    assert.equal(deployment.contact, null);
    for (const page of ['terms', 'privacy'] as const) {
      assert.ok(read(...PAGES[page]).includes('NOT_SUPPLIED'), `${page} must render the gap marker`);
    }
    assert.match(NOT_SUPPLIED, /not supplied/u);
  });

  it('the documents are reachable without answering the age question', () => {
    // A privacy policy readable only after declaring something about yourself is not a privacy policy.
    const config = readAgeGateConfig({ PRL_AGE_GATE: 'on', PRL_AGE_GATE_SCOPE: 'site' });
    assert.equal(config.scope, 'site');
    const gateSource = readFileSync(join(SRC, 'lib', 'age-gate.ts'), 'utf8');
    for (const path of [...Object.values(LEGAL_PATHS), AGE_GATE_PATH]) {
      assert.ok(gateSource.includes(`'${path}'`), `${path} must be on the always-open list`);
    }
  });
});

describe('the documents are reachable, and are not in the numbered navigation', () => {
  it('the footer links to all three', () => {
    const footer = read('components', 'SiteFooter.tsx');
    assert.match(footer, /DOCUMENT_DESTINATIONS/u, 'the footer renders the document list');

    // The list takes its hrefs from `LEGAL_PATHS`, so this checks the reference and not the strings.
    const nav = read('lib', 'nav.ts');
    assert.match(nav, /import \{ LEGAL_PATHS \} from '\.\/legal-config\.ts'/u);
    for (const key of Object.keys(LEGAL_PATHS)) {
      assert.ok(nav.includes(`LEGAL_PATHS.${key}`), `DOCUMENT_DESTINATIONS must include ${key}`);
    }
    assert.equal(Object.keys(LEGAL_PATHS).length, 3);
  });

  it('leaves NAV_DESTINATIONS at the five it argues for', () => {
    // The five numbered destinations are a learning order. A sixth is a product decision.
    const nav = read('lib', 'nav.ts');
    // Anchored on `export const`, because the module comment names `DOCUMENT_DESTINATIONS` too.
    const start = nav.indexOf('export const NAV_DESTINATIONS');
    const end = nav.indexOf('export const DOCUMENT_DESTINATIONS');
    assert.ok(start >= 0 && end > start, 'the two lists have moved; this assertion needs updating');
    const block = nav.slice(start, end);
    assert.ok(block.length > 100, 'NAV_DESTINATIONS has moved; this assertion needs updating');
    assert.equal((block.match(/href:/gu) ?? []).length, 5, 'exactly five numbered destinations');
    for (const path of Object.values(LEGAL_PATHS)) {
      assert.ok(!block.includes(path), `${path} must not be one of the five`);
    }
  });

  it('gives the footer’s second navigation landmark a name of its own', () => {
    // Two navigation landmarks with one name fail `landmark-unique`.
    const footer = read('components', 'SiteFooter.tsx');
    assert.match(footer, /aria-label="Sections"/u);
    assert.match(footer, /aria-label="Documents"/u);
    const labels = [...footer.matchAll(/aria-label="([^"]+)"/gu)].map((match) => match[1]);
    assert.ok(labels.length >= 2);
    assert.equal(new Set(labels).size, labels.length, 'every landmark in the footer needs its own name');
  });
});

/**
 * Every `CREATE TABLE prl.x` in `db/migrations`, except the `prl.schema_migrations` ledger.
 * Shared by the inventory and the money tripwire, because two scanners over one directory drift.
 */
function schemaTables(): readonly string[] {
  const dir = join(REPO, 'db', 'migrations');
  const sql = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => readFileSync(join(dir, file), 'utf8'))
    .join('\n');
  const found = new Set<string>();
  for (const match of sql.matchAll(/create table (?:if not exists )?prl\.([a-z_]+)/giu)) {
    const name = match[1];
    if (name !== undefined && name !== 'schema_migrations') found.add(name);
  }
  return [...found].sort();
}

describe('the inventory accounts for every table in the schema', () => {
  it('names every table that holds anything about a reader', () => {
    const tables = schemaTables();
    assert.ok(tables.length > 8, `expected the full schema, scanned ${String(tables.length)} tables`);
    const privacy = read(...PAGES.privacy);
    for (const table of tables) {
      assert.ok(
        privacy.includes(`prl.${table}`),
        `/privacy must account for prl.${table}. A new table holding something about a reader is ` +
          'exactly the moment to decide what the inventory says about it.',
      );
    }
  });
});

/**
 * Read as text, because `apps/web` and `apps/api` are separate packages and an import would pull the
 * API's module graph into a web test.
 */
const API_SESSION_REPO = readFileSync(
  join(REPO, 'apps', 'api', 'src', 'repositories', 'sessions.ts'),
  'utf8',
);
const API_SESSION_AUTH = readFileSync(join(REPO, 'apps', 'api', 'src', 'auth', 'session.ts'), 'utf8');
const API_RETENTION_SWEEP = readFileSync(
  join(REPO, 'apps', 'api', 'src', 'maintenance', 'retention-sweep.ts'),
  'utf8',
);

/**
 * Evaluates a product of number literals such as `60 * 24 * 60 * 60` and refuses any other shape, so
 * a computed constant fails loudly instead of being read as another number. `_` separators are stripped.
 */
function constantProduct(source: string, name: string): number {
  const match = new RegExp(String.raw`\bconst ${name} = ([0-9_*\s]+);`, 'u').exec(source);
  assert.ok(
    match?.[1] !== undefined,
    `${name} must still be defined as a product of number literals. If it has become a computed ` +
      'expression, this test has to learn the new shape rather than be deleted — it is the only ' +
      'thing keeping /privacy and the code from disagreeing about a retention period.',
  );
  const factors = match[1].split('*').map((part) => Number(part.replace(/_/gu, '').trim()));
  assert.ok(
    factors.length > 0 && factors.every((value) => Number.isInteger(value) && value > 0),
    `${name} must be a product of positive integers, parsed ${JSON.stringify(factors)}`,
  );
  return factors.reduce((total, factor) => total * factor, 1);
}

/**
 * The number words `/privacy` uses. A miss must fail, because a `String(n)` fallback would let a
 * changed period pass while the page still says the old one.
 */
const NUMBER_WORDS: Readonly<Record<number, string>> = {
  1: 'one',
  6: 'six',
  10: 'ten',
  14: 'fourteen',
  24: 'twenty-four',
  60: 'sixty',
};

function word(value: number): string {
  const spelled = NUMBER_WORDS[value];
  assert.ok(
    spelled !== undefined,
    `a retention period changed to ${String(value)}, which /privacy has no wording for. Update the ` +
      'page and add the word here.',
  );
  return spelled;
}

/**
 * `/privacy` §5 against the session code. The page once said fourteen days "from when it was issued",
 * which is the idle window, while the real ceiling is `SESSION_ABSOLUTE_TTL_SECONDS` (sixty days).
 */
describe('the retention periods on /privacy are the ones the code implements', () => {
  const idleDays = constantProduct(API_SESSION_REPO, 'SESSION_TTL_SECONDS') / 86_400;
  const absoluteDays = constantProduct(API_SESSION_AUTH, 'SESSION_ABSOLUTE_TTL_SECONDS') / 86_400;
  const attemptMinutes = constantProduct(API_SESSION_REPO, 'OIDC_ATTEMPT_TTL_SECONDS') / 60;
  const sweepHours = constantProduct(API_RETENTION_SWEEP, 'DEFAULT_INTERVAL_MS') / 3_600_000;

  it('parsed real periods rather than nothing at all', () => {
    // A regex that stopped matching would otherwise compare zero against zero.
    assert.equal(idleDays, 14, 'the idle window is fourteen days');
    assert.equal(absoluteDays, 60, 'the absolute ceiling is sixty days');
    assert.equal(attemptMinutes, 10, 'a sign-in attempt lasts ten minutes');
    assert.equal(sweepHours, 6, 'the sweep runs every six hours');
    assert.ok(
      absoluteDays > idleDays,
      'the ceiling has to be longer than the idle window, or sliding the expiry means nothing and ' +
        'the page should be describing a fixed lifetime instead',
    );
  });

  it('states the idle window as an idle window, not as a lifetime', () => {
    const privacy = flat(read(...PAGES.privacy));
    assert.ok(
      privacy.includes(`${word(idleDays)} days from your last visit`),
      'the page must say the window runs from the last visit. "From when it was issued" is the ' +
        'wrong claim and it understates how long a session is kept.',
    );
  });

  it('states the absolute ceiling, which is the real longest a session is kept', () => {
    const privacy = flat(read(...PAGES.privacy));
    assert.ok(
      privacy.includes(`${word(absoluteDays)} days from creation`),
      `/privacy must name the ${String(absoluteDays)}-day ceiling from SESSION_ABSOLUTE_TTL_SECONDS`,
    );
    assert.ok(
      privacy.includes(`${word(absoluteDays)} days from when it was issued`),
      'and the cookie paragraph in section 3 must name it too, because that is where a reader who ' +
        'is asking "how long does this cookie last" actually looks',
    );
  });

  it('states the sweep interval and the sign-in window the code uses', () => {
    const privacy = flat(read(...PAGES.privacy));
    assert.ok(privacy.includes(`every ${word(sweepHours)} hours`), 'the sweep interval must match');
    // The first sweep is a separate constant from the interval, and the page states both.
    const firstSweepMinutes = constantProduct(API_RETENTION_SWEEP, 'FIRST_SWEEP_DELAY_MS') / 60_000;
    assert.equal(firstSweepMinutes, 1, 'the first sweep runs a minute after start');
    assert.ok(
      privacy.includes('runs a minute after it starts'),
      '/privacy must state when the FIRST sweep runs, not only the interval between sweeps',
    );
    assert.ok(
      privacy.includes(`${word(attemptMinutes)} minutes`),
      'the sign-in attempt window must match OIDC_ATTEMPT_TTL_SECONDS',
    );
  });

  it('does not describe a row as gone at the moment it merely stops working', () => {
    // The sweep removes a row, so a row outlives its expiry by up to one sweep interval.
    const privacy = flat(read(...PAGES.privacy));
    assert.match(
      privacy,
      /up to six hours/u,
      'the page must say how long a row can outlive the moment it stopped being usable',
    );
  });

  it('says that deletion does not reach backups', () => {
    // Backups are the one place erasure cannot reach, so the deletion section must say so.
    const privacy = flat(read(...PAGES.privacy));
    assert.match(privacy, /backups/iu, 'section 6 must account for backups');
    assert.match(privacy, /six months/u, 'and for how long the shipped backup policy keeps one');
  });
});

describe('the detectors catch a real violation', () => {
  it('catches a clause whose marker has been removed from a page', () => {
    const real = read(...PAGES.terms);
    const clause = COUNSEL_CLAUSES['governing-law'];
    assert.equal(rendersClause(real, clause.id), true, 'the real page renders it');

    const tampered = real.replace(`COUNSEL_CLAUSES['${clause.id}']`, '');
    assert.equal(
      rendersClause(tampered, clause.id),
      false,
      'a page with the clause deleted must be detected as missing it',
    );
  });

  it('catches a clause id that is only nearly right', () => {
    const real = read(...PAGES.terms);
    const tampered = real.replace("COUNSEL_CLAUSES['governing-law']", "COUNSEL_CLAUSES['governing_law']");
    assert.equal(rendersClause(tampered, 'governing-law'), false, 'a typo must not pass as a match');
  });

  it('catches a page that stopped explaining the marker', () => {
    const explains = (source: string): boolean => /COUNSEL_MARKER_EXPLANATION/u.test(source);
    assert.equal(explains(read(...PAGES.privacy)), true);
    assert.equal(explains('<p>Some prose with no marker anywhere in it.</p>'), false);
  });

  it('catches a table that the inventory does not mention', () => {
    const inventoryMentions = (privacy: string, table: string): boolean => privacy.includes(`prl.${table}`);
    const privacy = read(...PAGES.privacy);
    assert.equal(inventoryMentions(privacy, 'quiz_attempts'), true, 'a real table is found');
    assert.equal(
      inventoryMentions(privacy, 'payment_methods'),
      false,
      'a table nobody documented must be reported as missing',
    );
  });

  it('catches a review document that has lost a clause', () => {
    const missing = REVIEW_DOC.replace(/governing-law/gu, '');
    assert.equal(missing.includes('governing-law'), false, 'the detector fires on the tampered copy');
    assert.equal(REVIEW_DOC.includes('governing-law'), true, 'and not on the real one');
  });

  it('catches a softened play-money warning', () => {
    const strong = (text: string): boolean => text.includes('does not mean you would play well');
    assert.equal(strong(PLAY_MONEY_WARNING), true);
    assert.equal(
      strong('Practising here is great preparation for playing at a real table.'),
      false,
      'the assertion must reject a warning that has become an endorsement',
    );
  });

  it('catches the retention sentence that was actually wrong', () => {
    // The sentence that shipped. Fourteen days is the idle window, not the session's lifetime.
    const describesLifetime = (text: string): boolean => text.includes('fourteen days from your last visit');
    assert.equal(
      describesLifetime('A session lasts fourteen days from when it was issued.'),
      false,
      'the sentence that shipped must be rejected',
    );
    assert.equal(
      describesLifetime('A session lasts fourteen days from your last visit.'),
      true,
      'and the corrected one accepted',
    );
    assert.equal(describesLifetime(flat(read(...PAGES.privacy))), true, 'as the real page is');
  });

  it('catches a page that names the idle window but not the ceiling', () => {
    // The half-fix, which corrects the idle wording and leaves the longest period unstated.
    const namesCeiling = (text: string): boolean => text.includes('sixty days from creation');
    assert.equal(
      namesCeiling('A session lasts fourteen days from your last visit.'),
      false,
      'a page with no ceiling must be reported as missing it',
    );
    assert.equal(namesCeiling(flat(read(...PAGES.privacy))), true);
  });

  it('catches a constant that has stopped being a product of literals', () => {
    // A parser that returned NaN or 0 here would make every period assertion pass for the wrong reason.
    assert.equal(constantProduct('const X = 60 * 24 * 60 * 60;', 'X'), 5_184_000);
    assert.equal(constantProduct('const Y = 6 * 60 * 60 * 1_000;', 'Y'), 21_600_000);
    assert.throws(
      () => constantProduct('const Z = DAYS * secondsIn(DAY);', 'Z'),
      /must still be defined as a product of number literals/u,
      'a computed expression must fail loudly rather than be read as some other number',
    );
    assert.throws(
      () => constantProduct('const A = 1;', 'MISSING'),
      /must still be defined as a product of number literals/u,
      'and a constant that has been renamed away must not pass silently',
    );
  });

  it('catches a period whose wording nobody added', () => {
    assert.equal(word(60), 'sixty');
    assert.throws(
      () => word(90),
      /which \/privacy has no wording for/u,
      'a period the page has never been told about must fail rather than be spelled numerically',
    );
  });

  it('scanned a real, non-empty set of pages', () => {
    assert.equal(PAGE_KEYS.length, 3);
    for (const page of PAGE_KEYS) {
      assert.ok(read(...PAGES[page]).length > 2_000, `${page} must be a real document, not a stub`);
    }
    assert.ok(COUNSEL_MARKER_EXPLANATION.length > 100);
  });
});

/**
 * What `/terms` says about money and what `db/migrations` creates must agree, in both directions.
 * An enrolment record does not show that money changed hands (a scholarship cohort writes the same
 * rows), so `/terms` takes one of two postures:
 *  * free-of-charge. The page says so, and no migration creates an entitlement table.
 *  * enrolment-aware. The page drops that claim, says what an enrolment record holds and that it
 *    implies nothing about money, and flags both commercial clauses for counsel. A migration must
 *    then create the record the page describes.
 * Conditional rather than an allowlist entry, so deleting the disclosure re-arms the table detector.
 * Money dependencies, money table names and money calls in source fail in every posture.
 */
describe('what /terms says about money, and the absence of a payment path', () => {
  /**
   * Word boundaries, because `sepa` is inside `separate` and a CSS hatch pattern is made of stripes.
   * `splitIdentifiers` runs first, because a word boundary cannot fall inside a camelCase identifier.
   */
  const PAYMENT_WORDS =
    /\b(stripe|braintree|adyen|paypal|payments?|checkout|invoices?|billing|merchant|iban|cardholder|paywall|subscribe_?to_?plan)\b/iu;

  /**
   * Table names that mean money moved. Forbidden in every posture, and never given an exception.
   * Matched on the split name, so `fee` and `card` need a word boundary and `prl.discards` and
   * `prl.coffee_breaks` pass. An adversarial review found seven money table names this once accepted.
   * The negative control below pins them and re-checks every real table against this pattern.
   */
  const MONEY_TABLE =
    /\b(payment|purchase|order|invoice|billing|receipt|refund|price|charge|checkout|transaction|wallet|ledger|subscription)|\b(fees?|tuitions?|amounts?|currenc(y|ies)|cards?|costs?|balances?|credits?|remittances?|stripe|paypal|braintree|adyen|merchants?|iban)\b/iu;

  /**
   * Table names that mean somebody holds an entitlement. Forbidden unless `/terms` says so.
   * Kept apart from `MONEY_TABLE`, because an entitlement is not a purchase.
   */
  const ENTITLEMENT_TABLE = /\b(enrolment|enrollment|entitlement|cohort|admission|licen[cs]e)/iu;

  /**
   * Reviewed, benign matches of `PAYMENT_WORDS`, keyed by repo-relative path. An entry is a claim that
   * a human looked, and one that no longer matches anything fails below. `app/terms/page.tsx` and
   * `lib/legal-config.ts` make the same denial as `/privacy` without the scanned words, so they stay
   * in reach.
   */
  const ALLOWED: ReadonlyArray<readonly [string, string]> = [
    ['apps/web/src/app/privacy/page.tsx', 'the page denying that payment details are held'],
    ['apps/web/src/fixtures/learn-glossary.ts', 'the glossary definition of an ante'],
    ['packages/ui/src/styles/tokens.css', 'a typography note citing Stripe as a reference'],
    ['packages/ui/src/styles/components.css', 'a hatch pattern drawn from stripes'],
  ];

  /** Spaces at camelCase transitions, so a word boundary exists to match. */
  const splitIdentifiers = (source: string): string => source.replace(/([a-z0-9])([A-Z])/gu, '$1 $2');

  /**
   * A table name as space-separated words (`prl.course_fees` -> `prl course fees`), because `_` is a
   * word character and a word boundary cannot fall inside snake_case. Kept apart from
   * `splitIdentifiers`, which must leave underscores intact for one `PAYMENT_WORDS` entry.
   */
  const splitTableName = (table: string): string => splitIdentifiers(table).replace(/[_.]/gu, ' ');

  const sourceFiles = (root: string): readonly string[] =>
    readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((entry) =>
      /\.(ts|tsx|css|sql)$/u.test(entry),
    );

  /**
   * Every workspace `src` tree, as `[repo-relative label, absolute path]`. An adversarial review got a
   * money SDK into `packages/ui` past a scan of the app roots alone. `packages/<name>/src` rather than
   * `packages`, which would descend into `node_modules` and `dist`. Enumerated, so a new package is
   * scanned the day it lands.
   */
  const SOURCE_ROOTS: ReadonlyArray<readonly [string, string]> = [
    ['apps/web/src', SRC],
    ['apps/api/src', resolve(REPO, 'apps', 'api', 'src')],
    ...readdirSync(join(REPO, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => [`packages/${entry.name}/src`, join(REPO, 'packages', entry.name, 'src')] as const)
      .filter(([, dir]) => existsSync(dir)),
  ];

  /** The whole of the free-of-charge posture. */
  const FREE_OF_CHARGE = /This service is provided free of charge/u;

  /**
   * Four named sentences, because the dangerous state is the half rewrite that keeps "an enrolment
   * exists" and drops "it implies nothing about money". Matched against `flat()`, because this is prose.
   */
  const ENROLMENT_DISCLOSURES: ReadonlyArray<readonly [string, RegExp]> = [
    [
      'that the software cannot take money and cannot tell a paying reader from any other',
      /cannot take money, and it cannot tell whether you paid/u,
    ],
    [
      'that no column can hold a price — the checkable half, and the one a reader can verify',
      /no column anywhere in its database that could hold an amount, a currency or a price/u,
    ],
    [
      'that an enrolment record is not evidence of a fee — a scholarship cohort produces the same rows',
      /An enrolment record is not evidence that money changed hands/u,
    ],
    [
      'that what the place cost, and what it bought, are outside this software rather than stated here',
      /are all outside this software, and this page would be inventing them/u,
    ],
  ];

  /** The two clauses the enrolment-aware posture must hand to counsel rather than assert. */
  const ENROLMENT_CLAUSES: readonly CounselClauseId[] = ['enrolment-and-fees', 'refunds-and-cancellation'];

  interface MoneyPosture {
    /** True while the page still makes the unconditional free-of-charge claim. */
    readonly claimsFree: boolean;
    readonly discloses: readonly string[];
    readonly missing: readonly string[];
    readonly flagged: readonly CounselClauseId[];
    readonly unflagged: readonly CounselClauseId[];
  }

  /**
   * Comments stripped first, because the `app/terms/page.tsx` header quotes the replaced clause and the
   * posture reader once read that quotation as a live claim.
   */
  const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//gu, ' ');

  function readMoneyPosture(termsSource: string): MoneyPosture {
    const document = withoutComments(termsSource);
    const prose = flat(document);
    const discloses: string[] = [];
    const missing: string[] = [];
    for (const [name, pattern] of ENROLMENT_DISCLOSURES) {
      (pattern.test(prose) ? discloses : missing).push(name);
    }
    const flagged = ENROLMENT_CLAUSES.filter((id) => rendersClause(document, id));
    return {
      claimsFree: FREE_OF_CHARGE.test(prose),
      discloses,
      missing,
      flagged,
      unflagged: ENROLMENT_CLAUSES.filter((id) => !flagged.includes(id)),
    };
  }

  const POSTURE = readMoneyPosture(read(...PAGES.terms));

  /** Only a complete enrolment-aware page counts, so a half rewrite cannot unlock the detector. */
  const ENROLMENT_AWARE =
    !POSTURE.claimsFree && POSTURE.missing.length === 0 && POSTURE.unflagged.length === 0;

  it('/terms takes one of the two honest positions on money, and takes it whole (TRIPWIRE)', () => {
    assert.ok(ENROLMENT_DISCLOSURES.length === 4, 'the disclosure list must not have quietly emptied');
    if (POSTURE.claimsFree) {
      assert.deepEqual(
        POSTURE.discloses,
        [],
        '/terms says the service is provided free of charge AND describes an enrolment record. Those ' +
          'are two different positions and a reader cannot be shown both: either the deployment ' +
          'enrols people, in which case drop the free-of-charge claim, or it does not, in which case ' +
          'drop the enrolment paragraphs.',
      );
      assert.deepEqual(
        POSTURE.flagged,
        [],
        '/terms still claims the service is free while flagging the enrolment clauses for counsel',
      );
    } else {
      assert.deepEqual(
        POSTURE.missing,
        [],
        '/terms has stopped saying the service is provided free of charge without saying what ' +
          'replaced it. The enrolment-aware posture is these sentences together; a page carrying ' +
          'some of them is the half-rewrite this group exists to catch. Missing: ' +
          POSTURE.missing.join('; '),
      );
      assert.deepEqual(
        POSTURE.unflagged,
        [],
        'a /terms that describes enrolment must hand the commercial half to counsel rather than ' +
          'assert it. Unflagged: ' +
          POSTURE.unflagged.join(', '),
      );
    }
    assert.equal(
      ENROLMENT_AWARE,
      !POSTURE.claimsFree,
      'the two postures must be exhaustive and exclusive; if this fails the detectors below are ' +
        'keyed to a page that says neither thing, and are guarding nothing',
    );
  });

  it('no dependency that moves money has been added (TRIPWIRE)', () => {
    // Every workspace manifest. An adversarial review added a money SDK to `packages/ui` unseen.
    const manifests = [
      'package.json',
      'apps/api/package.json',
      'apps/web/package.json',
      ...readdirSync(join(REPO, 'packages'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `packages/${entry.name}/package.json`)
        .filter((path) => existsSync(join(REPO, path))),
    ];
    assert.ok(manifests.length >= 9, `only ${manifests.length} manifests were found; the sweep is short`);
    let scanned = 0;
    for (const manifest of manifests) {
      const parsed = JSON.parse(readFileSync(join(REPO, manifest), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const names = [...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})];
      scanned += names.length;
      for (const name of names) {
        assert.doesNotMatch(
          splitIdentifiers(name),
          PAYMENT_WORDS,
          `${manifest} depends on "${name}". Recording an enrolment does not need one of these, and ` +
            'this assertion holds in every posture: if this deployment now takes money, the terms ' +
            'have to say what was bought and what is owed for it, and neither /terms nor anybody ' +
            'here has written that.',
        );
      }
    }
    assert.ok(scanned > 20, 'no dependencies were read; the scan proved nothing');
  });

  it('no table that records a purchase has been created (TRIPWIRE)', () => {
    const migrations = readdirSync(join(REPO, 'db', 'migrations')).filter((name) => name.endsWith('.sql'));
    assert.ok(migrations.length >= 5, 'no migrations were read; the scan proved nothing');
    // Names which way the page falls short, so the failure message is not misleading.
    const shortfall = POSTURE.claimsFree
      ? 'The clause still tells the reader the service is provided free of charge, and promises them ' +
        'no availability, no data survival and no notice before it is taken down.'
      : `The clause has stopped saying the service is free without finishing the job. Missing prose: ${
          POSTURE.missing.join('; ') || 'none'
        }. Clauses described but not handed to counsel: ${POSTURE.unflagged.join(', ') || 'none'}.`;
    for (const name of migrations) {
      const sql = readFileSync(join(REPO, 'db', 'migrations', name), 'utf8');
      for (const [, table] of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w.]+)/giu)) {
        const split = splitTableName(table ?? '');
        assert.doesNotMatch(
          split,
          MONEY_TABLE,
          `${name} creates "${table}". A table that records a charge means somebody is being billed ` +
            'through this system, which is a different fact from somebody holding a place in a ' +
            'course, and no wording on /terms unlocks it. This assertion is unconditional.',
        );
        if (!ENROLMENT_AWARE) {
          assert.doesNotMatch(
            split,
            ENTITLEMENT_TABLE,
            `${name} creates "${table}", and /terms is not honest about it. ${shortfall} That is a ` +
              'reasonable thing to say to somebody who was given the service for nothing, and not to ' +
              'somebody who holds a place in a course. Rewrite §7 and §8; do not exempt the table.',
          );
        }
      }
    }
  });

  it('/terms and db/migrations agree about whether enrolment exists (TRIPWIRE)', () => {
    const tables = schemaTables();
    assert.ok(
      tables.length > 8,
      `only ${String(tables.length)} tables were scanned; the sweep proved nothing`,
    );
    const entitlement = tables.filter((table) => ENTITLEMENT_TABLE.test(splitTableName(table)));
    assert.equal(
      ENROLMENT_AWARE,
      entitlement.length > 0,
      ENROLMENT_AWARE
        ? '/terms describes an enrolment record and NO migration in db/migrations creates one. A ' +
            'factual claim on a legal page about what the software stores has to be true of the ' +
            'schema, and this one is not. Either the migration was reverted and §7 has to go back to ' +
            'the free-of-charge position, or it never landed.'
        : `db/migrations creates ${entitlement.map((table) => `prl.${table}`).join(', ')} while /terms ` +
            'is still in the free-of-charge posture. This is the drift the whole group exists to ' +
            'prevent, read from the other end.',
    );
  });

  it('no source file has grown a payment path (TRIPWIRE)', () => {
    const allowed = new Map(ALLOWED);
    const seen = new Set<string>();
    let scanned = 0;
    assert.ok(SOURCE_ROOTS.length >= 8, `only ${SOURCE_ROOTS.length} source roots; the sweep is short`);
    for (const [label, root] of SOURCE_ROOTS) {
      for (const relative of sourceFiles(root)) {
        const full = join(root, relative);
        scanned += 1;
        if (!PAYMENT_WORDS.test(splitIdentifiers(readFileSync(full, 'utf8')))) continue;
        const key = `${label}/${relative.split(/[\\/]/u).join('/')}`;
        assert.ok(
          allowed.has(key),
          `${key} uses the vocabulary of a money-moving integration and is not on the reviewed ` +
            'list. Recording an enrolment needs none of these words. If a real one has been added, ' +
            'the terms have to say what was bought and what is owed for it, and they do not — that ' +
            'is a clause for counsel, not an entry on ALLOWED. If instead this is prose DENYING that ' +
            'money is taken, either reword it as app/terms/page.tsx and lib/legal-config.ts do, or ' +
            'add it to ALLOWED with the reason a human checked.',
        );
        seen.add(key);
      }
    }
    // No skip here. A `startsWith('../')` skip once hid the two entries that matched nothing.
    for (const [relative] of ALLOWED) {
      assert.ok(seen.has(relative), `${relative} is exempted but no longer matches; drop the exemption`);
    }
    assert.ok(scanned > 50, `only ${scanned} files were scanned; the sweep proved nothing`);
  });

  it('each tripwire fires on a synthetic violation (NEGATIVE CONTROL)', () => {
    // Without this, the group passes on a detector that can no longer see anything.
    assert.match(splitIdentifiers('@stripe/stripe-js'), PAYMENT_WORDS, 'a payment SDK must be recognised');
    assert.match(splitTableName('prl.payments'), MONEY_TABLE, 'a payment table');
    assert.match(
      splitIdentifiers('const session = await createCheckoutSession();'),
      PAYMENT_WORDS,
      'a camelCase payment call must be recognised: this is the spelling a real integration uses, ' +
        'and the boundary-only version of this regex could not see it',
    );
    // Near misses that must not fire.
    assert.doesNotMatch(splitIdentifiers('a separate concern'), PAYMENT_WORDS, '"separate" holds "sepa"');
    assert.doesNotMatch(
      splitIdentifiers('one table subscription per room'),
      PAYMENT_WORDS,
      'a socket subscription is not a payment plan',
    );
  });

  it('a money table is refused in BOTH postures, and an entitlement table only in one (NEGATIVE CONTROL)', () => {
    // Rewriting /terms unlocks an entitlement table and nothing else, so the patterns must not overlap.
    for (const table of ['prl.payments', 'prl.orders', 'prl.course_invoices', 'prl.unit_ledger']) {
      assert.match(splitTableName(table), MONEY_TABLE, `${table} must be refused whatever /terms says`);
      assert.doesNotMatch(splitTableName(table), ENTITLEMENT_TABLE, `${table} is not an entitlement`);
    }
    for (const table of ['prl.enrolments', 'prl.enrollments', 'prl.cohorts', 'prl.entitlements']) {
      assert.match(splitTableName(table), ENTITLEMENT_TABLE, `${table} must be seen`);
      assert.doesNotMatch(
        splitTableName(table),
        MONEY_TABLE,
        `${table} must not be read as a purchase - it is the distinction the whole rewrite rests on`,
      );
    }
    // The snake_case miss from the first draft, reproduced and then closed by `splitTableName`.
    assert.doesNotMatch(splitIdentifiers('prl.course_invoices'), MONEY_TABLE, 'the miss, reproduced');
    assert.match(splitTableName('prl.course_invoices'), MONEY_TABLE, 'and the fix that closes it');

    /*
     * Names an adversarial review found this detector accepting (REGRESSION). `prl.enrolment_fees` also
     * matches ENTITLEMENT_TABLE, so an honest `/terms` once unlocked it.
     */
    for (const table of [
      'prl.fees',
      'prl.enrolment_fees',
      'prl.tuition',
      'prl.amounts_due',
      'prl.currencies',
      'prl.card_details',
      'prl.stripe_customers',
      'prl.balances',
      'prl.credits',
      'prl.remittances',
    ]) {
      assert.match(
        splitTableName(table),
        MONEY_TABLE,
        `${table} names money and this detector accepted it. /terms tells a reader there is "no ` +
          'column anywhere in its database that could hold an amount, a currency or a price"; a ' +
          'table called this makes that sentence false.',
      );
    }
    // Names that merely contain a money word must not fire, or the detector gets switched off.
    for (const table of ['prl.discards', 'prl.coffee_breaks', 'prl.scorecards_v2', 'prl.hand_seats']) {
      assert.doesNotMatch(splitTableName(table), MONEY_TABLE, `${table} is not a purchase`);
    }
    const tables = schemaTables();
    assert.ok(tables.length > 8);
    for (const table of tables.filter((name) => !ENTITLEMENT_TABLE.test(splitTableName(name)))) {
      assert.doesNotMatch(
        splitTableName(table),
        MONEY_TABLE,
        `prl.${table} is a real table in this schema and the money detector claims it is a purchase`,
      );
    }
  });

  it('the posture reader rejects a /terms that says the wrong thing (NEGATIVE CONTROL)', () => {
    // Each fixture mutates the real page, so it cannot drift into agreeing with a broken detector.
    const real = read(...PAGES.terms);
    assert.equal(
      ENROLMENT_AWARE,
      readMoneyPosture(real).claimsFree === false,
      'the real page, as a baseline',
    );

    // 1. The old clause, with the enrolment record in the schema.
    const stillFree = readMoneyPosture(
      '<h2>7. Availability</h2><p>This service is provided free of charge and with no promise that ' +
        'it will be available, that your data will survive, or that any particular feature will ' +
        'continue to exist.</p>',
    );
    assert.equal(stillFree.claimsFree, true, 'the shipped sentence must still be recognised');
    assert.equal(stillFree.missing.length, ENROLMENT_DISCLOSURES.length, 'and carries no disclosure');
    assert.equal(stillFree.flagged.length, 0);

    // 2. The half rewrite, which drops the sentence saying an enrolment implies nothing about money.
    const halfway = readMoneyPosture(
      real.replace('An enrolment record is not evidence that money changed hands', 'Enrolment is recorded'),
    );
    assert.equal(halfway.claimsFree, false);
    assert.equal(halfway.missing.length, 1, 'exactly the deleted disclosure must be reported missing');
    assert.ok(
      halfway.missing[0]?.includes('scholarship cohort'),
      `the failure must name the claim that went missing, got ${JSON.stringify(halfway.missing)}`,
    );

    // 3. The counsel flag dropped, with the prose intact.
    const unflagged = readMoneyPosture(real.replace("COUNSEL_CLAUSES['refunds-and-cancellation']", ''));
    assert.deepEqual(unflagged.unflagged, ['refunds-and-cancellation']);
    assert.equal(unflagged.missing.length, 0, 'the prose is untouched; only the flag went');

    // 4. Both at once — a page that says the service is free AND describes enrolment.
    const both = readMoneyPosture(`${real}<p>This service is provided free of charge.</p>`);
    assert.equal(both.claimsFree, true);
    assert.ok(both.discloses.length > 0, 'and the contradiction is visible to the reader, not inferred');
  });
});

/**
 * The guest retention period on `/privacy` must be the code's. Only a session cookie can reach a
 * guest, so sixty days unseen (`SESSION_ABSOLUTE_TTL_SECONDS`) is the shortest period after which no
 * credential can. The test asserts that derivation, not 5,184,000, so the two cannot drift apart.
 */
describe('the guest retention promise on /privacy', () => {
  const SWEEP_SOURCE = readFileSync(
    resolve(REPO, 'apps', 'api', 'src', 'maintenance', 'retention-sweep.ts'),
    'utf8',
  );

  it('is still derived from the session ceiling, not a number somebody chose (REGRESSION)', () => {
    assert.match(
      SWEEP_SOURCE,
      /export const GUEST_RETENTION_SECONDS = SESSION_ABSOLUTE_TTL_SECONDS;/u,
      'GUEST_RETENTION_SECONDS is no longer the session ceiling. If that is deliberate, the derivation ' +
        'argument in retention-sweep.ts and the paragraph on /privacy both have to be rewritten — the ' +
        'period is only defensible as "every credential that could reach this account is already dead".',
    );
  });

  it('names that period on the page, in words, as the code computes it', () => {
    const days = constantProduct(API_SESSION_AUTH, 'SESSION_ABSOLUTE_TTL_SECONDS') / 86_400;
    // Lowercased, because the phrase opens a sentence on the page.
    const privacy = flat(read(...PAGES.privacy)).toLowerCase();
    assert.ok(
      privacy.includes(`${word(days)} days after a guest account was last seen`),
      `/privacy must say guests are erased ${word(days)} days after they were last seen`,
    );
  });

  it('states the liveness guarantee, which is the part a reader is owed', () => {
    // "Sixty days unseen" alone reads as a countdown that could reach a live account.
    const privacy = flat(read(...PAGES.privacy));
    assert.match(
      privacy,
      /never while a session is still live/u,
      '/privacy must say the sweep never takes an account with a live session',
    );
    assert.match(
      privacy,
      /seat at a table, a place in a room, or a room of its own/u,
      '/privacy must say what else protects an account from the sweep',
    );
  });

  /**
   * Counted from the predicate, not from a known list, because the failure is a clause being added.
   * 0006 made enrolments cascade on delete, the predicate gained a fifth clause, and the page listed four.
   */
  it('names every protection the predicate actually implements', () => {
    const users = readFileSync(resolve(REPO, 'apps', 'api', 'src', 'repositories', 'users.ts'), 'utf8');
    const start = users.indexOf('function abandonedGuestPredicate');
    assert.ok(start > 0, 'abandonedGuestPredicate has moved or been renamed; this assertion needs it');
    const predicate = users.slice(start, users.indexOf('}', users.indexOf('`;', start)));
    const guarded = [...predicate.matchAll(/from prl\.(\w+)/gu)].map((match) => match[1] ?? '');
    assert.ok(guarded.length >= 4, `the predicate scanned as ${JSON.stringify(guarded)}; that is not it`);

    // A table with no phrase fails on purpose, so somebody writes the sentence.
    const PHRASES: Readonly<Record<string, RegExp>> = {
      sessions: /never while a session is still live/u,
      room_members: /a place in a room/u,
      hand_seats: /seat at a table/u,
      rooms: /a room of its own/u,
      enrolments: /never while it holds a place in a class/u,
    };
    const privacy = flat(read(...PAGES.privacy));
    for (const table of guarded) {
      const phrase = PHRASES[table];
      assert.ok(
        phrase !== undefined,
        `the sweep now spares an account because of prl.${table}, and /privacy has no wording for ` +
          'it. That is a promise to a reader about when their account is safe, so the page has to ' +
          'learn the new one rather than this test learning to ignore it.',
      );
      assert.match(privacy, phrase, `/privacy must say that prl.${table} protects an account`);
    }
  });

  it('catches a protection the page has not learned about (NEGATIVE CONTROL)', () => {
    const scan = (predicate: string): readonly string[] =>
      [...predicate.matchAll(/from prl\.(\w+)/gu)].map((match) => match[1] ?? '');
    assert.deepEqual(
      scan('and not exists (select 1 from prl.enrolments e) and not exists (select 1 from prl.trophies t)'),
      ['enrolments', 'trophies'],
      'the scan must see both clauses',
    );
    assert.deepEqual(scan("u.kind = 'guest'"), [], 'and see nothing where there is nothing');
  });

  it('catches a page that promises erasure on the wrong period (NEGATIVE CONTROL)', () => {
    // Without this, the two assertions above pass against any `includes` that always returned true.
    const days = constantProduct(API_SESSION_AUTH, 'SESSION_ABSOLUTE_TTL_SECONDS') / 86_400;
    const wrong = 'Guests are erased thirty days after a guest account was last seen.';
    assert.equal(
      wrong.includes(`${word(days)} days after a guest account was last seen`),
      false,
      'a page naming the wrong period must not satisfy the check',
    );
  });
});
