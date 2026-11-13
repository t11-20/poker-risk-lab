/**
 * The home page. The "not a gambling product" line sits in the hero at full size, never only at the
 * bottom. No testimonials, logos, activity counters or streaks. `Reveal` and `MetricsBand` are client
 * leaves and both render their content on the server, so the page reads with scripting off.
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

/** The first lesson, not the index, whose first lesson button sat at y=1682 at 360x640. */
const FOUNDATIONS = firstLesson(lessonsInReadingOrder());
const FOUNDATIONS_HREF = FOUNDATIONS === null ? LEARN_PATH : lessonHref(FOUNDATIONS.id);

/** Each `points` entry is a capability that exists, not a promise. */
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
            {/* A link styled as a button, because `Button` in @prl/ui has no `href` on purpose. */}
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
