/**
 * The legal surface's configuration, and the register of clauses that a lawyer has to write.
 *
 * ## The defect this exists for
 *
 * There were no legal pages at all. No terms, no privacy policy, no responsible-use statement — in
 * an application that creates a database row for every visitor to `/learn`, stores their display
 * name, keeps a permanent hand history and writes an audit log. Whatever a deployer's obligations
 * turn out to be, "there is no document" is not a defensible starting point, and the absence was
 * invisible because nothing links to a page that does not exist.
 *
 * ## What this module is, and what it refuses to be
 *
 * It is the single source of three things the pages must not disagree about:
 *
 *  1. **The deployment facts** — who operates this instance, how to reach them, which law the terms
 *     are stated under, where the database physically sits, and the date the documents took effect.
 *     Every one of them is read from the live process environment, and every one of them is `null`
 *     until somebody sets it. Null is rendered as a visible gap, never as a plausible-looking
 *     default: a privacy policy naming the wrong controller is worse than one that says nobody has
 *     named a controller yet.
 *  2. **The register of clauses that require counsel.** `COUNSEL_CLAUSES` is the list, the pages
 *     render each entry inline where the clause sits, and `docs/production/legal-review-
 *     requirements.md` lists the same entries. `test/legal-pages.test.ts` asserts the three stay in
 *     step, so a clause cannot be quietly dropped from a page while remaining on the lawyer's list,
 *     or removed from the list while a page still carries its marker.
 *  3. **The one claim the product makes about transfer of skill**, `PLAY_MONEY_WARNING`. It appears
 *     on the age gate and on `/responsible-use`, and it is the sentence most likely to be softened
 *     by somebody improving the copy, so it is a constant with a test on it rather than prose in
 *     two places.
 *
 * It contains no legal text and draws no legal conclusion. Nothing here decides whether this
 * product is regulated anywhere, what age anyone must be, or which statutory rights apply to a
 * reader. Those are the questions in `COUNSEL_CLAUSES`, written as questions precisely so that an
 * answer can be checked off rather than assumed.
 *
 * ## Why the marker is data and not a component
 *
 * `COUNSEL_MARKER` is one string used by all three pages, and the markup around it is a handful of
 * elements repeated in each. That repetition is deliberate rather than overlooked: there is no
 * shared legal-component module in this app to put it in, and inventing one for three uses would
 * put the marker further from the prose it qualifies. What must not drift — the marker's wording,
 * the clause list, and which page owns which clause — is centralised here and pinned by the test.
 *
 * ## Why these are environment variables and not build constants
 *
 * `.env.example` is emphatic that `NEXT_PUBLIC_*` is banned in this repository: `next build`
 * inlines it, so a built image can never be retargeted. An operator name baked into an image at
 * build time is the same defect wearing a different hat — one image per deployer, and a wrong one
 * the moment an entity is renamed. These are read on the server at request time, in a page that is
 * already dynamic, so a container restart is the whole of a change.
 *
 * ## What breaks if this is removed
 *
 * The three pages lose their only mechanism for distinguishing reviewed text from placeholder text,
 * and a reader can no longer tell which is which. That is the specific failure the marker exists to
 * prevent.
 */

/** The three documents' routes. Deliberately absent from `NAV_DESTINATIONS` — see `lib/nav.ts`. */
export const LEGAL_PATHS = {
  terms: '/terms',
  privacy: '/privacy',
  responsibleUse: '/responsible-use',
} as const;

export type LegalPageKey = 'terms' | 'privacy' | 'responsible-use';

/**
 * The revision of the *text* in `src/app/terms`, `src/app/privacy` and `src/app/responsible-use`.
 *
 * A code constant rather than an environment variable, because it describes the source, not the
 * deployment. `-draft` says what it is: drafted by engineers from the schema and the code, and not
 * reviewed by anybody qualified to review it. Whoever replaces a clause with counsel-approved
 * wording moves this past `draft` entirely.
 *
 * `0.2-draft` because §11 makes a promise to a reader — "when the text changes, the revision changes
 * with it" — and the text materially changed: `/terms` §7 no longer states that the service is free
 * of charge, and two clauses were added to `COUNSEL_CLAUSES`. A reader who was shown the old §7 was
 * shown a different document, and the only mechanism this product has for telling them so is this
 * string. It is still `draft`: nothing here has been reviewed, and moving the leading digit would
 * claim that it had.
 */
