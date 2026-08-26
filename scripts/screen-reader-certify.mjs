#!/usr/bin/env node
/**
 * The screen-reader certification, run as a session rather than filled in as a form.
 *
 * This is what `pnpm run certify:screen-reader` does.
 *
 * ## Why this exists
 *
 * `docs/production/accessibility-certification.md` is a long document of 72 assertions, and every
 * release report this project has produced records the same result for it: **UNVERIFIED**. The
 * reason given each time is `osascript` error **-1743** — macOS refusing an agent permission to
 * send Apple events to System Events, so nothing automated can drive VoiceOver or read back what
 * it said.
 *
 * That reason is true and it is also, for this purpose, beside the point. **-1743 blocks an agent.
 * It does not block a person.** A human sitting at the machine needs no Automation grant to press
 * Command + F5 and listen; what they have needed, and not had, is a way to work through dozens of
 * assertions without losing their place, and a way to leave behind something a release report can
 * cite. A markdown table with blank cells is not that.
 *
 * So this harness does the parts a machine can do — check the environment, hold the place, read
 * the assertions out of the document, refuse an incomplete result, stamp it with the commit it was
 * run against — and leaves the one part a machine cannot do, which is listening, to the person.
 *
 * ## It asks for 4 of the 72, and says so
 *
 * A large share of those 72 were never really about speech. "The theme control announces as a radio
 * group with three options, the current one selected" is a fact about the accessibility tree, and a
 * machine reads that tree better than a person listening to it can. **68 of the 72 are now checked
 * on every run of `pnpm run test:ax`** (`scripts/ax-assertions.mjs`, one check per assertion ID),
 * and this session presents only the **4** that are left: where a virtual cursor goes past the end
 * of a modal, and three states no fixture reaches honestly.
 * Nineteen of those 68 were in this session until the gate grew three fixtures — a live table over
 * a real socket, a hand it played and replayed at `/review/<handId>`, and a second web app with no
 * API behind it — because "needs a live table" and "needs the API down" were statements about the
 * gate rather than about speech. Three more moved because they were application DEFECTS filed as
 * certification limits, and three more on 2026-08-26 because the reason each had been left was
 * answerable: a prompt read twice has exactly one cause inside the tree (2.4), "no score anywhere"
 * is decidable by running the quiz twice and requiring the two ends to read the same (2.9), and a
 * server refusal needs one task rather than a second actor (3.19). Section 5 of the document names
 * every one of them.
 *
 * Which set a row is in is decided by the document's own `Checked by` column, not by anything here,
 * so re-marking a row moves it with no code change — and `screen-reader-certify.test.mjs` asserts
 * that the `auto` rows are exactly the rows `ax-assertions.mjs` has a check for, in both
 * directions. A check deleted while the document still says `auto` would take that row out of the
 * automated set AND out of this session at once, leaving it covered by nobody. That is the failure
 * the mapping test exists to prevent.
 *
 * **This does not weaken the blocker.** The 4 still need a person, and until one has worked through
 * them the certification is UNVERIFIED. What changed is that it is now five minutes rather than an
 * afternoon, and that a regression in any of the other 68 fails `pnpm run verify` on the day it
 * lands instead of waiting for a session nobody has scheduled. One of the 4 — 4.2 — is a defect
 * this session is holding rather than a limit of it: the answer was measured and it is SILENT. See
 * section 5 of the document.
 *
 * ## It reads the document; it does not restate it
 *
 * Every assertion presented here is parsed out of the certification document at run time. That is
 * deliberate and it is the whole reason this file is short. A harness that carried its own copy of
 * the assertions would be a second source of truth that drifts from the first the moment
 * somebody edits either — and the failure would be silent, because a certification that asks the
 * wrong questions still produces a filled-in form. Edit the document; this follows.
 *
 * ## A certification is only valid for the commit it was run against
 *
 * The artefact records the SHA and whether the tree was clean. `--check` re-reads it and refuses
 * to call it current if `HEAD` has moved, which is what stops a passing certification from being
 * quoted at a build nobody listened to. That is the same rule
 * `deploy/staging/staging-verified.json` already applies to a smoke run, for the same reason.
 *
 * ## What this does NOT do
 *
 * It does not certify anything. It records what a person heard. If the person clicks through
 * without listening, the artefact is worthless and nothing here can tell. The defence against that
 * is the same as for any manual QA: the reviewer's name is on it, `--check` shows what build it
 * covers, and a `FAIL` or a `SILENT` requires a quoted announcement, so a careless PASS is at
 * least a deliberate one.
 *
 * Usage:
 *     pnpm run certify:screen-reader                 # start or resume a session (the 10)
 *     pnpm run certify:screen-reader -- --all        # every row, machine-covered ones included
 *     pnpm run certify:screen-reader -- --check      # is the recorded result current?
 *     pnpm run certify:screen-reader -- --preflight  # environment only, answer nothing
 *     pnpm run certify:screen-reader -- --section J3 # one journey
 *
 * Exit codes:
 *     0  a complete session with no FAIL and no SILENT, or a `--check` that is current
 *     1  incomplete, or any FAIL/SILENT, or a `--check` against a moved HEAD
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DOC = join(REPO_ROOT, 'docs', 'production', 'accessibility-certification.md');
const RESULT = join(REPO_ROOT, 'docs', 'production', 'accessibility-certification-result.json');

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const bold = (s) => paint('1', s);
const dim = (s) => paint('2', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const cyan = (s) => paint('36', s);

// ---------------------------------------------------------------------------
// Reading the document
// ---------------------------------------------------------------------------

/** The two values the document's `Checked by` column may hold. Anything else is a parse failure. */
export const COVERAGE_MARKERS = new Set(['auto', 'person']);

