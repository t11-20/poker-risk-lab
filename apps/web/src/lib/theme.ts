/**
 * Theme resolution, and the one inline script this app is allowed to ship.
 *
 * ## The problem this file exists to solve
 *
 * `tokens.css` resolves the theme in CSS: with no `data-theme` on the root element the
 * `prefers-color-scheme` query decides, and `[data-theme='light']` / `[data-theme='dark']`
 * override it in both directions. That is the whole mechanism, and it is correct — for a
 * reader who has never made a choice.
 *
 * For a reader who HAS made a choice, the choice lives in `localStorage`, and `localStorage` is
 * not readable from CSS. So somebody has to write the attribute, and *when* they write it is
 * the entire question. Any React-based answer — a provider, an effect, a `useSyncExternalStore`
 * — runs after hydration, which is after first paint. A reader whose system is dark and whose
 * choice is light would see a dark page flash to light. That is not a polish issue: it is a
 * full-screen luminance change fired at somebody who explicitly asked for the other one.
 *
 * The only thing that runs before first paint is a synchronous script in the document, so
 * that is what `THEME_BOOT_SCRIPT` is. It is the single inline script in the app, it takes no
 * input from the page, and it is a compile-time constant with no interpolation of anything a
 * user can influence.
 *
 * ## Why it also decides the boot sequence
 *
 * The boot overlay (§8) is server-rendered so that it is present in the very first paint rather
 * than appearing after hydration — an overlay that fades IN over an already-visible shell is
 * worse than no overlay at all. But it must be skipped on repeat visits within the session, and
 * "have we booted this session" is in `sessionStorage`, which CSS cannot read either. Same
 * problem, same solution, same script: it stamps `data-boot="skip"` on the root element and
 * `globals.css` suppresses the overlay from the first paint. Reduced motion needs no help here
 * — that one CSS *can* see.
 *
 * ## The CSP note
 *
 * An inline script needs `script-src` to allow it. The honest options are a per-response nonce
 * or a hash of the exact bytes; a hash suits a constant, and this string is constant. The value
 * is exported below as `THEME_BOOT_SCRIPT_CSP_HASH` so that deployment configuration *imports*
 * it, and `test/theme-csp-hash.test.ts` recomputes the digest over `THEME_BOOT_SCRIPT` and fails
 * when the two disagree.
 *
 * That test is the whole point. The hash previously lived in this comment as a digit string,
 * where it was reviewable but not verifiable — the script was edited, the digits were not, and
 * nothing could notice. A stale hash is not a cosmetic error: it is a CSP that blocks the one
 * script whose entire job is to prevent a full-screen theme flash, and the failure is invisible
 * server-side. A per-response nonce on the tag remains the alternative for anyone who would
 * rather not couple their response headers to a build artefact.
 *
 * Everything else here is a plain function over `window`, guarded for the server and for the
 * privacy modes where touching storage throws rather than returning null.
 */

/** The `localStorage` key holding the reader's explicit choice, if they have made one. */
export const THEME_STORAGE_KEY = 'prl-theme';

/** The `sessionStorage` key marking "the boot sequence has already played this session". */
export const BOOT_SESSION_KEY = 'prl-booted';

/** The attribute `tokens.css` reads. Absent means "follow the system". */
export const THEME_ATTRIBUTE = 'data-theme';

/** The attribute `globals.css` reads to suppress the boot overlay before it can paint. */
export const BOOT_ATTRIBUTE = 'data-boot';

/** The single value `BOOT_ATTRIBUTE` ever takes. */
export const BOOT_SKIP = 'skip';

/**
 * Three choices, not two.
 *
 * `system` is a first-class option and the default, because "follow the system" is a real
 * preference and not the absence of one — a reader whose laptop switches to light at sunrise
 * has expressed something, and a two-state toggle would silently overwrite it the first time
 * they touched the control.
 */
export const THEME_CHOICES = ['system', 'light', 'dark'] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number];

/**
 * The word on the control. Short because three of these sit in a header, and words rather than
 * icons because the design system says labels are words (§12) — a sun and a moon also have to
 * carry "auto", which no glyph does unambiguously.
 */
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
 * Storage access, wrapped.
 *
 * Reading `window.localStorage` THROWS rather than returning null in Safari's private mode and
 * wherever site data is blocked by policy. An unguarded read in a component that runs on every
 * page is therefore a blank page for a subset of readers, and the failure is invisible in
 * development. Every access in this file goes through one of these two helpers.
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
    // A reader who has blocked site data keeps a working app with a per-page theme choice.
    // Losing the preference is the correct degradation; throwing would lose the page.
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

