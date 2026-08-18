/**
 * The home page.
 *
 * ## What it is trying to do, in one line
 *
 * Make the product's actual differentiator legible in the first screen: the maths is computed, in
 * front of you, with its method and its assumptions attached — and none of it is a gambling
 * product. Everything on this page serves one of those two sentences.
 *
 * ## Five sections, and why each one is here
 *
 *  1. **Hero.** One display-1 statement, one primary action, one secondary. The "not a gambling
 *     product" line is here at full size rather than in the footer, because a disclosure that only
 *     exists at the bottom of a page is a disclosure written to be missed.
 *  2. **The process spine** — `01 LEARN → 02 CALCULATE → 03 DECIDE → 04 REVIEW`. The claim that
 *     playing a hand is one step of four, and that the step most products skip is the last one.
 *  3. **The metrics band.** Four figures, each of which is a checkable fact with a command that
 *     checks it. Not "trusted by", not "10,000 players" — evidence, not social proof.
 *  4. **Three capability modules.** What the reader can actually do, as hairlined panels.
 *  5. **How correctness is established.** This is genuinely the differentiator, so it gets a
 *     section rather than a footnote: every claim paired with the thing that verifies it.
 *
 * There are no testimonials, no logos, no counters of other people's activity, no streaks and
 * nothing that rewards an outcome. The design system rules all of those out and the product
 * guardrails rule them out again.
 *
 * ## Why this is a server component
 *
 * There is nothing on this page that depends on the browser. `Reveal` and `MetricsBand` are the
 * two client components, and they are leaves — the page's prose, structure, headings and links
 * ship as HTML with no JavaScript attached, which is also what makes the whole page legible with
 * scripting off (`.prl-reveal[data-revealed='false']` is neutralised under `@media (scripting:
 * none)`, and `MetricsBand` renders its real figures on the server for exactly that reason).
 *
 * One `h1`, then `h2` per section, then `h3` on the module panels — so `heading-order` holds.
 */

import { formatIndex, Panel, Reveal } from '@prl/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { MetricsBand } from '@/components/MetricsBand.tsx';
import { ProcessSpine } from '@/components/ProcessSpine.tsx';
import '@/styles/home.css';

export const metadata: Metadata = {
  // `absolute`, so the layout's `%s — Poker Risk Lab` template does not produce the name twice.
  title: { absolute: 'Poker Risk Lab — a decision laboratory for poker' },
  description:
    'Play no-limit hold’em with the probability, expected value and variance behind every ' +
    'decision computed in front of you. Free practice units, no real money, no odds table.',
};

interface CapabilityModule {
  readonly title: string;
  readonly eyebrow: string;
  readonly summary: string;
  readonly points: readonly string[];
  readonly href: string;
  readonly action: string;
}

/**
 * Three modules, one per verb. Each `points` entry is a capability that exists, not a promise —
 * anything aspirational belongs in a roadmap rather than on a home page.
 */
const MODULES: readonly CapabilityModule[] = [
  {
    eyebrow: 'Learn',
    title: 'Read the reasoning',
    summary:
      'Lessons that build one idea at a time, each ending in a quiz that asks you to reason rather than to recall.',
    points: [
      '17 lessons across 11 topics',
      'A glossary of 90 terms, linked from wherever a term first appears',
      'Every worked figure recomputed live, so no example can drift out of date',
    ],
    href: '/learn',
    action: 'Start with the foundations',
  },
  {
    eyebrow: 'Play',
    title: 'Take the decisions',
    summary:
      'Six-max no-limit hold’em against strategy simulations, with the price of every option printed on the button that takes it.',
    points: [
      'Equity, outs, pot odds and break-even, updated street by street',
      'A Coach panel whose assumptions are never collapsible',
      'Twelve opponent profiles, each a trait vector rather than a script',
    ],
    href: '/play',
    action: 'Sit at a table',
  },
  {
    eyebrow: 'Analyse',
    title: 'Change one input',
    summary:
      'The Scenario Lab isolates a single variable — a card, a bet size, an opponent’s range — so you can watch what it does to the maths.',
    points: [
      '36 scenarios, each carrying a claim the maths re-checks on every build',
      'Hand review that prices the decision separately from the result',
      'Variance and confidence intervals shown wherever a figure was sampled',
    ],
    href: '/lab',
    action: 'Open the Scenario Lab',
  },
];

interface ProofEntry {
  readonly claim: string;
  readonly detail: string;
  /** The command or file that settles it. A claim nobody can check is an assertion. */
  readonly check: string;
}

/**
 * Four claims, each with the thing that verifies it. Every figure below comes from
 * `docs/VERIFICATION.md` and every command is one that actually exists in `package.json`.
 */
