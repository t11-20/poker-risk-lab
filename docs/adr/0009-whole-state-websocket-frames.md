# ADR 0009 — Send whole redacted state, not deltas

**Status:** Accepted · **Date:** 2026-08-17

## Context

A live table changes on every action. The standard optimisation is to send patches.

## Decision

Every update sends the **complete redacted `PlayerView`** for that recipient.

## Why

A delta protocol requires client and server to agree on a base state. Any disagreement —
a dropped frame, out-of-order delivery, a reconnect at the wrong moment, a client bug in
patch application — produces a table that is *subtly* wrong: a stack off by the size of
one bet, a pot that does not match the seats. Those bugs are extremely hard to reproduce
and, at a poker table, look exactly like cheating.

Whole snapshots remove the class entirely. Reconnect becomes trivial: reconnect **is**
"send the current view", with no resynchronisation protocol to get wrong.

Events are still sent, for animation and the action log — but they are explicitly
**not load-bearing**. A client that ignored every event would still render a correct
table. That inversion is deliberate: the decorative channel is allowed to be lossy, the
authoritative channel is not.

## Consequences

* More bandwidth per update. For a six-max table this is a few kilobytes and irrelevant.
* Each frame carries a monotonic `revision` so a client can discard an out-of-order frame
  rather than applying it.
* Redaction runs once per recipient per update. Measurable, but far cheaper than the class
  of bug avoided.
* Reverting this decision would require designing a resynchronisation protocol, which is
  the work this decision exists to avoid.
