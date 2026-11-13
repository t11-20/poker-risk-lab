/**
 * The client half of account deletion. `deleteAccount` is driven for real against a stubbed `fetch`,
 * because the API refuses any body but the exact phrase. The control is asserted over source text,
 * because `apps/web` tests run with no DOM, on structure a render could not fake.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_DELETE_CONFIRMATION, API_PATHS } from '@prl/contracts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

// Before the import, because `API_ORIGIN` in `lib/api.ts` is resolved at module evaluation and a
// browser is what makes it the empty string (same as `test/y1-units-readout.test.ts`).
Object.defineProperty(globalThis, 'window', {
  value: { location: { origin: 'http://localhost' } },
  configurable: true,
  writable: true,
});

const { deleteAccount } = await import('../src/lib/api.ts');

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

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
    // Compared to the published constant, because a literal here would agree with itself for ever.
    assert.deepEqual(JSON.parse(request.body), { confirm: ACCOUNT_DELETE_CONFIRMATION });
    assert.ok(result.ok);
    assert.equal(result.data.deleted.roomMemberships, 2);
    assert.equal(result.data.anonymised.handSeats, 7);
  });

  it('never sends the confirmation on a request the caller did not make', async () => {
    // NEGATIVE CONTROL: a fetch made by nothing carries nothing, so the phrase is not sent everywhere.
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

const CONTROL = read('app', 'record', 'DeleteAccount.tsx');
const PAGE = read('app', 'record', 'page.tsx');

/** Whitespace collapsed, because the formatter wraps JSX prose at 110 characters. */
const CONTROL_PROSE = CONTROL.replace(/\s+/gu, ' ');

describe('the control asks twice, and says what survives before it asks at all', () => {
  it('is reachable from /record', () => {
    assert.match(PAGE, /import \{ AccountDeletion \} from '\.\/DeleteAccount\.tsx';/u);
    assert.match(
      PAGE,
      /<AccountDeletion deletable=\{record\.state !== 'signedOut'\} \/>/u,
      'the component exists but the page never renders it',
    );
    // Not offered to a reader with no account, which could only produce a 401.
    assert.match(CONTROL, /if \(!deletable && deletion\.state !== 'done'\) return null;/u);
  });

  it('does not act on the first press: the first press reveals the consequences', () => {
    // The erasure happens only from the form's submit handler, in the `confirming` state.
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
    // Checked again in the handler, because Enter in the text field submits the form.
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
    assert.doesNotMatch(
      CONTROL.replaceAll('ACCOUNT_DELETE_CONFIRMATION', ''),
      /'delete my account'/u,
      'the confirmation phrase is written out as a literal somewhere in this component',
    );
  });

  it('states what is DELETED and what is KEPT, before anything can be pressed', () => {
    // The retained half is what a learner would otherwise discover afterwards.
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

    // NEGATIVE CONTROL. `replaceAll`, because the sentence appears twice in the file.
    const stripped = CONTROL_PROSE.replaceAll('A hand belongs to everybody who was in it', 'It all goes');
    assert.doesNotMatch(
      stripped,
      /A hand belongs to everybody who was in it/u,
      'the phrase check cannot fail, so it was proving nothing',
    );
  });

  it('is operable from a keyboard, with an accessible name that says what it does', () => {
    assert.match(CONTROL, /<label className="prl-field__label" htmlFor=\{fieldId\}>/u);
    assert.match(CONTROL, /id=\{fieldId\}/u);
    assert.match(CONTROL, /aria-describedby=\{hintId\}/u);
    // "OK" and "Yes" mean nothing read out of context. The destructive label is a JSX expression, so it
    // is matched as a string literal.
    assert.match(CONTROL_PROSE, /'Permanently delete my account'/u);
    assert.match(CONTROL_PROSE, /> Keep my account </u);
    assert.doesNotMatch(CONTROL_PROSE, /> (?:OK|Yes|Confirm) </u, 'a button named nothing in particular');
    // In the DOM from the first render, because a live region that arrives with its text is missed.
    assert.match(CONTROL, /<p className="prl-note" role="status">/u);
    assert.doesNotMatch(CONTROL, /<(?:div|span|p)[^>]*onClick=/u);
  });
});

/**
 * `/record` is a per-reader server render, so the control must call `router.refresh()` after a
 * deletion, or the deleted account's figures stay on screen above the receipt (measured in Chrome
 * 151). The receipt must live in the client component, because the refresh removes everything the
 * server rendered for the session.
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

    // The receipt reaches state before the refresh, or the reader gets a frame with neither on it.
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
    // Banned by element, because gating a local `DeletePanel` wrapper is how the old page did it.
    const GATED = /\{[^{}]*record\.state[^{}]*\?[^{}]*<(?:AccountDeletion|DeleteAccount|DeletePanel)\b/u;
    assert.doesNotMatch(
      PAGE,
      GATED,
      'the page wraps the deletion panel in a condition on the session, so a successful deletion ' +
        'removes the receipt it just produced',
    );

    // NEGATIVE CONTROL: the line this replaced, plus the shapes a rename would produce.
    for (const gate of [
      "      {record.state === 'signedOut' ? null : <DeletePanel />}",
      "      {record.state === 'signedOut' ? null : <AccountDeletion deletable />}",
      "      {record.state !== 'signedOut' ? <DeleteAccount /> : null}",
    ]) {
      assert.match(gate, GATED, `the gate detector does not fire on a real gate: ${gate}`);
    }

    // The receipt's sentences live in the client component, which is what survives the refresh.
    assert.match(CONTROL_PROSE, /Gone for good:/u);
    assert.doesNotMatch(PAGE, /Gone for good/u);
  });
});

/**
 * Every `.ts`/`.tsx` file under `src`. The whole tree, because a native confirm blocks the page,
 * cannot be styled or translated and is suppressed by some browsers, wherever it is written.
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
 * Drops lines that open or continue a comment, because `DeleteAccount.tsx` explains why it uses no
 * native dialog. A trailing comment is still scanned as code, which is the safe direction for a ban.
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
    // NEGATIVE CONTROL. A regex that matched nothing would read exactly like a clean tree.
    for (const violation of [
      'if (window.confirm("are you sure?")) run();',
      'const ok = confirm("really?");',
      '  window.alert("done");',
      'const name = window.prompt("name?");',
    ]) {
      assert.match(withoutComments(violation), NATIVE_DIALOG, `should have been flagged: ${violation}`);
    }
    // Prose that must not be flagged.
    for (const prose of [
      ' * No `window.confirm`, and not only because it is ugly.',
      '// A native confirm(…) would block the page.',
      '/* window.alert() is banned here. */',
    ]) {
      assert.doesNotMatch(withoutComments(prose), NATIVE_DIALOG, `should not be flagged: ${prose}`);
    }
    // The real file with one real call appended, so the stripping cannot hide a genuine violation.
    assert.match(
      withoutComments(`${CONTROL}\nwindow.confirm('are you sure?');\n`),
      NATIVE_DIALOG,
      'a real call added to the deletion control was not detected',
    );
  });
});
