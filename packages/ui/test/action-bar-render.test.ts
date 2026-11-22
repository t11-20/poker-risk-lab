/**
 * `ActionBar`, rendered, with the bet field's invalid state as the subject.
 * Unparseable text in a number field reports `value === ''`, so the sizer silently fell back to the
 * minimum. The clean state is rendered. The malformed state needs a DOM (ADR 0008), so its decision
 * is driven in `bet-sizing.test.ts` and its wiring is read from the source here.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactNode } from 'react';
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
  readonly idleAction?: ReactNode;
  readonly context?: ReactNode;
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
    // A number input sanitises unparseable text to "", so the value cannot tell letters from a cleared field.
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
    // A reader told the field is invalid should hear why before hearing the range again.
    assert.match(
      SOURCE,
      /malformed\s*\?\s*`\$\{invalidId\} \$\{boundsId\}`\s*:/u,
      'the correction id must come first in aria-describedby',
    );
  });

  it('clears the invalid state on every path that writes a real number into the field', () => {
    // A separate flag could outlive its text and mark a preset's legal amount invalid, so every
    // draft writer states `badInput`.
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

  it('speaks the all-in (REGRESSION)', async () => {
    // Over 3,000 hands, 3,569 of 15,137 call offers were all-in calls.
    const markup = await render({ legalActions: ALL_IN_CALL, toCall: 62 });
    assert.match(
      markup,
      /aria-label="call 62 units, all in"/u,
      'the spoken name must begin with the visible label',
    );
  });

  it('prints the all-in on the button as well as speaking it', async () => {
    const markup = await render({ legalActions: ALL_IN_CALL, toCall: 62 });
    assert.match(markup, /<span class="prl-action-btn__label">Call 62<\/span>/u, markup);
    assert.match(markup, /<span class="prl-action-btn__cost">All in<\/span>/u, markup);
  });

  it('says nothing of the sort on an ordinary call, so the wording is conditional', async () => {
    const markup = await render();
    assert.match(
      markup,
      /aria-label="call 100 units"><span class="prl-action-btn__label">Call 100<\/span><\/button>/u,
      'an ordinary call is not announced or printed as all in',
    );
  });
});

describe('a bet or raise of the whole stack says so on the button', () => {
  /** Facing 100 with 340 behind: a full raise is out of reach, so the only raise is all in. */
  const SHOVE_ONLY: readonly LegalAction[] = [
    { type: 'fold' },
    { type: 'call', minTo: 100, costAtMin: 100 },
    { type: 'raise', minTo: 340, maxTo: 340, allInAtMax: true },
  ];

  it('prints and speaks the all-in when the only raise is the whole stack (REGRESSION)', async () => {
    const markup = await render({ legalActions: SHOVE_ONLY });
    assert.match(markup, /<span class="prl-action-btn__label">Raise to 340<\/span>/u, markup);
    assert.match(markup, /<span class="prl-action-btn__cost">All in<\/span>/u, markup);
    assert.match(markup, /aria-label="raise to 340 units, all in"/u);
    assert.match(
      markup,
      /<span class="prl-sizer__readout-value">All in<\/span>/u,
      'the readout must agree with the button',
    );
  });

  it('NEGATIVE CONTROL: a raise with chips left behind names no all-in', async () => {
    const markup = await render();
    assert.match(markup, /<span class="prl-action-btn__label">Raise to 200<\/span>/u, markup);
    assert.ok(!markup.includes('all in'), markup);
  });
});

describe('a fold where checking is free says what it gives up', () => {
  /** First to act on the flop: nothing to call, a bet on offer. */
  const CHECK_IS_FREE: readonly LegalAction[] = [
    { type: 'fold' },
    { type: 'check', costAtMin: 0 },
    { type: 'bet', minTo: 10, maxTo: 840 },
  ];

  it('prints and speaks that checking is free beside Fold (REGRESSION)', async () => {
    const markup = await render({ legalActions: CHECK_IS_FREE, toCall: 0 });
    assert.match(markup, /<p class="prl-action-bar__hint">Checking is free\.<\/p>/u);
    assert.match(markup, /fold, costs 0 units and gives up the hand, though checking is free/u);
  });

  it('draws Fold as plain Fold beside a free check until a pointer has pressed it once', async () => {
    // The armed state needs a click and so a DOM (ADR 0008). `fold-guard.test.ts` drives the decision.
    const markup = await render({ legalActions: CHECK_IS_FREE, toCall: 0 });
    assert.match(markup, /<span class="prl-action-btn__label">Fold<\/span>/u);
    assert.ok(!markup.includes('Fold anyway'), 'nothing has been pressed, so nothing is armed');
  });

  it('feeds the guard whether a POINTER pressed Fold, and sends the fold through it', () => {
    // A rewrite that dropped `event.detail` would render identically and fold a mis-tap at once.
    const code = SOURCE.replace(/\s+/gu, ' ');
    assert.match(code, /foldPress\(\{ canCheck, pointer: event\.detail > 0, armed: foldArmed \}\)/u);
    assert.match(code, /<FoldButton [^>]*onClick=\{pressFold\}/u);
    assert.doesNotMatch(
      code,
      /onClick=\{\(\) => actFromBar\(\{ type: 'fold' \}\)\}/u,
      'Fold must not bypass the guard',
    );
  });

  it('says nothing of a free check when there is something to call', async () => {
    const markup = await render();
    assert.ok(!markup.includes('Checking is free'), 'no free check is on offer');
    assert.match(markup, /aria-label="fold, costs 0 units and gives up the hand"/u);
  });
});

