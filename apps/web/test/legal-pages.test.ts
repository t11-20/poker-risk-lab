/**
 * The three legal documents: that the required disclosures are on them, that every clause a lawyer
 * still has to write carries the marker, and that the register, the pages and the review document
 * cannot drift apart.
 *
 * ## The defect these exist for
 *
 * There were no legal pages. What replaced that absence is a set of documents whose factual half is
 * checked against the schema and whose legal half is **placeholder text written by engineers**. The
 * whole value of the page depends on a reader being able to tell those halves apart, and that
 * distinction lives in prose — which is exactly the sort of thing that is quietly lost when
 * somebody tidies a page, deletes a paragraph that "reads like a disclaimer", or adds a clause and
 * forgets the marker.
 *
 * The failure mode is specific and bad: a deployer reads the terms, sees no marker, and ships a
 * governing-law clause that nobody qualified has ever looked at.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Yes, and each detector below is fed a real violation to prove it fires — see the negative-control
 * group at the end, which runs the same detectors over synthetic documents with the marker removed,
 * a clause dropped, and a table missing from the inventory, and asserts each one is caught.
 *
 * Every scan also asserts it read a non-empty set. A detector that silently scanned nothing is the
 * other way a guard like this passes for the wrong reason: `readdirSync` on a renamed directory, a
 * glob that stopped matching, a constant that became an empty array.
 *
 * ## What is asserted here, and what deliberately is not
 *
 * This does not judge whether a clause is legally sound — no test can, which is the entire premise
 * of the register. It asserts three mechanical properties:
 *
 *  1. **Coverage.** Every clause in `COUNSEL_CLAUSES` is rendered on each page it claims, and every
 *     clause rendered on a page is in the register.
 *  2. **Correspondence.** Every clause in the register appears in
 *     `docs/production/legal-review-requirements.md`, so the lawyer's list and the reader's page
 *     cannot disagree about what is outstanding.
 *  3. **Completeness of the inventory.** Every table `db/migrations` creates is named on `/privacy`.
 *     A new migration adding a table that holds something about a reader now fails this file, which
 *     is the one moment somebody is thinking about that table.
 *
 * `apps/web` has no component-render harness — its tests run under `node --test` with no DOM and no
 * JSX transform — so these are assertions over source text, which is the established pattern here
 * and `live-regions.test.ts` says so openly.
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
 * Source with every run of whitespace collapsed to one space.
 *
 * Every assertion about a SENTENCE goes through this. JSX prose is reflowed to the 110-column line
 * width by the formatter, so "no date of birth is stored" is one line today and split across two
 * after the next unrelated edit widens the paragraph above it. A test that fails because a
 * formatter moved a word is a test people learn to delete, and the property being asserted has
 * nothing to do with where the line breaks fall.
 *
 * Assertions about CODE — a constant's name, a clause key — are matched against the raw source,
 * where the exact spelling is the point.
 */
const flat = (source: string): string => source.replace(/\s+/gu, ' ');

/** The three documents, and where each one's source lives. */
const PAGES: Readonly<Record<LegalPageKey, readonly string[]>> = {
  terms: ['app', 'terms', 'page.tsx'],
  privacy: ['app', 'privacy', 'page.tsx'],
  'responsible-use': ['app', 'responsible-use', 'page.tsx'],
};

const PAGE_KEYS = Object.keys(PAGES) as readonly LegalPageKey[];

const REVIEW_DOC = readFileSync(join(REPO, 'docs', 'production', 'legal-review-requirements.md'), 'utf8');

/**
 * How a page renders a clause: `COUNSEL_CLAUSES['<id>']`, passed to the local `CounselFlag`.
 *
 * A source-text detector rather than a rendered one, for the reason in the header. It is specific
 * enough to be meaningful — the id has to be the exact key, so a typo is a failure rather than a
 * near miss — and the negative control below proves it discriminates.
 */
function rendersClause(source: string, id: CounselClauseId): boolean {
  return source.includes(`COUNSEL_CLAUSES['${id}']`);
}

