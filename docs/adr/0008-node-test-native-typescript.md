# ADR 0008 — `node --test` on native TypeScript, no test framework

**Status:** Accepted · **Date:** 2026-08-17

## Context

Node 24 executes `.ts` files directly via type stripping, and ships a test runner with
globs, concurrency, subtests and TAP output.

## Decision

Use `node --test 'test/**/*.test.ts'` with `node:assert/strict`. No Vitest, no Jest, no
transpiler in the test path.

## Consequences — including the uncomfortable one

**Good:** zero test dependencies (in a repo where every dependency is a reviewed event
with a 7-day cooldown), no build step in the inner loop, and no transform layer that can
make test behaviour differ from production behaviour.

**The cost:** type stripping cannot *transform* code, so `erasableSyntaxOnly` must be on,
which bans:

* `enum` → use `const OBJ = {...} as const` plus a derived union type
* `namespace`
* constructor parameter properties (`constructor(private x: T)`) → declare and assign
  explicitly

These are real constraints that shaped the code. They are also, arguably, improvements:
the `as const` object pattern produces better-typed and more tree-shakeable output than
an enum, and explicit field assignment is clearer than the parameter-property shorthand.

Relative imports carry `.ts` extensions, with `rewriteRelativeImportExtensions` making
`tsc` emit `.js` — so the same source runs directly under Node *and* builds to plain ESM.

**What is genuinely lost:** no snapshot testing, no built-in mocking framework beyond
`node:test`'s `mock`, no browser test environment. The last one is why component tests
are absent and only pure helpers in `@prl/ui` are unit-tested — stated plainly rather
than papered over with shallow-render tests that assert nothing.
