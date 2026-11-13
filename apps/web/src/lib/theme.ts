/**
 * Theme resolution, and the one inline script this app ships.
 *
 * A stored choice is in `localStorage`, which CSS cannot read, and anything React does runs after
 * first paint, so a reader who chose light on a dark system would see a full-screen flash.
 * `THEME_BOOT_SCRIPT` runs before paint and sets `data-theme`, plus `data-boot="skip"` so the
 * server-rendered boot overlay (§8) does not replay within a session. It is a constant, allowed by
 * `THEME_BOOT_SCRIPT_CSP_HASH`. Storage throws in some privacy modes, so every access is guarded.
 */

/** The `localStorage` key holding the reader's explicit choice, if they have made one. */
export const THEME_STORAGE_KEY = 'prl-theme';

/** The `sessionStorage` key marking "the boot sequence has already played this session". */
export const BOOT_SESSION_KEY = 'prl-booted';

/** The attribute `tokens.css` reads. Absent means "follow the system". */
export const THEME_ATTRIBUTE = 'data-theme';

/** The attribute `globals.css` reads to suppress the boot overlay before it can paint. */
export const BOOT_ATTRIBUTE = 'data-boot';

export const BOOT_SKIP = 'skip';

/** `system` is a real preference, so a two-state toggle would overwrite it on first touch. */
export const THEME_CHOICES = ['system', 'light', 'dark'] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** Words, not icons (§12). Short because three sit in a header, and no glyph says "auto". */
export const THEME_LABELS: Readonly<Record<ThemeChoice, string>> = {
  system: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

/** What a screen reader hears in place of the short word. */
export const THEME_DESCRIPTIONS: Readonly<Record<ThemeChoice, string>> = {
  system: 'Follow the system setting',
  light: 'Light theme',
  dark: 'Dark theme',
};

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && THEME_CHOICES.some((choice) => choice === value);
}

/**
 * Storage access THROWS in Safari private mode and where site data is blocked, which would blank the
 * page. Every access in this file goes through these two helpers.
 */
function readStorage(storage: 'localStorage' | 'sessionStorage', key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window[storage].getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: 'localStorage' | 'sessionStorage', key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window[storage].setItem(key, value);
  } catch {
    // Losing the preference is the correct degradation. Throwing would lose the page.
  }
}

/** The stored choice, or `system` when there is none, it is unreadable, or it is not a choice. */
export function readStoredTheme(): ThemeChoice {
  const stored = readStorage('localStorage', THEME_STORAGE_KEY);
  return isThemeChoice(stored) ? stored : 'system';
}

export function storeTheme(choice: ThemeChoice): void {
  writeStorage('localStorage', THEME_STORAGE_KEY, choice);
}

/** `system` removes the attribute, which hands control back to `prefers-color-scheme`. */
export function applyTheme(choice: ThemeChoice): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (choice === 'system') {
    root.removeAttribute(THEME_ATTRIBUTE);
    return;
  }
  root.setAttribute(THEME_ATTRIBUTE, choice);
}

/** From the DOM, which the boot script already reconciled, so the toggle cannot disagree with the page. */
export function readAppliedTheme(): ThemeChoice {
  if (typeof document === 'undefined') return 'system';
  const applied = document.documentElement.getAttribute(THEME_ATTRIBUTE);
  return isThemeChoice(applied) ? applied : 'system';
}

export function hasBooted(): boolean {
  return readStorage('sessionStorage', BOOT_SESSION_KEY) === '1';
}

export function markBooted(): void {
  writeStorage('sessionStorage', BOOT_SESSION_KEY, '1');
}

/**
 * The pre-paint resolver. Synchronous, as the first child of `<body>`, because a deferred script runs
 * after paint. Wrapped in `try` because storage can throw. Built only from this module's constants, so
 * the bytes are fixed at build time and hashable, and a key rename changes the hash below.
 */
export const THEME_BOOT_SCRIPT =
  '(function(){try{' +
  'var d=document.documentElement;' +
  `var t=window.localStorage.getItem('${THEME_STORAGE_KEY}');` +
  `if(t==='light'||t==='dark'){d.setAttribute('${THEME_ATTRIBUTE}',t);}` +
  `else{d.removeAttribute('${THEME_ATTRIBUTE}');}` +
  `if(window.sessionStorage.getItem('${BOOT_SESSION_KEY}')==='1'){` +
  `d.setAttribute('${BOOT_ATTRIBUTE}','${BOOT_SKIP}');}` +
  '}catch(e){}})();';

/**
 * The bare `sha256-…` token an operator allows as `script-src 'self' '<hash>'`. Recorded rather than
 * computed, so it shows in a diff and `node:crypto` stays out of the browser bundle.
 * `test/theme-csp-hash.test.ts` recomputes it. After an intentional script edit, paste the output of:
 *
 *     node --input-type=module -e "import {createHash} from 'node:crypto';\
 *     const m = await import('./apps/web/src/lib/theme.ts');\
 *     console.log('sha256-'+createHash('sha256').update(m.THEME_BOOT_SCRIPT).digest('base64'))"
 */
export const THEME_BOOT_SCRIPT_CSP_HASH = 'sha256-pFr/J6mAOwOBw+OUbWRw3SFuJuxHv7yTRXbAhz9wOxo=';
