/**
 * `ActionBar`, actually rendered, with the bet field's invalid state as the subject.
 *
 * ## The defect this exists for
 *
 * The bet amount had no invalid state at all. Type something that is not a number into it and the
 * browser keeps the characters on screen, reports `value === ''` to the change handler, and the
 * sizer resolves that to the minimum — so the commit button silently changed its number while the
 * field still showed letters and nothing said the two were connected. The audit called that
 * shape "announce, or silently clamp without marking the field" when it found it on the quiz's
 * numeric answer; the same control in this package was missed because it is not `.prl-input` and
 * does not live in `apps/web`.
 *
 * ## What is rendered and what is read from the source, and why the split is honest
 *
 * The CLEAN state is rendered for real, through `loadComponent`, by the same compiler and the same
 * React the app ships — so "the field is not marked invalid before anything is typed, and the
 * correction is not in the accessibility tree waiting to be read out on every visit" is a fact
 * about the component rather than about a copy of it.
 *
 * The MALFORMED state cannot be rendered here and this file does not pretend otherwise. Reaching
 * it needs a change event carrying `validity.badInput`, which needs a DOM, and this package's
 * tests run under `node --test` with no DOM and no client renderer (ADR 0008 — and adding one is a
 * dependency this project has declined). So the malformed path is covered in two other places
 * instead, and they are the two halves that actually matter:
 *
 *   - the DECISION is `isDraftMalformed` in `src/bet-sizing.ts`, a pure function driven in
 *     `bet-sizing.test.ts` with the exact pair a browser produces — `{ text: '', badInput: true }`
 *     against `{ text: '', badInput: false }` — which is the pair a value-derived implementation
 *     gets wrong;
 *   - the WIRING is asserted below against the component's source, because the one thing a
 *     rendered clean state cannot show is *where the flag comes from*. A rewrite that derived the
 *     invalid state from the value would still render this file's clean state identically, still
 *     pass every arithmetic test, and still be the original defect.
 *
 * That is the same division `apps/web/test/live-regions.test.ts` settled on for the same defect on
 * the quiz field, for the same reason.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LegalAction, TableAction } from '../src/view-types.ts';
import { loadComponent } from './support/render-component.ts';

interface ActionBarProps {
  readonly legalActions: readonly LegalAction[];
  readonly onAct: (action: TableAction) => void;
  readonly pot: number;
  readonly toCall: number;
  readonly committedThisStreet: number;
  readonly disabled?: boolean;
  readonly idleText?: string;
  readonly className?: string;
}

/** A spot with a sizer on offer: facing a bet of 100 with 840 behind. */
const FACING_A_BET: readonly LegalAction[] = [
  { type: 'fold' },
  { type: 'call', minTo: 100, costAtMin: 100 },
  { type: 'raise', minTo: 200, maxTo: 840, note: 'The minimum raise is twice the current bet.' },
];

async function render(props: Partial<ActionBarProps> = {}): Promise<string> {
  const ActionBar = await loadComponent<ActionBarProps>('components/ActionBar', 'ActionBar');
  return renderToStaticMarkup(
    createElement(ActionBar, {
      legalActions: FACING_A_BET,
      onAct: () => undefined,
      pot: 300,
      toCall: 100,
      committedThisStreet: 0,
      ...props,
    }),
  );
}

/** The `<input type="number">` tag, as one string, so its attributes can be read together. */
function numberFieldTag(markup: string): string {
  const found = /<input[^>]*type="number"[^>]*>/u.exec(markup);
  assert.ok(found !== null, `no number input in the rendered action bar:\n${markup}`);
  return found[0];
}

/** The value of one attribute on a tag, or null when the attribute is absent. */
function attribute(tag: string, name: string): string | null {
  const found = new RegExp(`${name}="([^"]*)"`, 'u').exec(tag);
  return found === null ? null : (found[1] ?? '');
}

const SOURCE = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src'), 'components', 'ActionBar.tsx'),
  'utf8',
);

