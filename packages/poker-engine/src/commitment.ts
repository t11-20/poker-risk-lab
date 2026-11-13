/**
 * Deck commitment as a per-card Merkle tree. Hashing the whole deck would reveal all 52 cards at the
 * end, including folded hands, so each position is its own leaf and only public cards are revealed.
 *
 *     leaf(i) = SHA256( 0x00 ‖ domain ‖ len(context) ‖ context ‖ i ‖ salt_i ‖ card_i )
 *     node    = SHA256( 0x01 ‖ left ‖ right )
 *
 * 52 leaves are padded to 64 with card-free leaves. The root is published before any action. After
 * the hand each public card is revealed with its salt and six sibling hashes. This proves each
 * revealed card sat at that position before the first action. It does not prove the deck was chosen
 * fairly, since the server could grind decks (accepted risk, docs/THREAT-MODEL.md).
 *
 * The 32-byte per-card salt stops brute-forcing a leaf's 52 possible values. The 0x00/0x01 prefixes
 * stop an internal node passing as a leaf (second-preimage attack).
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

export interface DeckCommitment {
  readonly algorithm: 'sha256';
  readonly version: typeof COMMITMENT_VERSION;
  /** Hex Merkle root over all 64 leaves. */
  readonly root: string;
  /** Binds the commitment to one hand, so it cannot be replayed for another. */
  readonly context: string;
}

/** Server-side only. Redaction strips it. */
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
  /** True only for an explicit end-of-session full reveal, never a hand result. */
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

/** Builds a reveal for exactly the given positions. `machine.ts` decides which are public. */
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

/** Verifies a reveal against its published root. The web app runs this so a player can check the deal. */
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
    // A reveal that shows one card at two positions is invalid whatever the hashes say.
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
