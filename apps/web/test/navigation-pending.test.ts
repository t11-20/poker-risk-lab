/**
 * A slow navigation says the press was taken, on the page it was pressed on (a replay took up to
 * 1839 ms to first byte). `loading.tsx` is refused by `app-shell-streaming.test.ts`, so the feedback
 * is `NavigationPending` in the shell. Its wiring has no DOM under `node --test` (ADR 0008) and is
 * held to source.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  formDestination,
  PENDING_CEILING_MS,
  PENDING_DELAY_MS,
  pendingMessage,
  shouldShowPending,
} from '../src/lib/navigation-pending.ts';

const at = (path: string): URL => new URL(path, 'https://lab.example');
const read = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

describe('which presses start the message', () => {
  it('a replay row and the compare link, the two the audit timed (REGRESSION)', () => {
    assert.equal(
      shouldShowPending({ destination: at('/review/hand_1'), current: at('/review'), documentLoad: true }),
      true,
    );
    assert.equal(
      shouldShowPending({
        destination: at('/legends/compare?profiles=a,b'),
        current: at('/legends'),
        documentLoad: false,
      }),
      true,
    );
  });

  it('a GET form back to the same page, which is a document load (the compare picker)', () => {
    assert.equal(
      shouldShowPending({
        destination: at('/legends/compare?profiles=a,b'),
        current: at('/legends/compare?profiles=c,d'),
        documentLoad: true,
      }),
      true,
    );
  });

  it('a GET form whose action is the page it is on, once its fields are the query (REGRESSION)', () => {
    const current = at('/legends/compare');
    const destination = formDestination('/legends/compare', current.href, [
      ['difficulty', 'standard'],
      ['profiles', 'calling-station'],
      ['profiles', 'maniac'],
    ]);
    assert.equal(destination.search, '?difficulty=standard&profiles=calling-station&profiles=maniac');
    assert.equal(shouldShowPending({ destination, current, documentLoad: true }), true);
    // The action alone equals the current URL, which is what the first version compared.
    assert.equal(
      shouldShowPending({ destination: at('/legends/compare'), current, documentLoad: true }),
      false,
    );
  });

  it('builds the query from text fields only, as a GET form sends it', () => {
    const destination = formDestination('?x=stale', 'https://lab.example/lab', [
      ['topic', 'pot-odds'],
      ['upload', { name: 'not text' }],
    ]);
    assert.equal(destination.href, 'https://lab.example/lab?topic=pot-odds');
  });

  it('not a fragment, the same page, or another site', () => {
    const current = at('/legends/compare?profiles=a,b');
    for (const destination of [
      at('/legends/compare?profiles=a,b#change-comparison'),
      at('/legends/compare?profiles=a,b'),
      new URL('https://elsewhere.example/legends'),
    ]) {
      assert.equal(shouldShowPending({ destination, current, documentLoad: true }), false, destination.href);
      assert.equal(shouldShowPending({ destination, current, documentLoad: false }), false, destination.href);
    }
  });

  it('not a router change of the query alone, which no press the audit timed is', () => {
    assert.equal(
      shouldShowPending({ destination: at('/lab?topic=pot-odds'), current: at('/lab'), documentLoad: false }),
      false,
    );
  });

  it('not a router press the age gate bounces back to the URL already shown (REGRESSION, PR #35)', () => {
    // The 303 lands on this exact URL, so nothing changes and nothing would withdraw the message.
    const toPlay = { destination: at('/play'), documentLoad: false } as const;
    assert.equal(shouldShowPending({ ...toPlay, current: at('/age-check?next=/play') }), false);
    assert.equal(shouldShowPending({ ...toPlay, current: at('/age-check?next=%2Fplay') }), false, 'encoded');
    // The destination's query travels in `next`, so it must match too.
    assert.equal(
      shouldShowPending({
        destination: at('/play?table=t1'),
        current: at('/age-check?next=%2Fplay%3Ftable%3Dt1'),
        documentLoad: false,
      }),
      false,
    );
  });

  it('still a router press from the gate that lands somewhere the shell sees change', () => {
    // The landing key includes the query, so a bounce that changes it withdraws the message.
    const cases: readonly (readonly [string, string])[] = [
      ['/play', '/age-check'],
      ['/play', '/age-check?next=/play&declined=yes'],
      ['/learn', '/age-check?next=/play'],
      ['/play', '/age-check?next=/review'],
    ];
    for (const [destination, current] of cases) {
      assert.equal(
        shouldShowPending({ destination: at(destination), current: at(current), documentLoad: false }),
        true,
        `${destination} from ${current}`,
      );
    }
  });

  it('a document load to the gated page from the gate, which replaces the page it was said on', () => {
    assert.equal(
      shouldShowPending({
        destination: at('/play'),
        current: at('/age-check?next=/play'),
        documentLoad: true,
      }),
      true,
    );
  });
});

describe('what it says and when', () => {
  it('says why the two slow routes are slow, and something plain everywhere else', () => {
    assert.match(pendingMessage('/review/hand_kape52'), /rebuilt from the action log/u);
    assert.match(pendingMessage('/legends/compare'), /^Comparing the styles\./u);
    assert.equal(pendingMessage('/review'), 'Loading the page…');
    assert.equal(pendingMessage('/learn'), 'Loading the page…');
  });

  it('waits long enough not to flash, and gives up well after the slowest measured load', () => {
    assert.ok(PENDING_DELAY_MS >= 200 && PENDING_DELAY_MS < 750, 'the 750ms freeze must be covered');
    assert.ok(PENDING_CEILING_MS > 1839 * 4, 'the ceiling must outlast a slow replay comfortably');
  });
});

describe('the wiring', () => {
  const component = read('components/NavigationPending.tsx');
  const header = read('components/SiteHeader.tsx');

  it('is mounted in the shell, told the pathname (REGRESSION)', () => {
    assert.match(header, /<NavigationPending pathname=\{pathname\} \/>/u);
  });

  it('listens on window, after React has decided whether Link took the press', () => {
    assert.match(component, /window\.addEventListener\('click', onClick\)/u);
    assert.match(component, /window\.addEventListener\('submit', onSubmit\)/u);
    assert.match(component, /window\.addEventListener\('pageshow', onPageShow\)/u);
    assert.match(component, /start\(new URL\(anchor\.href\), !event\.defaultPrevented\)/u);
    assert.match(
      component,
      /formDestination\(action, window\.location\.href, new FormData\(form\)\.entries\(\)\)/u,
    );
  });

  it('withdraws the message when the URL lands, query included (REGRESSION, PR #35)', () => {
    assert.match(component, /const search = useSearchParams\(\);/u);
    assert.match(component, /const landed = `\$\{pathname\}\?\$\{search\.toString\(\)\}`;/u);
    assert.match(component, /seenLanding\.current = landed;[\s\S]{0,200}setMessage\(null\);/u);
    assert.match(component, /\}, \[landed\]\);/u);
  });

  it('keeps an empty status region in the tree at rest, so the message is announced', () => {
    assert.match(
      component,
      /<div className="prl-pending" role="status">\s*\{message === null \? null : <p className="prl-pending__pill">/u,
    );
  });

  it('has not been replaced by the route-level loading file it exists to avoid', () => {
    const streaming = readFileSync(new URL('./app-shell-streaming.test.ts', import.meta.url), 'utf8');
    assert.match(streaming, /has no route-level loading file anywhere/u);
  });
});
