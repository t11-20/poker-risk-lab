# Legal review requirements

**Status:** Launch blocker · **Applies to:** every deployment · **Drafted:** 2026-08-22 ·
**Document revision under review:** `0.1-draft`

This is the list of things a lawyer has to decide before this software is offered to the public,
and the list of settings that have to be decided with them. It exists because the three documents
in `apps/web/src/app/terms`, `apps/web/src/app/privacy` and `apps/web/src/app/responsible-use` were
written by engineers from the source code. Their **factual** half — what is stored, what the chips
are, what deletion removes — is checked against the schema and can be relied on. Their **legal**
half is placeholder text.

Every placeholder is marked on the page with the words **"Requires legal review before launch"**,
and every one of them is a numbered entry below. The two lists are kept in step mechanically:
`apps/web/test/legal-pages.test.ts` fails if a clause is on a page and not in this document, or in
this document and not on the page it claims.

---

## How to use this document

1. **Answer each entry in writing.** Not "reviewed" — an answer, from somebody qualified in each
   place this deployment will be offered, recorded somewhere durable with a date on it.
2. **Replace the placeholder text in the page source with the counsel-approved wording**, and
   remove that clause from `COUNSEL_CLAUSES` in `apps/web/src/lib/legal-config.ts`. The marker
   cannot be removed on its own: it is rendered from the register, so deleting the register entry
   without replacing the prose leaves a page with a gap, and deleting the prose without the entry
   fails the test. That coupling is the point.
3. **Move `LEGAL_REVISION`** in the same file, so a reader can tell which text they are looking at.
4. **Then, and only then, revisit the `robots` decision** — see "Follow-ups that are not legal
   questions" below.

**Nothing in this document is legal advice, and no entry may be closed by an engineer.**

---

## The register

### 1. `operator-identity` — Who operates this deployment

**Appears on:** `/terms` §2, `/privacy` §7.

Which legal entity operates this instance, in which country is it established, and what
identification and contact details must appear on these pages for that entity in the places it
serves readers?

*Facts counsel can rely on:* the software is open source and can be run by anyone; the pages
display whatever `PRL_LEGAL_OPERATOR` and `PRL_LEGAL_CONTACT` contain, and display an explicit
"not supplied by this deployment" where they are unset.

### 2. `age-threshold` — The minimum age, and whether one is required at all

**Appears on:** `/terms` §3, `/responsible-use` §4, and the gate itself at `/age-check`.

Is a minimum age required for a free, play-money poker simulator in each place this deployment is
offered, and if so what is it? Counsel must also say whether an **unverified self-declaration** is
sufficient, because that is all the gate implements and all it can implement without collecting
identity documents.

*Facts counsel can rely on:*

* The software ships with **no age gate**. `PRL_AGE_GATE` is unset by default, and the pages say so
  in an unmissable notice rather than implying a threshold nobody chose. `apps/web/src/lib/age-gate.ts`
  records the argument for that default and the argument against it.
* Turning it on is `PRL_AGE_GATE=on`. `PRL_AGE_GATE_MINIMUM_AGE` sets the threshold (13 to 25;
  18 if unset), `PRL_AGE_GATE_SCOPE` chooses `play` (the simulated tables only) or `site`
  (everything except these three documents and the gate), and `PRL_AGE_GATE_JURISDICTION` names
  the place whose rule the threshold is claimed to satisfy. Where that is unset the gate tells the
  reader, in as many words, that the number is not tied to any jurisdiction.
* The gate stores a cookie recording the threshold declared against, for 180 days. **No date of
  birth is collected and there is no column in the schema that could hold one.**
* The declaration is submitted as a `GET` form so that it works without JavaScript. A third party
  can therefore cause a reader's browser to submit it by sending them a link. This changes nothing
  the reader could not do by pressing the button themselves, and there is no account state behind
  it — but counsel should hear it from us rather than discover it.
* A reader who declares they are under the threshold is not locked out or recorded; they are shown
  an explanation and a link to the written material. A lockout on a self-declaration enforces
  nothing.

### 3. `play-money-classification` — Whether this is a regulated product anywhere it will be offered

