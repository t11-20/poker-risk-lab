/**
 * The render boundary's answer to one question: may this count be called "outs"?
 *
 * ## The defect this closes
 *
 * On a live flop holding two pair, the Coach panel headed its outs section
 *
 *     OUTS — 47 CARDS IN TOTAL
 *
 * with `Clean 10`, `Dirty 37`, and 47 is *every unseen card*. The definition producing it
 * is a post-card equity threshold — a card counts once hero's equity after it clears 50%
 * — which is a legitimate and interesting way to classify cards, and it degenerates
 * completely when hero is already past 50% before any card arrives. Every card then
 * "qualifies", because hero needs none of them.
 *
 * A learner met a textbook **15** on a real flush-plus-straight draw and a nonsensical
 * **47** one spot later, from a panel whose own lesson — *Outs: Clean, Dirty and
 * Imaginary* — teaches that an out is a card that rescues a hand that is behind. The
 * paragraph underneath did explain itself, honestly, in its last sentence. That is not
 * enough: a caveat at the end of a paragraph does not undo a number set in the section
 * title.
 *
 * ## Why the check is here as well as in `@prl/poker-math`
 *
 * `computeOuts` now refuses at source: its result carries a typed `OutsCountRefusal` and
 * every sentence it generates stops using the word. That is the right place to fix the
 * data — see `outs.ts`, "When hero is already in front".
 *
 * It is not the place that protects the *page*, for exactly the reason set out at length
 * in `probability.ts`: a `CoachReport` arrives here as plain JSON, past a cache, a fixture
 * file and a deserialiser, and the fixtures in this repo are regenerated on their own
 * schedule. A stale fixture carrying `total: 47` with the old explanation would put the
 * headline straight back on the page, and the panel would render it without hesitating,
 * because the panel formats whatever it is handed. So this is deliberately duplicated
 * logic, the same way `isProbabilityFraction` deliberately duplicates
 * `assertProbabilityFraction`: the data layer fixes the number, this layer guarantees the
 * wrong number can never be *read*.
 *
 * ## Why the threshold is re-declared rather than imported
 *
 * `@prl/poker-math` owns it as `DEFAULT_AHEAD_THRESHOLD`, and importing it would be one
 * line. This package deliberately does not: `@prl/poker-math` links `@prl/poker-engine`,
 * whose module graph carries the shuffler, the deck commitment and `HandState` — the
 * secrets that must never reach a browser — and `CoachPanel` is the most widely rendered
 * component in the app. `cards.ts` re-derives the card encoding here for the same reason
 * and says so.
 *
 * A copied constant can drift, so it is pinned by a test rather than by a comment:
 * `test/outs-count.test.ts` imports `DEFAULT_AHEAD_THRESHOLD` — in a test, which ships
 * nowhere — and asserts the two are equal. If the producer ever moves its bar, that test
 * fails and this file is updated. That test is the contract.
 *
 * Pure, no React, no DOM, so every branch is directly testable.
 */

import { isProbabilityFraction } from './probability.ts';

/**
 * The equity at which a hand stops drawing and starts defending.
 *
 * The same bar a card has to clear to be counted at all, which is the whole point: a hand
 * already past it does not need a card, so nothing that arrives can be an out. Pinned to
 * `@prl/poker-math`'s `DEFAULT_AHEAD_THRESHOLD` by `test/outs-count.test.ts`.
 */
export const ALREADY_AHEAD_EQUITY = 0.5;

/**
 * Whether a spot with this hero equity has an outs count at all.
 *
 * `false` means the counts in the report are real classifications of real cards — they are
 * worth showing — but they are cards that KEEP hero in front rather than cards that rescue
 * the hand, and nothing on the page may add the two up and call the sum outs.
 *
 * An equity that is not a probability returns `true`, and that is a decision rather than an
 * oversight. A figure outside 0..1 is evidence of nothing: it cannot establish that hero is
 * ahead, so it must not be allowed to suppress a count that may be perfectly good. That
 * figure has its own refusal a few lines up the panel, where the reader will see it.
 */
export function countsAsOuts(heroEquity: number): boolean {
  if (!isProbabilityFraction(heroEquity)) return true;
  return heroEquity < ALREADY_AHEAD_EQUITY;
}
