/**
 * The legal pages' single source for deployment facts, the register of clauses counsel must write,
 * and `PLAY_MONEY_WARNING`. It contains no legal text and draws no legal conclusion.
 * Deployment facts are read from the environment at request time, never `NEXT_PUBLIC_*`, so one image
 * serves every deployer. Each is null until set, and null renders as a visible gap.
 * `test/legal-pages.test.ts` holds `COUNSEL_CLAUSES`, the pages and `legal-review-requirements.md` in step.
 */

/** The three documents' routes. Deliberately absent from `NAV_DESTINATIONS` — see `lib/nav.ts`. */
export const LEGAL_PATHS = {
  terms: '/terms',
  privacy: '/privacy',
  responsibleUse: '/responsible-use',
} as const;

export type LegalPageKey = 'terms' | 'privacy' | 'responsible-use';

/**
 * The revision of the text in the three legal routes. A code constant, because it describes the
 * source, not the deployment. `-draft` means nobody qualified has reviewed it. §11 promises the
 * revision changes with the text.
 */
export const LEGAL_REVISION = '0.2-draft';

export const LEGAL_DRAFTED_ON = '2026-08-25';

/** Worded as an outstanding action, and always rendered as text, never colour alone (GUARDRAILS §6). */
export const COUNSEL_MARKER = 'Requires legal review before launch';

export const COUNSEL_MARKER_EXPLANATION =
  'Passages carrying this marker are placeholders written by the people who built this software, ' +
  'from what the software actually does. They are not legal advice, they have not been reviewed by ' +
  'a lawyer, and they may be wrong or unenforceable where you are. Every one of them is listed in ' +
  'docs/production/legal-review-requirements.md for whoever deploys this.';

/**
 * Worded as what the practice omits, not as a warning about risk of harm, because that framing
 * implies there is something to gain (GUARDRAILS §1 and §3).
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
  readonly pages: readonly LegalPageKey[];
  readonly subject: string;
  /** A question, because a question has an answer somebody can be shown to have given. */
  readonly question: string;
}

/** Deliberately short, so the marker means "this specific passage". Everything else is checked fact. */
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

/** The order the review document lists them in. */
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
  // Appended, because the review document numbers its entries and a lawyer's answer cites the number.
  'enrolment-and-fees',
  'refunds-and-cancellation',
];

export function counselClausesFor(page: LegalPageKey): readonly CounselClause[] {
  return COUNSEL_CLAUSE_IDS.map((id) => COUNSEL_CLAUSES[id]).filter((clause) => clause.pages.includes(page));
}

/** `configured` is false while any field but `supportResource` is missing, which shows the notice. */
export interface LegalDeployment {
  readonly operator: string | null;
  readonly contact: string | null;
  readonly governingLaw: string | null;
  readonly hostingRegion: string | null;
  /** ISO `YYYY-MM-DD`. */
  readonly effectiveDate: string | null;
  /** Rendered as plain text, never a link, because it is operator-supplied. Null by default. */
  readonly supportResource: string | null;
  readonly configured: boolean;
  readonly problems: readonly string[];
}

/**
 * Removes C0 and C1 controls, zero-width characters and bidi overrides (the `users_display_name_shape`
 * set), because React escapes markup but not a right-to-left override. A code-point walk, because
 * biome refuses control characters in a regex. Duplicated from `cleanLabel` in `age-gate.ts` because
 * both are leaf modules. Split out to stay under biome's cognitive-complexity ceiling.
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
    // Line breaks become a space, so the words either side do not join.
    if (code === 0x09 || code === 0x0a || code === 0x0d) kept += ' ';
    else if (!isRemovable(code)) kept += char;
  }
  const collapsed = kept.replace(/\s+/gu, ' ').trim().slice(0, limit);
  return collapsed === '' ? null : collapsed;
}

const FIELD_LIMIT = 160;

/** @param env injectable so tests never mutate `process.env` */
export function readLegalDeployment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LegalDeployment {
  const problems: string[] = [];

  const operator = cleanField(env['PRL_LEGAL_OPERATOR'], FIELD_LIMIT);
  const contact = cleanField(env['PRL_LEGAL_CONTACT'], FIELD_LIMIT);
  const governingLaw = cleanField(env['PRL_LEGAL_GOVERNING_LAW'], FIELD_LIMIT);
  const hostingRegion = cleanField(env['PRL_LEGAL_HOSTING_REGION'], FIELD_LIMIT);
  // A sentence naming an organisation, not a label, so it gets twice the limit.
  const supportResource = cleanField(env['PRL_LEGAL_SUPPORT_RESOURCE'], FIELD_LIMIT * 2);

  const rawDate = cleanField(env['PRL_LEGAL_EFFECTIVE_DATE'], 10);
  let effectiveDate: string | null = null;
  if (rawDate !== null) {
    // `2026-02-31` matches the pattern and is not a date. `Date.parse` on an ISO date is UTC.
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
    // `supportResource` is excluded, so an operator is not pushed to fill it with something.
    configured:
      operator !== null &&
      contact !== null &&
      governingLaw !== null &&
      hostingRegion !== null &&
      effectiveDate !== null,
    problems,
  };
}

/** Never a plausible-looking placeholder. */
export const NOT_SUPPLIED = 'not supplied by this deployment';
