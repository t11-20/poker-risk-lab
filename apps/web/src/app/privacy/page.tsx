/**
 * `/privacy` — a data inventory, written from the schema rather than from intent.
 *
 * ## Why this page is written the way it is
 *
 * Most privacy policies are a description of what somebody meant to build. This one is a
 * description of `db/migrations/0001_initial.sql` through `0004_account_deletion.sql`, the
 * repositories in `apps/api/src/repositories`, and `apps/api/src/logging.ts`. Every table is named,
 * every column that holds anything about a reader is accounted for, and the digests are described
 * as what they are — including the honest limitation that a keyed HMAC is pseudonymisation and not
 * anonymisation, which is the sentence a policy of this kind usually leaves out.
 *
 * Naming the tables is deliberate. It makes the page checkable: a reader who can read SQL can
 * verify it, and so can the next engineer, which is the only mechanism that keeps a document like
 * this true a year after it was written. The alternative — categories like "usage information" —
 * cannot be falsified, which is exactly why it is the usual choice.
 *
 * ## What still needs a lawyer, and what does not
 *
 * The inventory does not. It is a factual claim about software and it is checked. What needs
 * counsel is who the controller is, which lawful basis covers each category, which statutory rights
 * apply to which readers, how long each category may be kept, and what a transfer out of the
 * hosting country requires. Those four clauses carry `COUNSEL_MARKER` and are listed in
 * `docs/production/legal-review-requirements.md`.
 *
 * ## One thing on this page is a policy rather than an observation
 *
 * The retention paragraph. `deleteExpired` and `deleteExpiredLoginAttempts` exist in
 * `apps/api/src/repositories/sessions.ts` and, when this page was first drafted, had no caller
 * anywhere outside the test suite — so expired rows were removable and nothing removed them. The
 * page said that in as many words rather than describing a sweep that did not run, and it said "if
 * a scheduled job is added, this paragraph changes with it".
 *
 * It has been, so it did. `apps/api/src/maintenance/retention-sweep.ts` runs both sweeps every six
 * hours in the API process. The paragraph below now describes what runs; what it still does not do
 * is decide the PERIODS, which are entry 7 of the counsel register and are a policy question, not
 * an observation about the code.
 *
 * ## The retention paragraph was also WRONG, in the direction that understates
 *
 * It said "a session lasts fourteen days from when it was issued". Fourteen days is the IDLE
 * window: `extendExpiry` in `apps/api/src/repositories/sessions.ts` slides it forward on every
 * visit past the halfway mark (`SESSION_REFRESH_AFTER`), bounded by `SESSION_ABSOLUTE_TTL_SECONDS`
 * in `apps/api/src/auth/session.ts` — SIXTY days from `created_at`. A learner who visits weekly
 * held one session row for four times as long as this page claimed. The ceiling is now stated, and
 * `apps/web/test/legal-pages.test.ts` reads both constants out of the API source and fails if the
 * page and the code disagree again. A retention period a document understates is worse than one it
 * leaves vague: the vague one sends a reader to ask, and the wrong one does not.
 *
 * Two smaller corrections went with it. "Only for the ten minutes an in-progress sign-in lasts"
 * described when a row stops WORKING, not when it stops EXISTING — the sweep is what removes it, so
 * the row can outlive its ten minutes by up to a sweep interval. And section 6 said what deletion
 * does without saying what it cannot reach: backups are sealed snapshots, and the shipped policy in
 * `scripts/backup.mjs` keeps one for up to six months.
 *
 * `robots` is not overridden here, for the reason written out on `/terms`.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import {
  COUNSEL_CLAUSES,
  COUNSEL_MARKER,
  COUNSEL_MARKER_EXPLANATION,
  type CounselClause,
  LEGAL_DRAFTED_ON,
  LEGAL_PATHS,
  LEGAL_REVISION,
  NOT_SUPPLIED,
  readLegalDeployment,
} from '@/lib/legal-config.ts';
import '../../styles/page.css';
import '../../styles/legal.css';

export const metadata: Metadata = {
  title: 'What is stored about you',
  description:
    'A table-by-table inventory of everything this application stores, taken from the database ' +
    'schema: what is kept, what is only ever a digest, and what deletion removes.',
};

/** See the note on the identical function in `app/terms/page.tsx` for why it is repeated. */
function CounselFlag(props: { readonly clause: CounselClause }): ReactElement {
  const { clause } = props;
  return (
    <div className="prl-legal-flag">
      <p className="prl-legal-flag__mark prl-label">{COUNSEL_MARKER}</p>
      <p>
        <strong>{clause.subject}.</strong> {clause.question}
      </p>
    </div>
  );
}

