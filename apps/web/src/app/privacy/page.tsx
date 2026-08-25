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
      'The raw address and the raw user agent are never written anywhere. Be clear about what the ' +
      'keyed digest achieves: it is pseudonymisation, not anonymisation. Somebody holding the ' +
      'server’s secret can confirm a guessed address; what it prevents is a leaked backup handing ' +
      'out a list of addresses.',
  },
  {
    table: 'prl.oidc_login_attempts',
    what:
      'Only if this deployment has an identity provider configured, and only for the ten minutes an ' +
      'in-progress sign-in lasts. Digests of the three single-use secrets (state, nonce and the PKCE ' +
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
              fourteen days.
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
        </section>

        <section className="prl-legal__section">
          <h2>5. How long things are kept</h2>
          <p>
            A session lasts fourteen days from when it was issued; a revoked one is meant to be removed a day
            after revocation, and an unfinished sign-in expires after ten minutes. Everything else — your
            account row, your progress, your answers and your hand history — is kept until you delete your
            account.
          </p>
          <p>
            <strong>An honest note about the sweeps.</strong> The code that removes expired sessions and
            expired sign-in attempts runs on a schedule — every six hours, inside the server, in bounded
            batches. So an expired session is both unusable and, within a few hours, gone. This paragraph used
            to say the opposite, because until that schedule existed nothing called that code at all. The
            periods above are still a policy: they say how long a thing may be kept, and the sweep only
            enforces what the code already implements.
          </p>
          <CounselFlag clause={COUNSEL_CLAUSES['retention-and-deletion']} />
        </section>

        <section className="prl-legal__section">
          <h2>6. Deleting your account</h2>
          <p>
            Deletion is a single operation, and this is exactly what it does — taken from the database
            migration that implements it rather than from a promise:
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
