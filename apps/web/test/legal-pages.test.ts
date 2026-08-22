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
