'use client';

/**
 * The control that lets a learner leave, and the sentences that make it an informed decision.
 *
 * ## What was wrong
 *
 * There was no way out. `/record` offered a units reset and nothing else, the API had no deletion
 * route, and the schema actively refused one: two foreign keys were `ON DELETE RESTRICT`, so any
 * learner who had created or joined a table could not have been removed even by hand. A product
 * that opens an account in one request with no email and no password, and then has no way to close
 * it, has made a decision about somebody else's data on their behalf.
 *
 * ## Why this looks nothing like `UnitsReset.tsx`, two files away
 *
 * That component's header says, in as many words, why it has no confirmation dialog: "There is
 * nothing to lose. Units are free, worth nothing... a 'are you sure?' would be ceremony implying a
 * stake that does not exist." Every word of that is true of a reset and false of this. Here there
 * IS something to lose, it cannot be recovered, and the friction is the feature rather than a dark
 * pattern.
 *
 * So the shape is deliberately the inverse: a first press reveals what will happen instead of
 * doing it, and the destructive button does not become operable until the reader has reproduced a
 * phrase. Two independent gestures, with the consequences on screen between them.
 *
 * ## Why the reader is told what SURVIVES, before they confirm
 *
 * Because the honest answer is not "everything goes", and finding that out afterwards would be
 * worse than being told now. A hand is a shared record — four other people were in it, it is in
 * their history, and `prl.hand_seats.user_id` is `ON DELETE SET NULL` precisely so the hand
 * survives with the seat anonymised. Tables this learner created stay too, because
 * `prl.hands` cascades from `prl.rooms` and deleting the table would delete everybody else's
 * hands with it. The panel says all of that in the sentences the reader reads before pressing
 * anything, and the API's response repeats it as counts afterwards.
 *
 * ## No `window.confirm`, and not only because it is ugly
 *
 * A native confirm blocks the whole page, cannot be styled or translated, is suppressed outright
 * by some browsers after a previous dialog, and — the part that matters here — its message cannot
 * carry the four sentences above. A reader who is told "Are you sure?" has not been told anything.
 *
 * ## Keyboard and assistive technology
 *
 * Everything here is a native `<button>` or a native `<input>` with a real `<label>`, so tab
 * order, Enter and Space are the platform's and not this component's. The confirmation panel is a
 * `<form>`, which makes Enter in the text field submit it — the same gesture as pressing the
 * button, rather than a dead key. Each button's accessible name is its visible text and says what
 * it does to what ("Permanently delete my account"), never "OK" or "Yes". The outcome is announced
 * through a live region that is in the DOM from the first render for the reason `UnitsReset`
 * states: a region that arrives with its text is missed by several screen readers.
 *
 * ## Why this component owns its whole panel, and why `RecordPage` renders it unconditionally
 *
 * ### The defect
 *
 * Deleting an account left the deleted account's record on the screen. This component swapped only
 * its own subtree, and everything `RecordPage` had server-rendered above it — the finished lesson
 * ids, the attempted scenario ids, the hands played and the lifetime net — stayed exactly where it
 * was, directly under a receipt reading "Nothing on this page refers to you any more." Measured in
 * Chrome 151 against the built app with the API up: one hand played, then deleted. After the
 * receipt appeared, `/record` still read "Hands played 1", "Units, net, all time 0 units" and the
 * three lists, for as long as the tab stayed open. On a shared machine that is the whole of what
 * the deletion was for.
 *
 * ### Why `router.refresh()` alone was measured and REVERTED
 *
 * A refresh re-renders the server component with no session, so the panel above goes. It also took
 * the receipt with it: `RecordPage` hid this entire panel whenever `record.state === 'signedOut'`,
 * which is exactly the state a successful deletion produces. The receipt names counts — how many
 * sign-ins, quiz answers, scenario decisions and seats went, and what was kept with the reader's
 * name taken off it — and it is the one thing on the page a reader cannot go and look up
 * afterwards, because the account it describes no longer exists. Trading it for the refresh is a
 * worse page than the defect.
 *
 * ### What is done instead
 *
 * The conditional moved into this client component, so the receipt is on the client side of it and
 * survives the refresh. `RecordPage` renders this unconditionally and passes `deletable`; this
 * component renders nothing at all for a reader who has no account to delete, the control for a
 * reader who has one, and the receipt for a reader who has just used it — whatever `deletable`
 * then says. Because the element is always in the same slot of `RecordPage`'s children, React
 * reconciles it as the same instance across the refresh and `useState` is preserved, which is what
 * Next's own `router.refresh()` contract promises ("without losing unaffected client-side React").
 */