/** Every clause id a page's source names, in register order. */
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
      // Written as a question so an answer is a thing somebody can be shown to have given.
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
      // Both come from `legal-config.ts` rather than being typed into the page, so the three pages
      // cannot end up marking the same thing with three different words.
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
    // ADR 0011's whole design rests on `archetype` being what a deployer gets by not thinking about
    // it. The document is where that instruction is written down for the person who deploys.
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
    // The single most important sentence in the product's honesty, and the one most likely to be
    // softened by somebody improving the copy. It is a constant so this assertion is possible.
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
    // The non-impersonation language ADR 0011 requires, in the reader-facing document.
    assert.match(terms, /not real people, not digital copies of anybody, and not endorsed by anyone/u);
  });

  it('the privacy page says what deletion removes, detaches and keeps', () => {
    const privacy = flat(read(...PAGES.privacy));
    for (const word of ['Removed', 'Detached from you', 'Kept, in full']) {
      assert.ok(privacy.includes(word), `the deletion section must state what is ${word}`);
    }
  });

  it('the privacy page describes the browser storage this product actually uses', () => {
    // Every key named here exists in the source. If one is renamed and this page is not, the page
    // is describing storage that is not there — which is the quiet way a data inventory rots.
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
    // A privacy policy that can only be read by somebody who has already declared something about
    // themselves is not a privacy policy. Asserted against the gate's own path list.
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
    // A document nothing links to is a document nobody reads, and that was the state before this:
    // the pages did not exist, so the absence was invisible.
    const footer = read('components', 'SiteFooter.tsx');
    assert.match(footer, /DOCUMENT_DESTINATIONS/u, 'the footer renders the document list');

    // The list itself takes its hrefs from `LEGAL_PATHS` rather than repeating the strings, which
    // is what makes a rename one edit instead of three. So this checks the reference, and the
    // paths themselves are checked where they are defined.
    const nav = read('lib', 'nav.ts');
    assert.match(nav, /import \{ LEGAL_PATHS \} from '\.\/legal-config\.ts'/u);
    for (const key of Object.keys(LEGAL_PATHS)) {
      assert.ok(nav.includes(`LEGAL_PATHS.${key}`), `DOCUMENT_DESTINATIONS must include ${key}`);
    }
    assert.equal(Object.keys(LEGAL_PATHS).length, 3);
  });

  it('leaves NAV_DESTINATIONS at the five it argues for', () => {
    // `/record`'s precedent: the five numbered destinations are an argument about learning order,
    // and an entry that is not a step in it blunts the argument. A sixth appearing here is a
    // product decision, and this assertion is where it gets noticed.
    const nav = read('lib', 'nav.ts');
    // Both anchors are the `export const` line rather than the bare name: the module comment above
    // mentions `DOCUMENT_DESTINATIONS` by name, and slicing to that produced an empty block that
    // asserted nothing.
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
    // Two navigation landmarks sharing a name is the `landmark-unique` failure, and a rotor
    // listing "Sections" twice tells a reader nothing about which is which.
    const footer = read('components', 'SiteFooter.tsx');
    assert.match(footer, /aria-label="Sections"/u);
    assert.match(footer, /aria-label="Documents"/u);
    const labels = [...footer.matchAll(/aria-label="([^"]+)"/gu)].map((match) => match[1]);
    assert.ok(labels.length >= 2);
    assert.equal(new Set(labels).size, labels.length, 'every landmark in the footer needs its own name');
  });
});

/**
 * Every `CREATE TABLE prl.x` in `db/migrations`, which is the set `/privacy` has to account for.
 *
 * `prl.schema_migrations` is excluded: it is the migration ledger, it holds nothing about a
 * reader, and the runtime role is granted nothing on it at all.
 *
 * At module scope rather than inside the inventory group because the payment tripwire below needs
 * the same set, and two scanners over the same directory drift: the day one learns a new statement
 * shape and the other does not, one of them starts passing over a table nobody is looking at.
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
    // The non-empty-set assertion. A renamed directory or a changed statement shape would otherwise
    // leave this file passing over nothing at all.
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

// ---------------------------------------------------------------------------
// Retention periods: the page against the constants
// ---------------------------------------------------------------------------

/**
 * The API source files that decide how long a session actually lives.
 *
 * Read as TEXT from the repository root rather than imported. `apps/web` and `apps/api` are separate
 * packages with no dependency between them and no reason to acquire one for a test, and `apps/web`'s
 * tests run under `node --test` with no build step — so an import would either fail to resolve or
 * quietly pull the API's whole module graph into a web test. Reading the file is the same technique
 * the inventory check above uses on `db/migrations`, for the same reason.
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
 * Evaluates a constant written as a product of number literals, e.g. `60 * 24 * 60 * 60`.
 *
 * Deliberately narrow. It parses the shape these four constants are actually written in and refuses
 * anything else, so a constant that becomes a computed expression fails this test loudly instead of
 * being read as some other number. Underscores are stripped because `1_000` is how the sweep writes
 * its interval.
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
 * The number words `/privacy` uses, because the page writes periods in prose and not in digits.
 *
 * A lookup that can MISS is the point. If a constant moves to a value with no word here, the test
 * fails and somebody has to open the page — which is exactly the moment the page needs editing. A
 * `String(n)` fallback would let a changed period pass silently, which is the defect this guards.
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
 * `/privacy` §5 and the session code, held together.
 *
 * ## The defect this exists for
 *
 * The page said "A session lasts fourteen days from when it was issued". Fourteen days is the IDLE
 * window — `extendExpiry` slides it forward on every visit past the halfway point — and the real
 * bound on a session's life is `SESSION_ABSOLUTE_TTL_SECONDS`, sixty days from `created_at`. So the
 * page understated its own longest retention period by a factor of more than four, and it did so in
 * the one section a reader consults to find out how long they are kept.
 *
 * Nothing could have caught it. The number lived in prose on one side of the repository and in a
 * constant on the other, with no mechanism between them, which is how every stated retention period
 * eventually stops being true.
 */
