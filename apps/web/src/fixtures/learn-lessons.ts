/**
 * Fixture: eight complete lessons, for the lesson reader.
 *
 * Eight of the seventeen, chosen so that between them they exercise every
 * `LessonBlock` variant and every `LiveCalculation` kind in the contract — equity, outs,
 * ruleOf24, potOdds, callEv, foldEquity, spr, variance, riskOfRuin and icm. The remaining
 * nine lessons appear in the index (see `learn-lesson-summaries.ts`) and are served by
 * the API once `apps/api/src/routes/content.ts` exists.
 *
 * ONE BLOCK IS NOT FROM THE CONTENT PACKAGE: the `scenarioLink` at the end of
 * `counting-outs`. No lesson in `packages/content` uses that variant yet, and
 * `LessonBlockRenderer` has to handle it, so the fixture supplies one pointing at a real
 * scenario id (`fl-overcards-dirty-outs`). It is the only authored content in this file
 * and it is here so the branch is reviewable rather than theoretical.
 *
 * Every string here is copied verbatim from `packages/content/data`, which is the real
 * teaching material. Nothing is paraphrased and nothing is invented, because a fixture that
 * drifts from the content it stands in for is a screen that was reviewed against fiction.
 *
 * NO COMPUTED FIGURE APPEARS ANYWHERE IN THIS FILE. Every number a learner reads is computed
 * in the browser from the `liveCalculation` and `calculation` parameters below — see
 * ADR 0006 and `src/lib/learn-calculations.ts`. Search this file for a percentage and you
 * will only find the ones that are *inputs* (a fold probability, an assumed win rate).
 */

import type { Lesson } from '@prl/contracts';

