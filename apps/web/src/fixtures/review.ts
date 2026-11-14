/**
 * The hand history index and two complete hand reviews, which the review screens render when the API
 * is unavailable. The two `HandReviewResponse` objects are `buildHandReview`'s own output over
 * hand-shaped rows (`pnpm run fixtures:regenerate`), so they follow the real rules:
 *
 *  1. Seat 1 in hand 0042 folded preflop and never showed, so `toReviewSeat` leaves its `holeCards`
 *     null even though the hand is over.
 *  2. Every decision by seat 1 or seat 2 carries `analysis: null`, because a Coach report needs the
 *     acting player's two cards.
 *  3. The Merkle roots, salts and sibling hashes were built by `commitToDeckOrder` and
 *     `revealPositions` over a fixed deck, so `CommitmentVerifier` returns `ok` in the browser. A
 *     fixture that showed the verifier failing would train a reviewer to accept a red result.
 *
 * `hand-0042` runs to a showdown, so the reveal proves the five board cards and the hole cards of each
 * seat that showed, and seals the rest. `hand-0041` ends preflop with everybody folding: its reveal is
 * EMPTY and verifies with `verifiedPositions: 0`, because proving more would reveal folded cards, the
 * leak the commitment scheme exists to prevent.
 *
 * The index rows with no matching review make the list longer than one page, and opening one lands on
 * the not-found state.
 */

import type { HandListResponse, HandReviewResponse, HandSummary } from '@prl/contracts';

/** How many rows a page of history holds. Small enough that the fixture spans two pages. */
export const HAND_PAGE_SIZE = 6;