/**
 * Every assertion in the certification document, in order.
 *
 * The document uses two table shapes and this reads both, because reading only one is how a
 * harness silently certifies a tenth of the document:
 *
 *   * the global table — `| G1 | <auto|person> | <assertion> | <result> |`
 *   * the journey tables — `| 1.4 | <auto|person> | <step, with keys> | <assertion> | <result> |`
 *
 * The journey shape carries the STEP as well as the assertion, and the step is the half that tells
 * a reviewer which keys to press. Dropping it would leave them holding an assertion about
 * something they were never told to do.
 *
 * The second cell is the `Checked by` marker, and it is REQUIRED rather than optional. A row
 * without one is thrown, not defaulted, because both defaults are wrong: defaulting to `person`
 * hides a check that was supposed to exist, and defaulting to `auto` drops a row out of the human
 * session on the strength of a typo. The only safe answer to "somebody added a row and did not
 * classify it" is to stop.
 *
 * The trailing result column is the blank a reviewer used to fill in by hand and is ignored: it is
 * what this harness replaces.
 *
 * A section is the `##`/`###` heading the row sits under, taken from the document rather than
 * hard-coded, so adding Journey 9 needs no edit here.
 *
 * @returns {Array<{id: string, section: string, coverage: string, step: string|null, text: string}>}
 */
