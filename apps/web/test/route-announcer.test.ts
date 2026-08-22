/**
 * What a client-side navigation announces, and which announcer says it.
 *
 * ## The premise was checked before any of this was written
 *
 * The obvious brief — "nothing announces a client navigation in this app" — is false, and finding
 * that out cost ten minutes of real Chrome rather than an afternoon of building the wrong thing.
 * Next 16.3.0 ships `AppRouterAnnouncer`, the App Router mounts it unconditionally, and driving
 * Chrome 151 over the DevTools Protocol against a production build of this app and clicking a real
 * `<Link>` from `/` to `/learn` showed it go from `""` to `"Learn — Poker Risk Lab"` within 300ms,
 * while staying empty on the initial load.
 *
 * What is wrong with it is HOW: it is `role="alert"` plus `aria-live="assertive"`, so it interrupts
 * on every navigation; and it lives inside a shadow root on a `<next-route-announcer>` element, so
 * it is invisible to every light-DOM scan — `scripts/a11y-audit.mjs` included — and unreliable on
 * the screen-reader/browser pairs that have historically dropped live regions in shadow trees. A
 * previous audit of this app came within one shadow-root inspection of filing "route change not
 * announced" as a finding.
 *
 * `RouteAnnouncer.tsx` therefore stands that one down and owns the announcement in the light DOM,
 * politely. Two regions saying the same title — one of them interrupting — is worse than one saying
 * it badly.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Yes, in three independent ways, and each was checked by breaking it:
 *
 *  1. `contractProblems` is a detector, and it is run against a NEGATIVE CONTROL below — a component
 *     that is assertive, has no `usePathname`, announces on first load and never stands the
 *     framework announcer down. Every one of those four is asserted to be reported.
 *  2. The real component is run through the same detector and must come back clean, which is what
 *     makes (1) meaningful rather than a test of a regex.
 *  3. The framework half is pinned against the INSTALLED Next, not against a remembered fact: if an
 *     upgrade renames `next-route-announcer` or stops shipping an announcer, the assertion fails and
 *     somebody re-checks whether there is still anything to stand down — rather than this app
 *     quietly growing a second announcer nobody in the light DOM can hear.
 *
 * The component itself cannot be rendered here: `apps/web` has no component harness (see
 * `live-regions.test.ts`), and a `.tsx` module cannot even be imported under `node --test`, because
 * Node's type stripping does not handle JSX. The constant is therefore read out of the source rather
 * than imported, which is stated here so nobody mistakes this for a render test.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

/**
 * Source with its comments removed.
 *
 * Load-bearing, not tidiness. Both files below EXPLAIN the framework announcer they replace, in
 * prose that names `role="alert"` and `aria-live="assertive"` — and the first version of the
 * detector read those sentences and reported the component as breaking the rule the sentences exist
 * to keep. A scan that cannot tell code from the documentation of code will always report the
 * best-documented file as the worst one.
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

const ANNOUNCER = withoutComments(read('components', 'RouteAnnouncer.tsx'));
const LAYOUT = withoutComments(read('app', 'layout.tsx'));

/**
 * Everything wrong with a route announcer, as a list of reasons.
 *
 * A named detector rather than a run of `assert.match` calls, so the negative control below can feed
 * it a component that gets every one of these wrong and prove the checks actually fire. A scan that
 * has only ever seen correct input is a scan nobody has tested.
 */
function contractProblems(source: string): readonly string[] {
  const problems: string[] = [];
  if (!/aria-live="polite"/u.test(source)) {
    problems.push('the region is not polite: arriving at a page is not an emergency');
  }
  if (/aria-live="assertive"|role="alert"/u.test(source)) {
    problems.push('the region interrupts, which is the framework behaviour this file replaces');
  }
  if (!/role="status"/u.test(source)) {
    problems.push('the region has no role="status", so it is not atomic and reads only what changed');
  }
  if (!/usePathname\(\)/u.test(source)) {
    problems.push('nothing observes the route, so nothing can announce a change of it');
  }
  if (!/data-prl-route-announcer/u.test(source)) {
    problems.push('the region carries no stable hook, so no audit can address it in the tree');
  }
  if (!/getElementsByTagName\(FRAMEWORK_ANNOUNCER_ELEMENT\)/u.test(source)) {
    problems.push('the framework announcer is not stood down, so the title is announced twice');
  }
  if (!/previous === null/u.test(source)) {
    problems.push('the first load is announced, over the document the browser is already reading');
  }
  if (/\.focus\(\)/u.test(source)) {
    problems.push('it moves focus, which this app deliberately does not do on navigation');
  }
  return problems;
}