export const LEARN_LESSONS: readonly Lesson[] = [
  {
    id: 'hand-flow',
    title: "How a Hand of Hold'em Runs",
    summary:
      'Follow one hand from the posted blinds to the showdown: what gets dealt, who acts when, and the four chances to bet.',
    topic: 'rules-and-flow',
    difficulty: 'intro',
    estimatedMinutes: 8,
    prerequisites: [],
    blocks: [
      {
        kind: 'prose',
        text: "A hand of No-Limit Hold'em is a fixed sequence. The cards change every time; the sequence never does. Every decision you will spend the rest of this lab studying happens inside this one skeleton, so it is worth being able to recite it before worrying about whether to call.",
      },
      {
        kind: 'heading',
        text: 'The skeleton',
      },
      {
        kind: 'list',
        ordered: true,
        items: [
          'Post. Before anyone sees a card, the two players left of the button put in the small blind and the big blind. Some games also collect an ante from every player. With only two players at the table this works differently, and the blinds lesson covers that separately.',
          'Deal. Every player receives two private cards, dealt one at a time round the table, starting left of the button. Only you ever see yours.',
          'Preflop betting. The player left of the big blind acts first. The round continues until everyone still in has matched the largest bet or folded.',
          'Flop. Three community cards are dealt face up. A second betting round begins, this time with the first player left of the button.',
          'Turn. A fourth community card. Third betting round, same order as the flop.',
          'River. A fifth community card. Fourth and final betting round.',
          'Showdown. If two or more players are still in, hands are compared and the best five-card hand takes the pot.',
        ],
      },
      {
        kind: 'callout',
        tone: 'insight',
        title: 'Four betting rounds, five shared cards',
        text: 'Two private cards, five community cards, four opportunities to put units in. Everything else in poker is choices made inside that frame.',
      },
      {
        kind: 'prose',
        text: 'One detail from live rooms that sometimes confuses newcomers: a human dealer usually burns a card face down before dealing each street. It is an anti-cheating ritual. It changes no probability, because a card you have not seen is a card you have not seen, whether it is in the deck or face down beside it.',
      },
      {
        kind: 'heading',
        text: 'What ends a betting round',
      },
      {
        kind: 'list',
        items: [
          'Everyone still able to act has matched the largest bet — including the case where nobody bet at all and everyone simply checked. A player who is already all-in for less has nothing left to match, and is not waited on.',
          'Everyone folded to one player, who wins immediately and never has to show.',
          'Nobody who is still in has units left to bet, because they are all-in. Remaining streets are then dealt with no betting.',
        ],
      },
      {
        kind: 'heading',
        text: 'Most pots never reach a showdown',
      },
      {
        kind: 'prose',
        text: 'It is easy to assume the point of the game is to make the best hand. Most hands are not decided that way. The pot goes to whoever is last standing, and usually that happens because everybody else folded. Winning the pot and holding the best hand are two different achievements, and the gap between them is where a large part of poker strategy lives — it is the whole source of what later lessons call fold equity.',
      },
      {
        kind: 'callout',
        tone: 'misconception',
        title: '"You need the best hand to win"',
        text: 'You need the best hand to win a showdown. You win a pot by being the last player who has not folded. Those are different, and the second happens far more often than the first.',
      },
      {
        kind: 'heading',
        text: 'One hand tells you almost nothing',
      },
      {
        kind: 'prose',
        text: 'Because five community cards are still to come preflop, even a large edge is only an edge. Two hands that look worlds apart in strength often run out closer than people expect, and the reverse is true too. This is the reason this lab judges decisions rather than results, and it is why a losing hand is not evidence of a mistake.',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'equity',
          heroCards: 'AhKs',
          opponents: ['7c7d'],
        },
        caption:
          'Ace-king against a pair of sevens, all five community cards still to come. Ask the app how often each hand wins. Whatever it says, notice that neither side is anywhere near certain — and that a single hand therefore cannot tell you who played better.',
      },
      {
        kind: 'heading',
        text: 'The seats rotate',
      },
      {
        kind: 'prose',
        text: 'After every hand the button moves one seat clockwise, so the blinds move with it. Nobody pays the blinds for ever, and nobody gets to act last for ever. Over a full rotation everyone has paid the same forced bets and played from every position — which is why the cost of the blinds is a shared cost rather than a private misfortune.',
      },
      {
        kind: 'prose',
        text: 'When it is your turn, this app shows exactly which actions are legal and the exact bounds on each one. Treat that list as a rules teacher rather than a menu: if an action you expected is missing, there is a rule behind its absence, and the next lesson covers most of them.',
      },
    ],
    keyTakeaways: [
      'Every hand runs the same way: blinds, hole cards, then four betting rounds separated by the flop, the turn and the river.',
      'You get two private cards and share five, and your hand is the best five out of those seven.',
      'A betting round ends when everyone still in has matched the largest bet, when only one player is left, or when nobody has units left to bet.',
      'Most pots are won because everyone else folded, not at a showdown — winning the pot and holding the best hand are different things.',
      'The button rotates every hand, so blind costs and positional advantages are shared over time.',
      "Because so many cards are still to come, one hand's result says almost nothing about the quality of the decisions in it.",
    ],
    quizId: 'quiz-hand-flow',
    glossaryTerms: [
      'street',
      'blinds',
      'ante',
      'button',
      'showdown',
      'all-in',
      'pot',
      'units',
      'fold-equity',
    ],
  },
  {
    id: 'counting-outs',
    title: 'Outs: Clean, Dirty and Imaginary',
    summary:
      'Counting the cards that improve you, and the difference between an out that wins the pot and one that merely improves your hand.',
    topic: 'hand-reading-and-outs',
    difficulty: 'core',
    estimatedMinutes: 12,
    prerequisites: ['reading-the-board'],
    blocks: [
      {
        kind: 'prose',
        text: 'An out is an unseen card that gives you the winning hand. Counting outs is the first real piece of arithmetic in poker, and it is also where many players quietly learn something false: they count the cards that improve their hand, and then treat that count as their chance of winning the pot. Those are different quantities, and the gap between them is where units disappear.',
      },
      {
        kind: 'heading',
        text: 'Counting, carefully',
      },
      {
        kind: 'prose',
        text: "Start from what you cannot see. After the flop you know your own two cards and the three on the board; every other card is unseen from your seat — including the cards in your opponents' hands. That is why the arithmetic talks about unseen cards rather than cards in the deck: a card in someone's hand is just as invisible to you, and treating it as available is the right assumption when you do not know what they hold. Now list the cards that would change the hand you show down, and be strict about it.",
      },
      {
        kind: 'callout',
        tone: 'misconception',
        title: '"Four to a flush, so every remaining card of my suit is an out"',
        text: 'Sometimes. An out only counts if the card makes you the winner. Cards that improve you into a hand that is still second best are not outs at all — they are the most expensive cards in the deck, because they are the ones you will pay off with.',
      },
      {
        kind: 'heading',
        text: 'Clean, dirty and imaginary',
      },
      {
        kind: 'list',
        items: [
          'A clean out makes you the winner. When it lands you are ahead of what your opponent actually holds, and a price comparison built on clean outs is honest.',
          'A dirty out improves your hand but can still lose: it improves your opponent more, or the hand it makes is second best, or there is still another card to come for them to draw out on you.',
          'An imaginary out improves nothing that matters. It makes you a pair that still loses, or a straight beaten by the flush the very same card completed.',
        ],
      },
      {
        kind: 'heading',
        text: 'The extreme case: an out that cannot win',
      },
      {
        kind: 'prose',
        text: 'You hold the ten of hearts and the nine of clubs. The flop comes the queen, the seven and the deuce of hearts — all one suit. You have four hearts, so one more makes a flush, and that looks like a draw worth paying for. Now suppose your opponent holds the ace of hearts and the king of clubs. They have four hearts as well. Every heart that completes your flush completes a higher one for them, so those cards are not outs in any sense: when one arrives you have made a hand and lost with it. The cards that can actually win are the ones you were not counting — the tens and nines that pair you — and not even all of those, because the nine of hearts brings the flush disaster along with the pair. Even the outs that do work leave your opponent drawing at the same flush behind you.',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'outs',
          heroCards: 'Th9c',
          board: 'Qh7h2h',
          opponentCards: 'AhKc',
        },
        caption:
          'Ask the app to split that draw into clean and dirty outs against that exact holding. The cards you would have counted first are the ones that cannot win, and the ones that can win are not part of the draw at all.',
      },
      {
        kind: 'heading',
        text: 'The subtler case, which is the common one',
      },
      {
        kind: 'prose',
        text: 'Most spots are less brutal than that, and much easier to get wrong. You hold the ten and nine of hearts. The flop is the king of spades, the queen of hearts and the four of hearts: four to a flush, and a jack would give you a straight. Counted naively that is a lot of cards, and it feels like a big draw. Now suppose your opponent holds the ace of hearts and a jack. Three things change at once and none of them is visible in the count. Their ace of hearts is one of the hearts you counted, so there is one fewer. Their jack is one of the jacks you counted, so there is one fewer of those too. And your flush can no longer be the best one available: once a third heart is on the board, a fourth on the river gives them the ace-high flush over yours, so even hitting is not the end of the story. Then there is a card that is worse than a blank — a ten pairs you, which is a genuine improvement, and hands them the highest straight there is.',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'outs',
          heroCards: 'Th9h',
          board: 'KsQh4h',
          opponentCards: 'AhJc',
        },
        caption:
          'Ask the app to sort this draw into clean and dirty outs against that exact holding. What matters is not either figure on its own but the gap between them — and how much of that gap comes from one single card sitting in their hand.',
      },
      {
        kind: 'prose',
        text: 'Now change only who holds the top card of the suit, and keep the shape of the draw the same.',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'outs',
          heroCards: 'AhKh',
          board: 'Qh7h2c',
          opponentCards: 'QsJd',
        },
        caption:
          'Four to a flush again, plus two cards higher than anything on the board — but this time you hold the highest card of the suit, so no opponent can make a better flush and nobody can be drawing to one. Ask the app for the clean and dirty split here and compare it with the two above.',
      },
      {
        kind: 'callout',
        tone: 'insight',
        title: 'Holding the top card of your draw is worth more than an extra out',
        text: 'It removes a whole category of disaster: hitting your hand and losing anyway. It also removes those hands from what your opponent can hold, since they cannot have the card you have. That is the plainest example of a blocker, and it is why two draws with the same number of cards can be worth very different amounts.',
      },
      {
        kind: 'heading',
        text: 'The cards you should count against yourself',
      },
      {
        kind: 'prose',
        text: 'Some cards help your opponent and not you, and they matter just as much when you decide whether to invest. A card that completes a flush for them while your pair remains a pair is not a neutral card. Once you stop assuming one specific holding and start assuming a range of hands, every card becomes partly an out and partly a disaster, weighted by how often they hold each hand. That weighted sum is exactly what an equity calculation does, and it is why equity is the better tool once a situation gets complicated. Out counting is the fast approximation you can do in your head; equity is what it is approximating.',
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Every out count hides an assumption — say it out loud',
        text: '"I have this many outs" is short for "against the hand I am assuming, these cards would win". Change the assumed hand and the count changes, sometimes to nothing. An out count without a stated assumption is not a fact; it is a guess wearing a number.',
      },
      {
        kind: 'heading',
        text: 'Two streets, one at a time',
      },
      {
        kind: 'prose',
        text: "On the flop there are two cards still to come, and it is tempting to combine both chances into one comfortable figure and stop thinking. Two things make that dangerous: you may have to pay again on the turn before you ever see the river, and your opponent's hand can improve on exactly the same cards. The next lesson is about the shortcut that turns outs into a percentage, and about both of those caveats.",
      },
      {
        kind: 'scenarioLink',
        scenarioId: 'fl-overcards-dirty-outs',
        prompt: 'Take the same distinction into a live spot: two overcards, only one of them clean.',
      },
    ],
    keyTakeaways: [
      'An out is an unseen card that makes you the winner, not merely one that improves your hand.',
      'Clean outs win the pot; dirty outs improve you and can still lose; imaginary outs were never outs at all.',
      "Count from unseen cards, which includes the cards in your opponents' hands, because those are invisible to you too.",
      'Every out count is relative to an assumed holding or range — state the assumption or the count means nothing.',
      "Holding the top card of your draw removes the hit-and-lose outcomes and removes combinations from your opponent's range: that is a blocker.",
      'Count the cards that help your opponent as well, and switch from counting outs to computing equity once the situation stops being simple.',
    ],
    quizId: 'quiz-counting-outs',
    glossaryTerms: [
      'outs',
      'clean-out',
      'dirty-out',
      'drawing-dead',
      'flush-draw',
      'open-ended-straight-draw',
      'gutshot',
      'backdoor-draw',
      'overcard',
      'blocker',
      'equity',
      'range',
      'reverse-implied-odds',
    ],
  },
  {
    id: 'rule-of-2-and-4',
    title: 'The Rule of 2 and 4',
    summary:
      'The table-friendly shortcut from outs to a percentage: what it approximates, why it works, and where it drifts.',
    topic: 'probability-and-equity',
    difficulty: 'core',
    estimatedMinutes: 10,
    prerequisites: ['counting-outs'],
    blocks: [
      {
        kind: 'prose',
        text: 'The rule of 2 and 4 turns an out count into a rough chance of hitting, fast enough to use while it is your turn. It is the most useful approximation in poker and also the one most often used past the point where it is honest. So learn it in two halves: what it estimates, and which way it is wrong.',
      },
      {
        kind: 'heading',
        text: 'The shortcut',
      },
      {
        kind: 'formula',
        expression:
          'chance of hitting (as a percentage) ~= 2 x outs, with one card to come;  ~= 4 x outs, with two cards to come',
        explanation:
          "Two versions of a single idea. Each unseen card is roughly one in fifty, so each out is worth roughly two percentage points per card to come, and two cards give roughly twice the chance of one. The word 'roughly' is doing real work in all three places.",
      },
      {
        kind: 'heading',
        text: 'Why it works',
      },
      {
        kind: 'prose',
        text: 'After the flop you have seen five cards — your two and the three on the board — so forty-seven are unseen from your seat. One out is therefore one chance in forty-seven, which is a little more than two percent. The shortcut rounds the unseen deck to fifty, because dividing by fifty is something a human can do at a table while three people wait. Then, because two cards to come give you two shots at the same thing instead of one, the multiplier doubles — which overstates it a little, because the two shots overlap: you can hit on both cards, and that outcome gets counted twice. Both approximations are deliberate, and both have a known direction.',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'ruleOf24',
          outs: 9,
          cardsToCome: 1,
        },
        caption:
          "A flush draw with one card left to come. Ask the app for the shortcut's estimate and the exact figure side by side, and note which way the error points.",
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'ruleOf24',
          outs: 9,
          cardsToCome: 2,
        },
        caption:
          'The same draw with two cards to come. Compare this gap with the one above and note that the two errors point in opposite directions: with one card the shortcut sits a little below the exact figure, and with two it sits a little above. Rounding the deck to fifty pulls one way; counting the times you hit on both cards pulls the other.',
      },
      {
        kind: 'heading',
        text: 'Where it is least accurate',
      },
      {
        kind: 'list',
        items: [
          'With many outs. Doubling the one-card chance counts the times you hit on both cards twice over, so with a big combined draw the four-times estimate runs well ahead of the truth. The more outs, the worse it gets.',
          'With one card to come it errs the other way, slightly low, because there are fewer than fifty unseen cards and each out is therefore worth a bit more than two points.',
          'When the two cards are not free. The four-times figure is the chance of hitting by the river — which you only collect if you actually get to see the river. Facing a bet on the flop with more betting to come, the one-card figure is the honest one to compare against the price.',
          'When your outs are dirty. The shortcut converts outs into a chance of a card arriving. Arriving is not winning.',
          'When your opponent can improve too. Hitting your draw on the turn does not settle the hand if they still have a card to draw out on you.',
        ],
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'ruleOf24',
          outs: 15,
          cardsToCome: 2,
        },
        caption:
          'A large combined draw — the case where the shortcut is at its worst. Compare the estimate with the exact figure and note the size of the error, because this is the situation in which the rule of 4 will most flatter a bad call.',
      },
      {
        kind: 'callout',
        tone: 'misconception',
        title: '"Four times my outs is my equity"',
        text: 'Three separate errors are packed into that sentence: that all the outs are clean, that both cards are free, and that hitting means winning. The shortcut estimates the chance of a card arriving. Equity is the chance of winning the pot, which also depends on what your opponent holds and on what happens after your card lands.',
      },
      {
        kind: 'heading',
        text: 'Holding it next to the real thing',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'equity',
          heroCards: '9h8h',
          board: 'Kh4h2c',
          opponents: ['KsQd'],
        },
        caption:
          "A flush draw against top pair, on a board where pairing just one of your own cards would not be enough. Ask the app for the exact equity and hold it next to what the rule of 4 would have told you from a flush draw's out count. Then work out why the two differ in the direction they do — part of the answer is that the hand has small chances the out count never mentioned, such as two running cards making it two pair or trips.",
      },
      {
        kind: 'prose',
        text: 'That comparison is the honest way to learn an approximation: use it, then check it, and build an instinct for the size and direction of its error. Do that a dozen times and the shortcut becomes genuinely reliable — not because it got more accurate, but because you now know when not to trust it.',
      },
      {
        kind: 'heading',
        text: 'What a rough number is for',
      },
      {
        kind: 'prose',
        text: "A rough number is enough when the decision is not close, and most decisions are not close. The shortcut's real job is to tell you quickly which of three regions you are in: the price is comfortable, the price is clearly wrong, or the answer depends on details. Only the third region needs care, and knowing which one you are in is most of the skill. The next topic supplies the other half of the comparison, by turning the price of a call into the equity you would need for it to break even.",
      },
      {
        kind: 'callout',
        tone: 'insight',
        title: 'An approximation is a decision, not a failure',
        text: 'Every number in this lab is a model of something. The honest way to use one is to know which way it is wrong: the rule of 4 runs high with many outs and when more betting is coming, and the rule of 2 runs slightly low. Knowing that is worth more than a decimal place you could never compute at the table anyway.',
      },
    ],
    keyTakeaways: [
      'Multiply your outs by two for one card to come and by four for two, as a fast estimate of the chance of hitting.',
      'It works because each unseen card is roughly one in fifty, and two cards to come are roughly twice the chance of one.',
      'With one card to come the estimate is slightly low; with many outs and two cards it runs high, because it double-counts hitting on both cards.',
      'The four-times figure assumes you see both cards for free, so compare a flop bet against the one-card figure when more betting is coming.',
      "Hitting is not winning: the shortcut says nothing about dirty outs or about your opponent's chance to draw out on you.",
      'Use the shortcut to tell whether a decision is close, and compute properly only when it is.',
    ],
    quizId: 'quiz-rule-of-2-and-4',
    glossaryTerms: [
      'rule-of-2-and-4',
      'outs',
      'clean-out',
      'dirty-out',
      'equity',
      'pot-odds',
      'break-even-equity',
      'flush-draw',
      'open-ended-straight-draw',
      'gutshot',
      'implied-odds',
    ],
  },
  {
    id: 'pot-odds',
    title: 'Pot odds: the price the pot is offering',
    summary:
      'A bet turns the pot into a price, and break-even equity is that same price rewritten as the share of the time you need to end up with the pot.',
    topic: 'pot-odds-and-ev',
    difficulty: 'core',
    estimatedMinutes: 10,
    prerequisites: ['betting-actions', 'counting-outs'],
    blocks: [
      {
        kind: 'prose',
        text: 'Every bet you face is a price. Someone has put units in the middle and told you what it costs to keep playing. Before you think about your cards at all, you can work out exactly what that price asks of you, because it is arithmetic on chips you can see. This is the one part of a poker decision with no guesswork in it, which is why it is the right place to start.',
      },
      {
        kind: 'heading',
        text: 'Two ways to write the same price',
      },
      {
        kind: 'prose',
        text: "The price can be written as a ratio or as a share. The ratio answers 'how much can I win compared with what I have to put in'. The share answers 'how often do I need to end up with this pot for calling to be no worse than folding'. They are one fact in two costumes. The ratio is easier to say out loud; the share is easier to compare against an equity estimate, which is what you actually want to do with it.",
      },
      {
        kind: 'formula',
        expression: 'pot odds as a ratio = (units in the pot, including their bet) : (units you must call)',
        explanation:
          "Read it as 'the pot is laying me X to one'. Notice that your cards appear nowhere in it. This is a statement about chips, not about your hand.",
      },
      {
        kind: 'formula',
        expression: 'break-even equity = call / (pot including their bet + call)',
        explanation:
          'If you call, you either take the whole middle - their bet, everything from earlier streets, and your own call coming back to you - or you lose the call. Calling breaks even when equity x (pot + call) = call, and solving for equity gives this fraction. It is the smallest share of the time you can end up with the pot without losing units by calling instead of folding.',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'potOdds',
          pot: 120,
          toCall: 60,
        },
        caption:
          'A pot-sized bet on the river: there were 60 in the middle, your opponent made it 60 more, so the pot stands at 120 and calling costs 60.',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'potOdds',
          pot: 90,
          toCall: 30,
        },
        caption:
          'A half-pot bet in the same spot: 60 in the middle, they bet 30, so the pot stands at 90 and calling costs 30.',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'potOdds',
          pot: 180,
          toCall: 120,
        },
        caption:
          'An overbet: 60 in the middle, they bet 120, so the pot stands at 180 and calling costs 120.',
      },
      {
        kind: 'prose',
        text: 'Look at what changed across those three calculators, and what did not. Your cards did not change. The board did not change. Only the size of the bet relative to the pot changed, and with it the share of the time you need to end up with the pot. That relationship is the entire mechanism by which bet sizing works: a size is a demand, and the bettor gets to choose how large a demand to make.',
      },
      {
        kind: 'callout',
        tone: 'insight',
        title: 'The price is only half of the comparison',
        text: 'Pot odds tell you what the pot demands. They cannot tell you whether you can supply it. The other half is equity, the share of the time you end up with the pot, and that depends entirely on what you assume your opponent can hold. Change the assumed range and the equity changes with it, so every comparison you make carries that assumption inside it whether you say so or not.',
      },
      {
        kind: 'heading',
        text: 'Putting the two halves together',
      },
      {
        kind: 'list',
        ordered: true,
        items: [
          'Work out the price from the chips. What share does the pot demand? This part is exact.',
          'Estimate your equity against a range you can actually defend, rather than against the single hand you fear or the single hand you hope for.',
          'Compare the two. If your estimated equity is above what the price demands, then under those assumptions calling gains units compared with folding.',
          "Say the assumption out loud. 'If they bet this way with every flush draw and every top pair' is a claim you can be wrong about, and the arithmetic inherits your error without complaint.",
        ],
      },
      {
        kind: 'callout',
        tone: 'misconception',
        title: "'I have a draw, so I have to call'",
        text: "A draw is not a licence. The price can be higher than the draw can pay, and no amount of wanting the card changes the fraction. The opposite error is just as common and less discussed: folding a hand whose equity comfortably clears a cheap price because the hand 'feels weak'. The arithmetic has no opinion about how your hand feels.",
      },
      {
        kind: 'heading',
        text: 'What the price leaves out',
      },
      {
        kind: 'prose',
        text: 'Break-even equity compares calling with folding, for the units on the table right now, assuming the hand stops after this call. Real hands have more streets and more options than that, so treat the comparison as a floor to reason from rather than a verdict.',
      },
      {
        kind: 'list',
        items: [
          'Implied odds: units you may win on later streets if you get there. These make a call better than the immediate price suggests, but only to the extent those units are genuinely likely to arrive - against an opponent who shuts down when the scary card lands, they may not.',
          'Reverse implied odds: hands that improve into second best. Making your draw and still losing is the most expensive way to be right about your outs.',
          'Raising: the comparison above was call against fold. Sometimes a raise beats both, and pot odds will never tell you so, because a raise changes the price instead of paying it.',
          'Extra players: each additional caller changes both the price and what you have to beat, usually in opposite directions.',
          'Position: the same equity is easier to convert into units when you act last, which is a real effect that no pot-odds fraction contains.',
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Numbers borrow their confidence from their assumptions',
        text: 'A break-even figure is exact arithmetic on units you can count. An equity figure is an estimate against a range you guessed at. Reporting the second with the precision of the first is the most common way an honest calculation turns into a misleading one. Whenever this app shows you an equity number, it shows you the range it used beside it, for exactly this reason.',
      },
    ],
    keyTakeaways: [
      'A bet turns the pot into a price, and that price can be read either as a ratio or as the share of the time you need to end up with the pot.',
      'Break-even equity is the call divided by the pot after your call, because your own call is part of what you take down when you win.',
      'Larger bets relative to the pot demand a larger share, and smaller bets demand less, which is why sizing is a lever rather than a habit.',
      'The price is exact; your equity is an estimate that depends on the range you assume, so state the assumption whenever you state the conclusion.',
      'Pot odds compare calling with folding only. Implied odds, reverse implied odds, raising, extra players and position all sit outside the fraction.',
    ],
    quizId: 'quiz-pot-odds',
    glossaryTerms: ['pot-odds', 'break-even-equity', 'equity', 'implied-odds', 'reverse-implied-odds'],
  },
  {
    id: 'expected-value',
    title: 'Expected value: what a decision is worth',
    summary:
      'EV is the average result of a decision repeated for ever, computed per decision rather than per hand, which is why a hand that is losing can still be a call worth making.',
    topic: 'pot-odds-and-ev',
    difficulty: 'core',
    estimatedMinutes: 11,
    prerequisites: ['pot-odds'],
    blocks: [
      {
        kind: 'prose',
        text: 'Expected value is the average result of a decision, if you could make that same decision under the same conditions over and over again. It is not a prediction about this hand. It is a way of ranking the options in front of you by what they gain on average, so that you can choose between them for a reason instead of by feel.',
      },
      {
        kind: 'heading',
        text: 'How it is computed',
      },
      {
        kind: 'formula',
        expression: 'EV = sum over outcomes of (how often that outcome happens x units won or lost in it)',
        explanation:
          'That is the whole definition, and it is not specific to poker. Every outcome, weighted by its frequency. The difficulty in poker is never the sum; it is knowing the frequencies.',
      },
      {
        kind: 'formula',
        expression: 'EV of calling = equity x (pot + call) - call',
        explanation:
          'Equivalently, equity x pot - (1 - equity) x call: you win the middle plus your own call when you get there, and you lose the call when you do not. Set this to zero and you recover break-even equity from the previous lesson, which is a good sign - the two ideas are the same arithmetic asked in different directions.',
      },
      {
        kind: 'heading',
        text: 'Zero has to mean something',
      },
      {
        kind: 'prose',
        text: 'Every EV is a comparison, so it needs a baseline, and folding is the natural zero. The units already in the middle are not yours: you neither win nor lose them by folding. Units you put in on earlier streets are in the same position. They belong to the pot now, and no decision you make can bring them back to you except by winning the pot outright.',
      },
      {
        kind: 'callout',
        tone: 'misconception',
        title: "'I have already put a third of my stack in, so I am committed'",
        text: 'This reverses the logic. Past investment cannot obligate a future call, because the past units are gone either way. What past investment does do is change the price: a bigger pot lowers the share you need, which sometimes makes continuing correct for a reason that has nothing to do with commitment. Same conclusion occasionally, completely different reasoning - and the reasoning is the part that transfers to the next hand.',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'callEv',
          pot: 120,
          toCall: 40,
          equity: 0.4,
        },
        caption:
          'The pot stands at 120 including their bet, calling costs 40, and we are assuming that against the range we have put them on we end up with the pot 40 times in 100. The equity here is an assumption, stated so you can argue with it.',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'callEv',
          pot: 80,
          toCall: 40,
          equity: 0.2,
        },
        caption:
          'A smaller pot, a bigger bet relative to it, and a hand that gets there only 20 times in 100. The sign of the answer is the point of this one.',
      },
      {
        kind: 'heading',
        text: 'Why a hand that is behind can be a call worth making',
      },
      {
        kind: 'prose',
        text: "Being behind and having a profitable call are not in conflict, because they answer different questions. 'Behind' describes who would win if the hand stopped this instant. The call describes whether a price is worth paying. If the pot is asking for roughly a quarter and your hand delivers roughly a third, then calling gains units even though the hand loses far more often than it wins. You will lose most of those pots and still be glad you called all of them.",
      },
      {
        kind: 'prose',
        text: "This is the single most useful thing EV does for you: it separates 'am I winning right now' from 'is this a good decision'. Most of the frustration people feel at a poker table comes from having only the first question available.",
      },
      {
        kind: 'callout',
        tone: 'insight',
        title: 'EV is per decision, not per hand',
        text: 'A hand is a chain of decisions, and they are scored separately. You can play the flop well and the river badly, or reach an excellent spot and hand the units straight back. Reviewing a hand means grading each decision against the information you had at the time, in the order you had it. Grading the hand by how it finished mixes together decisions you made and cards you did not choose.',
      },
      {
        kind: 'heading',
        text: 'What EV is not',
      },
      {
        kind: 'list',
        items: [
          'It is not a promise. A call that gains units on average can lose ten times in a row without anything being wrong with the calculation.',
          'It is not exact. The pot and the bet are exact; the equity is an estimate against an assumed range, and the EV inherits every bit of that uncertainty.',
          'It is not a ranking of your options unless you compute all of them. Comparing call with fold tells you nothing whatsoever about raise.',
          'It is not a measure of how well you played, once the result arrives. Results are the noisiest evidence available to you, which is the subject of the variance lesson.',
          'It is not a moral judgement. A decision with lower EV that you understand is often worth more to you than a higher-EV one you copied.',
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'The units here are counters, nothing more',
        text: 'In this lab chips are free, resettable and worth nothing at all: they cannot be bought, transferred or redeemed. That is precisely why it is a good place to practise a decision rule. You can be wrong at no cost and repeat the same spot until the reasoning is yours, which is not available anywhere the stakes are real.',
      },
    ],
    keyTakeaways: [
      'EV is the average result of a decision over many repetitions, weighting every outcome by how often it happens.',
      'Folding is the zero point, because units already in the pot are not yours and cannot be lost by folding.',
      'Setting the EV of a call to zero gives back break-even equity, so pot odds and EV are one idea approached from two directions.',
      'A hand that is behind can still be a call that gains units, because the question is whether your equity clears the price, not whether you are ahead.',
      'EV grades decisions, not results, and it is only as reliable as the range assumption used to estimate equity.',
    ],
    quizId: 'quiz-expected-value',
    glossaryTerms: ['expected-value', 'break-even-equity', 'equity', 'pot-odds', 'variance'],
  },
  {
    id: 'fold-equity',
    title: 'Fold equity: a bet that can win twice',
    summary:
      'Betting can profit two different ways - they fold now, or you improve later - and a semi-bluff is the hand that collects from both at once.',
    topic: 'fold-equity-and-bluffing',
    difficulty: 'core',
    estimatedMinutes: 11,
    prerequisites: ['pot-odds', 'expected-value'],
    blocks: [
      {
        kind: 'prose',
        text: 'When you call, there is exactly one way to win: hold the better hand at the end. When you bet, there are two. Your opponent can fold, and you take the pot with no showdown at all; or they can call, and you can still get there. Fold equity is the name for the first of those paths, and adding it to the second is what makes betting a genuinely different action rather than a louder call.',
      },
      {
        kind: 'formula',
        expression: 'EV of betting = f x pot + (1 - f) x [e x (pot + bet) - (1 - e) x bet]',
        explanation:
          'Here f is how often they fold and e is your equity when they do not. The first term is the pot you collect when they give up. The second is the showdown you have bought, weighted by how often you have to play it. The formula assumes the hand ends after this bet, which keeps it readable at the cost of ignoring later streets.',
      },
      {
        kind: 'heading',
        text: 'Two consequences worth more than the formula',
      },
      {
        kind: 'list',
        items: [
          'A hand with no chance of improving can still be a profitable bet, if it folds them out often enough. That is a pure bluff, and its break-even point is a fold frequency rather than an equity.',
          'A hand with a draw collects from both terms at once. That is a semi-bluff, and it is why the very same hand at the very same price can be a poor call and a good bet.',
        ],
      },
      {
        kind: 'callout',
        tone: 'insight',
        title: 'The same hand, two different questions',
        text: "Calling asks 'is my equity above the price?'. Betting asks 'do the folds I win plus the showdowns I win add up to more than the units I am risking?'. A flush draw facing a large bet can fail the first test and pass the second, because betting collects pots that calling can never collect. Noticing that the two questions are different is most of the skill here.",
      },
      {
        kind: 'formula',
        expression: 'break-even fold frequency for a pure bluff = bet / (pot + bet)',
        explanation:
          'The same shape as break-even equity, with your bet in the place of their call. This quantity is usually called alpha. Bet larger and you need folds more often; bet smaller and you need them less often but collect less each time. Its complement, the pot divided by pot plus bet, is how often the player facing the bet has to continue for your bluffs not to be free - the minimum defence frequency, which is a property of a whole strategy and not an instruction about any one hand.',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'foldEquity',
          pot: 100,
          betSize: 50,
          foldProbability: 0.5,
          equityWhenCalled: 0.3,
        },
        caption:
          'A semi-bluff: the pot is 100, you bet 50, we assume they fold half the time, and we assume that when they call you end up with the pot 30 times in 100.',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'foldEquity',
          pot: 100,
          betSize: 50,
          foldProbability: 0.2,
          equityWhenCalled: 0.3,
        },
        caption:
          'The identical bet with the identical cards, against a player who folds far less often. Nothing about your hand changed between these two calculators; only a claim about a person did.',
      },
      {
        kind: 'heading',
        text: 'The honest part: you are guessing about a human being',
      },
      {
        kind: 'prose',
        text: 'Look at what goes into that formula. The pot is a fact. Your bet size is your choice. Your equity when called is an estimate against an assumed range, which is uncertain but at least it is arithmetic. The fold frequency is something else entirely: a claim about how a particular person will react to a particular bet. You cannot look it up, and you will not measure it in an evening.',
      },
      {
        kind: 'prose',
        text: 'The habit that follows is to compute the decision twice, once with a pessimistic fold estimate and once with an optimistic one, and see whether the conclusion survives both. If it does, you have a bet. If it flips, you have learned something more useful than an answer: your play is a read rather than a calculation, and it is worth saying so out loud, to yourself, in those words.',
      },
      {
        kind: 'callout',
        tone: 'misconception',
        title: "'Bluffing is about nerve'",
        text: 'The chips have no way of knowing whether you were brave. A bet either has enough fold equity plus enough real equity to justify itself against the range that continues, or it does not. Choosing bluffs by mood produces the two classic errors in a matched pair: bluffing at the player who never folds, and never bluffing at the player who folds to everything.',
      },
      {
        kind: 'heading',
        text: 'Ask which hands fold, not how often',
      },
      {
        kind: 'prose',
        text: 'A fold percentage is a summary of something far more concrete: which of their holdings can pass, and which cannot. Working upwards from their holdings to a frequency is much more reliable than picking a percentage out of the air, and it keeps you honest about the board. A bet that only folds hands you were already beating has bought you very little. A bet that folds hands with real equity against you has bought you a great deal, even when it gets called some of the time.',
      },
      {
        kind: 'list',
        items: [
          'Board texture: the same size gets far more folds on a board that misses their range than on one that hits it, because folding is easy when nothing connects.',
          'Position: a bet from the seat that acts last is harder to continue against, since they must act first again on the next street with no new information.',
          'Number of opponents: every one of them has to fold, so fold equity shrinks quickly in a multiway pot even when each individual is fold-prone.',
          "Blockers: holding a card that would have made their strongest continuing hand removes some of those combinations, which nudges the same bet's fold frequency upwards.",
          'Your own story: sizes and lines that are consistent with a strong hand fold more often, but only against opponents who are actually watching. Against those who are not, story is decoration.',
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Fold equity is not a licence either',
        text: 'The formula is happy to tell you that a bet is profitable given the fold frequency you fed it, and it has no way of knowing you were optimistic. If you find that every bet you consider is profitable, the estimate is doing the work rather than the situation, and the assumption is the thing to examine.',
      },
    ],
    keyTakeaways: [
      'A bet can profit two ways: folds now, and equity later. Calling only ever collects the second.',
      'A pure bluff breaks even at a fold frequency of bet divided by pot plus bet, so larger bluffs must work more often.',
      'A semi-bluff collects from both terms at once, which is why the same hand and price can favour betting while disfavouring calling.',
      'The fold frequency is a claim about a person, not a measurable constant, so test whether your conclusion survives both an optimistic and a pessimistic estimate.',
      'Board texture, position, the number of opponents and your blockers all move the real fold frequency, so reason from which hands can fold rather than from a percentage.',
    ],
    quizId: 'quiz-fold-equity',
    glossaryTerms: ['fold-equity', 'semi-bluff', 'bluff', 'alpha', 'minimum-defence-frequency'],
  },
  {
    id: 'stack-to-pot-ratio',
    title: 'Stack-to-pot ratio: why depth changes the hand',
    summary:
      'The same cards on the same board play completely differently depending on how much is behind relative to the pot, and preflop sizing is what chooses that ratio.',
    topic: 'bet-sizing-and-spr',
    difficulty: 'core',
    estimatedMinutes: 10,
    prerequisites: ['bet-sizing'],
    blocks: [
      {
        kind: 'prose',
        text: 'Two players, the same two cards, the same flop, and the hand plays out in two entirely different ways. Most of the time the reason is not psychological. It is the ratio between the units left behind and the units already in the middle, because that ratio decides how many decisions are still to come and how large they can be.',
      },
      {
        kind: 'formula',
        expression: 'SPR = effective stack / pot',
        explanation:
          'Measured at the start of a street, usually the flop. The effective stack is the smaller of the two stacks in play, because neither player can win or lose more than the shorter one holds. In a multiway pot there is one SPR per opponent, and the shortest of them usually drives what happens.',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'spr',
          effectiveStack: 20,
          pot: 20,
        },
        caption:
          'A raised and re-raised pot left 20 in the middle with only 20 behind. Count how many bets fit in what remains.',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'spr',
          effectiveStack: 260,
          pot: 20,
        },
        caption:
          'A quietly played pot: the same 20 in the middle, but the shorter stack still has 260 behind.',
      },
      {
        kind: 'heading',
        text: 'Low ratio: commitment is nearly decided already',
      },
      {
        kind: 'prose',
        text: 'When only about a pot-sized bet remains, the hand has collapsed into a single question: are you continuing or not? There is no room for your opponent to apply pressure over three streets, no room for them to represent much, and no room for a draw to be paid off if it arrives. Top pair is enough hand for that single decision far more often than it would be with deep stacks, not because it beats more hands than usual, but because there is not enough left behind for it to matter that it beats fewer.',
      },
      {
        kind: 'prose',
        text: 'Draws suffer at a low ratio for the mirror-image reason. A draw pays a price now for a payoff later, and the payoff is capped by what is behind. When almost nothing is behind, the implied odds that justify chasing have nowhere to come from, and the draw is left relying on the immediate price alone.',
      },
      {
        kind: 'heading',
        text: 'High ratio: one pair is fragile',
      },
      {
        kind: 'prose',
        text: 'When many pot-sized bets remain, that same top pair has to survive three streets of betting from a range that includes plenty of hands beating it, and the units behind are exactly what makes that expensive. The chips behind are simultaneously the payoff a draw is chasing and the pressure a made hand must withstand. Hands whose value comes from occasionally making something enormous gain as the ratio rises. So does position, because more streets means more decisions made with information.',
      },
      {
        kind: 'callout',
        tone: 'insight',
        title: 'The same hand, two different jobs',
        text: "At a low ratio, top pair is a hand you are happy to commit with. At a high ratio, it is a hand you would like to win a medium pot with and avoid a huge one. Neither statement is about the cards. Both are about how much is behind, which is why naming a hand's strength without naming the stack depth is answering half the question.",
      },
      {
        kind: 'heading',
        text: 'You choose the ratio before the flop',
      },
      {
        kind: 'prose',
        text: 'SPR is not handed to you. It is the result of how large the preflop pot became relative to the stacks, and that is decided by raise sizes and by how many players came along. Raising more before the flop lowers the ratio and makes postflop decisions simpler and more mechanical. Keeping the pot small raises the ratio and leaves more decisions to be made, which is an advantage if you would rather be the one making them.',
      },
      {
        kind: 'prose',
        text: 'Neither choice is universally better, and anyone who tells you otherwise has skipped over the assumptions. Under the assumption that you would rather commit with a strong pair than navigate three streets, a lower ratio serves you. Under the assumption that you can out-decide your opponent on later streets, a higher one does. The point is that you get to pick which game you play, and you pick it before the flop.',
      },
      {
        kind: 'list',
        items: [
          'The effective stack is the smaller stack, so against a short stack you are in a low-ratio pot no matter how deep you are.',
          'A low ratio rewards hands that make a strong pair and punishes hands that need a lot behind to get paid.',
          'A high ratio rewards implied odds, position, and the willingness to fold a made hand when the story stops making sense.',
          'Every extra preflop caller shrinks the ratio, because the pot grows while the stacks do not.',
          'Antes and forced bets do the same thing more slowly, which is why the same chip count is deep in one blind level and short in another.',
        ],
      },
      {
        kind: 'callout',
        tone: 'misconception',
        title: "'Top pair is a strong hand'",
        text: 'It is a strong hand at some depths and a marginal one at others, and it is the same two cards in both cases. If you catch yourself ranking hands without reference to what is behind, you are ranking them for a game that does not exist.',
      },
    ],
    keyTakeaways: [
      'SPR is the effective stack divided by the pot, and the effective stack is always the smaller of the two.',
      'At a low ratio the hand becomes one commitment decision, which makes strong pairs comfortable and draws poorly paid.',
      'At a high ratio one pair must survive several streets of pressure, which favours implied odds, position and the ability to fold.',
      'Preflop raise sizing and the number of callers choose the ratio, so you are selecting which postflop game to play before you see the flop.',
      "A hand's strength cannot be stated without stating the stack depth it is being judged at.",
    ],
    quizId: 'quiz-stack-to-pot-ratio',
    glossaryTerms: ['spr', 'effective-stack', 'implied-odds', 'equity-realisation', 'pot-odds'],
  },
  {
    id: 'sample-size-and-risk-of-ruin',
    title: 'Sample size and risk of ruin',
    summary:
      'How many hands it takes before results mean anything, and how bankroll, edge and variance combine to decide whether a bad stretch ends the experiment.',
    topic: 'variance-and-bankroll',
    difficulty: 'advanced',
    estimatedMinutes: 12,
    prerequisites: ['variance'],
    blocks: [
      {
        kind: 'prose',
        text: 'Two questions look separate and turn out to be one. How many hands before my results mean anything? And how large a buffer do I need so that a bad stretch does not end the experiment before the answer arrives? Both are settled by comparing the size of an edge with the size of the noise around it, and both answers are less comfortable than people expect.',
      },
      {
        kind: 'heading',
        text: "Why the honest answer is 'more hands than you think'",
      },
      {
        kind: 'formula',
        expression:
          'width of the uncertainty around a win rate is proportional to standard deviation / square root of (hands / 100)',
        explanation:
          'The square root is the entire story. To halve your uncertainty you need four times the hands; to divide it by ten you need a hundred times as many. Your edge, meanwhile, does not grow at all, so the ratio of signal to noise improves painfully slowly.',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'variance',
          winRateBbPer100: 3,
          standardDeviationBbPer100: 90,
          hands: 20000,
        },
        caption:
          "A modest assumed edge against a typical assumed standard deviation, over a sample many players would call meaningful. Read the bounds as 'what an ordinary result could look like'.",
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'variance',
          winRateBbPer100: 3,
          standardDeviationBbPer100: 90,
          hands: 500000,
        },
        caption:
          'The same assumptions over a sample most players never reach. It is worth looking at these bounds before trusting any win-rate claim, including your own.',
      },
      {
        kind: 'callout',
        tone: 'misconception',
        title: "'I have twenty thousand hands, so I know my win rate'",
        text: "You know an interval, and at that length the interval is usually wide enough to hold both a decent winner and a loser. Quoting the midpoint as a fact throws away the part of the measurement that was doing the honest work. The correct sentence is longer and much less quotable: 'my results are consistent with anything between these two numbers'.",
      },
      {
        kind: 'heading',
        text: 'Risk of ruin',
      },
      {
        kind: 'prose',
        text: 'Now the second question. Suppose you play a game with a genuinely positive edge, staking a fixed amount, and you keep going until either the bankroll is gone or it grows without bound. There is a standard model for how often the first ending happens, and its shape teaches more than its output does.',
      },
      {
        kind: 'formula',
        expression:
          'risk of ruin is approximately e^(-2 x win rate x bankroll / standard deviation^2), with the bankroll in big blinds and both rates per 100 hands',
        explanation:
          'Three features matter more than the formula: risk falls exponentially as the bankroll grows, it falls exponentially as the edge grows, and it rises with the standard deviation, which enters the exponent squared. That squaring is why the standard deviation has more leverage than the other two, though the risk itself does not scale as its square — it cannot, being a probability. Double the standard deviation in the calculator below and watch what the risk actually does.',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'riskOfRuin',
          bankrollBb: 1000,
          winRateBbPer100: 3,
          standardDeviationBbPer100: 90,
        },
        caption:
          "A real edge and a bankroll that sounds substantial when you say it out loud. The model's answer tends to surprise people the first time they see it.",
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'riskOfRuin',
          bankrollBb: 3000,
          winRateBbPer100: 3,
          standardDeviationBbPer100: 90,
        },
        caption: 'Three times the bankroll, with the same edge and the same variance.',
      },
      {
        kind: 'liveCalculation',
        calculation: {
          kind: 'riskOfRuin',
          bankrollBb: 1000,
          winRateBbPer100: 9,
          standardDeviationBbPer100: 90,
        },
        caption:
          'Back to the smaller bankroll, with three times the edge instead. It lands in the same place as tripling the bankroll did, because bankroll and win rate enter the exponent in exactly the same way.',
      },
      {
        kind: 'prose',
        text: 'That last pair of calculators is the most useful thing on this page. Tripling your edge and tripling your buffer buy you the same reduction in risk, so a player who cannot easily do the first can always do the second. And because the standard deviation is squared, choosing a lower-variance game does more for your survival than either, which is an unglamorous conclusion that most people would rather not reach.',
      },
      {
        kind: 'heading',
        text: 'What the model assumes, and why that matters more than its answer',
      },
      {
        kind: 'list',
        items: [
          'A fixed win rate. Yours is not fixed: it moves with the games you sit in, your concentration, and what you have recently learned.',
          'Independent results with a normal shape. Poker results have fatter tails than a normal curve, because the biggest pots are much bigger than average, and fat tails make this model optimistic.',
          'No change of stakes, ever. Moving up when ahead and down when behind changes the problem completely, and mechanically doing so is one of the few genuinely free improvements available.',
          'A player who does not tilt. There is no term in the formula for the decisions you make after a bad hour, and those are usually the expensive ones.',
          "Playing for ever. 'Ruin before unbounded growth' is mathematically convenient and nobody's actual objective, which is worth remembering before quoting the output as a plan.",
        ],
      },
      {
        kind: 'callout',
        tone: 'warning',
        title: 'This is a model of risk, not advice about money',
        text: 'Nothing in this lab involves money, deposits, prizes or anything that can be cashed out; the units are free and you can reset them whenever you like. Risk of ruin is taught here because it is the clearest example of a general truth: when an activity has a small edge and large swings, the size of the buffer you need is set by the swings rather than by the edge. That pattern shows up in plenty of decisions that have nothing to do with cards.',
      },
      {
        kind: 'heading',
        text: 'Putting the two together',
      },
      {
        kind: 'prose',
        text: 'Sample size tells you how long you must wait before results become evidence. Risk of ruin tells you how large a buffer that wait requires. The uncomfortable part is that they point the same way: the noisier the game, the longer the wait and the bigger the buffer, both at once. The practical response is not to play faster. It is to make the edge larger and the swings smaller where you can, and to judge yourself on decisions in the meantime, because decisions are the only signal that arrives quickly enough to learn from.',
      },
    ],
    keyTakeaways: [
      'Uncertainty about a win rate shrinks with the square root of the number of hands, so cutting it in half takes four times as many hands.',
      'Samples in the tens of thousands of hands usually leave an interval wide enough to contain both a winner and a loser, so the midpoint alone is not a result.',
      'Risk of ruin falls exponentially with bankroll and with edge, and rises with the square of the standard deviation, which makes variance the dominant term.',
      'Tripling the edge and tripling the bankroll reduce risk of ruin identically, so the buffer is the lever available to everyone.',
      'The model assumes a fixed edge, normal results, unchanged stakes, no tilt and infinite play, and those assumptions do not all point the same way. Fat tails and tilt make the real risk higher than the number shown; moving down when the bankroll shrinks, and playing a finite stretch rather than for ever, both make it lower.',
    ],
    quizId: 'quiz-sample-size-and-risk-of-ruin',
    glossaryTerms: ['sample-size', 'risk-of-ruin', 'bankroll', 'standard-deviation', 'variance'],
  },
];
