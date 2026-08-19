# Reviewer F — P1 re-review (independent)

**Date:** 2026-08-19  
**HEAD:** `f20bbad` (`f20bbad2f082e9fe135ce98070da16eff7cc3f14`) — remediations are in the working tree, not a new commit  
**Workspace:** `/Users/terence/Projects/exploration-sites/poker-risk-lab`  
**Role:** Frontend & Accessibility. Did not apply the remediations. Did not modify source.

Scope is only the three P1 items below. Other original findings (units overflow, percent guards, A11Y-005, etc.) were not re-checked.

## How this was evidenced

| Method | What it covers |
| --- | --- |
| `next start` HTML | First paint as a crawler / JS-off reader sees it. Not a hydrated DOM. |
| Served CSS | Whether `display:none` on the wordmark also hides the accessible name. |
| Source + compiled `.next` | Whether the claimed `generateStaticParams` / `dynamicParams = false` / `NotFoundBody` remediations are actually in the running build. |

**Not done:** real browser, computed styles, screen reader, Tab order.

### Servers this pass started (and only these)

| Process | Bind | How |
| --- | --- | --- |
| API | `http://127.0.0.1:4901` | `PORT=4901 HOST=127.0.0.1 PUBLIC_WEB_ORIGIN=http://127.0.0.1:4900,http://localhost:4900 node --env-file-if-exists=.env apps/api/src/server.ts` |
| Web | `http://127.0.0.1:4900` | `PRL_API_ORIGIN=http://127.0.0.1:4901 pnpm exec next start --hostname 127.0.0.1 --port 4900` from `apps/web` |

`GET http://127.0.0.1:4901/api/v1/health` → `200 {"status":"ok",…}`. Postgres was already up (`poker-risk-lab-postgres-1`); it was not started here and was not taken down.

Web used the existing production build (`apps/web/.next/BUILD_ID` = `ENh7I1EKYwxNs_kgdFuLx`, written 2026-08-19 16:06). That is **after** the remediations (`learn/[lessonId]/page.tsx` 16:03, `SiteHeader.tsx` 15:58). The compiled lesson module exports `"dynamicParams",0,!1` and `generateStaticParams`. This is not a stale-build excuse.

Fetcher: `User-Agent: prl-rereview-f/1.0`. Repeat of `/learn/not-a-real-lesson` with `Googlebot/2.1` did not change the document.

---

## Verdicts

| ID | Original | After remediation | This re-review |
| --- | --- | --- | --- |
| UX-008 / A11Y-007 / A11Y-008 (unknown `/learn`, `/lab`, `/legends` ids) | **FAIL** — `__next_error__`, no `lang` / `<main>` / `h1` / nav | Claimed: router 404s via `generateStaticParams` + `dynamicParams = false`, same family as `/does-not-exist` | **FAIL — not remediating.** Source and build contain the flags. Fetched HTML is still the Next 16 error document. |
| A11Y-009 (brand home name) | **FAIL** at 375 and 860–1279 | Visually-hidden “Poker Risk Lab” even when the wordmark is `display:none` | **PASS** from markup + served CSS. |
| Hand review missing id | Empty `notFound()` HTML | Render `NotFoundBody` (`h1`) | **PASS** for the asked check (real `h1` in the document). Residual: HTTP **200**, not 404. |

---

## 1. UX-008 / A11Y-007 / A11Y-008 — unknown lesson / scenario / profile

**Required:** `/learn/not-a-real-lesson`, `/lab/not-a-real-scenario`, `/legends/not-a-real-profile` must no longer be empty Next 16 error HTML. They must be router 404s (`generateStaticParams` + `dynamicParams = false`) with `lang`, `<main>`, `h1`, `nav` — same family as `/does-not-exist`.

### Fetched HTML (this is the finding)