describe('the idle line carries the next step beside it', () => {
  const deal = createElement('button', { type: 'button' }, 'Deal the next hand');

  it('draws the action after the idle line, inside the bar, and marks the line to share its row', async () => {
    const markup = await render({ legalActions: [], idleText: 'This hand is complete.', idleAction: deal });
    const line = markup.indexOf('class="prl-action-bar__idle prl-action-bar__idle--beside"');
    const action = markup.indexOf(
      '<div class="prl-action-bar__idle-action"><button type="button">Deal the next hand',
    );
    assert.ok(line >= 0, `the idle line is not marked to share its row: ${markup}`);
    assert.ok(action > line, `the action is not after the line: ${markup}`);
  });

  it('NEGATIVE CONTROL: without one, the line keeps its full row and nothing is added', async () => {
    const markup = await render({ legalActions: [], idleText: 'Waiting for another player to act.' });
    assert.ok(!markup.includes('prl-action-bar__idle--beside'), markup);
    assert.ok(!markup.includes('prl-action-bar__idle-action'), markup);
  });

  it('draws no idle action while there is a decision', async () => {
    const markup = await render({ idleAction: deal });
    assert.ok(markup.includes('class="prl-sizer"'), 'the decision did not render; the check is over nothing');
    assert.ok(!markup.includes('Deal the next hand'), markup);
  });
});

describe('while the reader waits, the bar keeps its context', () => {
  const glance = createElement('span', { className: 'probe-glance' }, 'cards and board');

  it('draws the context above the idle line, so the board and the latest action stay on a phone', async () => {
    const markup = await render({ legalActions: [], context: glance });
    const drawn = markup.indexOf('probe-glance');
    assert.ok(drawn >= 0, `the waiting bar dropped its context: ${markup}`);
    assert.ok(
      drawn < markup.indexOf('prl-action-bar__idle'),
      `the context is not above the idle line: ${markup}`,
    );
  });
});

describe('How betting works matches the spot', () => {
  /** The big blind's option in a limped pot: a free check and a raise, nothing to call. */
  const OPTION: readonly LegalAction[] = [
    { type: 'fold' },
    { type: 'check', costAtMin: 0 },
    { type: 'raise', minTo: 20, maxTo: 990 },
  ];

  it('does not say nobody has bet, or size a raise after a call that is not there (REGRESSION)', async () => {
    const markup = await render({ legalActions: OPTION, toCall: 0, committedThisStreet: 10, pot: 40 });
    assert.ok(!markup.includes('Nobody has bet'), 'the blinds and the limps are bets');
    assert.ok(!markup.includes('after you call'), 'there is nothing to call');
    assert.match(markup, /size the raise as a share of the pot\./u);
  });

  it('sizes a raise after the call when there is one to make', async () => {
    assert.match(await render(), /size the raise as a share of the pot after you call\./u);
  });
});

describe('the sizer readout and the call help', () => {
  it('keeps "Stack after" and its figure in one item, so the readout gap cannot split them', async () => {
    assert.match(
      await render(),
      // The tip rides inside the same item, after the figure.
      /<p class="prl-sizer__readout"><span>Stack after <span class="prl-sizer__readout-value">[\d,]+<\/span>(?:<span class="prl-tip">[\s\S]*?<\/span><\/span>)?<\/span><\/p>/u,
    );
  });

  it('says a short call puts the stack in, and does not tell the reader to match the bet', async () => {
    const markup = await render({
      legalActions: [
        { type: 'fold' },
        {
          type: 'call',
          minTo: 62,
          costAtMin: 62,
          allInAtMax: true,
          note: 'Calling puts your whole remaining stack in.',
        },
      ],
      toCall: 100,
    });
    assert.match(markup, /<strong>Call<\/strong>: Calling puts your whole remaining stack in\./u);
    assert.ok(!markup.includes('match the bet'), 'a short stack cannot match the bet');
  });

  it('describes the pot buttons only when there is more than one size', async () => {
    const shoveOnly = await render({
      legalActions: [
        { type: 'fold' },
        { type: 'call', minTo: 100, costAtMin: 100 },
        { type: 'raise', minTo: 340, maxTo: 340 },
      ],
    });
    assert.ok(!shoveOnly.includes('The pot buttons'), 'only All in is offered');
    assert.match(await render(), /The pot buttons/u);
  });
});