describe('the retention periods on /privacy are the ones the code implements', () => {
  const idleDays = constantProduct(API_SESSION_REPO, 'SESSION_TTL_SECONDS') / 86_400;
  const absoluteDays = constantProduct(API_SESSION_AUTH, 'SESSION_ABSOLUTE_TTL_SECONDS') / 86_400;
  const attemptMinutes = constantProduct(API_SESSION_REPO, 'OIDC_ATTEMPT_TTL_SECONDS') / 60;
  const sweepHours = constantProduct(API_RETENTION_SWEEP, 'DEFAULT_INTERVAL_MS') / 3_600_000;

  it('parsed real periods rather than nothing at all', () => {
    // The non-empty-set assertion this file applies everywhere else. A regex that stopped matching
    // would otherwise leave every assertion below comparing zero against zero.
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
    // The FIRST sweep is a separate constant from the interval, and the page states both. It said
    // "six hours after it starts" for as long as that was true; when the first sweep moved to a
    // minute — because a server redeployed more often than six hours had never swept anything at
    // all — nothing failed, because nothing read this constant. It does now.
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
    // The sweep is what removes a row, so "expires after ten minutes" and "is deleted after ten
    // minutes" are different claims and only one of them is true. The page has to carry the gap.
    const privacy = flat(read(...PAGES.privacy));
    assert.match(
      privacy,
      /up to six hours/u,
      'the page must say how long a row can outlive the moment it stopped being usable',
    );
  });

  it('says that deletion does not reach backups', () => {
    // Section 6 is a list of what erasure removes. Backups are the one place it cannot reach, and a
    // deletion section that does not say so is describing an erasure stronger than the one that runs.
    const privacy = flat(read(...PAGES.privacy));
    assert.match(privacy, /backups/iu, 'section 6 must account for backups');
    assert.match(privacy, /six months/u, 'and for how long the shipped backup policy keeps one');
  });
});

// ---------------------------------------------------------------------------
// Negative controls
//
// Each detector above is run over a document that violates the thing it checks, and asserted to
// fire. Without this the whole file could be passing because the detectors match nothing at all.
// ---------------------------------------------------------------------------

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
    // The real defect, reproduced. This was the shipped wording, and it is the reading that
    // understates the period: fourteen days is when the window starts running out, not when the
    // session dies. The detector has to reject it and accept the corrected sentence.
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
    // The half-fix: somebody corrects "from when it was issued" and stops there, leaving the
    // longest period a session is actually kept unstated. That page reads correct and is not.
    const namesCeiling = (text: string): boolean => text.includes('sixty days from creation');
    assert.equal(
      namesCeiling('A session lasts fourteen days from your last visit.'),
      false,
      'a page with no ceiling must be reported as missing it',
    );
    assert.equal(namesCeiling(flat(read(...PAGES.privacy))), true);
  });

  it('catches a constant that has stopped being a product of literals', () => {
    // The parser's own failure mode. If it silently returned NaN or 0 for an expression it cannot
    // read, every period assertion above would compare nonsense and pass for the wrong reason.
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
    // `word()` is deliberately allowed to miss. This proves it does, because a `String(n)` fallback
    // would let a changed retention period pass while the page still says the old number.
    assert.equal(word(60), 'sixty');
    assert.throws(
      () => word(90),
      /which \/privacy has no wording for/u,
      'a period the page has never been told about must fail rather than be spelled numerically',
    );
  });

  it('scanned a real, non-empty set of pages', () => {
    // The last way this file could pass for the wrong reason: PAGES emptied, or every read
    // returning nothing.
    assert.equal(PAGE_KEYS.length, 3);
    for (const page of PAGE_KEYS) {
      assert.ok(read(...PAGES[page]).length > 2_000, `${page} must be a real document, not a stub`);
    }
    assert.ok(COUNSEL_MARKER_EXPLANATION.length > 100);
  });
});

