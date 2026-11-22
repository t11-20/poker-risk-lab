/**
 * The theme switch has one place at each width: the header bar from 860px, the menu sheet below it.
 * A second copy in the footer made two radio groups that a reader had to find and keep in step.
 * The components import CSS and cannot load under `node --test`, so they are held to their source.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { THEME_CHOICES, THEME_LABELS } from '../src/lib/theme.ts';

const read = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

/** Source without comment lines, so a sentence about the switch cannot stand in for it. */
const code = (path: string): string =>
  read(path)
    .split('\n')
    .filter((line) => !/^\s*(?:\*|\/\/|\/\*|\{\/\*)/u.test(line))
    .join('\n');

const css = (path: string): string => read(path).replace(/\/\*[\s\S]*?\*\//gu, '');

const toggles = (source: string): number => (source.match(/<ThemeToggle\b/gu) ?? []).length;

describe('the theme switch is in the header, and only there', () => {
  it('offers Light, Dark and System, in that order', () => {
    assert.deepEqual(
      THEME_CHOICES.map((choice) => THEME_LABELS[choice]),
      ['Light', 'Dark', 'System'],
    );
  });

  it('renders once in the header bar and once in the menu sheet (REGRESSION)', () => {
    assert.equal(toggles(code('components/SiteHeader.tsx')), 1, 'the header bar has no theme switch');
    assert.match(code('components/SiteHeader.tsx'), /<ThemeToggle className="prl-shell__theme" \/>/u);
    assert.equal(toggles(code('components/MobileNav.tsx')), 1, 'the menu sheet lost its theme switch');
  });

  it('is not repeated in the footer (REGRESSION)', () => {
    assert.equal(toggles(code('components/SiteFooter.tsx')), 0);
  });

  it('shows the header copy only where the sheet is not, from 860px', () => {
    const shell = css('app/globals.css');
    assert.match(shell, /\n\.prl-shell__theme \{\s*display: none;\s*\}/u, 'not hidden below 860px');
    const wide = /@media \(min-width: 860px\) \{([\s\S]*?)\n\}/u.exec(shell)?.[1] ?? '';
    assert.match(wide, /\.prl-shell__theme \{\s*display: flex;\s*\}/u, 'not shown from 860px');
    assert.match(wide, /\.prl-sheet \{\s*display: none;\s*\}|\.prl-sheet\s*\{[^}]*display: none/u);
  });
});