export const LEGAL_REVISION = '0.2-draft';

/** When the text in those three routes was last edited. Kept beside the revision it describes. */
export const LEGAL_DRAFTED_ON = '2026-08-25';

/**
 * The marker. One string, on every clause that a lawyer has to write before launch.
 *
 * Short enough to sit inline without becoming furniture, and worded as an instruction rather than a
 * hedge — "requires legal review" states an outstanding action, where something like "subject to
 * change" reads as boilerplate and would be skimmed past. It is rendered as text, never as a colour
 * or an icon alone: `docs/PRODUCT-GUARDRAILS.md` §6 forbids colour as the sole carrier of meaning,
 * and this is the one distinction on these pages a reader most needs to make.
 */
export const COUNSEL_MARKER = 'Requires legal review before launch';

/** The sentence that explains the marker, shown once per page above the first clause that uses it. */
export const COUNSEL_MARKER_EXPLANATION =
  'Passages carrying this marker are placeholders written by the people who built this software, ' +
  'from what the software actually does. They are not legal advice, they have not been reviewed by ' +
  'a lawyer, and they may be wrong or unenforceable where you are. Every one of them is listed in ' +
  'docs/production/legal-review-requirements.md for whoever deploys this.';

/**
 * What practising here does and does not transfer to, said once and reused.
 *
 * `docs/PRODUCT-GUARDRAILS.md` §1 forbids any "claim, implication or vibe suggesting that skill
 * here converts into money elsewhere", and §3 forbids claiming to be right. The awkward truth this
 * sentence carries is that a play-money table removes the one variable that dominates real results
 * — that losing costs something — so the habits it rewards are not the habits that survive a real
 * stake, and the arithmetic being correct does nothing to change that.
 *
 * Worded as a statement of what the practice omits, rather than as a warning about risk of harm.
 * The second framing is the one gambling operators use, and it works as advertising: it implies
 * there is something to be at risk of gaining.
 */
export const PLAY_MONEY_WARNING =
  'Playing well here does not mean you would play well, or win, for money. The chips are free and ' +
  'resettable, so nothing in this app can teach you how you behave when a loss costs you something ' +
  '— which is the variable that decides most real results. Nothing here is advice to gamble, and ' +
  'skill at this simulation is not evidence of an edge anywhere else.';

export type CounselClauseId =
  | 'operator-identity'
  | 'age-threshold'
  | 'play-money-classification'
  | 'governing-law'
  | 'liability-and-warranty'
  | 'enrolment-and-fees'
  | 'refunds-and-cancellation'
  | 'data-controller-and-rights'
  | 'retention-and-deletion'
  | 'international-transfer'
  | 'ai-legend-naming';

export interface CounselClause {
  readonly id: CounselClauseId;
  /** Which of the three pages render this clause. Several clauses appear on more than one. */
  readonly pages: readonly LegalPageKey[];
  /** The clause's subject, in a few words. Used as the heading in the review document. */
  readonly subject: string;
  /**
   * What counsel has to decide, written as a question.
   *
   * A question rather than a description, because a question has an answer somebody can be shown to
   * have given. "Governing law needs review" is a sentence anybody can nod at; "which jurisdiction's
   * law governs these terms, and does that survive where the reader is?" is not.
   */
  readonly question: string;
}

/**
 * Every clause on these pages that this project is not competent to write.
 *
 * The register is deliberately short. A page where everything is flagged says nothing — the marker
 * has to mean "this specific passage", or a reader learns to ignore it. Everything NOT on this list
 * is a statement of fact about what the software does, checked against the schema, the repositories
 * and the source, and those need no lawyer to be true.
 */