export function assertionsIn(markdown) {
  const found = [];
  let section = 'Unsectioned';
  for (const line of markdown.split('\n')) {
    const heading = /^#{2,3}\s+(.*?)\s*$/.exec(line);
    if (heading !== null) {
      section = heading[1].replace(/`/g, '');
      continue;
    }
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 3) continue;
    // A separator row, and the header row whose first cell is `#` or `ID`.
    if (/^:?-+:?$/.test(cells[0])) continue;

    const globalId = /^([A-Z]+\d+)$/.exec(cells[0]);
    const stepId = /^(\d+\.\d+)$/.exec(cells[0]);
    if (globalId === null && stepId === null) continue;

    const coverage = cells[1];
    if (!COVERAGE_MARKERS.has(coverage)) {
      throw new Error(
        `assertion ${cells[0]} has "Checked by" = "${coverage}", which is neither "auto" nor ` +
          '"person". Every row must say which set it is in; see §5 and §11 of the document.',
      );
    }
    if (globalId !== null && cells[2] !== '') {
      found.push({ id: globalId[1], section, coverage, step: null, text: cells[2] });
      continue;
    }
    // `1.4`, `3.11` — a journey step. Four cells at minimum: id, marker, step, assertion.
    if (stepId !== null && cells.length >= 4 && cells[3] !== '') {
      found.push({ id: `J${stepId[1]}`, section, coverage, step: cells[2], text: cells[3] });
    }
  }
  return found;
}

/** The rows a person still has to listen to. The rest are asserted by `pnpm run test:ax`. */
export const needsAPerson = (assertions) => assertions.filter((entry) => entry.coverage === 'person');

/** Markdown emphasis and links, flattened for a terminal. */
export function plainText(markdown) {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, (_, inner) => bold(inner))
    .replace(/`([^`]+)`/g, (_, inner) => (NO_COLOR ? inner : paint('36', inner)))
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * What a reviewer needs to know before they start, and what a stale result needs to be judged by.
 *
 * The `-1743` probe is here for one reason: to say plainly that it does NOT block this session.
 * Every readiness report so far has recorded it as the reason the certification is unverified, and
 * a reviewer who has read those reports will reasonably expect to be stopped by it. They are not.
 */
function environment() {
  const sha = git(['rev-parse', 'HEAD']);
  const dirty = (git(['status', '--porcelain']) ?? '').length > 0;
  let appleEvents = 'not applicable (not macOS)';
  if (process.platform === 'darwin') {
    try {
      execFileSync('osascript', ['-e', 'tell application "System Events" to return name of first process'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      appleEvents = 'granted';
    } catch (error) {
      appleEvents = /-1743/.test(String(error?.stderr ?? error?.message ?? ''))
        ? 'refused (-1743)'
        : 'unavailable';
    }
  }
  return { sha, dirty, platform: process.platform, appleEvents };
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

const VERDICTS = new Map([
  ['p', 'PASS'],
  ['f', 'FAIL'],
  ['s', 'SILENT'],
  ['n', 'N/A'],
]);

const options = {
  check: process.argv.includes('--check'),
  preflight: process.argv.includes('--preflight'),
  // `--all` puts the machine-covered rows back in front of the reviewer. It exists for somebody who
  // does not take the automated half on trust and wants to hear it, and it is not the normal
  // session — the artefact records which of the two was run so the two are never confused.
  all: process.argv.includes('--all'),
  section: (() => {
    const at = process.argv.indexOf('--section');
    return at === -1 ? null : (process.argv[at + 1] ?? null);
  })(),
};

function loadResult() {
  if (!existsSync(RESULT)) return null;
  try {
    return JSON.parse(readFileSync(RESULT, 'utf8'));
  } catch {
    return null;
  }
}

function summarise(answers) {
  const counts = { PASS: 0, FAIL: 0, SILENT: 0, 'N/A': 0 };
  for (const answer of Object.values(answers)) counts[answer.verdict] += 1;
  return counts;
}

/** A session is only a pass when every assertion was answered and none failed or was silent. */
function verdictOf(total, counts, answered) {
  if (answered < total) return { ok: false, why: `${total - answered} assertion(s) unanswered` };
  if (counts.FAIL > 0) return { ok: false, why: `${counts.FAIL} FAIL` };
  if (counts.SILENT > 0) return { ok: false, why: `${counts.SILENT} SILENT` };
  return { ok: true, why: 'every assertion answered, none failed, none silent' };
}

function reportCheck() {
  const stored = loadResult();
  if (stored === null) {
    console.log(red('\n  No certification result recorded.'));
    console.log(
      dim(`  Run \`pnpm run certify:screen-reader\` to produce ${RESULT.replace(`${REPO_ROOT}/`, '')}.\n`),
    );
    return 1;
  }
  const now = environment();
  const counts = summarise(stored.answers ?? {});
  const answered = Object.keys(stored.answers ?? {}).length;
  const verdict = verdictOf(stored.total ?? answered, counts, answered);

  console.log(bold('\nScreen-reader certification — recorded result\n'));
  console.log(`  reviewer     ${stored.reviewer ?? 'unrecorded'}`);
  console.log(`  reader       ${stored.reader ?? 'unrecorded'} on ${stored.browser ?? 'unrecorded'}`);
  console.log(`  recorded at  ${stored.recordedAt ?? 'unrecorded'}`);
  console.log(`  build        ${stored.sha ?? 'unrecorded'}${stored.dirty ? dim(' (tree was dirty)') : ''}`);
  console.log(
    `  assertions   ${answered}/${stored.total ?? answered} — ` +
      `${counts.PASS} PASS, ${counts.FAIL} FAIL, ${counts.SILENT} SILENT, ${counts['N/A']} N/A`,
  );

  const current = stored.sha === now.sha && stored.dirty === false;
  if (!verdict.ok) {
    console.log(red(`\n  NOT CERTIFIED — ${verdict.why}.\n`));
    return 1;
  }
  if (!current) {
    console.log(
      yellow(
        `\n  STALE — this certifies ${String(stored.sha).slice(0, 12)}` +
          `${stored.dirty ? ' (dirty)' : ''}, and HEAD is ${String(now.sha).slice(0, 12)}` +
          `${now.dirty ? ' (dirty)' : ''}.`,
      ),
    );
    console.log(dim('  A screen reader speaks the build it was run against and no other. Re-run it.\n'));
    return 1;
  }
  console.log(green(`\n  CERTIFIED for ${String(stored.sha).slice(0, 12)} — ${verdict.why}.\n`));
  return 0;
}