/** Hand 0042: five streets, a showdown, nine deck positions proved. */
export const REVIEW_HAND_SHOWDOWN: HandReviewResponse = {
  hand: {
    id: 'hand-0042',
    roomId: 'room-lab-01',
    handNumber: 42,
    startedAt: '2026-08-17T18:42:11.000Z',
    completedAt: '2026-08-17T18:43:58.000Z',
    board: ['Ah', '5h', '2c', '7d', 'Kh'],
    heroNet: 765,
    endedByFold: false,
    potTotal: 1520,
  },
  commitmentRoot: '9e1f07f25216506575ad44f62e0827411aadb092a9a1fe5352df3b69045b1612',
  commitmentContext: 'room-lab-01:42:hand-0042',
  reveal: {
    commitment: {
      algorithm: 'sha256',
      version: 'prl-deck-v2',
      root: '9e1f07f25216506575ad44f62e0827411aadb092a9a1fe5352df3b69045b1612',
      context: 'room-lab-01:42:hand-0042',
    },
    cards: [
      {
        index: 1,
        card: 51,
        saltHex: 'd12c3d8aba295bdfff2b93071b6bd749b6dcab0cccacf0b4287fd2ee9a192c41',
        proof: [
          '881cd2735b55db2fd2bbdb57b429bd82797e19baf1bc722be9f93feebd5af794',
          'ac8d584c5984134bce21011cf893f704654e1425fb789bf9644b8f00bfb1bf2f',
          'c631304939802d984053d9a54b79af8917a9ae750f1a9fa876e5e4ed00c54573',
          'fd7b386006e6f8fe614d30a2a04ac23ab58ce8455d3a685ba3d3c58e0db8d43c',
          '4028ecc08c707122c3fa6f110091d1762861afab75abd981ff41099392f0e573',
          'fd6ecc7758e793acc7b8b616251a686f927ac68fea4738c5f68ec1f26d6bd74f',
        ],
      },
      {
        index: 2,
        card: 30,
        saltHex: 'bf9b42b2b4bb1c4503131b3b07511b07c0b671464a8af43ff9a2f01400ebcb89',
        proof: [
          '0b2ff9ae5fc212a374282503775a5e99dc5fc53635d8ebeb88b8c538feefdc0a',
          '7ff0a46ab12c9f9310c79cde32b92d8536e0876c9973b39898cea7de4d1adb47',
          'c631304939802d984053d9a54b79af8917a9ae750f1a9fa876e5e4ed00c54573',
          'fd7b386006e6f8fe614d30a2a04ac23ab58ce8455d3a685ba3d3c58e0db8d43c',
          '4028ecc08c707122c3fa6f110091d1762861afab75abd981ff41099392f0e573',
          'fd6ecc7758e793acc7b8b616251a686f927ac68fea4738c5f68ec1f26d6bd74f',
        ],
      },
      {
        index: 4,
        card: 45,
        saltHex: 'a52ddb3be9524e8724ff1b7ee0c7f51081b943e2f7fbab644b470b2587fb938e',
        proof: [
          'd6453d30a813a3a2bc5a70b8bbaf924934be779d64058ec9466b594abe5333bc',
          '62e2ba6f967d4c090c17042065eced36a068772a6a92205e2778c9865ad0d0ba',
          '70b778214e6998d6127b433f773b75ebb78f22a014755eff8aca316b23cf75fa',
          'fd7b386006e6f8fe614d30a2a04ac23ab58ce8455d3a685ba3d3c58e0db8d43c',
          '4028ecc08c707122c3fa6f110091d1762861afab75abd981ff41099392f0e573',
          'fd6ecc7758e793acc7b8b616251a686f927ac68fea4738c5f68ec1f26d6bd74f',
        ],
      },
      {
        index: 5,
        card: 26,
        saltHex: 'd958350b275a0298969965a919b536aeb283bdadca473525d723a1c478412006',
        proof: [
          '3173e7c64a132ecfc86c17d7db4dafa3e02d6e6fd86ebf8b58dc90aa04c0e222',
          '62e2ba6f967d4c090c17042065eced36a068772a6a92205e2778c9865ad0d0ba',
          '70b778214e6998d6127b433f773b75ebb78f22a014755eff8aca316b23cf75fa',
          'fd7b386006e6f8fe614d30a2a04ac23ab58ce8455d3a685ba3d3c58e0db8d43c',
          '4028ecc08c707122c3fa6f110091d1762861afab75abd981ff41099392f0e573',
          'fd6ecc7758e793acc7b8b616251a686f927ac68fea4738c5f68ec1f26d6bd74f',
        ],
      },
      {
        index: 6,
        card: 50,
        saltHex: '1bc800b32772e98f0baaa7a1271c2a30e6f2079c5e6c694c72dd6d1480147c35',
        proof: [
          '26bbd3f1b878691ce06e1eb70d6bc16b920640aad27b4afa08037986ae5ce657',
          '1a234015947636490d04befce65f07e12fb6399c6e92ded36f1797f1329a3b21',
          '70b778214e6998d6127b433f773b75ebb78f22a014755eff8aca316b23cf75fa',
          'fd7b386006e6f8fe614d30a2a04ac23ab58ce8455d3a685ba3d3c58e0db8d43c',
          '4028ecc08c707122c3fa6f110091d1762861afab75abd981ff41099392f0e573',
          'fd6ecc7758e793acc7b8b616251a686f927ac68fea4738c5f68ec1f26d6bd74f',
        ],
      },
      {
        index: 7,
        card: 14,
        saltHex: 'e99c6b97c532948dd9fd4c48f55037505e8393f78cb878eebdfc856b860ebde7',
        proof: [
          '567371398e1700400b9f49eeca81824cf12f056b2368450340a572a5497a0175',
          '1a234015947636490d04befce65f07e12fb6399c6e92ded36f1797f1329a3b21',
          '70b778214e6998d6127b433f773b75ebb78f22a014755eff8aca316b23cf75fa',
          'fd7b386006e6f8fe614d30a2a04ac23ab58ce8455d3a685ba3d3c58e0db8d43c',
          '4028ecc08c707122c3fa6f110091d1762861afab75abd981ff41099392f0e573',
          'fd6ecc7758e793acc7b8b616251a686f927ac68fea4738c5f68ec1f26d6bd74f',
        ],
      },
      {
        index: 8,
        card: 0,
        saltHex: '0e51c438f62a92e8ee8c1b576cf428675526efa0dcf49c19b15f61e1673a05a2',
        proof: [
          'dd204a08c491b1689b12c6d4066688c2948cdbc84dc2eb275efd51b6b4d167d3',
          '805aa20dbce97bda462c0eab2b6e4f07ad68c7b21ba2774126dccdfdb71de61a',
          '49d35dfd44baeece0880d93f7e2af4dfd65e514c83dbbec80cc007e3e34b6827',
          '9d8a81e042b15c78c0ae5e6a2e623c7c85628581b2db4798b9bb19621d1347c6',
          '4028ecc08c707122c3fa6f110091d1762861afab75abd981ff41099392f0e573',
          'fd6ecc7758e793acc7b8b616251a686f927ac68fea4738c5f68ec1f26d6bd74f',
        ],
      },
      {
        index: 9,
        card: 21,
        saltHex: '7dfb43840cbafbbb464427b68d365a5bddf100d3fac24849d3bbfcd6481dd4d4',
        proof: [
          '41e9025f5e1dbe1d1bfb12d998a3e46ad0793c7eab7af26c2853351271a98d75',
          '805aa20dbce97bda462c0eab2b6e4f07ad68c7b21ba2774126dccdfdb71de61a',
          '49d35dfd44baeece0880d93f7e2af4dfd65e514c83dbbec80cc007e3e34b6827',
          '9d8a81e042b15c78c0ae5e6a2e623c7c85628581b2db4798b9bb19621d1347c6',
          '4028ecc08c707122c3fa6f110091d1762861afab75abd981ff41099392f0e573',
          'fd6ecc7758e793acc7b8b616251a686f927ac68fea4738c5f68ec1f26d6bd74f',
        ],
      },
      {
        index: 10,
        card: 46,
        saltHex: '519dd5b4c72bdbf740362f9d0e1acdfcef44939a7a1726dd4dacd6b77efd4823',
        proof: [
          '8db1c27107e940f4b407d419a704e23e9f06867a260b92a515359f5eaaa1e303',
          '393aa49f512fa0c57fed09e246f1e478c7995644f0c374def817b5e2d2f962ea',
          '49d35dfd44baeece0880d93f7e2af4dfd65e514c83dbbec80cc007e3e34b6827',
          '9d8a81e042b15c78c0ae5e6a2e623c7c85628581b2db4798b9bb19621d1347c6',
          '4028ecc08c707122c3fa6f110091d1762861afab75abd981ff41099392f0e573',
          'fd6ecc7758e793acc7b8b616251a686f927ac68fea4738c5f68ec1f26d6bd74f',
        ],
      },
    ],
    complete: false,
  },
  verification: {
    ok: true,
    verifiedPositions: 9,
  },
  seats: [
    {
      seat: 0,
      displayName: 'You',
      isBot: false,
      startingStack: 1000,
      net: 765,
      holeCards: ['9h', '8h'],
      showedDown: true,
    },
    {
      seat: 1,
      displayName: 'Ledger',
      isBot: true,
      startingStack: 1000,
      net: -10,
      holeCards: null,
      showedDown: false,
    },
    {
      seat: 2,
      displayName: 'Quartile',
      isBot: true,
      startingStack: 1000,
      net: -755,
      holeCards: ['As', 'Kd'],
      showedDown: true,
    },
  ],
  decisions: [
    {
      sequence: 1,
      street: 'preflop',
      seat: 0,
      action: 'raise',
      to: 60,
      amountPaid: 60,
      potBefore: 30,
      wasAutomatic: false,
      automaticReason: null,
      analysis: {
        street: 'preflop',
        potTotal: 30,
        toCall: 20,
        outs: null,
        equity: {
          heroEquity: 0.2768833333333335,
          method: 'monte-carlo',
          trials: 10000,
          confidenceHalfWidthPoints: 0.870472729869626,
          ruleOfThumb: null,
          perPlayer: [
            {
              label: 'you',
              equity: 0.2768833333333335,
              win: 0.2714,
              tie: 0.0125,
            },
            {
              label: 'opponent 1',
              equity: 0.3532333333333336,
              win: 0.3396,
              tie: 0.0288,
            },
            {
              label: 'opponent 2',
              equity: 0.3698833333333336,
              win: 0.356,
              tie: 0.0293,
            },
          ],
        },
        potOdds: {
          pot: 30,
          toCall: 20,
          breakEvenEquity: 0.4,
          oddsRatio: 1.5,
          equitySurplus: -0.12311666666666654,
          explanation:
            'You risk 20 to win the 30 already in the middle, a price of 1.50 to 1. Calling breaks even at 20 / (30 + 20) = 40.0% equity: with less than that, calling loses units over many repetitions of this spot; with more, it gains them. The 30 is what is in the middle before your own 20 goes in — counting the call inside the pot understates the equity a call needs. You do not clear that: 27.7% equity is 12.3 points short of it.',
        },
        candidates: [
          {
            action: 'fold',
            cost: 0,
            ev: 0,
            derivation:
              'EV(fold) = 0 chips. Folding is the baseline every other action is measured against: it costs nothing further and risks nothing further. Everything already in the pot is spent either way, so folding is the zero point every other action is measured against.',
          },
          {
            action: 'call',
            to: 20,
            cost: 20,
            ev: -6.155833333333327,
            derivation:
              'EV(call) = equity x (pot + toCall) - toCall = 0.2769 x (30 + 20) - 20 = -6.16 chips.',
            potShareIfCalled: 0.2768833333333335,
          },
          {
            action: 'raise',
            to: 40,
            cost: 40,
            ev: 0.6976750000000091,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 30 + 0.65 x [ 0.2769 x (30 + 20 + 2 x 20) - 40 ] = 10.5 + (-9.8) = 0.7 chips. Risks 40 to win 30. Raising by 20 is the smallest raise the rules allow here: 40% of the 50 that would be in the middle once you call. A caller needs 22.2% equity to break even on the extra 20, and has to continue with 42.9% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.2768833333333335,
          },
          {
            action: 'raise',
            to: 45,
            cost: 45,
            ev: -0.7525833333333249,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 30 + 0.65 x [ 0.2769 x (30 + 20 + 2 x 25) - 45 ] = 10.5 + (-11.25) = -0.75 chips. Risks 45 to win 30. Raising by 25 is the ½-pot size: 50% of the 50 that would be in the middle once you call. A caller needs 25% equity to break even on the extra 25, and has to continue with 40% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.2768833333333335,
          },
          {
            action: 'raise',
            to: 53,
            cost: 53,
            ev: -3.072996666666656,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 30 + 0.65 x [ 0.2769 x (30 + 20 + 2 x 33) - 53 ] = 10.5 + (-13.57) = -3.07 chips. Risks 53 to win 30. Raising by 33 is the ⅔-pot size: 66% of the 50 that would be in the middle once you call. A caller needs 28.4% equity to break even on the extra 33, and has to continue with 36.1% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.2768833333333335,
          },
          {
            action: 'raise',
            to: 70,
            cost: 70,
            ev: -8.003874999999987,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 30 + 0.65 x [ 0.2769 x (30 + 20 + 2 x 50) - 70 ] = 10.5 + (-18.5) = -8 chips. Risks 70 to win 30. Raising by 50 is the pot-sized size: 100% of the 50 that would be in the middle once you call. A caller needs 33.3% equity to break even on the extra 50, and has to continue with 30% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.2768833333333335,
          },
          {
            action: 'raise',
            to: 1000,
            cost: 1000,
            ev: -277.7519249999998,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 30 + 0.65 x [ 0.2769 x (30 + 20 + 2 x 980) - 1000 ] = 10.5 + (-288.25) = -277.75 chips. Risks 1000 to win 30. Raising by 980 puts your whole remaining stack in. A caller needs 48.8% equity to break even on the extra 980, and has to continue with 2.9% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.2768833333333335,
          },
        ],
        suggestion: {
          action: 'raise',
          sizeRange: {
            min: 40,
            max: 70,
          },
          confidence: 'low',
          reason:
            'Raise comes out marginally ahead here, but only just — treat this as close to indifferent rather than as a recommendation.',
          whatWouldChangeIt: [
            'This assumes the line wins uncontested 35% of the time. An opponent who folds less often makes it worse.',
            'Being raised is not modelled here, so treat the figure as optimistic.',
            'The equity figure is sampled, ±0.87 points at 95% confidence. A close decision could sit either side of that.',
            'The gap to the next-best action is only 0.7 units, well under a big blind — this is close to indifferent.',
          ],
        },
        stackContext: {
          effectiveStack: 990,
          spr: 33,
          potOddsOfferedByPotSizedBet: 0.3333333333333333,
          explanation:
            'The deepest opponent has only 990, so at most 990 can change hands even though you have 1000. The 10 above that is not in play this hand — nobody can pay you for it and nobody can take it. With 2 opponents each one has its own effective stack, the smaller of yours and theirs. 990 is the largest of them, so it is the most that can move against any single player and not the most you can lose across all of them. SPR = effective stack / pot = 990 / 30 = 33. There are 33 pots behind, which is the "very-high" band. Almost all of the money is still behind. The pot in front of you is small compared with what can still go in, so the cost of a later error dwarfs what is at stake right now. SPR describes the shape of the decision, not the answer to it: your hand, their range and position all still apply.',
        },
        assumptions: [
          'The hand is played to the river with no further betting — this is raw equity, not the value of the spot.',
          'You hold exactly 9h8h.',
          'Opponent 1 holds any of 262 combinations from "22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo", each equally likely.',
          'Opponent 2 holds any of 262 combinations from "22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo", each equally likely.',
          'Every hand in a range is weighted equally. Real opponents do not play every hand in a range the same way, so treat this as the range assumption, not a prediction.',
          'Estimated by sampling 10,000 random run-outs, not by exhaustive enumeration.',
          'No community cards are known yet, so five more cards are still to come.',
          'Bet and raise figures assume the line wins uncontested 35% of the time. That is an assumption, not something measured: the Scenario Lab lets you change it and watch these figures move.',
          'A half-pot bet of 15 is already break-even or better here purely on the equity you have when called — it does not need to win uncontested at all.',
          'Expected values are measured against folding, which is treated as zero. Chips already in the pot are spent either way.',
          'Each of the 2 opponents still in the hand is modelled with the same fixed range, "22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo". That is a stated assumption for the review, not a read of what they actually held: their cards are never disclosed unless they showed down, and this range does not narrow as the hand goes on.',
        ],
        uncertainty: {
          method: 'monte-carlo',
          summary:
            'Estimated by sampling 10,000 run-outs. The 95% confidence interval is ±0.87 percentage points.',
          confidenceInterval: {
            level: 0.95,
            halfWidthPoints: 0.870472729869626,
          },
          limitations: [
            'This is raw equity: the hand is treated as running to the river with no further betting. Real hands have more streets and more decisions.',
            'Every hand in the opponent range is weighted equally. Real opponents do not play every hand in a range the same way.',
            'Equity was estimated from 10,000 sampled run-outs, not enumerated exhaustively.',
            'Against several opponents the analysis assumes all of them see the river, which overstates your risk when some would fold.',
            'No implied odds, reverse implied odds or future-street play are modelled.',
          ],
        },
        teachingNotes: [
          'The pot is laying you 1.5 to 1, so you need 40.0% to break even on a call. That number depends only on the price — not on your cards.',
          'At an SPR of 33.0 there is a lot of money left behind, so hands that can keep improving are worth more than their current strength suggests.',
        ],
      },
    },
    {
      sequence: 2,
      street: 'preflop',
      seat: 1,
      action: 'fold',
      to: null,
      amountPaid: 0,
      potBefore: 90,
      wasAutomatic: false,
      automaticReason: null,
      analysis: null,
    },
    {
      sequence: 3,
      street: 'preflop',
      seat: 2,
      action: 'call',
      to: 60,
      amountPaid: 40,
      potBefore: 90,
      wasAutomatic: false,
      automaticReason: null,
      analysis: null,
    },
    {
      sequence: 4,
      street: 'flop',
      seat: 2,
      action: 'bet',
      to: 65,
      amountPaid: 65,
      potBefore: 130,
      wasAutomatic: false,
      automaticReason: null,
      analysis: null,
    },
    {
      sequence: 5,
      street: 'flop',
      seat: 0,
      action: 'call',
      to: 65,
      amountPaid: 65,
      potBefore: 195,
      wasAutomatic: false,
      automaticReason: null,
      analysis: {
        street: 'flop',
        potTotal: 195,
        toCall: 65,
        outs: {
          clean: 8,
          dirty: 7,
          total: 15,
          cleanCards: ['Kh', 'Jh', 'Qh', 'Th', '6h', '7h', '3h', '4h'],
          dirtyCards: ['2h', '8d', '8s', '8c', '9d', '9s', '9c'],
          explanation:
            'On Ah 5h 2c you hold 9h 8h — high card ace, nine eight kickers — for 43% equity against "22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo" (227 combinations still possible). Of the 47 cards that can come next, 8 are clean and 7 are dirty, which is 15 outs in total. Clean means your equity after that card is at least 90%; dirty means at least 50% but below 90%.',
        },
        equity: {
          heroEquity: 0.43323988786543854,
          method: 'exact-enumeration',
          trials: 224730,
          confidenceHalfWidthPoints: null,
          ruleOfThumb: {
            estimate: 0.32,
            errorPoints: 0.5476410730804773,
            note: '8 outs with two cards to come, times 4, is roughly 32% — the rule of 2 and 4. It works because one card out of the 46 or so you have not seen is worth a little over 2%, so 2% per out per card is close enough to do in your head. Count clean outs only: a card that improves your hand but hands an opponent a better one at the same time is not an out, and counting it is a bigger error than anything the shortcut itself does. The shortcut overstates by 0.5 points here — 32% against an exact 31.5%. Fine as a rough read, but do not hang a marginal call on it. The comparison is against the exact chance of one of those 8 clean cards arriving (Two cards to come, 8 outs, 47 cards unseen. Count the misses instead of the hits: 39 cards do not help. The turn misses 39/47 of the time, and with one miss now gone the river misses 38/46 of the time, so both cards miss (39/47) x (38/46) = 68.5% of the time. Hitting at least one is whatever is left: 1 - 68.5% = 31.5%. Adding 8/47 + 8/46 instead would count every run-out that hits twice twice over, and overstate the chance.), not against your equity: hitting and winning are different questions, and the 7 dirty outs are exactly the gap between them. The shortcut is an approximation and this is its error, stated rather than hidden.',
          },
          perPlayer: [
            {
              label: 'you',
              equity: 0.43323988786543854,
              win: 0.4236417033773862,
              tie: 0.019196368976104657,
            },
            {
              label: 'opponent 1',
              equity: 0.5667601121345615,
              win: 0.5571619276465092,
              tie: 0.019196368976104657,
            },
          ],
        },
        potOdds: {
          pot: 195,
          toCall: 65,
          breakEvenEquity: 0.25,
          oddsRatio: 3,
          equitySurplus: 0.18323988786543854,
          explanation:
            'You risk 65 to win the 195 already in the middle, a price of 3 to 1. Calling breaks even at 65 / (195 + 65) = 25.0% equity: with less than that, calling loses units over many repetitions of this spot; with more, it gains them. The 195 is what is in the middle before your own 65 goes in — counting the call inside the pot understates the equity a call needs. You clear that with 43.3% equity, a 18.3 point surplus.',
        },
        candidates: [
          {
            action: 'fold',
            cost: 0,
            ev: 0,
            derivation:
              'EV(fold) = 0 chips. Folding is the baseline every other action is measured against: it costs nothing further and risks nothing further. Everything already in the pot is spent either way, so folding is the zero point every other action is measured against.',
          },
          {
            action: 'call',
            to: 65,
            cost: 65,
            ev: 47.64237084501403,
            derivation:
              'EV(call) = equity x (pot + toCall) - toCall = 0.4332 x (195 + 65) - 65 = 47.64 chips.',
            potShareIfCalled: 0.43323988786543854,
          },
          {
            action: 'raise',
            to: 130,
            cost: 130,
            ev: 93.57631157388867,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 195 + 0.65 x [ 0.4332 x (195 + 65 + 2 x 65) - 130 ] = 68.25 + 25.33 = 93.58 chips. Risks 130 to win 195. Raising by 65 is the smallest raise the rules allow here: 25% of the 260 that would be in the middle once you call. A caller needs 16.7% equity to break even on the extra 65, and has to continue with 60% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.43323988786543854,
          },
          {
            action: 'raise',
            to: 152,
            cost: 152,
            ev: 91.66697236684023,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 195 + 0.65 x [ 0.4332 x (195 + 65 + 2 x 87) - 152 ] = 68.25 + 23.42 = 91.67 chips. Risks 152 to win 195. Raising by 87 is the ⅓-pot size: 33.5% of the 260 that would be in the middle once you call. A caller needs 20% equity to break even on the extra 87, and has to continue with 56.2% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.43323988786543854,
          },
          {
            action: 'raise',
            to: 195,
            cost: 195,
            ev: 87.93508209851824,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 195 + 0.65 x [ 0.4332 x (195 + 65 + 2 x 130) - 195 ] = 68.25 + 19.69 = 87.94 chips. Risks 195 to win 195. Raising by 130 is the ½-pot size: 50% of the 260 that would be in the middle once you call. A caller needs 25% equity to break even on the extra 130, and has to continue with 50% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.43323988786543854,
          },
          {
            action: 'raise',
            to: 238,
            cost: 238,
            ev: 84.20319183019626,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 195 + 0.65 x [ 0.4332 x (195 + 65 + 2 x 173) - 238 ] = 68.25 + 15.95 = 84.2 chips. Risks 238 to win 195. Raising by 173 is the ⅔-pot size: 66.5% of the 260 that would be in the middle once you call. A caller needs 28.5% equity to break even on the extra 173, and has to continue with 45% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.43323988786543854,
          },
          {
            action: 'raise',
            to: 325,
            cost: 325,
            ev: 76.65262314777733,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 195 + 0.65 x [ 0.4332 x (195 + 65 + 2 x 260) - 325 ] = 68.25 + 8.4 = 76.65 chips. Risks 325 to win 195. Raising by 260 is the pot-sized size: 100% of the 260 that would be in the middle once you call. A caller needs 33.3% equity to break even on the extra 260, and has to continue with 37.5% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.43323988786543854,
          },
          {
            action: 'raise',
            to: 940,
            cost: 940,
            ev: 23.27791349619543,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 195 + 0.65 x [ 0.4332 x (195 + 65 + 2 x 875) - 940 ] = 68.25 + (-44.97) = 23.28 chips. Risks 940 to win 195. Raising by 875 puts your whole remaining stack in. A caller needs 43.5% equity to break even on the extra 875, and has to continue with 17.2% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.43323988786543854,
          },
        ],
        suggestion: {
          action: 'raise',
          sizeRange: {
            min: 130,
            max: 325,
          },
          confidence: 'reasonable',
          reason:
            'Raise has the highest expected value against the stated range, by 45.9 units over the next-best action.',
          whatWouldChangeIt: [
            'This assumes the line wins uncontested 35% of the time. An opponent who folds less often makes it worse.',
            'Being raised is not modelled here, so treat the figure as optimistic.',
            '7 of your 15 outs are dirty — they improve you without making you safe, so counting all of them would overstate your chances.',
          ],
        },
        stackContext: {
          effectiveStack: 875,
          spr: 4.487179487179487,
          potOddsOfferedByPotSizedBet: 0.3333333333333333,
          explanation:
            'The deepest opponent has only 875, so at most 875 can change hands even though you have 940. The 65 above that is not in play this hand — nobody can pay you for it and nobody can take it. SPR = effective stack / pot = 875 / 195 = 4.49. There are 4.49 pots behind, which is the "medium" band. A bet and a raise, or two streets of betting, gets the stacks in. There is room for about one more decision after this one and not much more. SPR describes the shape of the decision, not the answer to it: your hand, their range and position all still apply.',
        },
        assumptions: [
          'The hand is played to the river with no further betting — this is raw equity, not the value of the spot.',
          'You hold exactly 9h8h.',
          'Opponent 1 holds any of 227 combinations from "22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo", each equally likely.',
          'Every hand in a range is weighted equally. Real opponents do not play every hand in a range the same way, so treat this as the range assumption, not a prediction.',
          'Computed by enumerating every remaining board — there is no sampling error.',
          'Bet and raise figures assume the line wins uncontested 35% of the time. That is an assumption, not something measured: the Scenario Lab lets you change it and watch these figures move.',
          'A half-pot bet of 98 is already break-even or better here purely on the equity you have when called — it does not need to win uncontested at all.',
          'Expected values are measured against folding, which is treated as zero. Chips already in the pot are spent either way.',
          'The one opponent still in the hand is modelled with the same fixed range, "22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo". That is a stated assumption for the review, not a read of what they actually held: their cards are never disclosed unless they showed down, and this range does not narrow as the hand goes on.',
        ],
        uncertainty: {
          method: 'exact-enumeration',
          summary:
            'Computed exactly by enumerating every remaining board (224,730 run-outs). There is no sampling error.',
          confidenceInterval: null,
          limitations: [
            'This is raw equity: the hand is treated as running to the river with no further betting. Real hands have more streets and more decisions.',
            'Every hand in the opponent range is weighted equally. Real opponents do not play every hand in a range the same way.',
            'The clean/dirty split for outs uses documented equity thresholds. They are a modelling choice, not a law of the game.',
            'No implied odds, reverse implied odds or future-street play are modelled.',
          ],
        },
        teachingNotes: [
          'The pot is laying you 3.0 to 1, so you need 25.0% to break even on a call. That number depends only on the price — not on your cards.',
          'Notice the split: 8 clean and 7 dirty, out of 15 outs in total. A card that improves you is not the same as a card that wins you the hand — an opponent who is behind after it lands can still draw out on the last card.',
          'The rule of 2 and 4 gives 32% on your 8 cards of clean outs, overstating the exact chance of hitting one of them by 0.5 points. Your equity here is 43.3%, which is a different question again: hitting is not the same as winning.',
          'A profitable call can still lose more often than it wins: you are under 50% here and the price is lower than that. Losing this hand would not make the call wrong.',
        ],
      },
    },
    {
      sequence: 6,
      street: 'turn',
      seat: 2,
      action: 'bet',
      to: 130,
      amountPaid: 130,
      potBefore: 260,
      wasAutomatic: false,
      automaticReason: null,
      analysis: null,
    },
    {
      sequence: 7,
      street: 'turn',
      seat: 0,
      action: 'call',
      to: 130,
      amountPaid: 130,
      potBefore: 390,
      wasAutomatic: false,
      automaticReason: null,
      analysis: {
        street: 'turn',
        potTotal: 390,
        toCall: 130,
        outs: {
          clean: 12,
          dirty: 0,
          total: 12,
          cleanCards: ['6c', '6d', '6s', 'Th', 'Jh', 'Qh', 'Kh', '3h', '4h', '6h', '2h', '7h'],
          dirtyCards: [],
          explanation:
            'On Ah 5h 2c 7d you hold 9h 8h — high card ace, nine eight kickers — for 32% equity against "22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo" (223 combinations still possible). Of the 46 cards that can come next, 12 are clean and 0 are dirty, which is 12 outs in total. Clean means your equity after that card is at least 90%; dirty means at least 50% but below 90%.',
        },
        equity: {
          heroEquity: 0.32139217284957194,
          method: 'exact-enumeration',
          trials: 9812,
          confidenceHalfWidthPoints: null,
          ruleOfThumb: {
            estimate: 0.24,
            errorPoints: -2.086956521739129,
            note: '12 outs with one card to come, times 2, is roughly 24% — the rule of 2 and 4. It works because one card out of the 46 or so you have not seen is worth a little over 2%, so 2% per out per card is close enough to do in your head. Count clean outs only: a card that improves your hand but hands an opponent a better one at the same time is not an out, and counting it is a bigger error than anything the shortcut itself does. The shortcut understates by 2.1 points here — 24% against an exact 26.1%. That is enough to flip a marginal call into a fold or the other way round, so use the exact figure for this decision. The comparison is against the exact chance of one of those 12 clean cards arriving (One card to come. 12 of the 46 unseen cards win the hand, so the chance is 12/46 = 26.1%. With a single card there is nothing to correct for: the count of outs over the count of unseen cards is the probability.), not against your equity: hitting and winning are different questions, and the dirty-out count is zero here only because every out is clean. The shortcut is an approximation and this is its error, stated rather than hidden.',
          },
          perPlayer: [
            {
              label: 'you',
              equity: 0.32139217284957194,
              win: 0.316041581736649,
              tie: 0.010701182225845903,
            },
            {
              label: 'opponent 1',
              equity: 0.678607827150428,
              win: 0.6732572360375051,
              tie: 0.010701182225845903,
            },
          ],
        },
        potOdds: {
          pot: 390,
          toCall: 130,
          breakEvenEquity: 0.25,
          oddsRatio: 3,
          equitySurplus: 0.07139217284957194,
          explanation:
            'You risk 130 to win the 390 already in the middle, a price of 3 to 1. Calling breaks even at 130 / (390 + 130) = 25.0% equity: with less than that, calling loses units over many repetitions of this spot; with more, it gains them. The 390 is what is in the middle before your own 130 goes in — counting the call inside the pot understates the equity a call needs. You clear that with 32.1% equity, a 7.1 point surplus.',
        },
        candidates: [
          {
            action: 'fold',
            cost: 0,
            ev: 0,
            derivation:
              'EV(fold) = 0 chips. Folding is the baseline every other action is measured against: it costs nothing further and risks nothing further. Everything already in the pot is spent either way, so folding is the zero point every other action is measured against.',
          },
          {
            action: 'call',
            to: 130,
            cost: 130,
            ev: 37.1239298817774,
            derivation:
              'EV(call) = equity x (pot + toCall) - toCall = 0.3214 x (390 + 130) - 130 = 37.12 chips.',
            potShareIfCalled: 0.32139217284957194,
          },
          {
            action: 'raise',
            to: 260,
            cost: 260,
            ev: 130.44583163473297,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 390 + 0.65 x [ 0.3214 x (390 + 130 + 2 x 130) - 260 ] = 136.5 + (-6.05) = 130.45 chips. Risks 260 to win 390. Raising by 130 is the smallest raise the rules allow here: 25% of the 520 that would be in the middle once you call. A caller needs 16.7% equity to break even on the extra 130, and has to continue with 60% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.32139217284957194,
          },
          {
            action: 'raise',
            to: 303,
            cost: 303,
            ev: 120.46165409702405,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 390 + 0.65 x [ 0.3214 x (390 + 130 + 2 x 173) - 303 ] = 136.5 + (-16.04) = 120.46 chips. Risks 303 to win 390. Raising by 173 is the ⅓-pot size: 33.3% of the 520 that would be in the middle once you call. A caller needs 20% equity to break even on the extra 173, and has to continue with 56.3% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.32139217284957194,
          },
          {
            action: 'raise',
            to: 390,
            cost: 390,
            ev: 100.26110884631062,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 390 + 0.65 x [ 0.3214 x (390 + 130 + 2 x 260) - 390 ] = 136.5 + (-36.24) = 100.26 chips. Risks 390 to win 390. Raising by 260 is the ½-pot size: 50% of the 520 that would be in the middle once you call. A caller needs 25% equity to break even on the extra 260, and has to continue with 50% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.32139217284957194,
          },
          {
            action: 'raise',
            to: 477,
            cost: 477,
            ev: 80.06056359559722,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 390 + 0.65 x [ 0.3214 x (390 + 130 + 2 x 347) - 477 ] = 136.5 + (-56.44) = 80.06 chips. Risks 477 to win 390. Raising by 347 is the ⅔-pot size: 66.7% of the 520 that would be in the middle once you call. A caller needs 28.6% equity to break even on the extra 347, and has to continue with 45% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.32139217284957194,
          },
          {
            action: 'raise',
            to: 650,
            cost: 650,
            ev: 39.89166326946595,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 390 + 0.65 x [ 0.3214 x (390 + 130 + 2 x 520) - 650 ] = 136.5 + (-96.61) = 39.89 chips. Risks 650 to win 390. Raising by 520 is the pot-sized size: 100% of the 520 that would be in the middle once you call. A caller needs 33.3% equity to break even on the extra 520, and has to continue with 37.5% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.32139217284957194,
          },
          {
            action: 'raise',
            to: 875,
            cost: 875,
            ev: -12.35112617203427,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 390 + 0.65 x [ 0.3214 x (390 + 130 + 2 x 745) - 875 ] = 136.5 + (-148.85) = -12.35 chips. Risks 875 to win 390. Raising by 745 puts your whole remaining stack in. A caller needs 37.1% equity to break even on the extra 745, and has to continue with 30.8% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.32139217284957194,
          },
        ],
        suggestion: {
          action: 'raise',
          sizeRange: {
            min: 260,
            max: 303,
          },
          confidence: 'reasonable',
          reason:
            'Raise has the highest expected value against the stated range, by 93.3 units over the next-best action.',
          whatWouldChangeIt: [
            'This assumes the line wins uncontested 35% of the time. An opponent who folds less often makes it worse.',
            'Being raised is not modelled here, so treat the figure as optimistic.',
          ],
        },
        stackContext: {
          effectiveStack: 745,
          spr: 1.9102564102564104,
          potOddsOfferedByPotSizedBet: 0.3333333333333333,
          explanation:
            'The deepest opponent has only 745, so at most 745 can change hands even though you have 875. The 130 above that is not in play this hand — nobody can pay you for it and nobody can take it. SPR = effective stack / pot = 745 / 390 = 1.91. There are 1.91 pots behind, which is the "low" band. One pot-sized bet and a call puts the stacks in. The live question on this street is whether you are committing, not what happens on the next one. SPR describes the shape of the decision, not the answer to it: your hand, their range and position all still apply.',
        },
        assumptions: [
          'The hand is played to the river with no further betting — this is raw equity, not the value of the spot.',
          'You hold exactly 9h8h.',
          'Opponent 1 holds any of 223 combinations from "22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo", each equally likely.',
          'Every hand in a range is weighted equally. Real opponents do not play every hand in a range the same way, so treat this as the range assumption, not a prediction.',
          'Computed by enumerating every remaining board — there is no sampling error.',
          'Bet and raise figures assume the line wins uncontested 35% of the time. That is an assumption, not something measured: the Scenario Lab lets you change it and watch these figures move.',
          'A half-pot bet of 195 is already break-even or better here purely on the equity you have when called — it does not need to win uncontested at all.',
          'Expected values are measured against folding, which is treated as zero. Chips already in the pot are spent either way.',
          'The one opponent still in the hand is modelled with the same fixed range, "22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo". That is a stated assumption for the review, not a read of what they actually held: their cards are never disclosed unless they showed down, and this range does not narrow as the hand goes on.',
        ],
        uncertainty: {
          method: 'exact-enumeration',
          summary:
            'Computed exactly by enumerating every remaining board (9,812 run-outs). There is no sampling error.',
          confidenceInterval: null,
          limitations: [
            'This is raw equity: the hand is treated as running to the river with no further betting. Real hands have more streets and more decisions.',
            'Every hand in the opponent range is weighted equally. Real opponents do not play every hand in a range the same way.',
            'The clean/dirty split for outs uses documented equity thresholds. They are a modelling choice, not a law of the game.',
            'No implied odds, reverse implied odds or future-street play are modelled.',
          ],
        },
        teachingNotes: [
          'The pot is laying you 3.0 to 1, so you need 25.0% to break even on a call. That number depends only on the price — not on your cards.',
          'The rule of 2 and 4 gives 24% on your 12 cards of clean outs, understating the exact chance of hitting one of them by 2.1 points. Your equity here is 32.1%, which is a different question again: hitting is not the same as winning.',
          'At an SPR of 1.9 the stacks are shallow enough that one more bet commits them. Decisions like that are effectively made now rather than later.',
          'A profitable call can still lose more often than it wins: you are under 50% here and the price is lower than that. Losing this hand would not make the call wrong.',
        ],
      },
    },
    {
      sequence: 8,
      street: 'river',
      seat: 2,
      action: 'bet',
      to: 200,
      amountPaid: 200,
      potBefore: 520,
      wasAutomatic: false,
      automaticReason: null,
      analysis: null,
    },
    {
      sequence: 9,
      street: 'river',
      seat: 0,
      action: 'raise',
      to: 500,
      amountPaid: 500,
      potBefore: 720,
      wasAutomatic: false,
      automaticReason: null,
      analysis: {
        street: 'river',
        potTotal: 720,
        toCall: 200,
        outs: null,
        equity: {
          heroEquity: 0.9853658536585366,
          method: 'exact-enumeration',
          trials: 205,
          confidenceHalfWidthPoints: null,
          ruleOfThumb: null,
          perPlayer: [
            {
              label: 'you',
              equity: 0.9853658536585366,
              win: 0.9853658536585366,
              tie: 0,
            },
            {
              label: 'opponent 1',
              equity: 0.014634146341463415,
              win: 0.014634146341463415,
              tie: 0,
            },
          ],
        },
        potOdds: {
          pot: 720,
          toCall: 200,
          breakEvenEquity: 0.21739130434782608,
          oddsRatio: 3.6,
          equitySurplus: 0.7679745493107105,
          explanation:
            'You risk 200 to win the 720 already in the middle, a price of 3.60 to 1. Calling breaks even at 200 / (720 + 200) = 21.7% equity: with less than that, calling loses units over many repetitions of this spot; with more, it gains them. The 720 is what is in the middle before your own 200 goes in — counting the call inside the pot understates the equity a call needs. You clear that with 98.5% equity, a 76.8 point surplus.',
        },
        candidates: [
          {
            action: 'fold',
            cost: 0,
            ev: 0,
            derivation:
              'EV(fold) = 0 chips. Folding is the baseline every other action is measured against: it costs nothing further and risks nothing further. Everything already in the pot is spent either way, so folding is the zero point every other action is measured against.',
          },
          {
            action: 'call',
            to: 200,
            cost: 200,
            ev: 706.5365853658536,
            derivation:
              'EV(call) = equity x (pot + toCall) - toCall = 0.9854 x (720 + 200) - 200 = 706.54 chips.',
            potShareIfCalled: 0.9853658536585366,
          },
          {
            action: 'raise',
            to: 400,
            cost: 400,
            ev: 837.4439024390244,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 720 + 0.65 x [ 0.9854 x (720 + 200 + 2 x 200) - 400 ] = 252 + 585.44 = 837.44 chips. Risks 400 to win 720. Raising by 200 is the smallest raise the rules allow here: 21.7% of the 920 that would be in the middle once you call. A caller needs 15.2% equity to break even on the extra 200, and has to continue with 64.3% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.9853658536585366,
          },
          {
            action: 'raise',
            to: 507,
            cost: 507,
            ev: 904.9582926829269,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 720 + 0.65 x [ 0.9854 x (720 + 200 + 2 x 307) - 507 ] = 252 + 652.96 = 904.96 chips. Risks 507 to win 720. Raising by 307 is the ⅓-pot size: 33.4% of the 920 that would be in the middle once you call. A caller needs 20% equity to break even on the extra 307, and has to continue with 58.7% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.9853658536585366,
          },
          {
            action: 'raise',
            to: 660,
            cost: 660,
            ev: 1001.4975609756098,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 720 + 0.65 x [ 0.9854 x (720 + 200 + 2 x 460) - 660 ] = 252 + 749.5 = 1001.5 chips. Risks 660 to win 720. Raising by 460 is the ½-pot size: 50% of the 920 that would be in the middle once you call. A caller needs 25% equity to break even on the extra 460, and has to continue with 52.2% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.9853658536585366,
          },
          {
            action: 'raise',
            to: 745,
            cost: 745,
            ev: 1055.130487804878,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 720 + 0.65 x [ 0.9854 x (720 + 200 + 2 x 545) - 745 ] = 252 + 803.13 = 1055.13 chips. Risks 745 to win 720. Raising by 545 puts your whole remaining stack in. A caller needs 27.1% equity to break even on the extra 545, and has to continue with 49.1% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.9853658536585366,
          },
        ],
        suggestion: {
          action: 'raise',
          sizeRange: {
            min: 745,
            max: 745,
          },
          confidence: 'reasonable',
          reason:
            'Raise has the highest expected value against the stated range, by 348.6 units over the next-best action.',
          whatWouldChangeIt: [
            'This assumes the line wins uncontested 35% of the time. An opponent who folds less often makes it worse.',
            'Being raised is not modelled here, so treat the figure as optimistic.',
          ],
        },
        stackContext: {
          effectiveStack: 545,
          spr: 0.7569444444444444,
          potOddsOfferedByPotSizedBet: 0.3333333333333333,
          explanation:
            'The deepest opponent has only 545, so at most 545 can change hands even though you have 745. The 200 above that is not in play this hand — nobody can pay you for it and nobody can take it. SPR = effective stack / pot = 545 / 720 = 0.76. There are 0.76 pots behind, which is the "very-low" band. The pot is already larger than what is behind, so a single bet gets the rest of the stack in. There is no later street to hold chips back for: at this depth the decision is effectively made now. SPR describes the shape of the decision, not the answer to it: your hand, their range and position all still apply.',
        },
        assumptions: [
          'The hand is played to the river with no further betting — this is raw equity, not the value of the spot.',
          'You hold exactly 9h8h.',
          'Opponent 1 holds any of 205 combinations from "22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo", each equally likely.',
          'Every hand in a range is weighted equally. Real opponents do not play every hand in a range the same way, so treat this as the range assumption, not a prediction.',
          'Computed by enumerating every remaining board — there is no sampling error.',
          'Bet and raise figures assume the line wins uncontested 35% of the time. That is an assumption, not something measured: the Scenario Lab lets you change it and watch these figures move.',
          'A half-pot bet of 360 is already break-even or better here purely on the equity you have when called — it does not need to win uncontested at all.',
          'Expected values are measured against folding, which is treated as zero. Chips already in the pot are spent either way.',
          'The one opponent still in the hand is modelled with the same fixed range, "22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo". That is a stated assumption for the review, not a read of what they actually held: their cards are never disclosed unless they showed down, and this range does not narrow as the hand goes on.',
        ],
        uncertainty: {
          method: 'exact-enumeration',
          summary:
            'Computed exactly by enumerating every remaining board (205 run-outs). There is no sampling error.',
          confidenceInterval: null,
          limitations: [
            'This is raw equity: the hand is treated as running to the river with no further betting. Real hands have more streets and more decisions.',
            'Every hand in the opponent range is weighted equally. Real opponents do not play every hand in a range the same way.',
            'No implied odds, reverse implied odds or future-street play are modelled.',
          ],
        },
        teachingNotes: [
          'The pot is laying you 3.6 to 1, so you need 21.7% to break even on a call. That number depends only on the price — not on your cards.',
          'At an SPR of 0.8 the stacks are shallow enough that one more bet commits them. Decisions like that are effectively made now rather than later.',
        ],
      },
    },
    {
      sequence: 10,
      street: 'river',
      seat: 2,
      action: 'call',
      to: 500,
      amountPaid: 300,
      potBefore: 1220,
      wasAutomatic: false,
      automaticReason: null,
      analysis: null,
    },
  ],
};

