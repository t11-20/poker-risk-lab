/**
 * The home page.
 *
 * ## What it is trying to do, in one line
 *
 * Make the product's actual differentiator legible in the first screen: the maths is computed, in
 * front of you, with its method and its assumptions attached — and none of it is a gambling
 * product. Everything on this page serves one of those two sentences.
 *
 * ## Four sections, and why each one is here
 *
 *  1. **Hero.** A statement, two actions, the "not a gambling product" line at full size — a
 *     disclosure that only exists at the bottom of a page is written to be missed — and beside them
 *     one hand with its price worked out (`HomeSpot`). The hand replaced a boxed notice: the product
 *     is a decision with its price attached, so the first screen shows one rather than describing it.
 *  2. **The process spine.** Learn, calculate, decide, review: playing a hand is one step of four,
 *     and the step most products skip is the last one.
 *  3. **Three ways in.** What the reader can actually do, each under its area's suit.
 *  4. **What has been checked.** Four checkable figures, and a link to the page that names the test
 *     behind each. The tests themselves used to be listed here, with `pnpm` commands, which is
 *     material for a reviewer rather than for somebody deciding whether to learn poker; it is now
 *     `/checks`.
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
 * One `h1`, then `h2` per section, then `h3` on the three ways in — so `heading-order` holds.
 */

import { lessonsInReadingOrder } from '@prl/content';
import { Reveal } from '@prl/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { HomeSpot } from '@/components/HomeSpot.tsx';
import { MetricsBand } from '@/components/MetricsBand.tsx';
import { ProcessSpine } from '@/components/ProcessSpine.tsx';
import { SuitMark } from '@/components/SuitMark.tsx';
import { CHECKS_PATH } from '@/lib/checks.ts';
import { homeSpot } from '@/lib/home-spot.ts';
import { firstLesson } from '@/lib/learn-curriculum.ts';
import { LEARN_PATH, lessonHref } from '@/lib/learn-data.ts';
import type { NavArea } from '@/lib/nav.ts';
import { RECORD_PATH } from '@/lib/record-data.ts';
import '@/styles/home.css';

export const metadata: Metadata = {
  // `absolute`, so the layout's `%s — Poker Risk Lab` template does not produce the name twice.
  title: { absolute: 'Poker Risk Lab — a decision laboratory for poker' },
  description:
    'Play no-limit hold’em with the probability, expected value and variance behind every ' +
    'decision computed in front of you. Free practice units, no real money, nothing looked up.',
};

interface CapabilityModule {
  readonly title: string;
  readonly area: NavArea;
  readonly summary: string;
  readonly points: readonly string[];
  readonly href: string;
  readonly action: string;
}

/**
 * Where "Start with the foundations" goes: the first lesson in reading order, not the index.
 *
 * It used to be `/learn`, and on a 360x640 first visit the index's first lesson button was measured
 * at y=1682 — a link that promised the foundations delivered four screens of curriculum first. The
 * index is still one tap away in the hero ("Read the lessons"), which is the link that names it.
 * Falls back to the index only if the content package ever ships no lessons at all.
 */
const FOUNDATIONS = firstLesson(lessonsInReadingOrder());
const FOUNDATIONS_HREF = FOUNDATIONS === null ? LEARN_PATH : lessonHref(FOUNDATIONS.id);

/**
 * Three modules, one per verb. Each `points` entry is a capability that exists, not a promise —
 * anything aspirational belongs in a roadmap rather than on a home page.
 */
const MODULES: readonly CapabilityModule[] = [
  {
    area: 'learn',
    title: 'Read the reasoning',
    summary:
      'Lessons that build one idea at a time, each ending in a quiz that asks you to reason rather than to recall.',
    points: [
      '17 lessons across 10 topics',
      'A glossary of 90 terms, linked from wherever a term first appears',
      'Every worked figure recomputed live, so no example can drift out of date',
    ],
    href: FOUNDATIONS_HREF,
    action: 'Start with the foundations',
  },
  {
    area: 'play',
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
    area: 'lab',
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

export default function HomePage(): ReactElement {
  const spot = homeSpot();
  return (
    <>
      <section aria-labelledby="home-title" className="prl-home__hero prl-container">
        <div className="prl-home__pitch">
          <h1 className="prl-home__title" id="home-title">
            Every bet has a price. Learn to read it.
          </h1>

          <p className="prl-home__lede">
            Play no-limit hold’em with practice units while the odds, the price of each call and what it is
            worth over time are worked out from the cards in front of you — every figure with how it was
            computed and what it assumes.
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

          <p className="prl-home__guardrail">
            <strong>Not a gambling product.</strong> There is no real money in this app. Chips are{' '}
            <strong>units</strong>: free practice counters with no monetary value, which cannot be bought,
            sold, transferred or cashed out, and which you can{' '}
            <Link href={RECORD_PATH}>reset to the starting amount at any time</Link>. Nothing here is a
            recommendation, and no figure is presented as the one correct play.
          </p>
        </div>

        <HomeSpot spot={spot} />
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
          <h2 className="prl-home__section-title">Three ways in</h2>
          <p className="prl-home__section-lede">
            The same maths underneath all three, presented for reading, for deciding under time pressure, and
            for taking apart one variable at a time.
          </p>
        </div>
        <ul className="prl-home__ways">
          {MODULES.map((module) => (
            <li className="prl-home__way" key={module.href}>
              <h3 className="prl-home__way-title">
                <SuitMark area={module.area} className="prl-home__way-mark" />
                {module.title}
              </h3>
              <p className="prl-home__way-text">{module.summary}</p>
              <ul className="prl-home__way-points">
                {module.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <p className="prl-home__way-link">
                <Link href={module.href}>{module.action}</Link>
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="prl-home__section prl-container">
        <div className="prl-home__section-head">
          <h2 className="prl-home__section-title">What has been checked</h2>
          <p className="prl-home__section-lede">
            Four figures, each of them a fact you can verify yourself rather than a claim you have to take on
            trust. <Link href={CHECKS_PATH}>How the numbers are checked</Link> names the test behind each one.
          </p>
        </div>
        <MetricsBand />
      </section>
    </>
  );
}
