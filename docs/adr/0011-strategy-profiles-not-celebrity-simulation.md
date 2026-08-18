# ADR 0011 — Modelled strategy profiles, not celebrity simulation

**Status:** Accepted · **Date:** 2026-08-17

## Context

The most valuable thing a learner can do after understanding pot odds is play a few hundred
hands against **contrasting** styles. A player who applies relentless pressure plays nothing
like one who waits for a clear edge, and feeling that difference teaches something no lesson
delivers. So the mode needs several distinct opponents that a learner can tell apart.

Attaching a well-known name to a style makes it memorable, and "Play a Legend" is a far better
invitation than "Play Opponent Configuration C". That single product decision creates three
risks that have nothing to do with poker:

1. **Misrepresentation.** A named opponent invites the reading that this software reproduces
   how that person actually plays, or that they were involved. Neither is true. These are
   coarse models built from tendencies that have been publicly discussed in general terms —
   aggression, positional awareness, willingness to bluff — not from anyone's hand histories,
   private decisions or thinking.
2. **Impersonation.** Generating a real person's inner monologue is fabrication presented as
   insight. It is also the fastest route from educational tool to disrespectful one, and it
   compounds: once one commentary string narrates someone's thoughts, every subsequent string
   is written in that register.
3. **Name, image and likeness.** Using a living person's name in a product may require
   permission. That is a question for whoever deploys this, and it is not one a codebase can
   answer on their behalf.

Two of the profiles under consideration were attributed to players who have died, which
changes nothing: being unable to object is not a reason to be less careful.

The wrong framing here is not a polish item. It is the failure mode that would make the whole
feature indefensible while every number in it stayed correct.

## Options considered

**A. Attempt actual simulation of named players** — gather hand histories, fit a model per
player, present it as reproducing their play. **Rejected, on three independent grounds, any one
of which is sufficient.** It would need data this project has no right to and no way to
validate. Even with perfect data, a fitted model of a few thousand observed hands is not a
person, so the claim would be false. And it would put the product in the business of asserting
things about identifiable humans, which is not a business an educational app should enter.

**B. Named profiles with a footer disclaimer.** Rejected. A disclaimer in the footer is a
disclaimer nobody reads, and it fails at exactly the moment it matters — a screenshot of a seat
plate carries the name and not the footer. Worse, it puts the safety property in a *layout*,
where a component refactor can silently remove it.

**C. Fully anonymous archetypes only** — no attributed names anywhere, ever. Rejected, though
it was close, and it remains the default behaviour. Rejecting it outright would mean this
codebase deciding, for every possible deployer, that no naming arrangement could ever be
legitimate — including one where permission had actually been obtained. That is not the
codebase's decision to make. The design instead makes anonymity the default and attribution a
deliberate act.

**D. Trait-based profiles, archetype-named by default, attribution behind an explicit opt-in
(chosen).**

**E. Have an LLM narrate the profile's reasoning in character.** Rejected, decisively, and for
this ADR's reasons rather than ADR 0012's. In-character narration of a real person is the
impersonation risk in its purest form, and it would be generated at runtime where no review can
reach it. ADR 0012 rejects LLMs in the decision loop for separate reasons; this one rejects them
in the *voice*.

## Decision

**Twelve profiles, each defined entirely by a sixteen-axis numeric trait vector, presented as
educational strategy simulations of styles.**

* **The trait vector is the whole model.** Nothing hides in per-profile special cases, so the
  profile card can show a learner exactly what they are facing, and a statistical test can
  assert that the observed behaviour matches the declared vector. Comparability, testability
  and honesty were all worth more than expressiveness (see `docs/AI-LEGENDS.md` §4).
* **Both names always exist in the data; configuration decides which is shown.** Every profile
  carries an `archetypeName` and, for most, an optional `attributedName`.
  `PRL_LEGEND_NAMING=attributed` is required to display the latter. Unset, empty, or
  `archetype` all yield archetype names; anything else throws rather than falling back.
* **`profileDisclosure()` returns the display name and its disclaimers in one object.** There
  is no function that returns a name alone, and `ProfileDisclosureDto.disclaimers` is a
  required, non-empty array on the wire.