/** Hand 0041: folded out preflop. Empty reveal, and that is the correct result. */
export const REVIEW_HAND_FOLDED: HandReviewResponse = {
  hand: {
    id: 'hand-0041',
    roomId: 'room-lab-01',
    handNumber: 41,
    startedAt: '2026-08-17T18:40:52.000Z',
    completedAt: '2026-08-17T18:41:09.000Z',
    board: [],
    heroNet: 30,
    endedByFold: true,
    potTotal: 90,
  },
  commitmentRoot: '3abc00d9db40420086ed9326bbb6036382e1b04bc6ee65442444e55752a7c76f',
  commitmentContext: 'room-lab-01:41:hand-0041',
  reveal: {
    commitment: {
      algorithm: 'sha256',
      version: 'prl-deck-v2',
      root: '3abc00d9db40420086ed9326bbb6036382e1b04bc6ee65442444e55752a7c76f',
      context: 'room-lab-01:41:hand-0041',
    },
    cards: [],
    complete: false,
  },
  verification: {
    ok: true,
    verifiedPositions: 0,
    reason:
      'nothing became public in this hand — no board was dealt and nobody showed — so there is nothing to prove, and an empty reveal is the correct result',
  },
  seats: [
    {
      seat: 0,
      displayName: 'You',
      isBot: false,
      startingStack: 1000,
      net: 30,
      holeCards: ['9h', '8h'],
      showedDown: false,
    },
    {
      seat: 1,
      displayName: 'Ledger',
      isBot: true,
      startingStack: 1000,
      net: -10,
      holeCards: null,
      showedDown: false,
    },
    {
      seat: 2,
      displayName: 'Quartile',
      isBot: true,
      startingStack: 1000,
      net: -20,
      holeCards: null,
      showedDown: false,
    },
  ],
  decisions: [
    {
      sequence: 1,
      street: 'preflop',
      seat: 0,
      action: 'raise',
      to: 60,
      amountPaid: 60,
      potBefore: 30,
      wasAutomatic: false,
      automaticReason: null,
      analysis: {
        street: 'preflop',
        potTotal: 30,
        toCall: 20,
        outs: null,
        equity: {
          heroEquity: 0.2778333333333334,
          method: 'monte-carlo',
          trials: 10000,
          confidenceHalfWidthPoints: 0.8698060518625897,
          ruleOfThumb: null,
          perPlayer: [
            {
              label: 'you',
              equity: 0.2778333333333334,
              win: 0.2709,
              tie: 0.0154,
            },
            {
              label: 'opponent 1',
              equity: 0.35603333333333365,
              win: 0.3411,
              tie: 0.0314,
            },
            {
              label: 'opponent 2',
              equity: 0.36613333333333364,
              win: 0.3516,
              tie: 0.0306,
            },
          ],
        },
        potOdds: {
          pot: 30,
          toCall: 20,
          breakEvenEquity: 0.4,
          oddsRatio: 1.5,
          equitySurplus: -0.12216666666666665,
          explanation:
            'You risk 20 to win the 30 already in the middle, a price of 1.50 to 1. Calling breaks even at 20 / (30 + 20) = 40.0% equity: with less than that, calling loses units over many repetitions of this spot; with more, it gains them. The 30 is what is in the middle before your own 20 goes in — counting the call inside the pot understates the equity a call needs. You do not clear that: 27.8% equity is 12.2 points short of it.',
        },
        candidates: [
          {
            action: 'fold',
            cost: 0,
            ev: 0,
            derivation:
              'EV(fold) = 0 chips. Folding is the baseline every other action is measured against: it costs nothing further and risks nothing further. Everything already in the pot is spent either way, so folding is the zero point every other action is measured against.',
          },
          {
            action: 'call',
            to: 20,
            cost: 20,
            ev: -6.108333333333331,
            derivation:
              'EV(call) = equity x (pot + toCall) - toCall = 0.2778 x (30 + 20) - 20 = -6.11 chips.',
            potShareIfCalled: 0.2778333333333334,
          },
          {
            action: 'raise',
            to: 40,
            cost: 40,
            ev: 0.7532500000000013,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 30 + 0.65 x [ 0.2778 x (30 + 20 + 2 x 20) - 40 ] = 10.5 + (-9.75) = 0.75 chips. Risks 40 to win 30. Raising by 20 is the smallest raise the rules allow here: 40% of the 50 that would be in the middle once you call. A caller needs 22.2% equity to break even on the extra 20, and has to continue with 42.9% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.2778333333333334,
          },
          {
            action: 'raise',
            to: 45,
            cost: 45,
            ev: -0.6908333333333303,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 30 + 0.65 x [ 0.2778 x (30 + 20 + 2 x 25) - 45 ] = 10.5 + (-11.19) = -0.69 chips. Risks 45 to win 30. Raising by 25 is the ½-pot size: 50% of the 50 that would be in the middle once you call. A caller needs 25% equity to break even on the extra 25, and has to continue with 40% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.2778333333333334,
          },
          {
            action: 'raise',
            to: 53,
            cost: 53,
            ev: -3.001366666666666,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 30 + 0.65 x [ 0.2778 x (30 + 20 + 2 x 33) - 53 ] = 10.5 + (-13.5) = -3 chips. Risks 53 to win 30. Raising by 33 is the ⅔-pot size: 66% of the 50 that would be in the middle once you call. A caller needs 28.4% equity to break even on the extra 33, and has to continue with 36.1% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.2778333333333334,
          },
          {
            action: 'raise',
            to: 70,
            cost: 70,
            ev: -7.911249999999999,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 30 + 0.65 x [ 0.2778 x (30 + 20 + 2 x 50) - 70 ] = 10.5 + (-18.41) = -7.91 chips. Risks 70 to win 30. Raising by 50 is the pot-sized size: 100% of the 50 that would be in the middle once you call. A caller needs 33.3% equity to break even on the extra 50, and has to continue with 30% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.2778333333333334,
          },
          {
            action: 'raise',
            to: 1000,
            cost: 1000,
            ev: -276.51075,
            derivation:
              'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 30 + 0.65 x [ 0.2778 x (30 + 20 + 2 x 980) - 1000 ] = 10.5 + (-287.01) = -276.51 chips. Risks 1000 to win 30. Raising by 980 puts your whole remaining stack in. A caller needs 48.8% equity to break even on the extra 980, and has to continue with 2.9% of their range for a raise of this size not to print automatically.',
            foldEquityAssumed: 0.35,
            potShareIfCalled: 0.2778333333333334,
          },
        ],
        suggestion: {
          action: 'raise',
          sizeRange: {
            min: 40,
            max: 70,
          },
          confidence: 'low',
          reason:
            'Raise comes out marginally ahead here, but only just — treat this as close to indifferent rather than as a recommendation.',
          whatWouldChangeIt: [
            'This assumes the line wins uncontested 35% of the time. An opponent who folds less often makes it worse.',
            'Being raised is not modelled here, so treat the figure as optimistic.',
            'The equity figure is sampled, ±0.87 points at 95% confidence. A close decision could sit either side of that.',
            'The gap to the next-best action is only 0.8 units, well under a big blind — this is close to indifferent.',
          ],
        },
        stackContext: {
          effectiveStack: 990,
          spr: 33,
          potOddsOfferedByPotSizedBet: 0.3333333333333333,
          explanation:
            'The deepest opponent has only 990, so at most 990 can change hands even though you have 1000. The 10 above that is not in play this hand — nobody can pay you for it and nobody can take it. With 2 opponents each one has its own effective stack, the smaller of yours and theirs. 990 is the largest of them, so it is the most that can move against any single player and not the most you can lose across all of them. SPR = effective stack / pot = 990 / 30 = 33. There are 33 pots behind, which is the "very-high" band. Almost all of the money is still behind. The pot in front of you is small compared with what can still go in, so the cost of a later error dwarfs what is at stake right now. SPR describes the shape of the decision, not the answer to it: your hand, their range and position all still apply.',
        },
        assumptions: [
          'The hand is played to the river with no further betting — this is raw equity, not the value of the spot.',
          'You hold exactly 9h8h.',
          'Opponent 1 holds any of 262 combinations from "22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo", each equally likely.',
          'Opponent 2 holds any of 262 combinations from "22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo", each equally likely.',
          'Every hand in a range is weighted equally. Real opponents do not play every hand in a range the same way, so treat this as the range assumption, not a prediction.',
          'Estimated by sampling 10,000 random run-outs, not by exhaustive enumeration.',
          'No community cards are known yet, so five more cards are still to come.',
          'Bet and raise figures assume the line wins uncontested 35% of the time. That is an assumption, not something measured: the Scenario Lab lets you change it and watch these figures move.',
          'A half-pot bet of 15 is already break-even or better here purely on the equity you have when called — it does not need to win uncontested at all.',
          'Expected values are measured against folding, which is treated as zero. Chips already in the pot are spent either way.',
          'Each of the 2 opponents still in the hand is modelled with the same fixed range, "22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo". That is a stated assumption for the review, not a read of what they actually held: their cards are never disclosed unless they showed down, and this range does not narrow as the hand goes on.',
        ],
        uncertainty: {
          method: 'monte-carlo',
          summary:
            'Estimated by sampling 10,000 run-outs. The 95% confidence interval is ±0.87 percentage points.',
          confidenceInterval: {
            level: 0.95,
            halfWidthPoints: 0.8698060518625897,
          },
          limitations: [
            'This is raw equity: the hand is treated as running to the river with no further betting. Real hands have more streets and more decisions.',
            'Every hand in the opponent range is weighted equally. Real opponents do not play every hand in a range the same way.',
            'Equity was estimated from 10,000 sampled run-outs, not enumerated exhaustively.',
            'Against several opponents the analysis assumes all of them see the river, which overstates your risk when some would fold.',
            'No implied odds, reverse implied odds or future-street play are modelled.',
          ],
        },
        teachingNotes: [
          'The pot is laying you 1.5 to 1, so you need 40.0% to break even on a call. That number depends only on the price — not on your cards.',
          'At an SPR of 33.0 there is a lot of money left behind, so hands that can keep improving are worth more than their current strength suggests.',
        ],
      },
    },
    {
      sequence: 2,
      street: 'preflop',
      seat: 1,
      action: 'fold',
      to: null,
      amountPaid: 0,
      potBefore: 90,
      wasAutomatic: false,
      automaticReason: null,
      analysis: null,
    },
    {
      sequence: 3,
      street: 'preflop',
      seat: 2,
      action: 'fold',
      to: null,
      amountPaid: 0,
      potBefore: 90,
      wasAutomatic: true,
      automaticReason: 'timeout',
      analysis: null,
    },
  ],
};