| URL | Status | Opening tag | `lang` | `<main>` | `<h1>` | `<nav>` | Bytes | Visible text with scripts stripped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/does-not-exist` | **404** | `<html lang="en">` | `en` | 1 (`id="prl-main"`) | `Page not found` | 4 (Primary, sheet All sections, 404 All sections, footer Sections) | 31 376 | Full shell (~2 900 characters) |
| `/learn/not-a-real-lesson` | **404** | `<html id="__next_error__">` | **none** | **0** | **0** | **0** | 17 620 | `Page not found — Poker Risk Lab` (the `<title>` only) |
| `/lab/not-a-real-scenario` | **404** | `<html id="__next_error__">` | **none** | **0** | **0** | **0** | 17 554 | same |
| `/legends/not-a-real-profile` | **404** | `<html id="__next_error__">` | **none** | **0** | **0** | **0** | 16 996 | same |
| `/learn/not-a-real-lesson` as Googlebot | **404** | `<html id="__next_error__">` | **none** | **0** | **0** | **0** | 17 643 | same |

Control known ids (same server) still render real pages: `/learn/hand-flow` 200 + `h1` “How a Hand of Hold'em Runs”; `/lab/eq-flush-draw-turn-small-bet` 200; `/legends/patient-technician` 200. The app is up. The unknown-id documents are the defect.

### What the unknown-id document actually is

First bytes of `/learn/not-a-real-lesson` (lab and legends are the same family):

```html
<!DOCTYPE html><html id="__next_error__"><head>…<title>Page not found — Poker Risk Lab</title>…</head>
<body><div hidden=""><!--$--><!--/$--></div><script>…self.__next_f.push(…)</script></body></html>
```

There is no skip link, no header, no `<main>`, no heading in the HTML tree. The 404 copy (`h1` “Page not found”, `nav aria-label="All sections"`) exists only inside the RSC flight payload. A reader without scripting — or a static a11y pass that walks the DOM — gets a titled empty page.

The flight data names the Next 16 path that produced it:

- `14:E{"digest":"NEXT_HTTP_ERROR_FALLBACK;404"}`
- `generateMetadata` still ran for the unknown id (`"Lesson not found — Poker Risk Lab"` / `"Profile not found"` in the payload). That is a **page render**, not a router miss.

`/does-not-exist` first paint (same fetch, same server) is the family they were supposed to join:

```html
<html lang="en">
  …
  <a class="prl-skip-link" href="#prl-main">Skip to main content</a>
  <header aria-label="Site">…</header>
  <main class="prl-app__main" id="prl-main">
    <section class="prl-container prl-section--tight">
      <p class="prl-label prl-label--strong">404</p>
      <h1>Page not found</h1>
      <nav aria-label="All sections">…five destinations…</nav>
```

Unknown ids are **not** that family.

### Why the source change did not move the HTML

The remediations are present:

```57:62:apps/web/src/app/learn/[lessonId]/page.tsx
/** Known ids 404 at the router (full HTML) instead of via `notFound()` (empty Next 16 body). */
export function generateStaticParams(): { lessonId: string }[] {
  return lessonsInReadingOrder().map((lesson) => ({ lessonId: lesson.id }));
}

export const dynamicParams = false;
```

Same pair on `apps/web/src/app/lab/[scenarioId]/page.tsx` and `apps/web/src/app/legends/[profileId]/page.tsx`. `apps/web/test/y3-known-ids-404.test.ts` only greps those strings; it never fetches HTML.

`apps/web/.next/prerender-manifest.json` lists static routes `/`, `/_global-error`, `/_not-found` only. `dynamicRoutes` is `{}`. The three parameterised pages were **not** prerendered. They still `fetch` the API at request time, so they stay dynamic. At runtime Next still enters the page for an unknown id (`generateMetadata` proves it) and the page still calls `notFound()`:

- learn: `UnavailableLesson` → `if (summary === null) notFound()`
- lab: `if (data.state === 'missing') notFound()`
- legends: `if (profile === null || learn === null) notFound()`

That is the same Next 16 `errorRecovery` empty-body path documented in `apps/web/src/app/not-found.tsx`. `dynamicParams = false` did not convert these into `/does-not-exist`-style router 404s.

**UX-008, A11Y-007, A11Y-008 remain FAIL** for unknown ids. Status 404 and `<title>Page not found` are not a page.

---

## 2. A11Y-009 — brand home link accessible name

**Required:** the home control must have an accessible name at all widths. A visually-hidden “Poker Risk Lab” must remain when the visible wordmark is `display:none`.

### Markup (fetched `/`, also present on every 2xx shell including authed `/review/not-a-real-hand`)

```html
<a class="prl-shell__brand prl-pillbar__brand" href="/">
  <span aria-hidden="true" class="prl-shell__brand-index prl-index">00</span>
  <span class="prl-visually-hidden">Poker Risk Lab, home</span>
  <span class="prl-shell__brand-name" aria-hidden="true">Poker Risk<span class="prl-shell__brand-tail"> Lab</span></span>