export const COUNSEL_CLAUSES: Readonly<Record<CounselClauseId, CounselClause>> = {
  'operator-identity': {
    id: 'operator-identity',
    pages: ['terms', 'privacy'],
    subject: 'Who operates this deployment',
    question:
      'Which legal entity operates this instance, in which country is it established, and what ' +
      'identification and contact details must appear on these pages for that entity in the places ' +
      'it serves readers?',
  },
  'age-threshold': {
    id: 'age-threshold',
    pages: ['terms', 'responsible-use'],
    subject: 'The minimum age, and whether one is required at all',
    question:
      'Is a minimum age required for a free, play-money poker simulator in each place this ' +
      'deployment is offered, and if so what is it? The software ships with no gate and no ' +
      'threshold, because a number chosen by its authors would be a legal conclusion they have no ' +
      'basis for. Counsel must also say whether an unverified self-declaration is sufficient, since ' +
      'that is all the gate implements and all it can implement without collecting identity ' +
      'documents.',
  },
  'play-money-classification': {
    id: 'play-money-classification',
    pages: ['terms', 'responsible-use'],
    subject: 'Whether this is a regulated product anywhere it will be offered',
    question:
      'Does a product with no stake, no purchase, no prize and no cash-out fall within any gambling, ' +
      'lottery, skill-gaming or advertising regime in the places this deployment is offered? The ' +
      'guardrails in docs/PRODUCT-GUARDRAILS.md are enforced in the schema and the test suite, so ' +
      'the factual description is reliable; whether those facts put the product inside or outside a ' +
      'regime is not a question the code can answer.',
  },
  'governing-law': {
    id: 'governing-law',
    pages: ['terms'],
    subject: 'Governing law and where a dispute is heard',
    question:
      'Which law governs these terms, which forum hears a dispute, and does that choice survive ' +
      'against a consumer resident elsewhere? Consumer-protection rules in several jurisdictions ' +
      'override a choice-of-law clause, so a clause that reads as settled may not be.',
  },
  /**
   * The premise "and that the software is offered free of charge" used to sit at the end of this
   * question, and it had to come out.
   *
   * It was true when it was written — an exhaustive search of this repository found no route by
   * which money could be taken and no way to tell a paying reader from any other. (The wording of
   * that sentence is deliberate: `test/legal-pages.test.ts` sweeps this file for the vocabulary of a
   * money-moving integration, and this module is not on its reviewed-exemption list. Keeping it off
   * that list is worth one careful sentence.) It stopped being a premise anybody here can
   * assert the moment the schema grew a record of who is enrolled in a course: an enrolment is
   * granted out of band, so this software cannot see whether money was involved, and a deployment
   * enrolling a scholarship cohort and one charging a fee produce the same rows. Asking counsel a
   * question premised on a fact this software can no longer establish would get an answer to the
   * wrong question, which is worse than getting no answer.
   */
  'liability-and-warranty': {
    id: 'liability-and-warranty',
    pages: ['terms'],
    subject: 'Warranty disclaimer and limitation of liability',
    question:
      'What may this deployment lawfully disclaim and limit, given that parts of a broad exclusion ' +
      'are unenforceable against consumers in several jurisdictions? This question used to end "and ' +
      'that the software is offered free of charge", and that premise has been withdrawn rather ' +
      'than answered: the software can record that an operator enrolled somebody in a course, and ' +
      'it cannot tell whether that place was paid for. Counsel must answer for both a deployment ' +
      'that charges and one that does not, because the code cannot distinguish them.',
  },
  'enrolment-and-fees': {
    id: 'enrolment-and-fees',
    pages: ['terms'],
    subject: 'What an enrolment record means, and what the operator has sold',
    question:
      'This deployment can record that an operator granted somebody a place in a course — a cohort, ' +
      'the authority it was granted on, a reference to an arrangement made outside this system, an ' +
      'expiry and a revocation — and it records nothing about money, because no column in this ' +
      'schema can hold an amount, a currency or a price. So: what, if anything, has the operator ' +
      'sold; which contract terms and pre-contract disclosures must be presented before that sale, ' +
      'on which page and by whom; and do terms displayed here bind a purchase completed somewhere ' +
      'this software cannot see? Counsel must answer for the free case too — a scholarship or ' +
      'employer-funded cohort produces exactly the same rows.',
  },
  'refunds-and-cancellation': {
    id: 'refunds-and-cancellation',
    pages: ['terms'],
    subject: 'Refunds, cancellation, and what an interruption costs the reader',
    question:
      'If a place in a course was paid for, what refund, cancellation or cooling-off right must be ' +
      'offered, does it survive the student starting the course, and where must it be stated? There ' +
      'is no refund concept at any layer of this software — no amount, no order, no receipt — so ' +
      'revoking an enrolment ends access and returns nothing. Counsel must also decide what the ' +
      'operator owes a reader whose access ends because the deployment was taken down, reset or ' +
      'changed, which the availability clause on this page reserves the right to do, and what ' +
      'deleting an account should do to a place in a course that has not expired.',
  },
  'data-controller-and-rights': {
    id: 'data-controller-and-rights',
    pages: ['privacy'],
    subject: 'Controller identity, lawful basis, and which rights apply',
    question:
      'Who is the controller of the data described in the inventory below, on what lawful basis is ' +
      'each category processed, and which statutory rights (access, rectification, erasure, ' +
      'portability, objection) must be offered to which readers? The inventory itself is checked ' +
      'against db/migrations and the repositories and can be relied on as a description of fact.',
  },
  'retention-and-deletion': {
    id: 'retention-and-deletion',
    pages: ['privacy'],
    subject: 'Retention periods, and what deletion must actually remove',
    question:
      'How long may each category be kept, and does erasure require the hand history to be deleted ' +
      'rather than detached from its account? The schema grants the runtime role no DELETE on ' +
      'prl.hands, prl.hand_seats or prl.hand_actions, so hand history can be anonymised but not ' +
      'removed without a migration and a change to the least-privilege grants.',
  },
  'international-transfer': {
    id: 'international-transfer',
    pages: ['privacy'],
    subject: 'Where the data physically sits, and who may reach it',
    question:
      'In which country does this deployment run its database and its backups, who administers ' +
      'them, and what transfer mechanism or disclosure does that require for the readers it serves?',
  },
  'ai-legend-naming': {
    id: 'ai-legend-naming',
    pages: ['terms', 'responsible-use'],
    subject: 'Name, image and likeness for attributed opponent profiles',
    question:
      'May this deployment display the attributed names carried in packages/poker-ai (PRL_LEGEND_' +
      'NAMING=attributed), and on what permission? ADR 0011 makes archetype names the default and ' +
      'attribution an explicit opt-in for exactly this reason. Until counsel has answered in ' +
      'writing, PRL_LEGEND_NAMING must stay unset.',
  },
};

