# ADR 0010 — No public matchmaking and no free-text chat

**Status:** Accepted · **Date:** 2026-08-17

## Context

Multiplayer poker invites two features by default: a lobby that seats strangers together,
and a chat box. Both are straightforward to build and both are how a social product
becomes an abuse surface.

## Decision

**Neither ships until moderation and anti-abuse review pass.**

* Rooms are **invite-only**, always. `rooms.visibility` carries a `CHECK` constraint
  permitting exactly one value, `'invite_only'`.
* There is **no chat**. The only user-supplied text is a display name and a room name,
  both length-limited and pattern-restricted to exclude control characters, bidi overrides
  and zero-width characters.

## Why the constraint is in the database

A boolean in a config file gets flipped. A `CHECK` constraint requires a migration, which
requires a review, which is where the question "have we built moderation yet?" actually
gets asked. The control is placed where it will be encountered.

## What this closes

* **Collusion against strangers.** With no matchmaking, a colluding pair cannot be seated
  against someone who did not invite them. This is why T11 in the threat model is rated
  Low rather than High.
* **Harassment through chat**, and impersonation via lookalike display names.
* **Room enumeration.** Invite codes are stored hashed and shown exactly once; "does not
  exist" and "not permitted" return the same error, so private tables cannot be discovered
  one request at a time.

## Consequences

* The product is smaller. Deliberately.
* The invite code cannot be recovered after creation — only its hash is stored — so the UI
  must make clear that it is shown once. That is a usability cost accepted for the security
  property.
* Relaxing either decision requires: moderation tooling, a reporting flow, rate and
  reputation systems, and a threat-model review. `docs/THREAT-MODEL.md` §10 lists this as
  an explicit review trigger.