interface InventoryEntry {
  readonly table: string;
  readonly what: string;
}

/**
 * The inventory, one entry per table that holds anything about a reader.
 *
 * Ordered as the schema is: identity, then sessions, then the tables, then what you did. Every
 * sentence is a description of columns that exist. Where a column holds a digest rather than a
 * value, the entry says which kind of digest and what that does and does not protect.
 */
const INVENTORY: readonly InventoryEntry[] = [
  {
    table: 'prl.users',
    what:
      'One row for you. An opaque identifier beginning usr_, whether you are a guest or signed in ' +
      'through an identity provider, a display name of 2 to 24 characters (generated for you unless ' +
      'you choose one), when you were last seen, and when the row was created and last changed. If ' +
      'you signed in through an identity provider, the issuer URL and the subject identifier that ' +
      'provider gave you. There is no email column, no password column, no date of birth, no ' +
      'address, no payment details and no balance of money — not blank ones: no such columns exist.',
  },
  {
    table: 'prl.sessions',
    what:
      'One row per signed-in browser. A SHA-256 digest of the session token — never the token, so ' +
      'reading this table cannot sign anyone in — when it expires, when it was revoked, and ' +
      'optionally a keyed HMAC-SHA-256 of your IP address and of your browser’s User-Agent string. ' +
      'Neither the raw address nor the raw user agent is ever written to the database — but read ' +
      'section 4 before concluding they are written nowhere, because the web server in front of ' +
      'this application is a different matter. Be clear about what the ' +
      'keyed digest achieves: it is pseudonymisation, not anonymisation. Somebody holding the ' +
      'server’s secret can confirm a guessed address; what it prevents is a leaked backup handing ' +
      'out a list of addresses.',
  },
  {
    table: 'prl.oidc_login_attempts',
    what:
      'Only if this deployment has an identity provider configured. A sign-in stops being completable ' +
      'ten minutes after it starts; the row itself is removed by the sweep described in section 5, so ' +
      'it can sit there for up to six hours longer. Digests of the three single-use secrets (state, nonce and the PKCE ' +
      'verifier) and, if you were going somewhere in particular, the local path to return you to. ' +
      'The secrets themselves are never stored, so a database read cannot complete somebody else’s ' +
      'sign-in. Each row can be consumed exactly once.',
  },
  {
    table: 'prl.rooms and prl.room_members',
    what:
      'Private tables you create or sit at: the table’s name, its blinds, its starting stack, its ' +
      'action timer, which seat you took, your chip stack, when you joined and when you left. The ' +
      'invite code is stored only as a SHA-256 digest and is shown to you exactly once, so it cannot ' +
      'be recovered afterwards by anyone including the operator.',
  },
  {
    table: 'prl.room_ownership',
    what:
      'Nothing about you, and it is listed here so that “nothing” is a stated fact rather than an ' +
      'omission. One row per table that currently has a hand in flight, recording which of the ' +
      'application’s own server processes is in charge of it and when that process last proved it ' +
      'was alive. The identifier in it names a process, not a person; there is no account ' +
      'identifier in the table and no column that could hold one. The row is deleted when the ' +
      'process lets the table go.',
  },
  {
    table: 'prl.hands, prl.hand_seats and prl.hand_actions',
    what:
      'Your hand history, in full and permanently. For each hand: the board, the street it reached, ' +
      'the result, the deck commitment that proves the deal was fixed before it was dealt, and ' +
      'whether it came from a real random source. For each seat: who sat there, the starting stack, ' +
      'the two hole cards, the net result and whether it went to showdown. For each action: the ' +
      'street, the seat, what was done, what it cost and the pot afterwards, in sequence. These ' +
      'three tables are append-only — the application’s database role holds no permission to delete ' +
      'from them at all.',
  },
  {
    table: 'prl.lesson_progress',
    what: 'Which lessons you have opened, which you reached the end of, and when you last looked at one.',
  },
  {
    table: 'prl.quiz_attempts',
    what:
      'One row per quiz question you answer: which question, the answer you gave, and whether it ' +
      'matched. There is no score, no streak, no pass mark and no aggregate — deliberately, and ' +
      'there is no column any of them could be stored in.',
  },
  {
    table: 'prl.scenario_attempts',
    what:
      'One row per decision you commit in the Scenario Lab: which scenario, the action you chose, ' +
      'and whether it matched what the scenario expected — which is left empty for the many ' +
      'scenarios that deliberately make no claim about a single correct action.',
  },
  {
    table: 'prl.audit_log',
    what:
      'Security-relevant events — a sign-in, a revocation, a refusal — with your account identifier ' +
      'where the event is about an account, an event name, a timestamp and a small structured ' +
      'detail. The detail is pre-redacted, and a constraint in the database refuses a row whose ' +
      'detail names a token, a password, an IP address, a user agent, an invite code, the deck, a ' +
      'commitment salt or hole cards.',
  },
];