/** The register in a stable order: the order the review document lists them in. */
export const COUNSEL_CLAUSE_IDS: readonly CounselClauseId[] = [
  'operator-identity',
  'age-threshold',
  'play-money-classification',
  'governing-law',
  'liability-and-warranty',
  'data-controller-and-rights',
  'retention-and-deletion',
  'international-transfer',
  'ai-legend-naming',
  // Appended rather than filed beside `liability-and-warranty`, where they belong by subject. This
  // list's contract is that it is "the order the review document lists them in", and the review
  // document's entries are numbered in prose: inserting at position six would renumber four
  // existing entries, and an entry number is how a lawyer's answer refers back to a question.
  'enrolment-and-fees',
  'refunds-and-cancellation',
];

/** Every clause a given page has to render. Used by the pages and asserted by the test. */
export function counselClausesFor(page: LegalPageKey): readonly CounselClause[] {
  return COUNSEL_CLAUSE_IDS.map((id) => COUNSEL_CLAUSES[id]).filter((clause) => clause.pages.includes(page));
}

/**
 * The facts about THIS deployment, or nulls where nobody has supplied them.
 *
 * Every field is optional in the sense that the app runs without it, and none is optional in the
 * sense that the pages are complete without it. `configured` is false while any of them is missing,
 * which is what puts the "not ready to be relied on" notice at the top of all three pages.
 */
export interface LegalDeployment {
  /** The legal entity operating this instance, e.g. a company name. */
  readonly operator: string | null;
  /** How a reader reaches that entity about these documents. An address, an email, a URL. */
  readonly contact: string | null;
  /** The jurisdiction whose law the terms are stated under. */
  readonly governingLaw: string | null;
  /** Where the database and its backups physically live. Feeds the transfer clause. */
  readonly hostingRegion: string | null;
  /** ISO `YYYY-MM-DD`, the date these documents took effect for this deployment. */
  readonly effectiveDate: string | null;
  /**
   * Where a reader in this deployment's audience can find help with gambling harm.
   *
   * Optional, and null by default, because the right organisation depends entirely on where a
   * reader is and this project has no way to know. `/responsible-use` renders it as plain text
   * rather than as a link: it is operator-supplied, and a clickable destination on a page about
   * vulnerability is not somewhere to relax about what an environment variable can contain.
   */
  readonly supportResource: string | null;
  /** True only when every field above is present. */
  readonly configured: boolean;
  readonly problems: readonly string[];
}