/**
 * The index rows, newest first.
 *
 * `heroNet` is nullable and one row uses it: hand 0039 is still unsettled, so there is no net yet.
 * The list must render that as "not settled" rather than as zero — a zero would read as a hand that
 * broke even, which is a different fact.
 */
export const REVIEW_HAND_SUMMARIES: readonly HandSummary[] = [
  REVIEW_HAND_SHOWDOWN.hand,
  REVIEW_HAND_FOLDED.hand,
  {
    id: 'hand-0040',
    roomId: 'room-lab-01',
    handNumber: 40,
    startedAt: '2026-08-17T18:38:04.000Z',
    completedAt: '2026-08-17T18:39:31.000Z',
    board: ['Td', '9d', '4s', 'Qc'],
    heroNet: -240,
    endedByFold: true,
    potTotal: 610,
  },
  {
    id: 'hand-0039',
    roomId: 'room-lab-01',
    handNumber: 39,
    startedAt: '2026-08-17T18:36:40.000Z',
    completedAt: null,
    board: ['Ks', '7h', '3h'],
    heroNet: null,
    endedByFold: false,
    potTotal: 180,
  },
  {
    id: 'hand-0038',
    roomId: 'room-lab-01',
    handNumber: 38,
    startedAt: '2026-08-17T18:34:52.000Z',
    completedAt: '2026-08-17T18:35:18.000Z',
    board: [],
    heroNet: -20,
    endedByFold: true,
    potTotal: 50,
  },
  {
    id: 'hand-0037',
    roomId: 'room-lab-01',
    handNumber: 37,
    startedAt: '2026-08-17T18:32:15.000Z',
    completedAt: '2026-08-17T18:33:47.000Z',
    board: ['6c', '6h', '2d', 'Jc', '8s'],
    heroNet: 418,
    endedByFold: false,
    potTotal: 836,
  },
  {
    id: 'hand-0036',
    roomId: 'room-lab-01',
    handNumber: 36,
    startedAt: '2026-08-17T18:30:02.000Z',
    completedAt: '2026-08-17T18:30:44.000Z',
    board: ['Ac', 'Qs', '5d'],
    heroNet: -65,
    endedByFold: true,
    potTotal: 190,
  },
  {
    id: 'hand-0035',
    roomId: 'room-lab-01',
    handNumber: 35,
    startedAt: '2026-08-17T18:28:19.000Z',
    completedAt: '2026-08-17T18:29:55.000Z',
    board: ['9s', '8c', '7d', '2h', 'Ad'],
    heroNet: 0,
    endedByFold: false,
    potTotal: 520,
  },
  {
    id: 'hand-0034',
    roomId: 'room-lab-01',
    handNumber: 34,
    startedAt: '2026-08-17T18:26:33.000Z',
    completedAt: '2026-08-17T18:27:02.000Z',
    board: [],
    heroNet: 30,
    endedByFold: true,
    potTotal: 90,
  },
];

