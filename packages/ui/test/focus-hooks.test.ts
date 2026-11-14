/**
 * The decisions behind `useFocusRescue` and `useFocusOnChange`, run without a DOM (ADR 0008).
 * `test:keyboard` drives the same rescues in real Chrome: Deal, fold, and the table set-up controls.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { createChangeWatch } from '../src/focus-on-change.ts';
import { browserAbandonedFocus, createFocusRescue } from '../src/focus-rescue.ts';

interface FakeNode {
  readonly name: string;
}

const INSIDE: FakeNode = { name: 'a button in the region' };
const OUTSIDE: FakeNode = { name: 'a link in the Coach panel' };

/** A region whose `contains` knows only `INSIDE`. */
const region = { contains: (other: unknown): boolean => other === INSIDE };

const blurTo = (next: FakeNode | null) =>
  ({ relatedTarget: next, currentTarget: region }) as unknown as Parameters<
    ReturnType<typeof createFocusRescue>['onBlurCapture']
  >[0];

/** A focus target that records every call, so a move and its options can both be asserted. */
function target(): { readonly element: HTMLElement; readonly calls: unknown[] } {
  const calls: unknown[] = [];
  const element = { focus: (options?: unknown) => calls.push(options) } as unknown as HTMLElement;
  return { element, calls };
}

describe('createFocusRescue', () => {
  it('moves nothing for a reader who was never in the region', () => {
    const rescue = createFocusRescue(() => true);
    const landing = target();
    rescue.rescue(landing.element);
    assert.deepEqual(landing.calls, []);
  });

  it('keeps the caret held through a blur with no next target, which is what an unmount reports', () => {
    const rescue = createFocusRescue(() => true);
    rescue.onFocusCapture();
    assert.equal(rescue.onBlurCapture(blurTo(null)), false);
    assert.equal(rescue.held(), true);
    const landing = target();
    rescue.rescue(landing.element);
    assert.deepEqual(landing.calls, [{ preventScroll: true }], 'every move must pass preventScroll');
    assert.equal(rescue.held(), false, 'a rescue is spent once it has moved the caret');
  });

  it('lets a reader who tabbed out of the region go', () => {
    const rescue = createFocusRescue(() => true);
    rescue.onFocusCapture();
    assert.equal(rescue.onBlurCapture(blurTo(OUTSIDE)), true);
    const landing = target();
    rescue.rescue(landing.element);
    assert.deepEqual(landing.calls, [], 'a reader in the Coach panel was pulled back into the region');
  });

  it('keeps holding while the caret moves between controls inside the region', () => {
    const rescue = createFocusRescue(() => true);
    rescue.onFocusCapture();
    assert.equal(rescue.onBlurCapture(blurTo(INSIDE)), false);
    assert.equal(rescue.held(), true);
  });

  it('stands down, and keeps holding, while something legitimate has focus', () => {
    const rescue = createFocusRescue(() => false);
    rescue.onFocusCapture();
    const landing = target();
    rescue.rescue(landing.element);
    assert.deepEqual(landing.calls, []);
    assert.equal(rescue.held(), true);
  });

  it('counts a press as presence, for an activation that arrived without a focus event', () => {
    const rescue = createFocusRescue(() => true);
    rescue.claim();
    const landing = target();
    rescue.rescue(landing.element);
    assert.deepEqual(landing.calls, [{ preventScroll: true }]);
  });

  it('is spent even when the landing place is gone', () => {
    const rescue = createFocusRescue(() => true);
    rescue.onFocusCapture();
    rescue.rescue(null);
    assert.equal(rescue.held(), false);
  });

  it('keeps one region’s state out of another’s', () => {
    const band = createFocusRescue(() => true);
    const controls = createFocusRescue(() => true);
    band.onFocusCapture();
    assert.equal(controls.held(), false);
  });
});

describe('browserAbandonedFocus', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  afterEach(() => {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', original);
  });

  const withActive = (pick: (doc: { body: object; documentElement: object }) => object | null): boolean => {
    const doc = { body: { tag: 'body' }, documentElement: { tag: 'html' }, activeElement: null as unknown };
    doc.activeElement = pick(doc);
    Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
    return browserAbandonedFocus();
  };

  it('treats null, <body> and <html> as abandoned, since Chrome uses both elements', () => {
    assert.equal(
      withActive(() => null),
      true,
    );
    assert.equal(
      withActive((doc) => doc.body),
      true,
    );
    assert.equal(
      withActive((doc) => doc.documentElement),
      true,
    );
  });

  it('treats a focused control as held', () => {
    assert.equal(
      withActive(() => ({ tag: 'button' })),
      false,
    );
  });
});

describe('createChangeWatch', () => {
  it('never reports the value it started from, so the first render takes no focus', () => {
    const changed = createChangeWatch(0);
    assert.equal(changed(0), false);
    assert.equal(changed(0), false, 'StrictMode re-runs a mount effect with the same value');
  });

  it('reports each change once, including a return to an earlier value', () => {
    const changed = createChangeWatch('idle');
    assert.equal(changed('live'), true);
    assert.equal(changed('live'), false);
    assert.equal(changed('idle'), true);
  });

  it('compares as React compares dependencies', () => {
    const changed = createChangeWatch(Number.NaN);
    assert.equal(changed(Number.NaN), false);
    assert.equal(changed(-0), true);
    assert.equal(changed(0), true);
  });
});