describe('the app’s own route announcer', () => {
  it('satisfies every part of the contract', () => {
    assert.deepEqual(
      contractProblems(ANNOUNCER),
      [],
      'RouteAnnouncer.tsx is the only thing announcing a client navigation in the light DOM',
    );
  });

  it('is mounted once, above every route, and outside <main>', () => {
    assert.match(LAYOUT, /import \{ RouteAnnouncer \} from '@\/components\/RouteAnnouncer\.tsx';/u);
    const mounted = LAYOUT.indexOf('<RouteAnnouncer />');
    const main = LAYOUT.indexOf('<main');
    assert.ok(mounted > 0, 'the root layout must mount it, or no route has a route announcer');
    assert.ok(
      mounted < main,
      'it must sit outside <main>: inside, it is a region the skip link can drop a reader onto, ' +
        'and it has nothing to read on arrival',
    );
    assert.equal(
      LAYOUT.split('<RouteAnnouncer />').length - 1,
      1,
      'exactly one. Two would announce every navigation twice, which is the defect this replaces',
    );
  });

  it('waits for the title rather than reading it once and giving up', () => {
    // A route whose metadata resolves in a later commit than its tree would otherwise be announced
    // as the title of the page the reader has just left, or not at all.
    assert.match(ANNOUNCER, /new MutationObserver\(/u);
    assert.match(ANNOUNCER, /observer\.disconnect\(\)/u, 'it must stop after one announcement');
    assert.match(ANNOUNCER, /TITLE_SETTLE_MS/u, 'the wait must be bounded, or a stale title is announced');
  });

  it('defers the stand-down past the commit that creates the element', () => {
    // React runs a child's effects before its parent's, and `AppRouterAnnouncer` is rendered by an
    // ancestor of everything in the app — so an inline `remove()` finds nothing on the first paint
    // and the element appears a moment later.
    assert.match(ANNOUNCER, /setTimeout\(\(\) => \{\s*document\.getElementsByTagName/u);
  });
});

describe('NEGATIVE CONTROL — an announcer that gets it wrong', () => {
  it('is reported, item by item', () => {
    const broken = `
      'use client';
      export function RouteAnnouncer() {
        const [text, setText] = useState(document.title);
        return <div aria-live="assertive" role="alert">{text}</div>;
      }
    `;
    const problems = contractProblems(broken);
    assert.ok(problems.length >= 6, `expected several problems, got: ${JSON.stringify(problems)}`);
    for (const expected of [/not polite/u, /interrupts/u, /nothing observes the route/u, /twice/u]) {
      assert.ok(
        problems.some((problem) => expected.test(problem)),
        `no problem matched ${String(expected)} in ${JSON.stringify(problems)}`,
      );
    }
  });

  it('reports an announcer that moves focus', () => {
    const grabby = `${ANNOUNCER}\nfunction extra() { document.querySelector('h1')?.focus(); }`;
    assert.ok(
      contractProblems(grabby).some((problem) => /moves focus/u.test(problem)),
      'moving focus on navigation makes "open this and carry on reading" impossible, and the ' +
        'skip link already puts a reader into <main> in one keystroke',
    );
  });
});

describe('the framework announcer this stands down', () => {
  const require = createRequire(import.meta.url);
  const nextRoot = dirname(require.resolve('next/package.json'));
  const announcerPath = join(nextRoot, 'dist', 'client', 'components', 'app-router-announcer.js');

  it('is still shipped by the installed Next, under the element name this app removes', () => {
    const source = readFileSync(announcerPath, 'utf8');
    const pinned = /FRAMEWORK_ANNOUNCER_ELEMENT = '([^']+)'/u.exec(ANNOUNCER)?.[1];
    assert.equal(
      pinned,
      'next-route-announcer',
      'the constant this app removes by name must be the element Next actually creates',
    );
    assert.ok(
      source.includes(`'${String(pinned)}'`),
      `the installed Next no longer creates <${String(pinned)}>. Re-check whether it still ships an ` +
        'announcer at all before assuming this app has to stand one down — and if it does not, this ' +
        'app is now the only announcer and the removal is dead code.',
    );
  });

  it('is still the assertive, shadow-DOM one — which is why it is replaced', () => {
    const source = readFileSync(announcerPath, 'utf8');
    assert.match(
      source,
      /ariaLive = 'assertive'/u,
      'if Next has made its announcer polite, the two reasons for replacing it are down to one ' +
        '(the shadow root) and this decision is worth revisiting rather than inheriting',
    );
    assert.match(source, /attachShadow\(/u);
  });
});