**Appears on:** `/terms` §9, `/responsible-use` §6.

Does a product with no stake, no purchase, no prize and no cash-out fall within any gambling,
lottery, skill-gaming or advertising regime in the places this deployment is offered?

*Facts counsel can rely on,* each enforced somewhere mechanical rather than by convention
(`docs/PRODUCT-GUARDRAILS.md` §1):

* No money enters or leaves. There is no purchase, deposit, subscription tied to play, prize,
  tournament with an external reward, or cash-out.
* There is **no column anywhere in the schema that could hold a balance of money**, and no endpoint
  that could transfer a unit between accounts.
* Units are free, resettable at will by the reader, and valueless. The reset is unconditional and
  is never penalised.
* No advertising of any kind, and no affiliate or referral link to a gambling operator.
* Tables are invite-only, enforced by a `CHECK` constraint in the database (ADR 0010), so there is
  no public lobby and no matchmaking between strangers.

### 4. `governing-law` — Governing law and where a dispute is heard

**Appears on:** `/terms` §10.

Which law governs these terms, which forum hears a dispute, and does that choice survive against a
consumer resident elsewhere? Consumer-protection rules in several jurisdictions override a
choice-of-law clause, so a clause that reads as settled may not be.

*Facts counsel can rely on:* the page displays `PRL_LEGAL_GOVERNING_LAW` and nothing else; there is
no arbitration clause, no class-action waiver and no forum selection in the shipped text, because
writing one would be exactly the kind of conclusion this document exists to refuse.

### 5. `liability-and-warranty` — Warranty disclaimer and limitation of liability

**Appears on:** `/terms` §8.

What may this deployment lawfully disclaim and limit, given that parts of a broad exclusion are
unenforceable against consumers in several jurisdictions, and that the software is offered free of
charge?

*Facts counsel can rely on:* the shipped text says only that the software is provided as it is and
that the authors make no warranty; it contains no cap, no exclusion list and no indemnity. The
licence in `LICENSE` covers the software; it does not cover the service a deployer offers.

### 6. `data-controller-and-rights` — Controller identity, lawful basis, and which rights apply

**Appears on:** `/privacy` §2.

Who is the controller of the data in the inventory, on what lawful basis is each category
processed, and which statutory rights — access, rectification, erasure, portability, objection —
must be offered to which readers?

*Facts counsel can rely on:* `/privacy` §2 is a table-by-table inventory taken from
`db/migrations/0001_initial.sql` and the repositories. It is a description of fact and has been
checked. In summary, an account row with a display name and no email or password; a sessions table
holding a SHA-256 of the token and optional **keyed** HMACs of the IP address and user agent (never
the raw values); private table membership; a permanent hand history; lesson, quiz and scenario
records; and an append-only audit log whose detail column is refused by a `CHECK` constraint if it
names a token, an IP, a user agent, an invite code, the deck, a salt or hole cards.

A keyed digest is **pseudonymisation, not anonymisation** — anyone holding the secret can confirm a
guessed address. The pages say so; counsel should assume the weaker property, not the stronger one.

### 7. `retention-and-deletion` — Retention periods, and what deletion must actually remove

**Appears on:** `/privacy` §5.

How long may each category be kept, and does erasure require the hand history to be **deleted**
rather than **detached** from its account?

*Facts counsel can rely on:*

* A session lasts 14 days; a revoked session's row is meant to be removed a day later; an
  unfinished federated sign-in expires after 10 minutes.
* **The sweeps that remove expired rows exist and are tested, and at the time of drafting nothing
  called them on a schedule.** `deleteExpired` and `deleteExpiredLoginAttempts` in
  `apps/api/src/repositories/sessions.ts` had no caller outside the test suite. So an expired
  session is unusable, and its row may still be present. This is an operational gap as well as a
  legal question — see the follow-ups below.
* Account deletion is implemented by `db/migrations/0004_account_deletion.sql` and
  `deleteAccount` in `apps/api/src/repositories/users.ts`. It **deletes** the account row, every
  session, lesson progress, quiz attempts, scenario attempts and table memberships; it
  **detaches** the reader's identity from their hand seats, their audit-log rows and any table they
  created; and it **retains every hand in full**, because a hand is a shared record that is also in
  four other people's history.
