/**
 * Deck commitment: a per-card Merkle tree.
 *
 * ## Why not simply hash the deck?
 *
 * The obvious scheme is `commitment = SHA256(salt || deck)`, published before the
 * deal and revealed afterwards so anyone can recompute it. It was the first design
 * here, and a hidden-information test killed it: revealing the deck reveals *all
 * 52 cards*, including the hole cards of players who folded and never showed.
 * Whether an opponent folded a bluff or a monster is exactly the information poker
 * is played over, and handing it out at the end of every hand would be a far worse
 * leak than the one the commitment was added to prevent.
 *
 * ## The scheme
 *
 * Each of the 52 deck positions becomes one Merkle leaf:
 *
 *     leaf(i) = SHA256( 0x00 ‖ domain ‖ len(context) ‖ context ‖ i ‖ salt_i ‖ card_i )
 *
 * with an independent 32-byte random `salt_i` per position. The tree is padded to
 * 64 leaves with card-free padding leaves, and internal nodes are
 *
 *     node = SHA256( 0x01 ‖ left ‖ right )
 *
 * The Merkle **root** is published before any player acts. Afterwards the server
 * reveals a leaf — position, card, salt and the six sibling hashes — for each card
 * that legitimately became public: every board card, and the hole cards of players
 * who actually showed at showdown. Every other leaf stays sealed.
 *
 * ## What this proves
 *
 * For each revealed card: it sat at that exact deck position, and it was fixed
 * before the first action. A server that re-ordered undealt cards mid-hand to hit
 * a draw, break a cooler, or protect a bot could not produce a valid proof.
 *
 * ## What it does not prove
 *
 * That the deck was *chosen* fairly. The server generates both deck and salts, so
 * a dishonest one could grind candidate decks and commit to a favourable one
 * before dealing. Ruling that out needs entropy the server cannot predict — a
 * multi-party commit-reveal where each player contributes a committed nonce. That
 * is out of scope and recorded as an accepted risk in docs/THREAT-MODEL.md rather
 * than papered over.
 *
 * ## Why the per-card salt is load-bearing
 *
 * A card is one of 52 values. Without a salt, `SHA256(i ‖ card)` has 52 possible
 * values per position and is trivially brute-forced, so an unrevealed leaf would
 * leak its card to anyone with the root. The 32-byte salt makes each leaf
 * preimage-infeasible.
 *
 * ## Why leaf and node hashes are domain-separated
 *
 * Prefixing leaves with `0x00` and internal nodes with `0x01` prevents a
 * second-preimage attack in which an internal node is passed off as a leaf, which
 * is a known weakness of naive Merkle constructions.
 */

import { createHash } from 'node:crypto';
import { type Card, DECK_SIZE } from './cards.ts';

export class CommitmentError extends Error {
  override readonly name = 'CommitmentError';
}

export const COMMITMENT_VERSION = 'prl-deck-v2';
export const SALT_BYTES = 32;
/** 52 real leaves padded to the next power of two. */
export const LEAF_COUNT = 64;
export const PROOF_LENGTH = 6;

const LEAF_TAG = 0x00;
const NODE_TAG = 0x01;
const PAD_TAG = 0x02;

/** Published before the first action of the hand. */
export interface DeckCommitment {
  readonly algorithm: 'sha256';
  readonly version: typeof COMMITMENT_VERSION;
  /** Hex Merkle root over all 64 leaves. */
  readonly root: string;
  /** Binds the commitment to one hand, so it cannot be replayed for another. */
  readonly context: string;
}

/** Server-side only. Never leaves the process; redaction strips it. */
export interface DeckSecret {
  readonly deck: readonly Card[];
  /** One 32-byte salt per deck position, concatenated: 52 × 32 bytes. */
  readonly salts: Uint8Array;
}

/** One card's proof that it occupied a given deck position. */
export interface RevealedCard {
  /** Position in the deck, 0-based, in deal order. */
  readonly index: number;
  readonly card: Card;
  readonly saltHex: string;
  /** Sibling hashes from the leaf upwards, hex. */
  readonly proof: readonly string[];
}

/** Published after the hand, covering only cards that legitimately became public. */
export interface DeckReveal {
  readonly commitment: DeckCommitment;
  readonly cards: readonly RevealedCard[];
  /**
   * True when every deck position was revealed. Only ever set by an explicit
   * end-of-session full reveal, never by a hand result.
   */
  readonly complete: boolean;
}

export interface RevealVerification {
  readonly ok: boolean;
  readonly reason?: string;
  /** Deck positions whose proofs checked out. */
  readonly verifiedIndices: readonly number[];
}

