/**
 * How the numbers are checked: four claims, each with the test or document that settles it.
 *
 * This list lived on the home page until the visual re-identity, under "How correctness is
 * established", with `pnpm` commands in it. It is evidence a reviewer wants and a learner deciding
 * whether to start does not, so it has its own page, linked from the home page's figures and from
 * the footer. Every figure comes from `docs/VERIFICATION.md` and every command is one that exists
 * in `package.json`.
 */

export const CHECKS_PATH = '/checks';

export interface ProofEntry {
  readonly claim: string;
  readonly detail: string;
  /** The command or file that settles it. A claim nobody can check is an assertion. */
  readonly check: string;
}

export const PROOF: readonly ProofEntry[] = [
  {
    claim: 'Every seven-card hand, enumerated',
    detail:
      'All 133,784,560 seven-card hands are classified and their nine category counts matched against the independently published frequencies — figures derived mathematically long before this code existed, so agreeing with them cannot be circular. A single misclassified hand moves at least two counters.',
    check: 'pnpm run test:exhaustive',
  },
  {
    claim: 'Ordering checked, not just classification',
    detail:
      'Agreeing on the category does not prove the kickers are ranked correctly, so 200,000 random pairs of hands are compared for relative order against an independent reference evaluator, and 20,000 seven-card hands against brute force over all 21 five-card subsets. Zero disagreements.',
    check: 'pnpm run test:unit',
  },
  {
    claim: 'Teaching claims checked against the maths',
    detail:
      'All 36 scenarios carry qualitative claims — 74 of them — asserted by a human and then confirmed by the computation. A scenario whose teaching point stops being true fails the build rather than quietly misleading somebody.',
    check: 'pnpm --filter @prl/content test',
  },
  {
    claim: 'Nothing is looked up in an odds table',
    detail:
      'A hard-coded odds table is a lie waiting to happen: if it was wrong when it was written, or right for a situation slightly different from yours, nothing in the product will ever say so. No figure here is produced by reading one — every one is computed from the actual deck at the moment you ask, and arrives with its method: exact enumeration, or Monte Carlo with an interval. The single exception is a bundled worked example shown when the calculator cannot be reached, and the page you are on says so at the top when that happens.',
    check: 'docs/THREAT-MODEL.md',
  },
];