* **The educational content is identical in both modes.** `learnFrom`, `styleNotes`,
  `counterStrategy`, `modelBasis`, the traits and every computed figure are byte-identical
  whichever mode is set.
* **`assertNoImpersonation()` runs at profile load time**, inside `validateProfiles()` at
  module scope, over every learner-facing string in the set — and again at commentary
  generation time on every generated string.

## Why the safe mode is the default

**The mode you get by not thinking about it should be the safe one.** A deployer who never
reads this document, never sets an environment variable and never considers the question ships
archetype names. A deployer who wants attributed names has to type the variable, and that is
precisely the moment at which somebody is thinking about whether they may — which is where the
name, image and likeness question actually gets asked.

`resolveNamingMode()` reads `process.env` itself rather than accepting a mode parameter. For a
package that is otherwise strict about purity that looks like the wrong instinct, and is not: a
parameter can be forgotten at a call site, and the forgotten default would be whatever the
author of that call site happened to pick. One reading, in one place, makes the safe answer
unavoidable. The environment is injectable for tests, so nothing has to mutate `process.env`.

**That the content does not change with the mode is the load-bearing evidence.** If the names
were carrying teaching weight, switching modes would change what the product taught. It does
not — so the names are mnemonics, and the traits are the substance. That claim is checkable
rather than rhetorical: a test can render every profile card in both modes and diff everything
except the identity fields.

## Why the mechanical guard sits at load time

`validateProfiles()` runs when `profiles.ts` is imported, and its output is the exported
`PROFILES` constant. So a profile containing an impersonating string **cannot be imported** —
the module throws, the API does not start, and the string never reaches a build artefact, let
alone a learner.

The alternatives were weaker in a specific way:

* **A unit test** can be skipped, quarantined, or simply not run on the branch that adds the
  bad string. It reports a problem after the fact.
* **A code-review convention** depends on the reviewer knowing the rule and reading that hunk.
* **A check at render time** fires in front of a user, in production, on a path that may not be
  exercised in staging — which is the worst place to discover it.

Load-time validation converts the whole class of failure into a boot failure, which is loud,
immediate, and impossible to ignore. It costs a small amount of module-load work once per
process, and it makes the guarantee structural rather than procedural.

The guard is intentionally crude and errs towards rejection. A false positive costs a reworded
sentence; a false negative ships a fabricated claim about a person. That asymmetry decides the
tuning.

## Consequences

* **Adding a profile is a constrained exercise.** New prose has to pass the guard at import
  time, and a new trait vector has to sit far enough from the existing ones that the floor
  asserted over the pairwise distances `profileDiversity()` reports still holds. Both frictions
  are the feature.
* **The impersonation guard is a backstop, not the primary control.** Its pattern list does not
  catch a proper noun followed by a mental-state verb. What actually prevents that is
  structural: commentary templates take *the model* as their grammatical subject, an attributed
  name is never interpolated into commentary prose, and `ModelReasoning` has no field capable
  of holding a mental state. Recorded as L7 in `docs/AI-LEGENDS.md` §12, with the tighter check
  that would close it.
* **The disclaimer constants deliberately fail the guard** — a disclaimer has to be able to say
  "not endorsed by anyone", which is a phrase commentary must never assert. They are therefore
  scoped out of the sweep. Widening the sweep to include them makes the package throw on
  import, which is a confusing way to learn this.
* **Some product copy is more awkward.** "Heads-Up Pressure Expert" is less catchy than a name.
  Accepted: the archetype name also says what the profile *does*, which a name does not.
* **This document does not list the attributed names**, and neither does any other document
  here. `profiles.ts` is the single source of truth. A document that lists them reads as a
  roster of endorsements, which is the impression the entire design exists to avoid.
* **Reversing this decision is not a config change.** Presenting profiles as simulations of
  people would require new data, a defensible basis for the claim, permissions, and a rewrite
  of `labelling.ts`, `profiles.ts` and `legends.ts` — because the current types have nowhere to
  put such a claim. That is the intended cost.