/**
 * What `/terms` says about money and what `db/migrations` does about it are one fact, and must fail
 * together.
 *
 * ## The defect this exists for
 *
 * A compliance audit found that `/terms` §7 opened "This service is provided free of charge" while
 * the product was being prepared to onboard students onto a course. That reads like a stale sentence
 * somebody forgot to edit. It was not, and treating it as a copy-edit was the trap: the clause was
 * *load-bearing on being free*. What followed the first six words was "with no promise that it will
 * be available, that your data will survive, or that any particular feature will continue to
 * exist… it may be taken down, reset or changed at any time" — reasonable to somebody who paid
 * nothing, indefensible to somebody who paid for a course, and worse still if "free of charge" were
 * simply swapped for "for a fee", which would leave a document promising a paying student nothing at
 * all and looking deliberate about it.
 *
 * ## What fired, and why it was right to
 *
 * `prl.cohorts` and `prl.enrolments` landed: a durable record of who holds a place in a course, on
 * whose authority, against a reference to an arrangement made outside this system. The migration
 * detector below fired on the table name, at the moment somebody was holding the change that made
 * the clause false. That is exactly what it was built to do, and the answer was to rewrite the
 * clause rather than to exempt the table.
 *
 * ## The subtlety this group now encodes
 *
 * **An enrolment record does not establish that money changed hands.** A scholarship cohort, an
 * employer-funded class and a paid course produce identical rows, because the grant happens out of
 * band and no column in this schema can hold an amount, a currency or a price. So there is no single
 * true sentence for every deployment, and the page cannot simply be flipped from one assertion to
 * the other.
 *
 * What IS invariant is that the page and the schema must agree. `/terms` may take one of exactly two
 * positions, and this group holds it to whichever one the schema is in:
 *
 *  * **free-of-charge** — the page says the service is provided free of charge, and `db/migrations`
 *    creates no table that records an entitlement.
 *  * **enrolment-aware** — the page has stopped saying that, says instead what an enrolment record
 *    holds and that it implies nothing about money, and hands both commercial halves (what the
 *    enrolment bought; what a cancellation or an interruption is worth) to `COUNSEL_CLAUSES`. In
 *    that case `db/migrations` must actually create the record the page describes.
 *
 * ## Why the assertion is conditional rather than exempted
 *
 * The alternative was an allowlist entry for `enrolments`, and it is the wrong shape for a reason
 * worth writing down: an exemption is a claim about a table, evaluated once, by whoever added it.
 * The property that actually matters is a claim about *two files agreeing*, and it has to be
 * re-evaluated on every run. Under the conditional shape the enrolment table is permitted **only for
 * as long as `/terms` keeps saying the honest thing about it**; delete the disclosure paragraphs, or
 * drop one of the two counsel flags, and the migration detector starts firing again on a table that
 * has not changed. An exemption cannot do that, because it does not know what the page says.
 *
 * It runs in both directions, which is the half an exemption could never have: a `/terms` rewritten
 * to describe an enrolment record that no migration creates is a false factual claim on a legal
 * page, and fails here too.
 *
 * ## What kept its teeth, unconditionally
 *
 * A real payment path still fails in every posture, in all three of the places one would have to
 * show up: a dependency, a table name that means money moved, or a call in the source. Nothing about
 * enrolment relaxes any of those — the whole point of the split is that recording an entitlement and
 * taking money are different things, so the detector for the second must not have been widened to
 * accommodate the first.
 *
 * ## Would this fail if the behaviour broke?
 *
 * The negative-control test at the end feeds every detector the thing it exists to catch — a payment
 * SDK, a payment table, a camelCase checkout call — and feeds the new conditional shape a `/terms`
 * that says the wrong thing: one still claiming the service is free, one describing enrolment with a
 * counsel flag dropped, and one claiming both at once. A tripwire nobody has watched trip is a
 * comment.
 */
