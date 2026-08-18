# ADR 0004 — Per-card Merkle commitment instead of hashing the deck

**Status:** Accepted · **Date:** 2026-08-17 · **Supersedes:** the original hash-of-deck design

## Context

The requirement: commit to the deck before any player acts, and let anyone verify
afterwards that the deal was not altered mid-hand.

## The design that was implemented first, and why it was wrong

```
commitment = SHA-256(salt ‖ context ‖ deck)      // published before the deal
reveal     = { salt, deck }                       // published after the hand
```

Simple, correct for its stated goal, and **it created a worse hole than it closed.**

A hidden-information test caught it: revealing the deck reveals **all 52 cards**,
including the hole cards of every player who folded without showing. Heads-up, a fold
would publish the winner's exact hand. Whether an opponent folded a bluff or a monster is
precisely the information poker is played over — so the integrity mechanism would have
handed out strategically decisive private information at the end of every hand.

This is recorded at length because the lesson generalises: **an integrity control can
create a confidentiality leak, and the two properties have to be designed together.**

## Decision

A **per-card Merkle tree**.

```
leaf(i) = SHA-256( 0x00 ‖ domain ‖ len(ctx) ‖ ctx ‖ i ‖ salt_i ‖ card_i )
node    = SHA-256( 0x01 ‖ left ‖ right )
commitment = Merkle root over 64 leaves (52 real + 12 padding)
```

Published before the deal: the **root**. After the hand: a leaf reveal — position, card,
salt and six sibling hashes — for **only** the cards that legitimately became public
(every board card, plus the hole cards of seats that actually showed). Every other leaf
stays sealed forever.

## Details that are load-bearing

* **A 32-byte salt per card.** A card is one of 52 values, so an unsalted leaf is
  brute-forced instantly and would leak its card to anyone holding the root.
* **Domain-separated leaf and node hashing** (`0x00` / `0x01`), preventing the classic
  Merkle second-preimage attack in which an internal node is presented as a leaf.
* **Context binding.** Room id, hand number and hand id are hashed into every leaf, so a
  commitment cannot be replayed for a different hand.
* **Permutation checking on verify.** A reveal claiming the same card at two positions is
  rejected before any hash is compared.

## What it proves, and what it does not

**Proves:** each revealed card sat at that exact deck position, fixed before the first
action. A server that re-ordered undealt cards to hit a draw, break a cooler or protect a
bot cannot produce valid proofs.

**Does not prove:** that the deck was *chosen* fairly. The server generates both deck and
salts, so a dishonest operator could grind candidate decks and commit to a favourable one
before dealing. Closing that needs entropy the server cannot predict — a multi-party
commit-reveal with player-contributed nonces. **Not implemented; accepted risk**, recorded
in `docs/THREAT-MODEL.md` G1 and in the module header, rather than hidden behind the
phrase "provably fair".

## Consequences

* Cost: 52 salts (1,664 bytes) held in memory per live hand, and a six-hash proof per
  revealed card. Both negligible.
* A fold-out hand reveals **nothing** — not even the board, if no board was dealt. That is
  correct, and the verification UI must say so rather than appearing broken.
* `revealEverything()` exists for end-of-session auditing and must never be called for a
  live or recently-completed hand.