describe('the bet amount field, rendered clean', () => {
  it('renders a number field wired to the allowed range', async () => {
    const field = numberFieldTag(await render());
    const describedBy = attribute(field, 'aria-describedby');
    assert.ok(describedBy !== null, `the number field describes itself with nothing: ${field}`);
    assert.equal(
      describedBy.split(' ').length,
      1,
      `expected one description before anything is typed, got "${describedBy}"`,
    );
    const markup = await render();
    assert.ok(
      markup.includes(`id="${describedBy}"`),
      'aria-describedby must point at an element that exists; a dangling id is announced as nothing',
    );
  });

  it('is not marked invalid before anything has been typed', async () => {
    const field = numberFieldTag(await render());
    assert.equal(
      attribute(field, 'aria-invalid'),
      null,
      'a field nobody has typed in yet must not be announced as invalid; `aria-invalid="false"` ' +
        'is also wrong here — the attribute is simply absent until there is something wrong',
    );
  });

  it('keeps the correction out of the accessibility tree until it applies', async () => {
    const markup = await render();
    assert.ok(
      !markup.includes('prl-field__error'),
      'the correction is rendered conditionally, not hidden with CSS: a description that is ' +
        'present but usually irrelevant is read out on every visit to the field',
    );
  });
});

describe('where the invalid state comes from', () => {
  it('reads it from validity.badInput, which is the only thing that can report it', () => {
    // The defect, stated so it cannot come back: an `<input type="number">` sanitises text it
    // could not parse to the empty string, so nothing about the value distinguishes "the reader
    // typed letters" from "the reader cleared the field". Deriving the invalid state from the
    // draft therefore produces a check that can never fire.
    assert.match(
      SOURCE,
      /event\.target\.validity\.badInput/u,
      'the bet field must capture `event.target.validity.badInput` in its change handler. It is ' +
        'the only platform signal that unparseable text is present, and it is unrecoverable ' +
        'afterwards — by the time the draft is inspected the value is already "".',
    );
    assert.match(
      SOURCE,
      /aria-invalid=\{malformed \? true : undefined\}/u,
      'the number field must set aria-invalid from the malformed state',
    );
    assert.match(
      SOURCE,
      /const malformed = isDraftMalformed\(draft\)/u,
      'the malformed state must come from the shared predicate, which is where the two ways of ' +
        'getting non-numeric text into the field are handled and tested',
    );
  });

  it('puts the correction before the range in aria-describedby', () => {
    // Order is not cosmetic. A reader who has just been told the field is invalid should hear WHY
    // before hearing the allowed range again, which they have already heard once.
    assert.match(
      SOURCE,
      /malformed \? `\$\{invalidId\} \$\{boundsId\}` : boundsId/u,
      'the correction id must come first in aria-describedby',
    );
  });

  it('clears the invalid state on every path that writes a real number into the field', () => {
    // A separate `badInput` flag beside the text could outlive the text it described: click a
    // preset while the flag is true and a perfectly legal amount stays marked invalid. Carrying
    // both in one draft object makes that unreachable, so every writer states `badInput: false`.
    const writers = [...SOURCE.matchAll(/onDraft\(\{[^}]*\}/gu)].map((match) => match[0]);
    assert.ok(writers.length >= 4, `expected the sizer's draft writers, found ${writers.length}`);
    for (const writer of writers) {
      assert.match(
        writer,
        /badInput: (?:false|event\.target\.validity\.badInput)/u,
        `every path that writes a draft must state the badInput it implies: ${writer}`,
      );
    }
  });
});

describe('a call that takes the whole stack says so', () => {
  /** Facing a bet of 62 with exactly 62 behind: calling is all in. */
  const ALL_IN_CALL: readonly LegalAction[] = [
    { type: 'fold' },
    {
      type: 'call',
      minTo: 62,
      costAtMin: 62,
      allInAtMax: true,
      note: 'Calling puts your whole remaining stack in.',
    },
  ];

  it('speaks the all-in and prints the engine sentence (REGRESSION)', async () => {
    // The engine decides this and writes the sentence; both were dropped here, so a learner
    // pressing Call for their last chip saw "Call / 62 units" — identical to any other call.
    // Measured over 3,000 hands: 3,569 of 15,137 call offers were all-in calls.
    const markup = await render({ legalActions: ALL_IN_CALL, toCall: 62 });
    assert.match(markup, /call 62 units, which is all in/u, 'the spoken label must say it is all in');
    assert.match(markup, /Calling puts your whole remaining stack in\./u, "the engine's note must be shown");
  });

  it('says nothing of the sort on an ordinary call, so the wording is conditional', async () => {
    // Without this, the guard above is satisfied by printing "all in" on every call.
    const markup = await render();
    assert.ok(!markup.includes('which is all in'), 'an ordinary call must not be announced as all in');
    assert.ok(
      !markup.includes('Calling puts your whole remaining stack in.'),
      'an ordinary call must not carry the all-in note',
    );
  });
});