const PROOF: readonly ProofEntry[] = [
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
    claim: 'No odds table, anywhere',
    detail:
      'A hard-coded odds table is a lie waiting to happen: if it was wrong when it was written, or right for a situation slightly different from yours, nothing in the product will ever say so. Every figure here is computed from the actual deck at the moment you ask, and arrives with its method — exact enumeration, or Monte Carlo with an interval.',
    check: 'docs/THREAT-MODEL.md',
  },
];

export default function HomePage(): ReactElement {
  return (
    <>
      <section className="prl-home__hero prl-container">
        <p className="prl-home__eyebrow prl-label">
          <span aria-hidden="true" className="prl-home__eyebrow-index prl-index">
            00
          </span>
          Practice units only · no real money
        </p>

        <h1 className="prl-home__title">A decision laboratory with a poker table in it.</h1>

        <p className="prl-home__lede">
          Play no-limit hold’em while the probability, price and expected value behind every choice are
          computed from the actual deck in front of you — each figure with its method, its interval and the
          assumptions it was computed under.
        </p>

        <div className="prl-home__actions">
          {/* A link, styled as the primary button. `Button` in @prl/ui deliberately has no `href`:
              a button that is really a link is a link, and the app's links go through next/link. */}
          <Link className="prl-btn prl-btn--primary prl-btn--lg" href="/play">
            Start a hand
          </Link>
          <Link className="prl-btn prl-btn--secondary prl-btn--lg" href="/learn">
            Read the lessons
          </Link>
        </div>

        <div className="prl-home__guardrail">
          <p className="prl-home__guardrail-label prl-label prl-label--strong">Not a gambling product</p>
          <p className="prl-home__guardrail-text">
            There is no real money in this app. Chips are <strong>units</strong>: free practice counters with
            no monetary value, which cannot be bought, sold, transferred or cashed out, and which you can
            reset to the starting amount at any time. Nothing here is a recommendation, and no figure is
            presented as the one correct play.
          </p>
        </div>
      </section>

      <Reveal>
        <section className="prl-home__section prl-container">
          <div className="prl-home__section-head">
            <h2 className="prl-home__section-title">The loop this is built around</h2>
            <p className="prl-home__section-lede">
              Playing a hand is one step of four, and the one most products leave out is the last. Reviewing a
              decision is where the learning happens, because it is the only place the decision can be judged
              apart from how it happened to turn out.
            </p>
          </div>
          <ProcessSpine />
        </section>
      </Reveal>

      <section className="prl-home__section prl-container">
        <div className="prl-home__section-head">
          <h2 className="prl-home__section-title">What has been checked</h2>
          <p className="prl-home__section-lede">
            Four figures, each of them a fact you can verify yourself rather than a claim you have to take on
            trust.
          </p>
        </div>
        <MetricsBand />
      </section>

      <section className="prl-home__section prl-container">
        <div className="prl-home__section-head">
          <h2 className="prl-home__section-title">Three ways in</h2>
          <p className="prl-home__section-lede">
            The same maths underneath all three, presented for reading, for deciding under time pressure, and
            for taking apart one variable at a time.
          </p>
        </div>
        <div className="prl-home__modules">
          {MODULES.map((module, position) => (
            <Reveal key={module.href} stagger={position}>
              <Panel
                className="prl-home__module"
                eyebrow={module.eyebrow}
                headingLevel={3}
                index={position + 1}
                title={module.title}
              >
                <div className="prl-home__module-body">
                  <p className="prl-home__module-text">{module.summary}</p>
                  <ul className="prl-home__module-points">
                    {module.points.map((point) => (
                      <li className="prl-home__module-point" key={point}>
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="prl-home__module-link">
                    <Link href={module.href}>{module.action}</Link>
                  </p>
                </div>
              </Panel>
            </Reveal>
          ))}
        </div>
      </section>

      <Reveal>
        <section className="prl-home__section prl-container">
          <div className="prl-home__section-head">
            <h2 className="prl-home__section-title">How correctness is established</h2>
            <p className="prl-home__section-lede">
              An educational tool that teaches a wrong number is worse than no tool at all, so this is the
              part of the product with the most work in it. Each claim below names what backs it.
            </p>
          </div>
          <dl className="prl-home__proof">
            {PROOF.map((entry, position) => (
              <div className="prl-home__proof-row" key={entry.claim}>
                <dt className="prl-home__proof-term">
                  <span aria-hidden="true" className="prl-home__proof-index prl-index">
                    {formatIndex(position + 1)}
                  </span>
                  <span>{entry.claim}</span>
                </dt>
                <dd className="prl-home__proof-detail">
                  {entry.detail}
                  <code className="prl-home__proof-check">{entry.check}</code>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </Reveal>
    </>
  );
}
