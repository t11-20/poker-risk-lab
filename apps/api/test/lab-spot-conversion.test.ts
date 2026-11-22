/**
 * The Lab editor's copy of a built-in scenario prices to the report this API serves for it, byte for
 * byte, so "Edit a copy" opens on the numbers the reader just saw. The web modules are loaded by URL,
 * as `web-fixture-figures.test.ts` loads the fixtures, because `apps/web` is not a dependency here.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { scenarios } from '@prl/content';
import type { CoachReport, Scenario } from '@prl/contracts';
import { coachTaskFor } from '../src/routes/content.ts';
import { WorkerPool } from '../src/workers/pool.ts';

const WEB_LIB = new URL('../../web/src/lib/', import.meta.url);

interface Converted {
  readonly draftFromScenario: (scenario: Scenario) => unknown;
}
interface Validated {
  readonly validateDraft: (
    draft: unknown,
  ) => { ok: true; spot: unknown } | { ok: false; errors: Map<string, string> };
}
interface Analysed {
  readonly reportForSpot: (
    spot: unknown,
  ) => { ok: true; report: CoachReport } | { ok: false; message: string };
}

const { draftFromScenario } = (await import(new URL('spot-convert.ts', WEB_LIB).href)) as Converted;
const { validateDraft } = (await import(new URL('spot-validate.ts', WEB_LIB).href)) as Validated;
const { reportForSpot } = (await import(new URL('spot-analysis.ts', WEB_LIB).href)) as Analysed;

const pool = new WorkerPool({ size: 1, timeoutMs: 60_000 });
after(async () => {
  await pool.close();
});

test('every built-in scenario, copied into the editor, prices to the report the API serves', async () => {
  const all = scenarios();
  assert.ok(all.length > 30, 'a sweep of nothing is not a pass');
  for (const scenario of all) {
    const draft = draftFromScenario(scenario);
    assert.ok(draft !== null, `${scenario.id} did not convert`);
    const checked = validateDraft(draft);
    assert.ok(
      checked.ok,
      `${scenario.id} failed validation: ${checked.ok ? '' : [...checked.errors.values()].join(' ')}`,
    );
    const priced = reportForSpot(checked.spot);
    assert.ok(priced.ok, `${scenario.id} was refused: ${priced.ok ? '' : priced.message}`);
    const served = await pool.runCoach(coachTaskFor(scenario));
    assert.equal(JSON.stringify(priced.report), JSON.stringify(served), scenario.id);
  }
});

test('a stated fold rate survives the copy', async () => {
  const base = all36('rk-high-spr-same-top-pair');
  for (const rate of [0.3, 0.35, 0.333]) {
    const scenario = { ...base, assumedFoldEquity: rate };
    const checked = validateDraft(draftFromScenario(scenario));
    assert.ok(checked.ok);
    const priced = reportForSpot(checked.spot);
    assert.ok(priced.ok);
    assert.equal(
      JSON.stringify(priced.report),
      JSON.stringify(await pool.runCoach(coachTaskFor(scenario))),
      `${rate}`,
    );
  }
});

function all36(id: string): Scenario {
  const found = scenarios().find((scenario) => scenario.id === id);
  assert.ok(found !== undefined, `${id} is no longer in the bundle`);
  return found;
}