* Deleting a hand is not merely a policy choice: the runtime database role holds **no `DELETE`
  privilege at all** on `prl.hands`, `prl.hand_seats` or `prl.hand_actions`. If counsel concludes
  that erasure must remove hand history, that is a migration, a change to the least-privilege
  grants, and a decision about the other players in those hands — not a code change.
* **Abandoned guest accounts are erased sixty days after they were last seen** (since 2026-08-25;
  `apps/api/src/maintenance/retention-sweep.ts`). Two things counsel should be told plainly about
  that number. It is **not stated in any specification** — the four places that documented this
  sweep before it existed name the mechanism and the column and write the period as `<cutoff>` —
  so it is **derived**: a guest has no email, no password and no federated identity, its only
  credential is a session cookie, and a session cannot outlive sixty days from creation, so that
  is the point at which the account can no longer be reached by anybody. And it is the *floor*
  rather than the whole rule: no account holding a live session, a table membership, a seat in any
  hand, or a room of its own is ever removed, at any age. If counsel decides a different period is
  required, it is one constant.

### 8. `international-transfer` — Where the data physically sits, and who may reach it

**Appears on:** `/privacy` §7.

In which country does this deployment run its database and its backups, who administers them, and
what transfer mechanism or disclosure does that require for the readers it serves?

*Facts counsel can rely on:* the application makes no outbound connection other than to its own
database and, if configured, to an OIDC identity provider. There is no analytics provider, no
error-reporting service, no CDN and no remote font — the content-security policy has no host for
any of them. `PRL_LEGAL_HOSTING_REGION` is what the page displays.

### 9. `ai-legend-naming` — Name, image and likeness for attributed opponent profiles

**Appears on:** `/terms` §5, `/responsible-use` §5.

May this deployment display the attributed names carried in `packages/poker-ai`, and on what
permission?

**Until this entry is answered in writing, `PRL_LEGEND_NAMING` must remain unset.** Unset resolves
to `archetype`, which shows generic style names only. This is not a preference and it is not
belt-and-braces: ADR 0011 makes the safe mode the default precisely so that a deployer who never
reads this document cannot ship attributed names by accident, and setting the variable is the act
that is supposed to prompt this question.

*Facts counsel can rely on:*

* The profiles are **not** simulations of real people. Each is a sixteen-axis numeric trait vector,
  built from tendencies discussed publicly in general terms, not from anyone's hand histories,
  private decisions or thinking.
* The educational content is **byte-identical** in both naming modes — the traits, the counter-
  strategy, the model basis, every computed figure. Only the identity fields change.
* No commentary narrates any person's thoughts. `assertNoImpersonation()` runs at profile load time
  over every learner-facing string and again on every generated commentary string, and
  `ModelReasoning` has no field capable of holding a mental state.
* Every profile is accompanied by disclaimers as structured data — there is no code path producing
  a profile card without them — stating that the profiles are not real people, not digital copies
  of anyone, and **not endorsed by anyone**. Attributed mode adds a further disclaimer stating that
  the model does not reproduce how that person plays and is not affiliated with or approved by them.
* Some of the profiles under consideration are attributed to players who have died. That changes
  nothing about the analysis: being unable to object is not a reason to be less careful.

---

## Configuration that has to be decided before launch

Read by the web app at **runtime**, on the server. None is a `NEXT_PUBLIC_` variable, deliberately:
`.env.example` explains at length why a build-time value cannot be retargeted, and an operator name
frozen into an image is that defect wearing a different hat.

