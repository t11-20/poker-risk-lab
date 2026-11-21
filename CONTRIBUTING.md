# Contributing

`CLAUDE.md` explains the house style, the release gate and the safety rules. This file is the checklist
for a pull request.

## Before you push

Do these steps in order. Steps 1 to 3 are on your own computer and use no CI minutes.

1. Run the release gate: `pnpm run verify`. All its gates must pass.
2. Get a separate review of the diff. Use one of these:
   - the `/code-review` skill in Claude Code, at a level that runs locally (not `ultra`);
   - a new agent that did not write the code. Give it only the diff.
3. Fix each problem that the review finds. If you fix something, do steps 1 to 3 again.
4. Push once for each pass through these steps.

If `main` moves before you merge, merge `main` into the branch with a merge commit. Do not rebase a
branch you have pushed, and do not force-push. Then do steps 1 to 4 again.

## In the pull request

- Write that the local review ran.
- Write what the review found and what you changed. If it found nothing, write that.
- For each fix that changes code, name the test that fails on the old code.

## Merging

Merge only when all of these are true:

- The branch contains the latest `main`.
- All required CI checks pass.
- All review threads are resolved.
- The local review is clean.

Use `gh pr merge <number> --merge`. Do not delete the branch.