/**
 * Writes the choice to the root element.
 *
 * `system` REMOVES the attribute rather than setting it to `'system'`, which is what hands
 * control back to `prefers-color-scheme`. Setting a third attribute value would mean adding a
 * third branch to every themed selector in `tokens.css`, and the absence of the attribute
 * already means exactly this.
 */
export function applyTheme(choice: ThemeChoice): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (choice === 'system') {
    root.removeAttribute(THEME_ATTRIBUTE);
    return;
  }
  root.setAttribute(THEME_ATTRIBUTE, choice);
}

/**
 * The choice currently in force, read from the DOM rather than from storage.
 *
 * Used by the toggle for its initial client state. The attribute is the single source of truth
 * at that moment — the inline script has already reconciled storage with it — and reading the
 * DOM means the control cannot disagree with the page it is sitting on, which a second
 * independent storage read could.
 */
export function readAppliedTheme(): ThemeChoice {
  if (typeof document === 'undefined') return 'system';
  const applied = document.documentElement.getAttribute(THEME_ATTRIBUTE);
  return isThemeChoice(applied) ? applied : 'system';
}

/** True when the boot sequence has already played in this browsing session. */
export function hasBooted(): boolean {
  return readStorage('sessionStorage', BOOT_SESSION_KEY) === '1';
}

export function markBooted(): void {
  writeStorage('sessionStorage', BOOT_SESSION_KEY, '1');
}

/**
 * The pre-paint resolver, as source.
 *
 * Constraints this string is written under, all of them load-bearing:
 *
 *  - **Synchronous and tiny.** It runs as the first child of `<body>`, where it blocks parsing
 *    before any renderable content exists. That is the property that removes the flash; an
 *    `async` or deferred script would run after paint and reintroduce it.
 *  - **Wrapped in `try`.** Storage access throws in private modes (see `readStorage`). A throw
 *    here would abort the script before the theme was applied — worse than not having it.
 *  - **No `</script` sequence, no template holes fed by anything dynamic.** The interpolations
 *    below are this module's own constants, so the emitted bytes are fixed at build time. That
 *    is what makes a CSP hash meaningful: a script assembled from request data could not be
 *    hashed, and would not deserve to be.
 *  - **Keys come from the constants above**, so renaming a key cannot leave the script reading
 *    a stale one. Any such rename changes these bytes, and therefore changes the required CSP
 *    hash — which is `THEME_BOOT_SCRIPT_CSP_HASH`, immediately below.
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
 * The `script-src` source expression an operator must allow for `THEME_BOOT_SCRIPT`.
 *
 * Emit it quoted, alongside whatever else the policy allows:
 *
 *     script-src 'self' '<THEME_BOOT_SCRIPT_CSP_HASH>'
 *
 * The quotes belong to the header syntax, not to this value, so the value itself stays a bare
 * `sha256-…` token that can be compared against a freshly computed digest without unwrapping.
 *
 * This is a recorded constant rather than a digest computed here at runtime, and that is
 * deliberate twice over: hashing on demand would pull `node:crypto` into a module that ships to
 * the browser, and it would make the policy unreviewable, because the value an operator has to
 * allow would never appear in a diff. The cost of recording it is that it can drift, which is
 * exactly what happened before — so `test/theme-csp-hash.test.ts` recomputes SHA-256 over
 * `THEME_BOOT_SCRIPT` and asserts equality with this constant. After an intentional edit to the
 * script, run the same computation and paste the result here:
 *
 *     node --input-type=module -e "import {createHash} from 'node:crypto';\
 *     const m = await import('./apps/web/src/lib/theme.ts');\
 *     console.log('sha256-'+createHash('sha256').update(m.THEME_BOOT_SCRIPT).digest('base64'))"
 */
export const THEME_BOOT_SCRIPT_CSP_HASH = 'sha256-pFr/J6mAOwOBw+OUbWRw3SFuJuxHv7yTRXbAhz9wOxo=';
