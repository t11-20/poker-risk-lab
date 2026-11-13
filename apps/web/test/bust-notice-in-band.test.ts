/**
 * A reader who busts is told so in the decision band, not only in the card a screen above.
 *
 * ## The defect (audit at 6b3886e, M4)
 *
 * The out-of-units notice rendered only in the connection card, which sits above the table: at the
 * moment of a bust it was at y -1,203..-780 at 390x844, and above a Deal at -558 at 1440x900. On
 * screen were STACK 0, "went all in" and the showdown — the result, not that the reader was out, and
 * not what to do about it.
 *
 * ## What is checked, and how
 *
 * `TableStage.tsx` and `LiveTable.tsx` import `@prl/ui`, whose entry re-exports `.tsx`, and this
 * runner cannot load that (see `lib/coach-body.ts`), so the wiring is read from source. Each
 * predicate is also run against the text it replaced, where it must fail. The browser half — the
 * notice on screen beside the result — is measured, and recorded in the commit that added this.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

/** The live table hands the band a notice exactly when the roster says the reader is out. */
const handed = (source: string): boolean =>
  /\{\.\.\.\(live\.outOfUnits \? \{ decisionNotice: <OutOfUnitsAtTheTable \/> \} : \{\}\)\}/u.test(source);

/** The band renders whatever notice it was handed, inside `.prl-play__decision`. */
const rendered = (source: string): boolean => {
  const band = /function DecisionBand\([\s\S]*?\n\}\n/u.exec(source)?.[0] ?? '';
  return band.includes('className="prl-play__decision"') && band.includes('{props.notice}');
};

/** The band's copy of the notice says the reader is out and carries the way on. */
function bandNotice(source: string): string {
  const body = /function OutOfUnitsAtTheTable\(\): ReactElement \{([\s\S]*?)\n\}\n/u.exec(source)?.[1] ?? '';
  return body.replace(/\s+/gu, ' ');
}

describe('the out-of-units notice is where the reader is looking', () => {
  it('is handed to the decision band when the reader is out of units', () => {
    assert.ok(handed(read('app', 'play', 'LiveTable.tsx')), 'LiveTable does not hand the band the notice');
  });

  it('is rendered by the band', () => {
    assert.ok(rendered(read('components', 'TableStage.tsx')), 'DecisionBand does not render its notice');
  });

  it('says the reader is out, and links to the reset', () => {
    const words = bandNotice(read('app', 'play', 'LiveTable.tsx'));
    assert.match(words, /title="You are out of units"/u);
    assert.match(words, /<Link href="\/record">Reset your units on your record page<\/Link>/u);
  });

  it('is not a live region: the bust was narrated as it happened, and an alert would say it twice', () => {
    const words = bandNotice(read('app', 'play', 'LiveTable.tsx'));
    assert.ok(words.length > 0, 'the band notice was not found; the sweep is over nothing');
    assert.doesNotMatch(words, /role=|aria-live/u);
  });

  it('NEGATIVE CONTROLS: the predicates fail the code before, which showed it in the card only', () => {
    const oldStage = `function DecisionBand(props: DecisionBandProps): ReactElement {
  return (
    <div className="prl-play__decision">
      {autoActed === null ? null : <Callout tone="warning" title="The clock ran out">{autoActed}</Callout>}
    </div>
  );
}
`;
    assert.equal(rendered(oldStage), false);
    const oldLive = `        decisionRef={decisionRef}
        idleMessage={IDLE_TABLE_MESSAGE}`;
    assert.equal(handed(oldLive), false);
    assert.equal(bandNotice(oldLive), '');
  });
});