describe('what /terms says about money, and the absence of a payment path', () => {
  /**
   * Words that only appear in a system that moves money — matched with word boundaries, because
   * `sepa` is inside `separate` and `stripe` is inside a CSS hatch pattern, and a detector that
   * cried wolf on either would be turned off within a week.
   *
   * Word boundaries alone are not enough, and the negative control below is how that was found:
   * `\bcheckout\b` does not match `createCheckoutSession`, because there is no boundary in the
   * middle of a camelCase identifier. That is not an edge case — a payment path in this codebase
   * would be named exactly that way, so the one spelling most likely to appear was the one spelling
   * the detector could not see. `splitIdentifiers` puts a space at every case transition first.
   */
  const PAYMENT_WORDS =
    /\b(stripe|braintree|adyen|paypal|payments?|checkout|invoices?|billing|merchant|iban|cardholder|paywall|subscribe_?to_?plan)\b/iu;

  /**
   * Table names that mean money moved. **Forbidden in every posture, always.**
   *
   * This is the list that must never learn a new exception. Recording that somebody holds a place in
   * a course and recording that somebody was charged for it are different facts, and the second one
   * needs a clause nobody here is competent to write — so a table that could hold a price fails this
   * file whatever `/terms` currently says.
   *
   * The second line is a correction, and the omission it repairs is the sharpest kind: an
   * adversarial review put `prl.fees`, `prl.enrolment_fees`, `prl.tuition`, `prl.amounts_due`,
   * `prl.currencies`, `prl.card_details` and `prl.stripe_customers` through this detector and every
   * one of them was ACCEPTED. `stripe` is the worst of them, because `PAYMENT_WORDS` — the list used
   * on dependencies and on source — has known the word all along; the table detector simply had a
   * different list, and nothing held the two to each other. `prl.enrolment_fees` is the second
   * worst: it matched `ENTITLEMENT_TABLE`, so in the enrolment-aware posture the page's own
   * permission covered a table whose name says a fee was charged.
   *
   * The words are those `/terms` itself uses — "an amount, a currency or a price" — plus the fee
   * vocabulary a course would actually arrive under, plus the payment brands. `fee` and `card` are
   * matched at a word boundary on the SPLIT name, so `prl.discards` and `prl.coffee_breaks` do not
   * fire; the assertion at the end of this group re-checks every real table in the schema against
   * this pattern, which is what makes widening it safe to do.
   */
  const MONEY_TABLE =
    /\b(payment|purchase|order|invoice|billing|receipt|refund|price|charge|checkout|transaction|wallet|ledger|subscription)|\b(fees?|tuitions?|amounts?|currenc(y|ies)|cards?|costs?|balances?|credits?|remittances?|stripe|paypal|braintree|adyen|merchants?|iban)\b/iu;

  /**
   * Table names that mean somebody holds an entitlement. **Forbidden unless `/terms` says so.**
   *
   * Deliberately separate from `MONEY_TABLE` rather than a carve-out inside it. An entitlement is not
   * a purchase — this repository's whole position rests on that distinction — and collapsing the two
   * lists would either let a payment table through or make the honest enrolment record permanently
   * unrepresentable.
   */
  const ENTITLEMENT_TABLE = /\b(enrolment|enrollment|entitlement|cohort|admission|licen[cs]e)/iu;

  /**
   * Known-benign occurrences of `PAYMENT_WORDS` in the source, each pinned to its file and reason.
   *
   * Two of these are `/privacy` DENYING that payment details are held — the exact sentence that
   * would have to change first, so it is right that the scanner sees it and right that it is listed
   * here rather than excluded by a blanket path rule. One is the glossary defining an ante. Two are
   * CSS: a typography note citing Stripe's website, and a hatch pattern made of stripes.
   *
   * `app/terms/page.tsx` and `lib/legal-config.ts` both make the same denial and are deliberately
   * NOT here. Their wording was chosen to make it without using any of the scanned words, so both
   * files stay inside the scanner's reach — a legal page and the clause register are plausible
   * places for somebody to describe a buying flow in prose, and each file left out of this list is
   * one fewer place a real integration could sit unread.
   *
   * An entry here is a claim that a human looked. If a file drops off this list its exemption dies
   * with it, which is the point — `assert` below fails on an entry that no longer matches anything.
   *
   * Keys are REPO-RELATIVE, and that is a correction. They used to be relative to whichever root
   * happened to contain them, which had two consequences an adversarial review found: the two
   * `packages/ui` entries were written as `../../../packages/…`, a path no root could ever produce,
   * and the "an exemption that matches nothing must die" loop below skipped exactly those two by
   * testing `startsWith('../')`. So the two entries read as evidence that somebody had scanned
   * `packages/` and found the matches benign, and nothing had scanned `packages/` at all.
   */
  const ALLOWED: ReadonlyArray<readonly [string, string]> = [
    ['apps/web/src/app/privacy/page.tsx', 'the page denying that payment details are held'],
    ['apps/web/src/fixtures/learn-glossary.ts', 'the glossary definition of an ante'],
    ['packages/ui/src/styles/tokens.css', 'a typography note citing Stripe as a reference'],
    ['packages/ui/src/styles/components.css', 'a hatch pattern drawn from stripes'],
  ];

  /** `createCheckoutSession` -> `create Checkout Session`, so a word boundary exists to match. */
  const splitIdentifiers = (source: string): string => source.replace(/([a-z0-9])([A-Z])/gu, '$1 $2');

  /**
   * A table identifier reduced to space-separated words: `prl.course_invoices` -> `prl course
   * invoices`.
   *
   * `splitIdentifiers` alone is not enough for a table name, and the negative control below is how
   * that was found — the same way the camelCase miss was found, one naming convention along.
   * `\binvoice` does not match `course_invoices`, because `_` is a word character and there is no
   * boundary in the middle of a snake_case identifier. Every table in this schema is snake_case, so
   * the spelling a real purchase table would arrive under was, again, the one spelling the detector
   * could not see.
   *
   * Kept separate from `splitIdentifiers` rather than folded into it: that one runs over whole source
   * files, where `PAYMENT_WORDS` matches `subscribe_to_plan` with its underscores intact, and
   * splitting them there would break the pattern it was written for.
   */
  const splitTableName = (table: string): string => splitIdentifiers(table).replace(/[_.]/gu, ' ');

  const sourceFiles = (root: string): readonly string[] =>
    readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((entry) =>
      /\.(ts|tsx|css|sql)$/u.test(entry),
    );

  /**
   * Every source tree the payment scan reads, as `[repo-relative label, absolute path]`.
   *
   * The two app roots were the whole list, and an adversarial review demonstrated what that left
   * out: `@stripe/stripe-js` added to `packages/ui/package.json` and a `createCheckoutSession`
   * calling `loadStripe` written into `packages/ui/src/` passed all 59 tests in this file, while the
   * identical function in `apps/api/src/` failed the tripwire. `packages/ui` is a React package —
   * it is the single most plausible home for a checkout component in this repository.
   *
   * `packages/<name>/src` rather than `packages` itself: a recursive read of `packages` descends
   * into `node_modules` and `dist` (4,454 and 1,253 entries measured), which would put a scanner
   * whose findings must each be reviewed by a human over the whole dependency graph and the build
   * output. The workspace packages are enumerated rather than listed, so a seventh one is scanned
   * the day it lands rather than the day somebody remembers this file.
   */
  const SOURCE_ROOTS: ReadonlyArray<readonly [string, string]> = [
    ['apps/web/src', SRC],
    ['apps/api/src', resolve(REPO, 'apps', 'api', 'src')],
    ...readdirSync(join(REPO, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => [`packages/${entry.name}/src`, join(REPO, 'packages', entry.name, 'src')] as const)
      .filter(([, dir]) => existsSync(dir)),
  ];

  /** The sentence the clause used to open with, and the whole of the free-of-charge posture. */
  const FREE_OF_CHARGE = /This service is provided free of charge/u;

  /**
   * The enrolment-aware posture, as four sentences the page has to be carrying.
   *
   * Four rather than one, and each one a separate named requirement, because the dangerous state is
   * the HALF rewrite: somebody deletes the paragraph that says an enrolment implies nothing about
   * money and leaves the one that says an enrolment exists, and the page now reads as a confirmation
   * that readers were charged. Each entry names what it is holding the page to, so a failure says
   * which claim went missing rather than "the regex stopped matching".
   *
   * Matched against `flat()`, never the raw source: this is prose, the formatter reflows it to 110
   * columns, and a test that fails because a word moved to the next line is a test people delete.
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
    /** Named disclosures the page carries, and the ones it does not. */
    readonly discloses: readonly string[];
    readonly missing: readonly string[];
    /** Counsel clauses the page renders, and the ones it should and does not. */
    readonly flagged: readonly CounselClauseId[];
    readonly unflagged: readonly CounselClauseId[];
  }

  /**
   * The document, with the source file's own commentary about the document removed.
   *
   * Found the hard way, twice. The header of `app/terms/page.tsx` explains this rewrite by QUOTING
   * the clause it replaced, and the posture reader — which decides what the page says by looking for
   * that exact sentence — read the quotation as a live claim and reported the page as asserting both
   * positions at once. A reader is shown the JSX and never the comments above it, so the comments
   * come out before anything here decides what the page says. Without this, the only way to document
   * the change honestly would have been to stop quoting the sentence being changed.
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

  /**
   * The one boolean everything below keys off: is `/terms` completely in the enrolment-aware
   * posture? Anything short of complete is not it, which is what stops a half-rewrite from
   * unlocking the migration detector.
   */
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
    // Every manifest in the workspace, not just the three at the top. `pnpm-workspace.yaml` makes
    // `packages/*` first-class, and an adversarial review demonstrated that `@stripe/stripe-js`
    // added to `packages/ui/package.json` — the React package, the obvious home for a checkout
    // component — passed this file untouched. A dependency list that reads three of nine manifests
    // is a dependency list that describes a different repository from the one being shipped.
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
    // Which of the two ways the page can be short of enrolment-aware, so the failure below names the
    // one that is actually true. "The clause still says the service is free" is wrong and misleading
    // when what happened is that somebody deleted a counsel flag from an otherwise honest page.
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
    // No `continue` here any more. The skip it used to carry — `relative.startsWith('../')` —
    // exempted precisely the two entries that no root could produce, so the check that an exemption
    // must still match something was itself exempted for the two entries that matched nothing.
    for (const [relative] of ALLOWED) {
      assert.ok(seen.has(relative), `${relative} is exempted but no longer matches; drop the exemption`);
    }
    assert.ok(scanned > 50, `only ${scanned} files were scanned; the sweep proved nothing`);
  });

  it('each tripwire fires on a synthetic violation (NEGATIVE CONTROL)', () => {
    // The detectors, fed the thing they exist to catch. Without this the group above passes on a
    // repo that has no payment path AND on a detector that can no longer see one.
    assert.match(splitIdentifiers('@stripe/stripe-js'), PAYMENT_WORDS, 'a payment SDK must be recognised');
    assert.match(splitTableName('prl.payments'), MONEY_TABLE, 'a payment table');
    assert.match(
      splitIdentifiers('const session = await createCheckoutSession();'),
      PAYMENT_WORDS,
      'a camelCase payment call must be recognised: this is the spelling a real integration uses, ' +
        'and the boundary-only version of this regex could not see it',
    );
    // And the two that made a naive scanner useless, which must NOT fire.
    assert.doesNotMatch(splitIdentifiers('a separate concern'), PAYMENT_WORDS, '"separate" holds "sepa"');
    assert.doesNotMatch(
      splitIdentifiers('one table subscription per room'),
      PAYMENT_WORDS,
      'a socket subscription is not a payment plan',
    );
  });

  it('a money table is refused in BOTH postures, and an entitlement table only in one (NEGATIVE CONTROL)', () => {
    // The property that makes the conditional shape safe: rewriting /terms buys an enrolment record
    // and nothing else. If MONEY_TABLE ever matched what ENTITLEMENT_TABLE matches, or the reverse,
    // an honest page would have unlocked a payment table.
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
    // The snake_case miss, pinned as its own case because it is the one that got through the first
    // draft of this group: `\binvoice` has no boundary to find inside `course_invoices`.
    assert.doesNotMatch(splitIdentifiers('prl.course_invoices'), MONEY_TABLE, 'the miss, reproduced');
    assert.match(splitTableName('prl.course_invoices'), MONEY_TABLE, 'and the fix that closes it');

    /*
     * The vocabulary miss, found by an adversarial review, and pinned the same way (REGRESSION).
     *
     * Every name below was ACCEPTED by this detector. `prl.stripe_customers` is the one worth
     * staring at: `PAYMENT_WORDS` has known the word `stripe` since this group was written, and
     * this list simply did not — two detectors for the same subject with no assertion holding
     * either to the other. `prl.enrolment_fees` is the second: it matches ENTITLEMENT_TABLE, so
     * an honest `/terms` was unlocking a table whose name says a fee was charged.
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
    // And the words that merely CONTAIN one of the new ones, which must not fire — a detector that
    // refused `prl.discards` in a poker schema is a detector somebody switches off.
    for (const table of ['prl.discards', 'prl.coffee_breaks', 'prl.scorecards_v2', 'prl.hand_seats']) {
      assert.doesNotMatch(splitTableName(table), MONEY_TABLE, `${table} is not a purchase`);
    }
    // The tables that exist today, none of which may be read as a purchase.
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
    // The new conditional shape, fed each way it can be got wrong. Every fixture below is built by
    // mutating the REAL page, so a fixture cannot drift into agreeing with a detector that has
    // stopped working.
    const real = read(...PAGES.terms);
    assert.equal(
      ENROLMENT_AWARE,
      readMoneyPosture(real).claimsFree === false,
      'the real page, as a baseline',
    );

    // 1. The state that fired this rewrite: the old clause, with the enrolment record in the schema.
    const stillFree = readMoneyPosture(
      '<h2>7. Availability</h2><p>This service is provided free of charge and with no promise that ' +
        'it will be available, that your data will survive, or that any particular feature will ' +
        'continue to exist.</p>',
    );
    assert.equal(stillFree.claimsFree, true, 'the shipped sentence must still be recognised');
    assert.equal(stillFree.missing.length, ENROLMENT_DISCLOSURES.length, 'and carries no disclosure');
    assert.equal(stillFree.flagged.length, 0);

    // 2. The half-rewrite: says an enrolment record exists, dropped the sentence saying it implies
    //    nothing about money. This page reads as a confirmation that the reader was charged.
    const halfway = readMoneyPosture(
      real.replace('An enrolment record is not evidence that money changed hands', 'Enrolment is recorded'),
    );
    assert.equal(halfway.claimsFree, false);
    assert.equal(halfway.missing.length, 1, 'exactly the deleted disclosure must be reported missing');
    assert.ok(
      halfway.missing[0]?.includes('scholarship cohort'),
      `the failure must name the claim that went missing, got ${JSON.stringify(halfway.missing)}`,
    );

    // 3. The flag dropped: the page describes the enrolment and then asserts the commercial half by
    //    saying nothing about it, which is the exact failure COUNSEL_MARKER exists to prevent.
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
 * `/privacy` promises that abandoned guest accounts are erased, and the period must be the code's.
 *
 * ## The defect this exists for
 *
 * The abandoned-guest sweep was documented in four places, had an index built for it and a DELETE
 * grant widened for it, and **nothing consumed any of it**. Guest accounts were retained forever
 * while five separate comments described the reaper that would remove them. A compliance audit found
 * it; no test could have, because every one of those five sites was prose.
 *
 * The sweep exists now, and the page says so. That creates the opposite risk, and it is the worse
 * one: a page that promises erasure on a period the code does not implement is a false statement to
 * a reader, where the old comments were only a false statement to a maintainer.
 *
 * ## Why the assertion is about the DERIVATION and not the number
 *
 * Sixty days was not picked. A guest has no email, no password and no federated identity — no column
 * could hold one — so the only thing that can ever reach the account again is a session cookie, and
 * a session cannot outlive `SESSION_ABSOLUTE_TTL_SECONDS`. Sixty days unseen is therefore the
 * SMALLEST period after which every credential that could reach the account is already dead. Shorter
 * deletes reachable accounts; longer keeps provably unreachable ones.
 *
 * That is why this asserts `GUEST_RETENTION_SECONDS` is still *defined as* the session ceiling
 * rather than asserting it equals 5,184,000. Someone who edits the ceiling for an unrelated reason
 * must carry the guest period with it, and a test pinned to the literal would let the two drift
 * apart while both still "passed".
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
    // Lowercased, because this phrase opens a sentence on the page and `word()` is lowercase.
    // Matching case here would make the test fail on a paragraph that says the right thing.
    const privacy = flat(read(...PAGES.privacy)).toLowerCase();
    assert.ok(
      privacy.includes(`${word(days)} days after a guest account was last seen`),
      `/privacy must say guests are erased ${word(days)} days after they were last seen`,
    );
  });

  it('states the liveness guarantee, which is the part a reader is owed', () => {
    // The period is the boring half. The half that matters to somebody mid-course is that the sweep
    // cannot take an account still in use — and the page must say it, because "sixty days unseen"
    // alone reads as a countdown that could reach a live account.
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
   * The page lists what protects an account; the predicate decides it. They must not drift.
   *
   * They already did once, quietly and in the direction that matters. `db/migrations/0006_cohort_
   * enrolments.sql` made `prl.enrolments.user_id` `ON DELETE CASCADE`, so an account taken by this
   * sweep takes its enrolments with it — and a class enrolled in advance of the day it opens (0006
   * argues for exactly that at `:72-73`) is a student erased weeks before their course begins. The
   * predicate gained a fifth clause for it. The page listed four things and would have gone on
   * listing four.
   *
   * Counted rather than named, because the failure mode is a clause being ADDED and the page not
   * following. A test that checked the four it knew about would have passed over the fifth, which is
   * the whole defect.
   */
  it('names every protection the predicate actually implements', () => {
    const users = readFileSync(resolve(REPO, 'apps', 'api', 'src', 'repositories', 'users.ts'), 'utf8');
    const start = users.indexOf('function abandonedGuestPredicate');
    assert.ok(start > 0, 'abandonedGuestPredicate has moved or been renamed; this assertion needs it');
    const predicate = users.slice(start, users.indexOf('}', users.indexOf('`;', start)));
    const guarded = [...predicate.matchAll(/from prl\.(\w+)/gu)].map((match) => match[1] ?? '');
    assert.ok(guarded.length >= 4, `the predicate scanned as ${JSON.stringify(guarded)}; that is not it`);

    // What the page must say for each table the predicate consults. A table here with no phrase is a
    // deliberate failure: somebody has to write the sentence.
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
    // The detector above, fed a predicate with a clause nobody has written a sentence for. Without
    // this it could be passing because the scan found nothing, or because every table happened to
    // have a phrase already.
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
