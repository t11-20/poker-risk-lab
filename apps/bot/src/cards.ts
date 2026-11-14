import { parseCards } from '@prl/poker-engine';
import { cardsText } from './view.ts';

/**
 * Two or more cards, joined or one space apart. A lone token is left alone because "As" and "Ah" are
 * English words, and the alphanumeric guards keep range notation ("AKs", "T9s") whole.
 */
const CARD_RUN = /(?<![A-Za-z0-9])[2-9TJQKA][shdc](?: ?[2-9TJQKA][shdc])+(?![A-Za-z0-9])/g;

/** Shared text writes cards as "7s2d". The table shows "7♠ 2♦", so a learner reads one notation. */
export function cardNotationText(text: string): string {
  return text.replace(CARD_RUN, (run) => cardsText(parseCards(run)));
}
