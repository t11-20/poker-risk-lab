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

export function normalize(node) {
  if (Array.isArray(node)) {
    const out = [];
    for (const item of node) {
      if (item && item.type === 'JSXExpressionContainer' && item.expression?.type === 'JSXEmptyExpression')
        continue;
      const n = normalize(item);
      if (n && n.type === 'JSXText') {
        const prev = out[out.length - 1];
        if (prev && prev.type === 'JSXText') {
          prev.value = `${prev.value} ${n.value}`.replace(/\s+/g, ' ').trim();
          continue;
        }
      }
      out.push(n);
    }
    return out.filter((n) => !(n && n.type === 'JSXText' && n.value === ''));
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'span' || k === 'ctxt') continue;
      // Positions also travel under other keys (`SpreadElement.spread` is one): drop any value that
      // is nothing but a start and an end.
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === 'end,start')
        continue;
      if (k === 'raw' && node.type === 'JSXText') continue;
      out[k] = normalize(v);
    }
    if (out.type === 'JSXText') out.value = String(out.value).replace(/\s+/g, ' ').trim();
    return out;
  }
  return node;
}

export function stripCss(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const q = c;
      out += c;
      for (i++; i < src.length && src[i] !== q; i++) {
        if (src[i] === '\\') out += src[i++];
        out += src[i];
      }
      out += q;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 1;
      out += ' ';
    } else out += c;
  }
  return out
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};:,>])\s*/g, '$1')
    .trim();
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

export function stripYaml(src) {
  return src
    .split('\n')
    .map((line) => stripHashLine(line).replace(/\s+$/, ''))
    .filter((line) => line !== '')
    .join('\n');
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
    if (/\.(ts|tsx|js|mjs|cjs)$/.test(path)) {
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