import { ACCOUNT_DELETE_CONFIRMATION } from '@prl/contracts';
import { Button, Callout, Panel, pluralise } from '@prl/ui';
import { useRouter } from 'next/navigation';
import { type FormEvent, type ReactElement, useId, useState } from 'react';
import { deleteAccount, fetchSession } from '@/lib/api.ts';

/**
 * What the reader has typed, compared the way a person means it.
 *
 * Trimmed and case-folded, because "Delete My Account" from a phone keyboard with autocapitalise
 * on is the same intent as the lower-case phrase, and refusing it would be the control failing for
 * the reader who did exactly what was asked. The API compares strictly, which is why the request
 * body is built from the constant in `lib/api.ts` rather than from this field: the reader's typing
 * is the consent, and the constant is the wire format.
 */
function matchesConfirmation(typed: string): boolean {
  return typed.trim().toLowerCase() === ACCOUNT_DELETE_CONFIRMATION;
}

/** What was actually removed and what was kept, as the API reported it. */
interface Outcome {
  readonly sessions: number;
  readonly lessonsCompleted: number;
  readonly quizAttempts: number;
  readonly scenarioAttempts: number;
  readonly roomMemberships: number;
  readonly handSeats: number;
  readonly roomsCreated: number;
}

type DeleteState =
  | { readonly state: 'closed' }
  | { readonly state: 'confirming' }
  | { readonly state: 'working' }
  | { readonly state: 'done'; readonly outcome: Outcome }
  | { readonly state: 'failed'; readonly message: string };

export interface AccountDeletionProps {
  /**
   * Whether there is an account to delete — every state except `signedOut`.
   *
   * Not a tidiness rule: there is no account to delete when nobody is signed in, so the control
   * could only ever produce a 401, and offering an irreversible action that cannot work is worse
   * than not offering it. `unavailable` is a different case and keeps the control — that reader
   * has an account, and whether they can leave must not depend on whether their figures loaded.
   *
   * It is deliberately NOT a condition on the receipt below. A successful deletion signs the
   * reader out, so this goes false in the very same refresh that the receipt has to survive.
   */
  readonly deletable: boolean;
}