| Variable | Meaning | Unset behaviour |
| --- | --- | --- |
| `PRL_LEGAL_OPERATOR` | The entity operating this instance | Pages show "not supplied by this deployment" |
| `PRL_LEGAL_CONTACT` | How to reach them about these documents | As above |
| `PRL_LEGAL_GOVERNING_LAW` | The law the terms are stated under | As above |
| `PRL_LEGAL_HOSTING_REGION` | Where the database and backups live | As above |
| `PRL_LEGAL_EFFECTIVE_DATE` | `YYYY-MM-DD` these documents took effect | As above; a malformed value is ignored and reported |
| `PRL_LEGAL_SUPPORT_RESOURCE` | A gambling-support organisation for this audience, as plain text | `/responsible-use` says no organisation is named and why |
| `PRL_AGE_GATE` | `on` or `off` | No gate, and the pages say nobody has decided |
| `PRL_AGE_GATE_MINIMUM_AGE` | 13 to 25 | 18, described on the page as a placeholder rather than a determination |
| `PRL_AGE_GATE_SCOPE` | `play` or `site` | `play` |
| `PRL_AGE_GATE_JURISDICTION` | The place the threshold is set for | The gate says the threshold is tied to no jurisdiction |
| `PRL_LEGEND_NAMING` | `archetype` or `attributed` | `archetype`. **Must stay unset until entry 9 is answered.** |

**All eleven are now in `.env.example`.** This line used to say they were not, and that was
true of the change that produced this document — it has since been done. The three age-gate
variables that ship with a value are set there (`PRL_AGE_GATE=off`,
`PRL_AGE_GATE_MINIMUM_AGE=18`, `PRL_AGE_GATE_SCOPE=play`); the other eight are present as
commented placeholders with the reason beside each, because for these the *unset* behaviour is
the deliberate one. A blank operator name renders as a visible "not configured" marker, while
a plausible default would read as a reviewed term.

---

## Follow-ups that are not legal questions

Engineering work that this review unblocks or depends on. None of it closes a register entry.

1. **`robots` is `noindex, nofollow` on all three documents**, inherited from the root layout and
   deliberately not overridden. Publishing unreviewed placeholder clauses to a search index under a
   real operator's name is a worse failure than being unfindable. Once the register is closed and
   the placeholders are replaced, that decision should be revisited on purpose.
2. **Done: the expiry sweeps are scheduled.** This read "Entry 7 depends on it: today the
   retention paragraph on `/privacy` is honest only because it says the sweep does not run."
   `apps/api/src/maintenance/retention-sweep.ts` now calls `deleteExpired` and
   `deleteExpiredLoginAttempts` every six hours, in bounded batches, started after `listen` and
   stopped before the shutdown drain. It runs in the API process rather than as a systemd unit —
   unlike the backups, it needs exactly the privileges the API already has on exactly the tables
   the API already owns, and it is meaningless while the API is down; that reasoning is in the
   file. `apps/api/test/retention-sweep.test.ts` covers the backlog, the pass ceiling and its
   reporting, a database failure the schedule survives, and the overlap guard.

   What is **not** closed is entry 7 itself, which is a question for counsel: how long each
   category may be kept, and whether erasure must delete hand history rather than detach it. The
   sweep enforces the periods the code already implements (14-day session, 24-hour revoked-row
   grace, 10-minute sign-in attempt); it does not decide them. The `/privacy` §5 wording needs
   re-reading now that the sweep runs, because the sentence that made it honest was the admission
   that it did not.

   **Since 2026-08-25 the same schedule also erases abandoned guest accounts**, which is the one
   period here that the code did *not* already implement and no document stated — see the fact
   above and `docs/production/legal-register.md` D4 for the derivation. `/privacy` §5 is now
   inaccurate for that category and says everything except sessions is kept "until you delete your
   account"; correcting it is E11 in that register.
3. **Done: `.env.example` carries all eleven variables above.** This follow-up read "needs the
   eleven variables above … outside the scope of the change that produced this document and was
   not edited". They are there now — grep it for `PRL_AGE_GATE`, `PRL_LEGAL_` and
   `PRL_LEGEND_NAMING`. What is *not* done is anything about their values: every legal placeholder
   is still commented out, which is the register's problem, not the example file's.
4. **Stale, and worth recording as stale rather than deleting.** This read: "`a11y-audit.mjs`
   crawls from `/` and follows links, so a redirect at `/play` would leave the table screens
   silently unaudited while the report still says PASS." That is no longer true and is the more
   dangerous half of the original claim, so the correction matters. `a11y-audit.mjs` sends a
   declaration cookie, compares the URL it LANDED on against the one it asked for, and records any
   route the gate answered as UNAUDITABLE — which fails the run, with the gate named and with
   `--routes /age-check` offered as the way to audit the interstitial deliberately. An
   interstitial can no longer be audited under the name of `/play`.
   `scripts/keyboard-audit.mjs` drives `/play` directly and fails outright, which is the correct
   behaviour and always was. The shipped default (no gate) still avoids the question entirely,
   which remains one of the three reasons it is the default.
