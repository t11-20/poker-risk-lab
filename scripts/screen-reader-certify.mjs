#!/usr/bin/env node
/**
 * `pnpm run certify:screen-reader`: a guided VoiceOver session for the certification rows a person
 * must listen to. `osascript` error -1743 blocks an agent from driving VoiceOver, not a person.
 *
 * Rows are parsed from `docs/production/accessibility-certification.md` at run time, so the document
 * is the only copy. Its `Checked by` column decides which rows are `auto` (asserted by
 * `pnpm run test:ax`) and which need a person. The test pins `auto` rows to the checks in
 * `ax-assertions.mjs` in both directions. The artefact records the commit, and `--check` refuses it
 * once HEAD moves. It records what a person heard and certifies nothing by itself.
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

/** Anything else in the `Checked by` column is a parse failure. */
export const COVERAGE_MARKERS = new Set(['auto', 'person']);

/**
 * Reads both table shapes: global `| G1 | marker | assertion | result |` and journey
 * `| 1.4 | marker | step | assertion | result |`. The marker is required, because defaulting either
 * way hides a row. The trailing result column is ignored. Sections come from the headings.
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
    // A journey step needs at least id, marker, step and assertion.
    if (stepId !== null && cells.length >= 4 && cells[3] !== '') {
      found.push({ id: `J${stepId[1]}`, section, coverage, step: cells[2], text: cells[3] });
    }
  }
  return found;
}

export const needsAPerson = (assertions) => assertions.filter((entry) => entry.coverage === 'person');

export function plainText(markdown) {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, (_, inner) => bold(inner))
    .replace(/`([^`]+)`/g, (_, inner) => (NO_COLOR ? inner : paint('36', inner)))
    .replace(/\s+/g, ' ')
    .trim();
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** The -1743 probe is reported to say plainly that it does not block this session. */
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

const VERDICTS = new Map([
  ['p', 'PASS'],
  ['f', 'FAIL'],
  ['s', 'SILENT'],
  ['n', 'N/A'],
]);

const options = {
  check: process.argv.includes('--check'),
  preflight: process.argv.includes('--preflight'),
  // `--all` adds the machine-covered rows back. The artefact records which session was run.
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
    // Say whether the section has no rows or only machine-covered rows.
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
      // A FAIL or SILENT needs the quoted announcement, or nobody can act on it.
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
 * `total` is the size of the set asked, not the document. `scope` and `machineCovered` keep the two
 * apart when the file is quoted later.
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
