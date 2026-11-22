/**
 * The tips `apps/web` attaches, held to the same one-sentence rule as `UI_TIPS` by the same check
 * (`test/tips-copy.test.ts`). Keyed by what they sit beside.
 */

import type { TipCopy } from '@prl/ui/tips';

export const WEB_TIPS = {
  labTopic: {
    term: 'the topic',
    text: 'The idea a scenario practises, such as pot odds or reading a hand.',
  },
  labDifficulty: {
    term: 'the difficulty',
    text: 'How much a scenario expects you to know already, from Intro up to Advanced.',
  },
  labStreet: {
    term: 'the street',
    text: 'The betting round the decision is on, from preflop before any shared cards up to the river.',
  },
  legendSetting: {
    term: 'the opponent setting',
    text: 'It changes how the bot plays and whether the Coach can help you during the hand.',
  },
  reviewOrder: {
    term: 'the order',
    text: 'Choose which hands come first, such as your newest or the one with the biggest pot.',
  },
} as const satisfies Readonly<Record<string, TipCopy>>;
