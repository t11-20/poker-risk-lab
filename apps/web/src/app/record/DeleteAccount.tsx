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
 */

import { ACCOUNT_DELETE_CONFIRMATION } from '@prl/contracts';
import { Button, Callout, pluralise } from '@prl/ui';
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

export function DeleteAccount(): ReactElement {
  const [deletion, setDeletion] = useState<DeleteState>({ state: 'closed' });
  const [typed, setTyped] = useState('');
  const fieldId = useId();
  const hintId = useId();

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
    })();
  };

  if (deletion.state === 'done') {
    const { outcome } = deletion;
    return (
      <div className="prl-stack">
        <Callout tone="insight" title="Your account has been deleted">
          <p className="prl-prose">
            {`Gone for good: ${pluralise(outcome.sessions, 'sign-in')}, ` +
              `${pluralise(outcome.lessonsCompleted, 'lesson')} marked as read, ` +
              `${pluralise(outcome.quizAttempts, 'quiz answer')}, ` +
              `${pluralise(outcome.scenarioAttempts, 'scenario decision')} and ` +
              `${pluralise(outcome.roomMemberships, 'seat')} at a table.`}
          </p>
          <p className="prl-prose">
            {`Kept, with your name taken off them: ${pluralise(outcome.handSeats, 'seat')} in hands that ` +
              `were played, and ${pluralise(outcome.roomsCreated, 'table')} you created — now closed. ` +
              'Those hands belong to the other people who were in them as much as to you, so they stay, ' +
              'with nothing in them pointing back at you.'}
          </p>
          <p className="prl-prose">
            You are signed out. Nothing on this page refers to you any more, and opening a table again starts
            a brand-new account with no connection to the old one.
          </p>
        </Callout>
      </div>
    );
  }

  return (
    <div className="prl-stack">
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
              Deleted outright: your sign-ins, the lessons you have marked as read, every quiz answer, every
              scenario decision, and your seat at every table — the ones you are sitting at and the ones you
              have left.
            </p>
            <p className="prl-prose">
              Kept, with your name removed: the hands you have played, and any table you created. A hand
              belongs to everybody who was in it — deleting it would erase it from their history too — so your
              seat in it stays, holding what it was dealt and what it won or lost, and stops naming anybody.
              Tables you created are closed and stop naming you; they are not deleted, because the hands
              played at them would go with them.
            </p>
            <p className="prl-prose">
              There is no recovery, no undo and no grace period. We cannot put this back for you afterwards,
              and neither can you.
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

      {/*
        In the DOM from the first render, empty. A live region that arrives at the same moment as
        its text is missed by several screen readers, and the failure message here is the only
        thing telling the reader their account is still there.
      */}
      <p className="prl-note" role="status">
        {deletion.state === 'failed' ? deletion.message : ''}
      </p>
    </div>
  );
}