async function main() {
  if (!existsSync(DOC)) {
    console.error(red(`  ${DOC} is missing; there is nothing to certify against.`));
    return 1;
  }
  if (options.check) return reportCheck();

  const env = environment();
  const everyRow = assertionsIn(readFileSync(DOC, 'utf8'));
  // The session is the `person` rows. The rest are asserted on every run of `pnpm run test:ax` and
  // a reviewer's half-hour is the scarcest thing here — spending it re-deciding what a gate already
  // decides is how the whole procedure stays unexecuted.
  const all = options.all ? everyRow : needsAPerson(everyRow);
  const machineCovered = everyRow.length - needsAPerson(everyRow).length;
  const coverage = {
    scope: options.all ? 'every-row' : 'person',
    documentAssertions: everyRow.length,
    machineCovered,
  };
  const assertions = options.section === null ? all : all.filter((a) => a.id.startsWith(options.section));

  console.log(bold('\nScreen-reader certification\n'));
  console.log(`  build        ${env.sha}${env.dirty ? yellow(' — TREE IS DIRTY') : ''}`);
  console.log(`  platform     ${env.platform}`);
  console.log(`  Apple events ${env.appleEvents}`);
  console.log(
    `  assertions   ${assertions.length}${options.section === null ? '' : ` in ${options.section}`}` +
      `${options.all ? ' (--all: the machine-covered rows are included)' : ''}`,
  );
  console.log(
    `  of ${everyRow.length} in the document, ${green(String(machineCovered))} are marked ` +
      `${bold('auto')} and are asserted on every run of ${cyan('pnpm run test:ax')}`,
  );
  console.log(
    dim(
      '  Those checks are scripts/ax-assertions.mjs, one per assertion ID, against the rendered\n' +
        '  accessibility tree in real Chrome. They certify NOTHING — they establish that the facts\n' +
        `  those rows rest on are still true. The ${needsAPerson(everyRow).length} rows below are the ` +
        'ones no gate in this\n  repository can decide: a virtual cursor past the end of a modal, a count that ' +
        'arrives\n  with its own full page load, and two states no honest fixture reaches. Section 5 of ' +
        'the\n  document gives the reason for each, one line each — read them before you start.',
    ),
  );
  if (!options.all) {
    console.log(dim('  Run with --all to be asked the machine-covered rows as well.'));
  }
  console.log(
    yellow('\n  Before you start: confirm `pnpm run test:ax` is green on this build.') +
      dim('\n  A manual pass over a build whose machine-checkable facts are broken certifies nothing.'),
  );
  if (env.appleEvents === 'refused (-1743)') {
    console.log(
      dim(
        '\n  -1743 is why every automated attempt at this has been recorded as UNVERIFIED. It does\n' +
          '  NOT block you: it refuses an agent permission to drive VoiceOver, and you are going to\n' +
          '  drive it yourself with Command + F5. Nothing below needs that grant.',
      ),
    );
  }
  if (env.dirty) {
    console.log(
      yellow(
        '\n  The working tree is dirty. A certification records what a reader said about a build,\n' +
          '  and a build nobody can reconstruct is not one. Commit first, or accept that `--check`\n' +
          '  will always call this stale.',
      ),
    );
  }
  console.log(dim(`\n  Read §2 to §5 of ${DOC.replace(`${REPO_ROOT}/`, '')} before starting.`));
  console.log(dim('  Turn on the speech viewer / announcement log first — you will be asked to quote.'));

  if (options.preflight) {
    console.log(dim('\n  --preflight: nothing recorded.\n'));
    return 0;
  }
  if (assertions.length === 0) {
    // "No assertions matched" is the wrong report for a section every row of which is machine
    // covered — a reviewer who ran `--section G` and read that would reasonably conclude the
    // harness had lost the global assertions, when what happened is that all ten of them are now
    // checked by a gate. Say which of the two it is.
    const inSection =
      options.section === null ? everyRow : everyRow.filter((a) => a.id.startsWith(options.section));
    if (!options.all && inSection.length > 0) {
      console.log(
        green(
          `\n  Every one of the ${inSection.length} assertion(s) in ${options.section} is marked ` +
            '`auto` and is checked by `pnpm run test:ax`.',
        ),
      );
      console.log(dim('  Nothing here needs a person. Use --all to be asked them anyway.\n'));
      return 0;
    }
    console.error(
      red(`\n  No assertions matched${options.section === null ? '' : ` --section ${options.section}`}.\n`),
    );
    return 1;
  }

  const stored = loadResult();
  const answers = stored?.sha === env.sha ? { ...(stored.answers ?? {}) } : {};
  if (Object.keys(answers).length > 0) {
    console.log(
      dim(`\n  Resuming: ${Object.keys(answers).length} assertion(s) already recorded for this build.`),
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let section = null;
    for (const assertion of assertions) {
      if (answers[assertion.id] !== undefined) continue;
      if (assertion.section !== section) {
        section = assertion.section;
        console.log(bold(`\n── ${section} ${'─'.repeat(Math.max(0, 60 - section.length))}`));
      }
      console.log(`\n${bold(assertion.id)}  ${plainText(assertion.text)}`);
      if (assertion.step !== null) console.log(dim(`      do: ${plainText(assertion.step)}`));
      let verdict = null;
      while (verdict === null) {
        const key = (await rl.question(dim('   [p]ass / [f]ail / [s]ilent / [n]a / [q]uit > ')))
          .trim()
          .toLowerCase();
        if (key === 'q') {
          console.log(dim('\n  Stopping. Answers so far are saved; re-run to resume.\n'));
          writeResult(env, all.length, answers, stored, coverage);
          return 1;
        }
        verdict = VERDICTS.get(key) ?? null;
        if (verdict === null) console.log(dim('   one of p, f, s, n, q'));
      }
      // A failure without the words is a failure nobody can act on: "it announced the wrong thing"
      // is not a defect report, and the announcement is the entire subject matter here.
      let heard = '';
      if (verdict === 'FAIL' || verdict === 'SILENT') {
        heard = (await rl.question(dim('   quote what was announced (empty if nothing) > '))).trim();
      }
      const note = (await rl.question(dim('   note (optional) > '))).trim();
      answers[assertion.id] = {
        verdict,
        ...(heard === '' ? {} : { heard }),
        ...(note === '' ? {} : { note }),
      };
      writeResult(env, all.length, answers, stored, coverage);
    }

    const reviewer = stored?.reviewer ?? (await rl.question(dim('\n  reviewer name > '))).trim();
    const reader = stored?.reader ?? (await rl.question(dim('  screen reader and version > '))).trim();
    const browser = stored?.browser ?? (await rl.question(dim('  browser and version > '))).trim();
    writeResult(env, all.length, answers, { reviewer, reader, browser }, coverage);

    const counts = summarise(answers);
    const verdict = verdictOf(all.length, counts, Object.keys(answers).length);
    console.log(bold('\nResult'));
    console.log(
      `  ${counts.PASS} PASS · ${counts.FAIL} FAIL · ${counts.SILENT} SILENT · ${counts['N/A']} N/A ` +
        `of ${all.length}`,
    );
    console.log(dim(`  written to ${RESULT.replace(`${REPO_ROOT}/`, '')}`));
    if (verdict.ok) {
      console.log(green(bold(`\n  CERTIFIED — ${verdict.why}.\n`)));
      return 0;
    }
    console.log(red(bold(`\n  NOT CERTIFIED — ${verdict.why}.\n`)));
    for (const [id, answer] of Object.entries(answers)) {
      if (answer.verdict === 'FAIL' || answer.verdict === 'SILENT') {
        console.log(`  ${red(answer.verdict.padEnd(6))} ${id}  ${answer.heard ?? dim('(nothing quoted)')}`);
      }
    }
    console.log('');
    return 1;
  } finally {
    rl.close();
  }
}

/**
 * The artefact.
 *
 * `total` is the size of the set this session was asked, not the size of the document, and `scope`
 * plus `machineCovered` are what stop those two being confused by whoever quotes the file later. A
 * release report that read "7 of 7" with no scope would look like a certification of a 72-row
 * document that had shrunk without explanation.
 */
function writeResult(env, total, answers, identity, coverage) {
  const payload = {
    schema: 'prl.screen-reader-certification.v2',
    recordedAt: new Date().toISOString(),
    sha: env.sha,
    dirty: env.dirty,
    platform: env.platform,
    reviewer: identity?.reviewer ?? null,
    reader: identity?.reader ?? null,
    browser: identity?.browser ?? null,
    scope: coverage?.scope ?? 'person',
    documentAssertions: coverage?.documentAssertions ?? null,
    machineCovered: coverage?.machineCovered ?? null,
    machineCheckedBy: 'pnpm run test:ax — scripts/ax-assertions.mjs',
    total,
    answers,
  };
  writeFileSync(RESULT, `${JSON.stringify(payload, null, 2)}\n`);
}

if (import.meta.main) {
  process.exitCode = await main();
}