function contextBytes(context: string): Buffer {
  const bytes = Buffer.from(context, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function indexBytes(index: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(index, 0);
  return bytes;
}

const DOMAIN = Buffer.from(COMMITMENT_VERSION, 'utf8');

export function leafHash(context: string, index: number, salt: Uint8Array, card: Card): Buffer {
  if (salt.length !== SALT_BYTES)
    throw new CommitmentError(`salt must be ${SALT_BYTES} bytes, got ${salt.length}`);
  if (!Number.isInteger(card) || card < 0 || card >= DECK_SIZE) {
    throw new CommitmentError(`invalid card id ${card}`);
  }
  return createHash('sha256')
    .update(Buffer.from([LEAF_TAG]))
    .update(DOMAIN)
    .update(contextBytes(context))
    .update(indexBytes(index))
    .update(Buffer.from(salt))
    .update(Buffer.from([card]))
    .digest();
}

function paddingLeafHash(context: string, index: number): Buffer {
  return createHash('sha256')
    .update(Buffer.from([PAD_TAG]))
    .update(DOMAIN)
    .update(contextBytes(context))
    .update(indexBytes(index))
    .digest();
}

function nodeHash(left: Buffer, right: Buffer): Buffer {
  return createHash('sha256')
    .update(Buffer.from([NODE_TAG]))
    .update(left)
    .update(right)
    .digest();
}

function saltAt(salts: Uint8Array, index: number): Uint8Array {
  const start = index * SALT_BYTES;
  if (start + SALT_BYTES > salts.length) throw new CommitmentError(`no salt for deck position ${index}`);
  return salts.subarray(start, start + SALT_BYTES);
}

/** All 64 leaf hashes, in position order. */
function buildLeaves(context: string, deck: readonly Card[], salts: Uint8Array): Buffer[] {
  if (deck.length !== DECK_SIZE)
    throw new CommitmentError(`deck must have ${DECK_SIZE} cards, got ${deck.length}`);
  const leaves: Buffer[] = [];
  for (let index = 0; index < DECK_SIZE; index++) {
    const card = deck[index];
    if (card === undefined) throw new CommitmentError(`deck position ${index} is empty`);
    leaves.push(leafHash(context, index, saltAt(salts, index), card));
  }
  for (let index = DECK_SIZE; index < LEAF_COUNT; index++) {
    leaves.push(paddingLeafHash(context, index));
  }
  return leaves;
}

/** Every level of the tree, level 0 being the leaves. */
function buildLevels(leaves: readonly Buffer[]): Buffer[][] {
  const levels: Buffer[][] = [[...leaves]];
  let current = levels[0];
  while (current !== undefined && current.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1];
      if (left === undefined || right === undefined) throw new CommitmentError('unbalanced Merkle level');
      next.push(nodeHash(left, right));
    }
    levels.push(next);
    current = next;
  }
  return levels;
}

/** Sibling hashes from the leaf upwards. */
function buildProof(levels: readonly Buffer[][], leafIndex: number): string[] {
  const proof: string[] = [];
  let index = leafIndex;
  for (let level = 0; level < levels.length - 1; level++) {
    const nodes = levels[level];
    if (nodes === undefined) throw new CommitmentError(`missing Merkle level ${level}`);
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    const sibling = nodes[siblingIndex];
    if (sibling === undefined)
      throw new CommitmentError(`missing sibling at level ${level} index ${siblingIndex}`);
    proof.push(sibling.toString('hex'));
    index = Math.floor(index / 2);
  }
  return proof;
}

export interface CommittedDeck {
  readonly commitment: DeckCommitment;
  readonly secret: DeckSecret;
}

/** Commits to a deck. Call before dealing a single card. */
export function commitToDeckOrder(context: string, deck: readonly Card[], salts: Uint8Array): CommittedDeck {
  if (context === '') throw new CommitmentError('commitment context must not be empty');
  if (salts.length !== DECK_SIZE * SALT_BYTES) {
    throw new CommitmentError(`salts must be ${DECK_SIZE * SALT_BYTES} bytes, got ${salts.length}`);
  }
  if (new Set(deck).size !== DECK_SIZE) {
    throw new CommitmentError('deck must be a permutation of 52 distinct cards');
  }
  const levels = buildLevels(buildLeaves(context, deck, salts));
  const root = levels[levels.length - 1]?.[0];
  if (root === undefined) throw new CommitmentError('failed to compute the Merkle root');
  return {
    commitment: { algorithm: 'sha256', version: COMMITMENT_VERSION, root: root.toString('hex'), context },
    secret: { deck: [...deck], salts: Uint8Array.from(salts) },
  };
}