/**
 * Cleans an operator-supplied label before it reaches a page.
 *
 * The same character classes `users_display_name_shape` excludes in the schema: C0 and C1 controls,
 * zero-width characters and bidi overrides, which are the mechanisms for making one string render
 * as another. React escapes markup; it does not remove a right-to-left override, and a company name
 * that reorders the sentence around it is a real way for a legal page to say something it does not
 * say. Truncated because a page has a column width and an unbounded environment variable does not.
 *
 * A code-point walk rather than a regex over the control ranges, because biome refuses a control
 * character inside a regular expression — correctly: the escaped form is easy to misread, and this
 * form says what it excludes. `apps/api/src/repositories/users.ts` walks code points for the same
 * check on the same character classes.
 *
 * These twenty lines also exist as `cleanLabel` in `lib/age-gate.ts`, and that is on purpose. Both
 * files are leaf modules with no imports by design — `age-gate.ts` because the proxy and a bare
 * `node --test` file both have to read it without dragging a framework in — and a third module
 * holding one small function is more indirection than the duplication costs. A third caller is the
 * moment to reconsider that, not before.
 *
 * `isRemovable` is split out rather than inlined for a reason worth stating: with the seven range
 * tests inside the loop, biome measures the function past its cognitive-complexity ceiling. That
 * warning is doing its job — a reader of the loop should see "keep, or turn into a space", not seven
 * ranges — so the ranges get a name and the loop gets shorter.
 */
function isRemovable(code: number): boolean {
  if (code < 0x20) return true;
  if (code >= 0x7f && code <= 0x9f) return true;
  if (code >= 0x200b && code <= 0x200f) return true;
  if (code === 0x2028 || code === 0x2029) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return code === 0xfeff;
}

function cleanField(raw: string | undefined, limit: number): string | null {
  if (raw === undefined) return null;
  let kept = '';
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    // Tab, newline and carriage return become a space rather than vanishing: dropping them would
    // join the words either side of a line break into one.
    if (code === 0x09 || code === 0x0a || code === 0x0d) kept += ' ';
    else if (!isRemovable(code)) kept += char;
  }
  const collapsed = kept.replace(/\s+/gu, ' ').trim().slice(0, limit);
  return collapsed === '' ? null : collapsed;
}

/** Longest an operator name, contact line or jurisdiction may be. Past this it is prose. */
const FIELD_LIMIT = 160;

/**
 * @param env the environment to read; injectable so tests never mutate `process.env`
 */
export function readLegalDeployment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LegalDeployment {
  const problems: string[] = [];

  const operator = cleanField(env['PRL_LEGAL_OPERATOR'], FIELD_LIMIT);
  const contact = cleanField(env['PRL_LEGAL_CONTACT'], FIELD_LIMIT);
  const governingLaw = cleanField(env['PRL_LEGAL_GOVERNING_LAW'], FIELD_LIMIT);
  const hostingRegion = cleanField(env['PRL_LEGAL_HOSTING_REGION'], FIELD_LIMIT);
  // Longer than the rest: this one is a sentence naming an organisation and how to reach it, not
  // a label. Still bounded, because a page has a column width.
  const supportResource = cleanField(env['PRL_LEGAL_SUPPORT_RESOURCE'], FIELD_LIMIT * 2);

  const rawDate = cleanField(env['PRL_LEGAL_EFFECTIVE_DATE'], 10);
  let effectiveDate: string | null = null;
  if (rawDate !== null) {
    // Shape then reality: `2026-02-31` matches the pattern and is not a date. `Date.parse` on an
    // ISO date string is UTC and unambiguous, which is the one case where it can be trusted.
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(rawDate) || Number.isNaN(Date.parse(rawDate))) {
      problems.push('PRL_LEGAL_EFFECTIVE_DATE is not a YYYY-MM-DD date and is being ignored.');
    } else {
      effectiveDate = rawDate;
    }
  }

  return {
    operator,
    contact,
    governingLaw,
    hostingRegion,
    effectiveDate,
    supportResource,
    // `supportResource` is deliberately NOT part of this: a deployment serving a jurisdiction with
    // no obvious organisation to name is not misconfigured, and making the banner depend on it
    // would push an operator to fill the field with something rather than leave it honest.
    configured:
      operator !== null &&
      contact !== null &&
      governingLaw !== null &&
      hostingRegion !== null &&
      effectiveDate !== null,
    problems,
  };
}

/** What a page shows in place of a field nobody has set. Never a plausible-looking placeholder. */
export const NOT_SUPPLIED = 'not supplied by this deployment';