5. **Done: the gate has a browser-level test, and it found the gate broken.** This read: "The gate
   has no browser-level test. The pure decisions are covered by `apps/web/test/age-gate.test.ts`;
   that a redirect and a `Set-Cookie` actually reach a browser, and that an in-app router
   navigation is gated as well as a document navigation, needs a running server and is not covered
   anywhere yet." `scripts/age-gate-audit.mjs` — `pnpm run test:age-gate` — is that test, and the
   half this follow-up singled out was the half that was wrong.

   **The defect it found.** The proxy decided whether a request was an in-app router navigation by
   reading the `rsc` header, which is what the App Router sends. Next deletes that header, with the
   rest of its `FLIGHT_HEADERS`, before middleware runs. So the branch was dead: **with the gate
   switched on, a reader who clicked "Play" in the site header from any page went straight to the
   tables, every time.** Only a hard document navigation was ever gated. It found a second one
   beside it: the proxy matcher excluded `purpose: prefetch` on the reasoning that a prefetch is
   not a document, and that header changes nothing on the server — such a request was answered with
   the complete page, ungated and with no Content-Security-Policy on it. Both are fixed
   (`isRouterNavigation` and `isRouterPrefetch` in `apps/web/src/lib/guest-bootstrap.ts`), and the
   pure halves of both are now in `apps/web/test/guest-bootstrap.test.ts` so an ordinary `pnpm test`
   catches a regression without needing a build.

   **What is now covered**, against a production build the harness starts itself, with the gate
   switched on at a threshold of 21 (deliberately not the built-in default, so a server that
   ignored its configuration could not pass): a document navigation to a gated route is redirected
   with a real 303 and a real `Location`; the declaration's `Set-Cookie` is the shape a browser
   over plain HTTP will keep, records the threshold rather than a flag, is refused when it names a
   lower one, and is stored and honoured by a real Chrome that pressed the real button; an in-app
   router navigation is gated, measured both as a request shape and by clicking the real `<Link>`
   and asserting that the click travelled as a router fetch rather than as a page load; a router
   prefetch is not gated and its payload carries neither the page nor the interstitial; and
   `PRL_AGE_GATE_SCOPE=site` gates `/`, `/learn` and `/lab` while leaving `/age-check`, `/terms`,
   `/privacy` and `/responsible-use` open. Every refusal has a request beside it that must succeed,
   and the run refuses to pass unless it refused something, allowed something, and used a browser.

   **It is a release gate.** `test:age-gate` sits in the `pnpm run verify` loop directly after
   `test:csp` — eleventh of the fourteen, in run order. The production build it needs is already
   guaranteed there — `build` runs ahead of the browser harnesses, and `test:ax` and `test:csp`
   depend on exactly the same thing — so it costs about twenty seconds and one more Chrome launch
   and changes nothing else about the gate's shape. The reason it is in the list rather than beside
   it: this is the only check in the repository that exercises the age gate switched **on**, the
   gate is off by default so every other gate runs past it, and the defect above survived from the
   day the gate landed precisely because nothing did this.

   **What is still not covered.** It is one
   browser: Chrome. It is plain HTTP, so the `__Host-` cookie name and the `x-forwarded-proto` path
   a TLS deployment takes are untested, and what is asserted instead is the other half — that over
   http the cookie is *not* `__Host-` and *not* `Secure`, which is the case that would otherwise be
   a silent redirect loop. And none of it says anything about the shipped configuration, which has
   no gate: that is entry 1 above, and it is still open.

---

## What this document deliberately does not do

It does not answer any of the questions above, name a jurisdiction, assert compliance with any
regime, or claim that any part of this product is or is not regulated. Every entry is written as a
question so that an answer is a thing somebody can be shown to have given.