/**
 * Builds a reveal for exactly the deck positions given.
 *
 * The caller decides which positions are public — see `machine.ts`, which reveals
 * board cards and the hole cards of seats that showed, and nothing else.
 */
export function revealPositions(
  commitment: DeckCommitment,
  secret: DeckSecret,
  positions: readonly number[],
): DeckReveal {
  const levels = buildLevels(buildLeaves(commitment.context, secret.deck, secret.salts));
  const unique = [...new Set(positions)].sort((a, b) => a - b);
  const cards: RevealedCard[] = unique.map((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= DECK_SIZE) {
      throw new CommitmentError(`cannot reveal invalid deck position ${index}`);
    }
    const card = secret.deck[index];
    if (card === undefined) throw new CommitmentError(`deck position ${index} is empty`);
    return {
      index,
      card,
      saltHex: Buffer.from(saltAt(secret.salts, index)).toString('hex'),
      proof: buildProof(levels, index),
    };
  });
  return { commitment, cards, complete: unique.length === DECK_SIZE };
}

/** Reveals every position. For end-of-session auditing, never for a live hand. */
export function revealEverything(commitment: DeckCommitment, secret: DeckSecret): DeckReveal {
  return revealPositions(
    commitment,
    secret,
    Array.from({ length: DECK_SIZE }, (_unused, index) => index),
  );
}

/**
 * Verifies a reveal against its published root. This is the client side of the
 * protocol: the web app runs exactly this function so a player can check the deal
 * themselves rather than taking the server's word for it.
 */
export function verifyDeckReveal(reveal: DeckReveal): RevealVerification {
  const { commitment } = reveal;
  if (commitment.version !== COMMITMENT_VERSION) {
    return { ok: false, reason: `unsupported commitment version ${commitment.version}`, verifiedIndices: [] };
  }
  if (commitment.algorithm !== 'sha256') {
    return { ok: false, reason: `unsupported algorithm ${commitment.algorithm}`, verifiedIndices: [] };
  }
  if (!/^[0-9a-f]{64}$/.test(commitment.root)) {
    return { ok: false, reason: 'root is not a 32-byte hex hash', verifiedIndices: [] };
  }

  const verified: number[] = [];
  const seenIndices = new Set<number>();
  const seenCards = new Set<Card>();

  for (const entry of reveal.cards) {
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= DECK_SIZE) {
      return { ok: false, reason: `invalid deck position ${entry.index}`, verifiedIndices: verified };
    }
    if (seenIndices.has(entry.index)) {
      return { ok: false, reason: `deck position ${entry.index} revealed twice`, verifiedIndices: verified };
    }
    seenIndices.add(entry.index);

    if (!Number.isInteger(entry.card) || entry.card < 0 || entry.card >= DECK_SIZE) {
      return { ok: false, reason: `invalid card id ${entry.card}`, verifiedIndices: verified };
    }
    // A deck cannot contain the same card twice, so a reveal that claims it does is
    // invalid regardless of whether the hashes happen to check out.
    if (seenCards.has(entry.card)) {
      return { ok: false, reason: `card ${entry.card} revealed at two positions`, verifiedIndices: verified };
    }
    seenCards.add(entry.card);

    if (!/^[0-9a-f]{64}$/.test(entry.saltHex)) {
      return {
        ok: false,
        reason: `salt for position ${entry.index} is not 32 hex bytes`,
        verifiedIndices: verified,
      };
    }
    if (entry.proof.length !== PROOF_LENGTH) {
      return {
        ok: false,
        reason: `proof for position ${entry.index} has ${entry.proof.length} hashes, expected ${PROOF_LENGTH}`,
        verifiedIndices: verified,
      };
    }
    if (!entry.proof.every((hash) => /^[0-9a-f]{64}$/.test(hash))) {
      return {
        ok: false,
        reason: `proof for position ${entry.index} is malformed`,
        verifiedIndices: verified,
      };
    }

    let hash = leafHash(commitment.context, entry.index, Buffer.from(entry.saltHex, 'hex'), entry.card);
    let index = entry.index;
    for (const siblingHex of entry.proof) {
      const sibling = Buffer.from(siblingHex, 'hex');
      hash = index % 2 === 0 ? nodeHash(hash, sibling) : nodeHash(sibling, hash);
      index = Math.floor(index / 2);
    }
    if (hash.toString('hex') !== commitment.root) {
      return {
        ok: false,
        reason: `position ${entry.index} does not prove against the published root`,
        verifiedIndices: verified,
      };
    }
    verified.push(entry.index);
  }

  return { ok: true, verifiedIndices: verified };
}
