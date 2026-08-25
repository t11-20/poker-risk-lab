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
import { readdirSync, readFileSync } from 'node:fs';
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

describe('the inventory accounts for every table in the schema', () => {
  /**
   * Every `CREATE TABLE prl.x` in `db/migrations`, which is the set `/privacy` has to account for.
   *
   * `prl.schema_migrations` is excluded: it is the migration ledger, it holds nothing about a
   * reader, and the runtime role is granted nothing on it at all.
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
 * §7 of `/terms` and the absence of a payment path are one fact, and must fail together.
 *
 * ## The defect this exists for
 *
 * A compliance audit of this repo found that `/terms` §7 opens "This service is provided free of
 * charge" — while the product was being prepared to charge students a course fee. That reads like a
 * stale sentence somebody forgot to edit. It is not, and treating it as a copy-edit is the trap.
 *
 * The clause is *load-bearing on being free*. What follows the first six words is "with no promise
 * that it will be available, that your data will survive, or that any particular feature will
 * continue to exist… it may be taken down, reset or changed at any time". Every one of those is a
 * reasonable thing to say to somebody who paid nothing, and none of them survives contact with a
 * paying student. Swapping "free of charge" for "for a fee" would leave a document that promises
 * nothing to somebody who has been charged — which is worse than the contradiction it replaced,
 * because it looks deliberate.
 *
 * Right now the sentence is TRUE: an exhaustive search of this repo found no payment path at all,
 * no enrolment record, and no way to tell a paid user from an unpaid one. So the honest thing is to
 * leave it standing and make it impossible for the first commit that takes money to slip past it.
 *
 * ## Would this fail if the behaviour broke?
 *
 * That is the whole design. This is not a guard on today's text — today's text is fine. It is a
 * tripwire on the change that makes today's text false, and it watches three independent places a
 * payment path would have to show up in: a dependency, a table, or the source. Any one of them
 * fires and this test names the clause that has to be rewritten, at the moment somebody is holding
 * the code that made it necessary. The negative controls below feed each detector a synthetic
 * violation, because a tripwire nobody has ever seen trip is a comment.
 */
describe('the free-of-charge clause and the absence of a payment path', () => {
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
   * Known-benign occurrences, each pinned to its file and its reason.
   *
   * Two of these are `/privacy` DENYING that payment details are held — the exact sentence that
   * would have to change first, so it is right that the scanner sees it and right that it is listed
   * here rather than excluded by a blanket path rule. One is the glossary defining an ante. Two are
   * CSS: a typography note citing Stripe's website, and a hatch pattern made of stripes.
   *
   * An entry here is a claim that a human looked. If a file drops off this list its exemption dies
   * with it, which is the point — `assert` below fails on an entry that no longer matches anything.
   */
  const ALLOWED: ReadonlyArray<readonly [string, string]> = [
    ['app/privacy/page.tsx', 'the page denying that payment details are held'],
    ['fixtures/learn-glossary.ts', 'the glossary definition of an ante'],
    ['../../../packages/ui/src/styles/tokens.css', 'a typography note citing Stripe as a reference'],
    ['../../../packages/ui/src/styles/components.css', 'a hatch pattern drawn from stripes'],
  ];

  /** `createCheckoutSession` -> `create Checkout Session`, so a word boundary exists to match. */
  const splitIdentifiers = (source: string): string => source.replace(/([a-z0-9])([A-Z])/gu, '$1 $2');

  const sourceFiles = (root: string): readonly string[] =>
    readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((entry) =>
      /\.(ts|tsx|css|sql)$/u.test(entry),
    );

  it('says the service is free, in those words', () => {
    // If this stops matching, everything below is guarding a sentence that is no longer there and
    // would keep passing while the clause said something else entirely.
    assert.match(
      flat(read(...PAGES.terms)),
      /This service is provided free of charge/u,
      '/terms §7 no longer opens with the free-of-charge claim — the tripwire below is now pointed at nothing',
    );
  });

  it('no dependency that moves money has been added (TRIPWIRE)', () => {
    const manifests = ['package.json', 'apps/api/package.json', 'apps/web/package.json'];
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
          `${manifest} depends on "${name}". If this product now takes money, /terms §7 promises a ` +
            'paying student no availability, no data survival and no notice before it is taken down. ' +
            'Rewrite the clause before shipping the integration.',
        );
      }
    }
    assert.ok(scanned > 20, 'no dependencies were read; the scan proved nothing');
  });

  it('no table that records a purchase has been created (TRIPWIRE)', () => {
    const migrations = readdirSync(join(REPO, 'db', 'migrations')).filter((name) => name.endsWith('.sql'));
    assert.ok(migrations.length >= 5, 'no migrations were read; the scan proved nothing');
    for (const name of migrations) {
      const sql = readFileSync(join(REPO, 'db', 'migrations', name), 'utf8');
      for (const [, table] of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([\w.]+)/giu)) {
        assert.doesNotMatch(
          splitIdentifiers(table ?? ''),
          /\b(payment|order|purchase|invoice|billing|subscription|enrolment|enrollment|entitlement|receipt)/iu,
          `${name} creates "${table}". A table that records a purchase means somebody is being ` +
            'charged, and /terms §7 still tells them the service is free and promises them nothing.',
        );
      }
    }
  });

  it('no source file has grown a payment path (TRIPWIRE)', () => {
    const roots = [SRC, resolve(REPO, 'apps', 'api', 'src')];
    const allowed = new Map(ALLOWED);
    const seen = new Set<string>();
    let scanned = 0;
    for (const root of roots) {
      for (const relative of sourceFiles(root)) {
        const full = join(root, relative);
        scanned += 1;
        if (!PAYMENT_WORDS.test(splitIdentifiers(readFileSync(full, 'utf8')))) continue;
        const key = relative.split(/[\\/]/u).join('/');
        assert.ok(
          allowed.has(key),
          `${key} mentions money and is not on the reviewed list. If a payment path has been added, ` +
            'rewrite /terms §7 — it promises a paying student nothing at all.',
        );
        seen.add(key);
      }
    }
    for (const [relative] of ALLOWED) {
      if (relative.startsWith('../')) continue;
      assert.ok(seen.has(relative), `${relative} is exempted but no longer matches; drop the exemption`);
    }
    assert.ok(scanned > 50, `only ${scanned} files were scanned; the sweep proved nothing`);
  });

  it('each tripwire fires on a synthetic violation (NEGATIVE CONTROL)', () => {
    // The three detectors, fed the thing they exist to catch. Without this the group above passes
    // on a repo that has no payment path AND on a detector that can no longer see one.
    assert.match(splitIdentifiers('@stripe/stripe-js'), PAYMENT_WORDS, 'a payment SDK must be recognised');
    assert.match(splitIdentifiers('prl.payments'), /\b(payment|order|purchase)/iu, 'a payment table');
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