export default function PrivacyPage(): ReactElement {
  const deployment = readLegalDeployment();

  return (
    <div className="prl-container">
      <header className="prl-page-head">
        <p className="prl-label">What is stored about you</p>
        <h1 className="prl-page-head__title prl-display-2">Every table, and what is in it</h1>
        <p className="prl-page-head__standfirst">
          This inventory is written from the database schema, not from intent. Every table is named so that
          somebody who can read SQL can check it. What needs a lawyer — who the controller is, which rights
          apply, how long things may be kept — is marked as such and is not answered here.
        </p>
      </header>

      <div className="prl-legal">
        <div className="prl-legal__banner">
          <p className="prl-legal__banner-mark prl-label">Not a reviewed document</p>
          <p>{COUNSEL_MARKER_EXPLANATION}</p>
        </div>

        <dl className="prl-legal__meta">
          <dt>Revision</dt>
          <dd>{`${LEGAL_REVISION}, drafted ${LEGAL_DRAFTED_ON}`}</dd>
          <dt>In effect from</dt>
          <dd>{deployment.effectiveDate ?? NOT_SUPPLIED}</dd>
          <dt>Operated by</dt>
          <dd>{deployment.operator ?? NOT_SUPPLIED}</dd>
          <dt>Contact</dt>
          <dd>{deployment.contact ?? NOT_SUPPLIED}</dd>
          <dt>Database and backups held in</dt>
          <dd>{deployment.hostingRegion ?? NOT_SUPPLIED}</dd>
        </dl>

        <section className="prl-legal__section">
          <h2>1. The short version</h2>
          <p>
            You get an account without being asked for anything: no email, no password, no confirmation. It is
            created the first time you open a lesson, the Scenario Lab or your record, and it is a real row
            with a generated display name. From then on this application keeps what you read, what you
            answered, what you tried and every hand you played.
          </p>
          <p>
            It does not keep your email address, a password, a date of birth, a payment method, an advertising
            identifier or your raw IP address, because there is nowhere in the schema to put any of them.
            There are no third-party trackers and no analytics service: the page you are reading is served
            under a content-security policy that has no host it could load one from.
          </p>
        </section>

        <section className="prl-legal__section">
          <h2>2. The inventory</h2>
          <p>
            One entry per table that holds anything about you. A “digest” below means a one-way hash: the
            value itself is not stored and cannot be read back out.
          </p>
          <dl className="prl-legal__inventory">
            {INVENTORY.map((entry) => (
              <div key={entry.table}>
                <dt>{entry.table}</dt>
                <dd>{entry.what}</dd>
              </div>
            ))}
          </dl>
          <CounselFlag clause={COUNSEL_CLAUSES['data-controller-and-rights']} />
        </section>

        <section className="prl-legal__section">
          <h2>3. What stays in your browser</h2>
          <p>
            Some things never reach the server at all. They live in this browser, on this device, and nothing
            here can read them back:
          </p>
          <ul>
            <li>
              <strong>Your session cookie</strong>, and the paired token that protects against cross-site
              request forgery. The session cookie is the one thing in this list that is sent to the server: it
              is what identifies your account. It is marked so that scripts cannot read it, and it lasts
              fourteen days from your last visit — each visit past the halfway point moves that fourteen days
              forward, and no amount of visiting carries it past sixty days from when it was issued.
            </li>
            <li>
              <strong>Your theme choice</strong> (<code>prl-theme</code> in local storage) and whether the
              opening animation has already played in this tab (<code>prl-booted</code> in session storage).
              Both are read before the first paint so the page does not flash.
            </li>
            <li>
              <strong>Whether you dismissed the first-run explainer</strong> on the curriculum page (
              <code>prl.learn.onboarding.dismissed</code> in local storage).
            </li>
            <li>
              <strong>The sitting timer in the footer</strong>: when this tab was opened (
              <code>prl.session.startedAt</code> in session storage), the reminder interval you chose if you
              chose one (<code>prl.session.reminderMinutes</code> in local storage), and whether you hid it (
              <code>prl.session.hidden</code> in session storage). None of these is sent anywhere, attached to
              your account, or recorded.
            </li>
            <li>
              <strong>An age declaration</strong>, if this deployment asks for one. It records the threshold
              you declared against and nothing else — no date of birth, because none is asked for and there is
              nowhere to keep one.
            </li>
          </ul>
        </section>

        <section className="prl-legal__section">
          <h2>4. Logs and operational metrics</h2>
          <p>
            The server writes an application log. A line carries a request identifier generated by the server
            (never one supplied by a caller), the method and route, the response status and how long it took,
            and a <em>client key</em> — a keyed HMAC of your IP address, truncated, used to apply rate limits
            and to make an abuse investigation possible. It is the same trade as the session table makes: a
            leaked log file does not hand out a list of addresses, and anybody holding the server’s secret can
            still confirm a guessed one.
          </p>
          <p>
            A redaction layer censors, by key name and by fixed path, anything that looks like a token, a
            secret, a password, a cookie, an authorization header or an invite code, along with your display
            name and every piece of hidden game state — the deck, the commitment salts and hole cards.
            Operational metrics carry no personal data at all: their labels are routes, methods, status codes
            and error codes, and the number of distinct label values is capped so that a caller cannot make
            one carry data.
          </p>
          <p>
            <strong>
              The web server in front of the application is a separate log, and it is not redacted.
            </strong>{' '}
            Everything above describes the application’s own log. Requests reach the application through a
            reverse proxy, and the proxy configuration this project ships writes a conventional access log:
            one line per request carrying your <em>raw</em> IP address, your <em>full</em> User-Agent string,
            the complete request line including anything in the query string, and the page you came from. None
            of the redaction described above applies to it, because none of it is written by the application.
            If you sign in through an identity provider, the provider sends you back to a URL with single-use
            sign-in parameters in the query string, and that URL is in this log too.
          </p>
          <p>
            This is said here rather than left to be discovered because the paragraphs above would otherwise
            read as a promise the whole system does not keep. Where those lines are sent, who can read them,
            and how long they are kept are decisions of whoever operates this deployment; nothing in this
            software rotates or deletes them, and no retention period for them is configured anywhere in it.
          </p>
        </section>

        <section className="prl-legal__section">
          <h2>5. How long things are kept</h2>
          <p>
            A session lasts fourteen days <em>from when it was last used</em>, not from when it was issued.
            Each visit past the halfway point of that window slides the expiry forward, so a session you keep
            using does not stop working after a fortnight. What stops it sliding is a hard ceiling of{' '}
            <strong>sixty days from creation</strong>: a learner who visits at least once a week keeps one
            session row for up to sixty days, and then has to sign in again. A revoked session becomes
            removable a day after revocation, and an unfinished sign-in stops being usable after ten minutes.
            Everything else — your account row, your progress, your answers and your hand history — is kept
            until you delete your account, with one exception described next.
          </p>
          <p>
            <strong>Guest accounts you stop using are removed for you.</strong> A guest account has no email
            address and no password — no such columns exist — so the only thing that can ever reach it again
            is the cookie in the browser that created it, and that cookie cannot outlive the sixty-day ceiling
            above. Sixty days after a guest account was last seen it is therefore unreachable by anybody, and
            it is erased on the same schedule as the sweeps below. An account is only ever taken when it is
            genuinely finished with: never while a session is still live, never while it still holds a seat at
            a table, a place in a room, or a room of its own — at any age. The erasure is the same operation
            as section 6, with the same guarantees; nothing about it is a shortcut.
          </p>
          <p>
            <strong>An honest note about the sweeps.</strong> The code that removes expired sessions and
            expired sign-in attempts runs on a schedule — every six hours, inside the server, in bounded
            batches. This paragraph used to say the opposite, because until that schedule existed nothing
            called that code at all. Being <em>unusable</em> and being <em>gone</em> are still two different
            moments, and the gap between them is up to six hours: a sign-in attempt stops working after ten
            minutes and its row is removed at the next sweep, which is why the row can outlive the ten minutes
            by several hours. The first sweep of a freshly started server runs six hours after it starts, not
            at boot. The periods above are a policy; the sweep only enforces what the code already implements.
          </p>
          <CounselFlag clause={COUNSEL_CLAUSES['retention-and-deletion']} />
        </section>

        <section className="prl-legal__section">
          <h2>6. Deleting your account</h2>
          <p>
            Deletion is a single operation, and this is exactly what it does — taken from the database
            migration that implements it rather than from a promise. It runs when you ask for it, and it is
            also what removes an abandoned guest account sixty days after it was last seen (section 5); the
            two paths are the same code, so the list below is true of both:
          </p>
          <ul>
            <li>
              <strong>Removed.</strong> Your account row, every session, every lesson you had marked as read,
              every quiz answer, every scenario attempt, and your seat at every table you have ever joined.
            </li>
            <li>
              <strong>Detached from you.</strong> Your seats in hands that have been played, your rows in the
              audit log, and any private table you created. The rows survive; they stop naming anybody. Tables
              you owned are closed first, because a table whose owner has gone can never be closed by anyone
              afterwards.
            </li>
            <li>
              <strong>Kept, in full.</strong> Every hand — its actions, its board, its deck commitment and its
              reveal. A hand is a shared record: other people were in it and it is in their history, so
              deleting it would be editing theirs. Your identity is removed from it; the hand is not.
            </li>
          </ul>
          <p>
            The operation verifies itself: it counts what was there, deletes, counts again inside the same
            transaction, and refuses to commit if anything that should have gone is still present. If your
            deployment shows no control for this, the feature has not been wired up in that build, and nothing
            on this page can delete anything on your behalf — ask whoever runs it.
          </p>
          <p>
            <strong>What deletion does not reach: backups.</strong> Deletion runs against the live database
            and against nothing else. If this deployment takes backups — the shipped tooling takes one a
            night, keeps the last seven, then one a week for four weeks and one a month for six months, and
            never deletes the newest working one — then your rows are still inside the encrypted archives
            taken before you left, and they stay there until those archives age out of that policy. There is
            no way to edit a backup: an archive is a sealed snapshot, and rewriting one would destroy the
            property that makes it trustworthy as a record. What this means in practice is that erasure is
            immediate in the system you use and takes as long as the backup policy in the archives nobody
            reads unless the database has to be rebuilt. Whether that is acceptable, and whether the backup
            periods are the right ones, is part of the retention question marked in section 5.
          </p>
        </section>

        <section className="prl-legal__section">
          <h2>7. Who else sees any of this</h2>
          <p>
            By default, nobody. This application talks to its own database and to nothing else: no analytics
            provider, no advertising network, no error-reporting service, no content delivery network, no
            fonts loaded from anywhere. The only outbound connection it can make is to an identity provider,
            and only if this deployment has configured one and you choose to sign in through it — in which
            case that provider learns that you signed in here.
          </p>
          <CounselFlag clause={COUNSEL_CLAUSES['international-transfer']} />
          <CounselFlag clause={COUNSEL_CLAUSES['operator-identity']} />
        </section>
      </div>

      <p className="prl-page-nav">
        <Link href={LEGAL_PATHS.terms}>Terms of use</Link>
        <Link href={LEGAL_PATHS.responsibleUse}>Responsible use</Link>
        <Link href="/record">Your record</Link>
      </p>
    </div>
  );
}
