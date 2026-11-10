/**
 * The client half of account deletion: the request that is actually sent, and the consent that has
 * to happen before it is.
 *
 * ## The defect this exists for
 *
 * `/record` showed a learner everything the product holds about them and offered no way to have it
 * hold none of it. There was no route, no path constant and no control — and the schema refused a
 * deletion outright, so one could not have been performed by hand either. That is now fixed, and
 * the part of the fix that lives in this package is a request whose body has to be exactly right
 * and a control that has to be operated twice on purpose.
 *
 * ## Two kinds of assertion, and why
 *
 * `deleteAccount` in `src/lib/api.ts` is an ordinary importable function, so it is driven for real
 * against a stubbed `fetch`. That is where the load-bearing wire facts are: the path, the method,
 * the CSRF header, and the exact confirmation phrase — which the API refuses anything but, so a
 * drift here is a delete button that silently stops working.
 *
 * The control itself is a React component and `apps/web` has no render harness — the suite runs
 * under `node --test` with no DOM and no JSX transform, exactly as `test/live-regions.test.ts`
 * says of itself. So its half is asserted over source text, and the assertions are deliberately
 * about structure a rendering could not fake: a `disabled` expression bound to the confirmation, a
 * real `<label htmlFor>`, a live region, and the absence of a native dialog anywhere in the client.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Yes, and each scan carries a negative control that feeds the detector a genuine violation and
 * asserts it fires — the phrase check, the disabled-until-confirmed check, the retained-data copy
 * and the native-dialog ban all have one. The wire assertions fail by construction, since they
 * read the request the function actually built rather than a description of it. Checked by hand as
 * well: changing the body to `{ confirm: true }` fails the first case, and deleting the `disabled`
 * expression fails the third.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_DELETE_CONFIRMATION, API_PATHS } from '@prl/contracts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

// Before the import, not after: `API_ORIGIN` in `lib/api.ts` is resolved at module evaluation, and
// a browser is what makes it the empty string — which is the whole point of the same-origin rule
// the session cookie depends on. Copied from `test/y1-units-readout.test.ts`, which needs it for
// the same reason.
Object.defineProperty(globalThis, 'window', {
  value: { location: { origin: 'http://localhost' } },
  configurable: true,
  writable: true,
});

const { deleteAccount } = await import('../src/lib/api.ts');

/** One captured request, so the assertions are about what was sent rather than about the call. */
interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Replaces `fetch` for one call and puts the real one back afterwards. */
async function withFetch<T>(
  reply: () => Response,
  run: () => Promise<T>,
): Promise<{ readonly result: T; readonly sent: Sent | null }> {
  const original = globalThis.fetch;
  let sent: Sent | null = null;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    sent = { url, method: String(init.method), headers, body: String(init.body ?? '') };
    return Promise.resolve(reply());
  }) as unknown as typeof globalThis.fetch;
  try {
    return { result: await run(), sent };
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ACCEPTED = {
  deleted: {
    sessions: 2,
    lessonsCompleted: 3,
    quizAttempts: 4,
    scenarioAttempts: 1,
    roomMemberships: 2,
  },
  anonymised: { handSeats: 7, auditEvents: 5, roomsCreated: 1 },
};

describe('the request the client actually sends', () => {
  it('posts the exact confirmation phrase the API refuses anything but', async () => {
    const { result, sent } = await withFetch(
      () => jsonResponse(200, ACCEPTED),
      () => deleteAccount('csrf-token-value'),
    );

    assert.ok(sent !== null, 'no request was made at all');
    const request: Sent = sent;
    assert.equal(request.method, 'POST', 'a DELETE with a required body is not the contract');
    assert.equal(request.url, API_PATHS.accountDelete());
    assert.match(request.url, /^\/api\/v1\//u, 'the version segment is what every path here once lost');
    assert.equal(
      request.headers['x-csrf-token'],
      'csrf-token-value',
      'without the token the API answers csrf_failed and nothing is deleted',
    );
    // The exact body, compared to the published constant rather than to a literal. A phrase
    // written out here would agree with itself for ever while disagreeing with the validator.
    assert.deepEqual(JSON.parse(request.body), { confirm: ACCOUNT_DELETE_CONFIRMATION });
    assert.ok(result.ok);
    assert.equal(result.data.deleted.roomMemberships, 2);
    assert.equal(result.data.anonymised.handSeats, 7);
  });

  it('never sends the confirmation on a request the caller did not make', async () => {
    // The negative control for the case above: the body is only ever built inside `deleteAccount`,
    // so a fetch made by nothing carries nothing. Without this, an assertion that the phrase is
    // present would also pass against a client that sent it on every request it made.
    const { sent } = await withFetch(
      () => jsonResponse(200, ACCEPTED),
      () => Promise.resolve(null),
    );
    assert.equal(sent, null);
  });

  it('reports a refusal as a value instead of throwing, so the screen can say what happened', async () => {
    const { result } = await withFetch(
      () =>
        jsonResponse(409, {
          error: {
            code: 'account_deletion_blocked',
            message: 'Your account could not be deleted, and nothing was removed.',
            requestId: 'req-abcdefgh',
          },
        }),
      () => deleteAccount('csrf-token-value'),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(
      result.error.code,
      'account_deletion_blocked',
      'the screen branches on the code; a message would break the first time the copy changed',
    );
  });

  it('reports an unreachable API as a transport failure rather than as a deletion', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('connection refused'))) as typeof globalThis.fetch;
    try {
      const result = await deleteAccount('csrf-token-value');
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error.code, 'transport');
      assert.equal(result.error.status, 0, 'nothing answered, so there is no status to report');
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

const CONTROL = read('app', 'record', 'DeleteAccount.tsx');
const PAGE = read('app', 'record', 'page.tsx');

/**
 * The source with every run of whitespace collapsed to one space.
 *
 * Prose in JSX is wrapped by the formatter at 110 characters, so a sentence a reader sees as one
 * line is several lines in the file and a phrase assertion against the raw text fails for a reason
 * that has nothing to do with the copy. Collapsing first means these assertions are about what the
 * reader is told rather than about where biome happened to break the line.
 */
const CONTROL_PROSE = CONTROL.replace(/\s+/gu, ' ');

describe('the control asks twice, and says what survives before it asks at all', () => {
  it('is reachable from /record', () => {
    assert.match(PAGE, /import \{ AccountDeletion \} from '\.\/DeleteAccount\.tsx';/u);
    assert.match(
      PAGE,
      /<AccountDeletion deletable=\{record\.state !== 'signedOut'\} \/>/u,
      'the component exists but the page never renders it',
    );
    // And it is not offered to a reader with no account, which could only ever produce a 401 —
    // now a prop rather than a wrapper, for the reason the next block measures.
    assert.match(CONTROL, /if \(!deletable && deletion\.state !== 'done'\) return null;/u);
  });

  it('does not act on the first press: the first press reveals the consequences', () => {
    // `closed` renders the opener, `confirming` renders the panel with the field in it. The
    // erasure happens only from the form's submit handler, which lives in the second state.
    assert.match(CONTROL, /state: 'closed'/u);
    assert.match(CONTROL, /setDeletion\(\{ state: 'confirming' \}\)/u);
    assert.match(
      CONTROL,
      /onSubmit=\{run\}/u,
      'the deletion must be the form submission, not the opener button',
    );
  });

  it('keeps the destructive button switched off until the reader reproduces the phrase', () => {
    const guarded = /disabled=\{!confirmed \|\| deletion\.state === 'working'\}/u;
    assert.match(
      CONTROL,
      guarded,
      'the button that erases an account must not be operable until the confirmation matches',
    );
    // And the handler checks it again, because Enter in the text field submits the form and
    // `disabled` is a property of one element rather than a rule about the form.
    assert.match(CONTROL, /if \(!confirmed\) return;/u);

    // NEGATIVE CONTROL: the same detector against a version with the guard removed.
    assert.doesNotMatch(
      CONTROL.replace(guarded, "disabled={deletion.state === 'working'}"),
      guarded,
      'the pattern matched a source it should not, so the assertion above proves nothing',
    );
  });

  it('compares what the reader typed against the published constant, not a copy of it', () => {
    assert.match(CONTROL, /import \{ ACCOUNT_DELETE_CONFIRMATION \} from '@prl\/contracts';/u);
    assert.match(CONTROL, /typed\.trim\(\)\.toLowerCase\(\) === ACCOUNT_DELETE_CONFIRMATION/u);
    // A literal phrase in this file would be a second definition of the contract, and the two
    // would drift the first time the wording changed.
    assert.doesNotMatch(
      CONTROL.replaceAll('ACCOUNT_DELETE_CONFIRMATION', ''),
      /'delete my account'/u,
      'the confirmation phrase is written out as a literal somewhere in this component',
    );
  });

  it('states what is DELETED and what is KEPT, before anything can be pressed', () => {
    // The retained half is the part a learner would otherwise discover afterwards, so it is the
    // part pinned here. Each phrase is a fact the API and the migration enforce.
    const retained: readonly RegExp[] = [
      /the hands you have played/u,
      /any table you created/u,
      /A hand belongs to everybody who was in it/u,
      /Tables you created are closed/u,
    ];
    for (const phrase of retained) {
      assert.match(CONTROL_PROSE, phrase, `the reader is not told: ${String(phrase)}`);
    }
    const deleted: readonly RegExp[] = [
      /your sign-ins/u,
      /the lessons you have marked as read/u,
      /every quiz answer/u,
      /every scenario decision/u,
      /your seat at every table/u,
    ];
    for (const phrase of deleted) {
      assert.match(CONTROL_PROSE, phrase, `the reader is not told: ${String(phrase)}`);
    }
    assert.match(CONTROL_PROSE, /no recovery, no undo and no grace period/u);

    // NEGATIVE CONTROL: strip the retained paragraph and the detector must fire. `replaceAll`,
    // because the sentence is now in this file twice — the panel's summary and the confirmation
    // panel's full list both make the promise, and stripping one would leave the other matching.
    const stripped = CONTROL_PROSE.replaceAll('A hand belongs to everybody who was in it', 'It all goes');
    assert.doesNotMatch(
      stripped,
      /A hand belongs to everybody who was in it/u,
      'the phrase check cannot fail, so it was proving nothing',
    );
  });

  it('is operable from a keyboard, with an accessible name that says what it does', () => {
    // A real label bound to a real input, rather than a placeholder standing in for one.
    assert.match(CONTROL, /<label className="prl-field__label" htmlFor=\{fieldId\}>/u);
    assert.match(CONTROL, /id=\{fieldId\}/u);
    assert.match(CONTROL, /aria-describedby=\{hintId\}/u);
    // Both buttons say what they do to what. "OK" and "Yes" are names that mean nothing read out
    // of context, which is exactly how a screen-reader user meets them. The destructive one's
    // label is a JSX expression because it also carries the in-flight wording, so it is matched as
    // the string literal it is rather than as element text.
    assert.match(CONTROL_PROSE, /'Permanently delete my account'/u);
    assert.match(CONTROL_PROSE, /> Keep my account </u);
    assert.doesNotMatch(CONTROL_PROSE, /> (?:OK|Yes|Confirm) </u, 'a button named nothing in particular');
    // The outcome is announced. In the DOM from the first render, empty — a live region that
    // arrives with its text is missed by several screen readers.
    assert.match(CONTROL, /<p className="prl-note" role="status">/u);
    // Nothing here is a clickable div: every interactive element is a native control, so tab
    // order, Enter and Space are the platform's.
    assert.doesNotMatch(CONTROL, /<(?:div|span|p)[^>]*onClick=/u);
  });
});

// ---------------------------------------------------------------------------
// Nothing of the deleted account is left on the screen, and the receipt is
// ---------------------------------------------------------------------------

/**
 * The shared-machine case, which the control used to fail.
 *
 * ## What a reader saw
 *
 * `/record` is a per-reader SERVER render: the finished lesson ids, the attempted scenario ids,
 * the hands played and the lifetime net are drawn by `RecordPage` from the session cookie. The
 * deletion control swapped only its own subtree, so all of that stayed on the screen after the
 * account was gone — directly beneath a receipt reading "Nothing on this page refers to you any
 * more." Measured in Chrome 151 against the built app with the API up: open a table, play one hand
 * to the end, delete the account. The receipt appeared, and above it the page still read
 * "Hands played 1", "Units, net, all time 0 units" and all three lists, until the tab was closed.
 *
 * ## Why the obvious fix was reverted before this one
 *
 * `router.refresh()` on its own re-renders the page with no session and takes the whole deletion
 * panel with it, because `RecordPage` hid that panel whenever the reader was signed out — which is
 * the state a successful deletion produces. The receipt names counts for an account that no longer
 * exists, so it is the one thing on the page that cannot be looked up afterwards.
 *
 * So both halves are asserted here, and they are only correct together: the refresh happens, AND
 * the receipt is on the client side of it.
 */
describe('deleting an account clears the record from the screen and keeps the receipt', () => {
  it('re-renders the server component once the deletion has succeeded', () => {
    assert.match(CONTROL, /import \{ useRouter \} from 'next\/navigation';/u);
    assert.match(CONTROL, /const router = useRouter\(\);/u);
    assert.match(
      CONTROL,
      /router\.refresh\(\);/u,
      'nothing re-runs the server render, so the deleted account’s figures stay on the screen',
    );

    // Ordering is load-bearing: the receipt is put into state BEFORE the refresh is asked for, or
    // the reader gets a frame with neither the record nor the receipt on it. Both needles are
    // written so they match the CODE and not the module header, which discusses both by name.
    const done = CONTROL.indexOf("state: 'done',");
    const refreshed = CONTROL.indexOf('router.refresh();');
    assert.ok(done > 0, 'no `state: done,` assignment found, so the ordering check read nothing');
    assert.ok(refreshed > done, 'the refresh is fired before the receipt reaches state');

    // NEGATIVE CONTROL: the detector against the source it replaced.
    assert.doesNotMatch(
      CONTROL.replace(/router\.refresh\(\);/u, ''),
      /router\.refresh\(\);/u,
      'the refresh check cannot fail, so it was proving nothing',
    );
  });

  it('does not let the page gate the receipt on a session the deletion has just ended', () => {
    // The panel must be rendered unconditionally and decide for itself. A conditional in the page
    // is the exact shape that swallows the receipt, so it is banned by pattern rather than by
    // convention — and by element rather than by name, because wrapping the island in a local
    // `DeletePanel` and gating THAT is how it was written before and would read as a tidy-up.
    const GATED = /\{[^{}]*record\.state[^{}]*\?[^{}]*<(?:AccountDeletion|DeleteAccount|DeletePanel)\b/u;
    assert.doesNotMatch(
      PAGE,
      GATED,
      'the page wraps the deletion panel in a condition on the session, so a successful deletion ' +
        'removes the receipt it just produced',
    );

    // NEGATIVE CONTROL: the detector, fed the exact line this replaced, plus the shape a rename
    // would produce. Without this the check would have passed unchanged against the old page.
    for (const gate of [
      "      {record.state === 'signedOut' ? null : <DeletePanel />}",
      "      {record.state === 'signedOut' ? null : <AccountDeletion deletable />}",
      "      {record.state !== 'signedOut' ? <DeleteAccount /> : null}",
    ]) {
      assert.match(gate, GATED, `the gate detector does not fire on a real gate: ${gate}`);
    }

    // And the receipt's own sentences live in the client component, not in the server render —
    // which is what makes them survive the refresh at all.
    assert.match(CONTROL_PROSE, /Gone for good:/u);
    assert.doesNotMatch(PAGE, /Gone for good/u);
  });
});

// ---------------------------------------------------------------------------
// No native dialogs, anywhere in this client
// ---------------------------------------------------------------------------

/**
 * Every `.ts`/`.tsx` file under `src`, as `{ path, text }`.
 *
 * The whole tree rather than the one component, because the rule is about the client and not
 * about this feature: the moment a second destructive control is written, the cheap way to
 * confirm it is `window.confirm`, and the reasons that is wrong here (it blocks the page, cannot
 * be styled or translated, is suppressed by some browsers, and cannot carry the four sentences a
 * reader needs) apply to that one too.
 */
function sources(directory: string): readonly { readonly path: string; readonly text: string }[] {
  const found: { path: string; text: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sources(full));
    else if (extname(entry.name) === '.ts' || extname(entry.name) === '.tsx') {
      found.push({ path: relative(SRC, full), text: readFileSync(full, 'utf8') });
    }
  }
  return found;
}

const NATIVE_DIALOG = /(?:^|[^.\w])(?:window\.)?(?:confirm|alert|prompt)\s*\(/u;

/**
 * Lines that are prose rather than code, dropped before the scan.
 *
 * `DeleteAccount.tsx` explains at length why it does NOT use a native confirm, so a scan of the
 * raw text would flag the file for the comment saying it is not there — the same trap
 * `migrate.mjs` documents about a migration whose prose mentions a DROP.
 *
 * The rule is deliberately simple: a line whose first non-space characters open or continue a
 * comment. Every block comment in this codebase is written with a leading asterisk per line, so
 * this covers them. What it does NOT cover is a comment that trails real code on the same line,
 * which would be scanned as code — that direction is the safe one for a ban.
 */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

describe('no screen in this client confirms anything with a native dialog', () => {
  const FILES = sources(SRC);

  it('scanned a real tree, so a clean result means something', () => {
    assert.ok(FILES.length > 12, `expected the whole client source tree, scanned ${FILES.length} files`);
    assert.ok(
      FILES.some((file) => file.path.endsWith(join('record', 'DeleteAccount.tsx'))),
      'the deletion control was not in the scanned set, which is the file the rule exists for',
    );
  });

  it('uses no window.confirm, window.alert or window.prompt', () => {
    const offenders = FILES.filter((file) => NATIVE_DIALOG.test(withoutComments(file.text))).map(
      (file) => file.path,
    );
    assert.deepEqual(
      offenders,
      [],
      'a native dialog blocks the page, cannot be styled or translated, is suppressed outright by ' +
        'some browsers after a previous dialog, and cannot carry the sentences a reader needs ' +
        'before an irreversible action. Build the confirmation into the page, as ' +
        'app/record/DeleteAccount.tsx does.',
    );
  });

  it('would notice one: the detector fires on a real call and not on prose about one', () => {
    // NEGATIVE CONTROL. Without it, a regex that had stopped matching anything would report an
    // empty offender list and read exactly like a clean tree.
    for (const violation of [
      'if (window.confirm("are you sure?")) run();',
      'const ok = confirm("really?");',
      '  window.alert("done");',
      'const name = window.prompt("name?");',
    ]) {
      assert.match(withoutComments(violation), NATIVE_DIALOG, `should have been flagged: ${violation}`);
    }
    // And the prose that must NOT be flagged, which is what the comment stripping is for.
    for (const prose of [
      ' * No `window.confirm`, and not only because it is ugly.',
      '// A native confirm(…) would block the page.',
      '/* window.alert() is banned here. */',
    ]) {
      assert.doesNotMatch(withoutComments(prose), NATIVE_DIALOG, `should not be flagged: ${prose}`);
    }
    // The real file, with one real call appended, must be flagged — which proves the stripping
    // above does not also hide a genuine violation in that file.
    assert.match(
      withoutComments(`${CONTROL}\nwindow.confirm('are you sure?');\n`),
      NATIVE_DIALOG,
      'a real call added to the deletion control was not detected',
    );
  });
});