export function AccountDeletion({ deletable }: AccountDeletionProps): ReactElement | null {
  const [deletion, setDeletion] = useState<DeleteState>({ state: 'closed' });
  const [typed, setTyped] = useState('');
  const fieldId = useId();
  const hintId = useId();
  const router = useRouter();

  const confirmed = matchesConfirmation(typed);

  const run = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    // Checked here as well as by the disabled button, because a form can be submitted by pressing
    // Enter in the field and because `disabled` is a property of one element rather than a rule.
    if (!confirmed) return;
    setDeletion({ state: 'working' });
    void (async () => {
      const session = await fetchSession();
      const token = session.ok ? session.data.csrfToken : null;
      if (token === null) {
        setDeletion({
          state: 'failed',
          message:
            'This page could not get a security token from the server, so nothing was sent and your ' +
            'account is exactly as it was. Reload and try again.',
        });
        return;
      }
      const result = await deleteAccount(token);
      if (!result.ok) {
        setDeletion({ state: 'failed', message: `${result.error.message} Nothing was deleted.` });
        return;
      }
      setDeletion({
        state: 'done',
        outcome: {
          sessions: result.data.deleted.sessions,
          lessonsCompleted: result.data.deleted.lessonsCompleted,
          quizAttempts: result.data.deleted.quizAttempts,
          scenarioAttempts: result.data.deleted.scenarioAttempts,
          roomMemberships: result.data.deleted.roomMemberships,
          handSeats: result.data.anonymised.handSeats,
          roomsCreated: result.data.anonymised.roomsCreated,
        },
      });
      /*
        The half that actually removes the deleted account's record from the screen.

        `RecordPage` is a per-reader server render carrying the session cookie, and the deletion
        has just invalidated it — so re-running it is what turns the panel above into "there is no
        session to read a record with". Fired after the state is set, not before: this component's
        own subtree is on the client side of the refresh and keeps the receipt, and a refresh that
        landed first would briefly draw a page with neither the record nor the receipt on it.
      */
      router.refresh();
    })();
  };

  /*
    Nothing to show a reader with no account and no receipt. The two conditions are separate on
    purpose — see `deletable` above and the module header: after a successful deletion this reader
    has no account AND has a receipt, and that is the case the old structure could not render.
  */
  if (!deletable && deletion.state !== 'done') return null;

  return (
    <Panel title="Delete your account" eyebrow="Irreversible" index={3} headingLevel={2}>
      {deletion.state === 'done' ? (
        /*
          The receipt, and the reason this whole panel moved inside a client component. It is on
          the client side of `router.refresh()`, so the refresh that clears the record above cannot
          take it with it. The counts it names describe an account that no longer exists, so this
          is the last and only place a reader can read them.
        */
        <Callout tone="insight" title="Your account has been deleted">
          <p className="prl-prose">
            {`Gone for good: ${pluralise(deletion.outcome.sessions, 'sign-in')}, ` +
              `${pluralise(deletion.outcome.lessonsCompleted, 'lesson')} marked as read, ` +
              `${pluralise(deletion.outcome.quizAttempts, 'quiz answer')}, ` +
              `${pluralise(deletion.outcome.scenarioAttempts, 'scenario decision')} and ` +
              `${pluralise(deletion.outcome.roomMemberships, 'seat')} at a table.`}
          </p>
          <p className="prl-prose">
            {`Kept, with your name taken off them: ${pluralise(deletion.outcome.handSeats, 'seat')} in ` +
              `hands that were played, and ${pluralise(deletion.outcome.roomsCreated, 'table')} you ` +
              'created — now closed. Those hands belong to the other people who were in them as much as ' +
              'to you, so they stay, with nothing in them pointing back at you.'}
          </p>
          <p className="prl-prose">
            You are signed out. Nothing on this page refers to you any more, and opening a table again starts
            a brand-new account with no connection to the old one.
          </p>
        </Callout>
      ) : (
        <>
          {/*
            The panel's own copy, and it is written in the future tense — so it is rendered only
            while it is still about something that has not happened. The control expands into the
            full list of what goes and what stays before anything can be pressed. Everything true
            about that list is enforced in `db/migrations/0004_account_deletion.sql` and proved in
            `apps/api/test/account-deletion.test.ts`, which is what stops these sentences from
            becoming a claim nobody checks.
          */}
          <p className="prl-prose">
            You can close this account and take your record with you. Your sign-ins, the lessons you have
            marked as read, your quiz answers, your scenario decisions and your seat at every table are
            deleted outright — there is no recovery and no grace period.
          </p>
          <p className="prl-prose">
            Two things are kept rather than deleted, with your name removed from them: the hands you have
            played, and any table you created. A hand belongs to everybody who was in it — deleting it would
            erase it from their history too — so the seat stays and stops naming anybody. Tables you created
            are closed and detached for the same reason: the hands played at them would go with them.
          </p>

          {deletion.state === 'closed' ? (
            <p className="prl-btn-row">
              <Button
                variant="secondary"
                onClick={() => {
                  setTyped('');
                  setDeletion({ state: 'confirming' });
                }}
              >
                Delete my account
              </Button>
            </p>
          ) : (
            <form className="prl-stack" onSubmit={run}>
              <Callout tone="warning" title="This cannot be undone">
                <p className="prl-prose">
                  Deleted outright: your sign-ins, the lessons you have marked as read, every quiz answer,
                  every scenario decision, and your seat at every table — the ones you are sitting at and the
                  ones you have left.
                </p>
                <p className="prl-prose">
                  Kept, with your name removed: the hands you have played, and any table you created. A hand
                  belongs to everybody who was in it — deleting it would erase it from their history too — so
                  your seat in it stays, holding what it was dealt and what it won or lost, and stops naming
                  anybody. Tables you created are closed and stop naming you; they are not deleted, because
                  the hands played at them would go with them.
                </p>
                <p className="prl-prose">
                  There is no recovery, no undo and no grace period. We cannot put this back for you
                  afterwards, and neither can you.
                </p>
              </Callout>

              <div className="prl-field">
                <label className="prl-field__label" htmlFor={fieldId}>
                  {`To confirm, type ${ACCOUNT_DELETE_CONFIRMATION}`}
                </label>
                <input
                  className="prl-input"
                  id={fieldId}
                  name="confirm"
                  type="text"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={64}
                  aria-describedby={hintId}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                />
                <p className="prl-field__hint" id={hintId}>
                  {'Typing the words is the second of the two deliberate steps this needs. Capital letters ' +
                    'and stray spaces are fine. The button below stays switched off until the field reads ' +
                    `“${ACCOUNT_DELETE_CONFIRMATION}”.`}
                </p>
              </div>

              <p className="prl-btn-row">
                <Button variant="primary" type="submit" disabled={!confirmed || deletion.state === 'working'}>
                  {deletion.state === 'working' ? 'Deleting…' : 'Permanently delete my account'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setTyped('');
                    setDeletion({ state: 'closed' });
                  }}
                  disabled={deletion.state === 'working'}
                >
                  Keep my account
                </Button>
              </p>
            </form>
          )}
        </>
      )}

      {/*
        In the DOM from the first render, empty, and still mounted alongside the receipt so it is
        never re-inserted. A live region that arrives at the same moment as its text is missed by
        several screen readers, and the failure message here is the only thing telling the reader
        their account is still there.
      */}
      <p className="prl-note" role="status">
        {deletion.state === 'failed' ? deletion.message : ''}
      </p>
    </Panel>
  );
}