const REVIEWS_BY_ID: ReadonlyMap<string, HandReviewResponse> = new Map([
  [REVIEW_HAND_SHOWDOWN.hand.id, REVIEW_HAND_SHOWDOWN],
  [REVIEW_HAND_FOLDED.hand.id, REVIEW_HAND_FOLDED],
]);

/**
 * One page of history, in the shape `GET /api/hands` returns. The cursor is the id of the first row of
 * the NEXT page, the keyset shape, which survives rows being inserted while the reader pages.
 */
export function handListFixture(cursor?: string | null): HandListResponse {
  const rows = REVIEW_HAND_SUMMARIES;
  const start = cursor === undefined || cursor === null ? 0 : rows.findIndex((row) => row.id === cursor);
  const from = start < 0 ? 0 : start;
  const page = rows.slice(from, from + HAND_PAGE_SIZE);
  const next = rows[from + HAND_PAGE_SIZE];
  return { hands: page, nextCursor: next === undefined ? null : next.id };
}

/** The empty state a reader with no hands yet would get. Not an error, and it must not look like one. */
export function emptyHandListFixture(): HandListResponse {
  return { hands: [], nextCursor: null };
}

/** One review, or null for a hand this fixture has no review for. */
export function handReviewFixture(handId: string): HandReviewResponse | null {
  return REVIEWS_BY_ID.get(handId) ?? null;
}