</a>
```

What that does:

1. `00` is `aria-hidden`. It cannot be the name.
2. The visible wordmark is a **sibling**, also `aria-hidden`. It cannot be the name even when it is painted.
3. The only non-hidden text inside the link is `Poker Risk Lab, home` on `.prl-visually-hidden`.
4. That span is **not** a child of `.prl-shell__brand-name`. Hiding the wordmark cannot hide the name.

No second unnamed home link in `MobileNav`.

### Served CSS (`GET /_next/static/chunks/091j6yqnweg2p.css`)

`.prl-visually-hidden` is clip-path hiding, not `display:none`:

```css
.prl-visually-hidden,.prl-visually-hidden-focusable:not(:focus):not(:focus-within){
  clip-path:inset(50%);white-space:nowrap;border:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden
}
```

The wordmark is the thing that disappears:

| Width | `.prl-pillbar__brand .prl-shell__brand-name` | Name still in the tree? |
| --- | --- | --- |
| default (&lt;600, includes 375) | `display:none` | yes — sibling `.prl-visually-hidden` |
| ≥600 | `display:inline` | yes — visible name stays `aria-hidden` |
| ≥860 (includes laptop-not-wide) | `display:none` again | yes |
| ≥1280 | `display:inline` | yes |

This is the original 375 and 860–1279 hole, closed in markup. Accessible name at every width is **“Poker Risk Lab, home”** (product name plus “home”). That is stricter than the asked “Poker Risk Lab” and is not an unnamed link.

**A11Y-009 PASS.**

---

## 3. Hand review missing id → `NotFoundBody`

**Required:** a missing hand id must render `NotFoundBody` (`h1`), not empty `notFound()` HTML.

### Unsigned (no session cookie)

`GET http://127.0.0.1:4900/review/not-a-real-hand` → **200**, `<html lang="en">`, `<main id="prl-main">`, `<h1>This replay needs a session</h1>`. Not a 404, not `__next_error__`. Same honest signed-out screen as the original UX-006 note.

`NotFoundBody` is only reached when `loadReview` gets `state === 'missing'`, and that is only `isMissingResource` (API HTTP 404). Signed-out is `not_authenticated` → `unavailable`. Proving the missing-id path needs a session.

### Authenticated missing id

1. `POST http://127.0.0.1:4901/api/v1/auth/guest` → 201 guest, `prl_session` cookie.
2. `GET http://127.0.0.1:4901/api/v1/hands/not-a-real-hand` with that cookie → **404** `hand_not_found`.
3. `GET http://127.0.0.1:4900/review/not-a-real-hand` with `Cookie: prl_session=…` (forwarded by `readerCallOptions`) →

| Check | Result |
| --- | --- |
| Status | **200** (not 404) |
| `<html>` | `lang="en"` — not `__next_error__` |
| `<main>` | `class="prl-app__main" id="prl-main"` |
| `<h1>` | **Page not found** |
| 404 body | `<p class="prl-label prl-label--strong">404</p>` + “There is nothing at this address…” |
| `<nav>` | `aria-label="All sections"` with the five destinations (same markup as `/does-not-exist`’s main) |
| Skip / site header / footer | present |
| “This replay needs a session” | absent |

That is `NotFoundBody` inlined into the root layout, not `notFound()`. Source:

```215:219:apps/web/src/app/review/[handId]/page.tsx
  // Next 16 `notFound()` from a page returns empty HTML. Hand ids cannot be enumerated at
  // build time, so render the same 404 body the routing-level page uses.
  if (data.state === 'missing') return <NotFoundBody />;
```

The page no longer imports `next/navigation`.

**PASS** on the asked criterion: missing id paints an `h1` and a real document. Residual (not a reopen of the empty-HTML bug): the status is 200 because a server component cannot set 404 without `notFound()`. `not-found.tsx` already records that trade-off.

---

## What still fails, in one line

`generateStaticParams` + `dynamicParams = false` is in the source, the tests, and the running build, and it **does not** give unknown `/learn/*`, `/lab/*`, `/legends/*` ids the `/does-not-exist` HTML. Those three URLs are still Next 16 `__next_error__` documents with no `lang`, no `<main>`, no `h1`, no `nav`. Brand name and missing-hand `NotFoundBody` are fixed.

The gate that greps the flags (`y3-known-ids-404.test.ts`) would stay green.

---

## Scripts / fetches actually run

```
GET http://127.0.0.1:4901/api/v1/health
GET http://127.0.0.1:4900/does-not-exist
GET http://127.0.0.1:4900/learn/not-a-real-lesson
GET http://127.0.0.1:4900/lab/not-a-real-scenario
GET http://127.0.0.1:4900/legends/not-a-real-profile
GET http://127.0.0.1:4900/learn/hand-flow
GET http://127.0.0.1:4900/lab/eq-flush-draw-turn-small-bet
GET http://127.0.0.1:4900/legends/patient-technician
GET http://127.0.0.1:4900/
GET http://127.0.0.1:4900/review/not-a-real-hand
GET http://127.0.0.1:4900/_next/static/chunks/091j6yqnweg2p.css
POST http://127.0.0.1:4901/api/v1/auth/guest  (then GET /api/v1/hands/not-a-real-hand and GET /review/not-a-real-hand with the session)
Googlebot repeat of /learn/not-a-real-lesson and /does-not-exist
```
