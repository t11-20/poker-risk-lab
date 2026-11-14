#!/usr/bin/env node
/**
 * Whether a change touched comments and nothing else, so CI can skip the runtime gates for it. TS and
 * JS are compared as SWC ASTs with positions dropped; CSS, YAML, Dockerfile and SQL with comments
 * stripped. Anything it cannot prove is a code change: the safe answer is "run everything".
 *
 * usage: node scripts/ci/comment-only.mjs <checkout> <base-ref>   (exit 0 comment-only, 1 not, 2 usage)
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * What a JSX text child renders as: Babel's whitespace rule, which React follows. Lines are trimmed
 * where they meet a newline, blank lines dropped, and the rest joined with one space.
 */
export function jsxRenderedText(value) {
  const lines = String(value).split(/\r\n|\n|\r/);
  let lastNonEmpty = 0;
  lines.forEach((line, index) => {
    if (/[^ \t]/.test(line)) lastNonEmpty = index;
  });
  let out = '';
  lines.forEach((line, index) => {
    let text = line.replace(/\t/g, ' ');
    if (index !== 0) text = text.replace(/^ +/, '');
    if (index !== lines.length - 1) text = text.replace(/ +$/, '');
    if (text !== '') out += index === lastNonEmpty ? text : `${text} `;
  });
  return out;
}

export function normalize(node) {
  if (Array.isArray(node)) {
    const out = [];
    for (const item of node) {
      if (item && item.type === 'JSXExpressionContainer' && item.expression?.type === 'JSXEmptyExpression')
        continue;
      if (item && item.type === 'JSXText') {
        // Each child renders on its own and adjacent strings concatenate, so compare what is rendered.
        const rendered = jsxRenderedText(item.value);
        if (rendered === '') continue;
        const prev = out[out.length - 1];
        if (prev && prev.type === 'JSXText') prev.value += rendered;
        else out.push({ type: 'JSXText', value: rendered });
        continue;
      }
      out.push(normalize(item));
    }
    return out;
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'span' || k === 'ctxt') continue;
      // Positions also travel under other keys (`SpreadElement.spread` is one): drop any value that
      // is nothing but a start and an end.
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === 'end,start')
        continue;
      out[k] = normalize(v);
    }
    return out;
  }
  return node;
}

/**
 * CSS with comments removed and whitespace runs collapsed, strings kept byte for byte. A comment
 * touching whitespace is whitespace; one wedged between two tokens is kept as a marker, because
 * removing it may join them, so that edit reads as code.
 */
export function stripCss(src) {
  let out = '';
  let space = false;
  const emit = (text) => {
    if (space && out !== '') out += ' ';
    space = false;
    out += text;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      emit(src.slice(i, j + 1));
      i = j;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      const touchesSpace = space || out === '' || stop >= src.length || /\s/.test(src[stop]);
      if (touchesSpace) space = true;
      else emit('\u0000');
      i = stop - 1;
    } else if (/\s/.test(c)) space = true;
    else emit(c);
  }
  return out;
}

// `#` starts a comment at the start of a line or after whitespace, outside quotes. Shell comments in a
// `run: |` block are stripped the same way, which is what the shell would do with them.
function stripHashLine(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== null) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      // An apostrophe inside a word (`don't`) does not open a quote.
      if (c === "'" && i > 0 && /[A-Za-z0-9]/.test(line[i - 1])) continue;
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/**
 * YAML with comments stripped, except inside block scalars (`run: |`, `key: >-`), which are data:
 * a `#` line there may be a heredoc's content, so those lines are compared verbatim.
 */
export function stripYaml(src) {
  const out = [];
  let owner = null;
  const closeBlock = () => {
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    owner = null;
  };
  for (const line of src.split('\n')) {
    const indent = /^ */.exec(line)[0].length;
    if (owner !== null) {
      if (line.trim() === '' || indent > owner) {
        out.push(line.trim() === '' ? '' : line.replace(/\s+$/, ''));
        continue;
      }
      closeBlock();
    }
    const code = stripHashLine(line).replace(/\s+$/, '');
    if (code === '') continue;
    out.push(code);
    if (/(^|:\s|-\s)\s*[|>][1-9+-]{0,2}$/.test(code.trimStart())) owner = indent;
  }
  if (owner !== null) closeBlock();
  return out.join('\n');
}

// Dockerfile comments are whole lines only; an inline `#` is part of the instruction. Parser
// directives (`# syntax=`) are code.
export function stripDockerfile(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*#/.test(line) || /^#\s*(syntax|escape|check)\s*=/i.test(line))
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '')
    .join('\n');
}

export function stripSql(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end < 0 ? src.length : end;
      out += src.slice(i, stop + 1);
      i = stop;
    } else if (c === '$' && /^\$[A-Za-z_]*\$/.test(src.slice(i))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(src.slice(i))[0];
      const end = src.indexOf(tag, i + tag.length);
      const stop = end < 0 ? src.length : end + tag.length;
      out += src.slice(i, stop);
      i = stop - 1;
    } else if (c === '-' && src[i + 1] === '-') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end - 1;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
      out += ' ';
    } else out += c;
  }
  return out
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '')
    .join('\n');
}

/** Returns null when every changed file is comment-only, else the first reason it is not. */
export async function firstCodeChange({ checkout, base, swcFrom = checkout }) {
  const git = (...args) =>
    execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const changed = git('diff', '--name-status', '--no-renames', `${base}...HEAD`)
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
  if (changed.length === 0) return 'no changed files';
  let swc = null;
  const ast = async (text, filename) => {
    if (swc === null) {
      swc = createRequire(join(swcFrom, 'apps/web/package.json'))('next/dist/build/swc');
      await swc.loadBindings();
    }
    return JSON.stringify(normalize(await swc.parse(text, { filename, comments: false })));
  };
  for (const [status, path] of changed) {
    // Markdown reaches no build, image or browser gate; the jobs that read docs never skip.
    if (path.endsWith('.md')) continue;
    if (status !== 'M') return `${path}: status ${status}`;
    if (path.startsWith('db/migrations/')) return `${path}: an applied migration is checksummed`;
    const before = git('show', `${base}:${path}`);
    const after = git('show', `HEAD:${path}`);
    let same;
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) {
      const name = path.replace(/\.[mc]js$/, '.js');
      same = (await ast(before, name)) === (await ast(after, name));
    } else if (path.endsWith('.css')) same = stripCss(before) === stripCss(after);
    else if (/\.ya?ml$/.test(path)) same = stripYaml(before) === stripYaml(after);
    else if (/(^|\/)Dockerfile(\.[a-z]+)?$/.test(path))
      same = stripDockerfile(before) === stripDockerfile(after);
    else if (path.endsWith('.sql')) same = stripSql(before) === stripSql(after);
    else return `${path}: not a file this check can read`;
    if (!same) return `${path}: more than comments changed`;
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [checkout, base] = process.argv.slice(2);
  if (!checkout || !base) {
    console.error('usage: node scripts/ci/comment-only.mjs <checkout> <base-ref>');
    process.exit(2);
  }
  try {
    const reason = await firstCodeChange({ checkout, base });
    console.log(reason === null ? 'comment-only' : `code: ${reason}`);
    process.exit(reason === null ? 0 : 1);
  } catch (err) {
    console.log(`code: the check could not run (${err.message})`);
    process.exit(1);
  }
}
