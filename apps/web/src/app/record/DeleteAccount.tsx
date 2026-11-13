'use client';

/**
 * Account deletion. Unlike `UnitsReset`, this has something to lose, so a first press only reveals the
 * consequences and the button stays off until the reader types a phrase. The reader is told what
 * survives before confirming. Hand seats are `ON DELETE SET NULL` and created tables are kept, because
 * `prl.hands` cascades from `prl.rooms`. No native dialog, because its message cannot carry that.
 * `RecordPage` renders this unconditionally in a fixed slot, so `useState` and the receipt survive the
 * `router.refresh()` that clears the deleted record above it.
 */

import { ACCOUNT_DELETE_CONFIRMATION } from '@prl/contracts';
import { Button, Callout, Panel, pluralise } from '@prl/ui';
import { useRouter } from 'next/navigation';
import { type FormEvent, type ReactElement, useId, useState } from 'react';
import { deleteAccount, fetchSession } from '@/lib/api.ts';

/**
 * Trimmed and case-folded, because phone keyboards autocapitalise. The API compares strictly, so the
 * request body uses the constant, not this field.
 */
function matchesConfirmation(typed: string): boolean {
  return typed.trim().toLowerCase() === ACCOUNT_DELETE_CONFIRMATION;
}

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
   * Every state except `signedOut`, so `unavailable` keeps the control. Not a condition on the
   * receipt, because a deletion signs the reader out in the same refresh the receipt must survive.
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
    // Also checked here, because Enter in the field submits the form.
    if (!confirmed) return;
    setDeletion({ state: 'working' });
    void (async () => {
      const session = await fetchSession();
      const token = session.ok ? session.data.csrfToken : null;
      if (token === null) {
        setDeletion({
          state: 'failed',
          message:
            'Something went wrong before anything was sent, so nothing was deleted and your account is ' +
            'exactly as it was. Reload the page and try again.',
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
        Clears the deleted record from the server render. After the state is set, so the receipt is
        never missing from the screen.
      */
      router.refresh();
    })();
  };

  if (!deletable && deletion.state !== 'done') return null;

  return (
    <Panel title="Delete your account" eyebrow="Irreversible" index={3} headingLevel={2}>
      {deletion.state === 'done' ? (
        /* The only place these counts can be read, since the account they describe is gone. */
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
            These sentences are enforced by `db/migrations/0004_account_deletion.sql` and proved in
            `apps/api/test/account-deletion.test.ts`.
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

      {/* Mounted empty from the first render. Screen readers miss a region that mounts with its text. */}
      <p className="prl-note" role="status">
        {deletion.state === 'failed' ? deletion.message : ''}
      </p>
    </Panel>
  );
}
