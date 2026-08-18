import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DECK_SIZE, orderedDeck } from '../src/cards.ts';
import {
  COMMITMENT_VERSION,
  commitToDeckOrder,
  type DeckReveal,
  PROOF_LENGTH,
  revealEverything,
  revealPositions,
  SALT_BYTES,
  verifyDeckReveal,
} from '../src/commitment.ts';
import { commitToDeck, commitToKnownDeck, createSecureRandom, shuffledDeck } from '../src/rng.ts';

const random = createSecureRandom();

test('a commitment publishes only a root before the deal', () => {
  const { commitment } = commitToDeck('room_1:hand_1', random);
  assert.equal(commitment.version, COMMITMENT_VERSION);
  assert.equal(commitment.algorithm, 'sha256');
  assert.match(commitment.root, /^[0-9a-f]{64}$/);
  // The published object carries no salts, no deck and no card values at all.
  // Checked by key name rather than substring: the version string itself contains
  // the word "deck", so a naive substring check here would fail on nothing.
  assert.deepEqual(Object.keys(commitment).sort(), ['algorithm', 'context', 'root', 'version']);
  const serialised = JSON.stringify(commitment);
  assert.ok(!serialised.includes('"salts"'), 'the commitment must not carry salts');
  assert.ok(!serialised.includes('"deck"'), 'the commitment must not carry the deck');
});

test('a revealed position proves against the root', () => {
  const { commitment, secret } = commitToDeck('room_1:hand_1', random);
  const reveal = revealPositions(commitment, secret, [0, 1, 5, 51]);
  assert.equal(reveal.cards.length, 4);
  assert.equal(reveal.complete, false);
  for (const entry of reveal.cards) {
    assert.equal(entry.proof.length, PROOF_LENGTH);
    assert.equal(entry.saltHex.length, SALT_BYTES * 2);
    assert.equal(entry.card, secret.deck[entry.index]);
  }
  const verification = verifyDeckReveal(reveal);
  assert.equal(verification.ok, true, verification.reason);
  assert.deepEqual([...verification.verifiedIndices], [0, 1, 5, 51]);
});

test('a full reveal proves every position and is marked complete', () => {
  const { commitment, secret } = commitToDeck('room_1:hand_1', random);
  const reveal = revealEverything(commitment, secret);
  assert.equal(reveal.cards.length, DECK_SIZE);
  assert.equal(reveal.complete, true);
  const verification = verifyDeckReveal(reveal);
  assert.equal(verification.ok, true, verification.reason);
  assert.equal(verification.verifiedIndices.length, DECK_SIZE);
});

test('substituting a card at a revealed position fails verification', () => {
  const { commitment, secret } = commitToDeck('room_1:hand_1', random);
  const reveal = revealPositions(commitment, secret, [0, 1, 2]);
  const first = reveal.cards[0];
  assert.ok(first !== undefined);
  // This is the attack the commitment exists to catch: the server claims a
  // different card sat at a position after seeing how the hand played out.
  const substituted: DeckReveal = {
    ...reveal,
    cards: [{ ...first, card: (first.card + 1) % DECK_SIZE }, ...reveal.cards.slice(1)],
  };
  const verification = verifyDeckReveal(substituted);
  assert.equal(verification.ok, false);
  assert.match(String(verification.reason), /does not prove against the published root|two positions/);
});

test('moving a card to a different position fails verification', () => {
  const { commitment, secret } = commitToDeck('room_1:hand_1', random);
  const reveal = revealPositions(commitment, secret, [10]);
  const entry = reveal.cards[0];
  assert.ok(entry !== undefined);
  const moved: DeckReveal = { ...reveal, cards: [{ ...entry, index: 11 }] };
  assert.equal(verifyDeckReveal(moved).ok, false, 'the index is bound into the leaf hash');
});

test('a tampered salt fails verification', () => {
  const { commitment, secret } = commitToDeck('room_1:hand_1', random);
  const reveal = revealPositions(commitment, secret, [3]);
  const entry = reveal.cards[0];
  assert.ok(entry !== undefined);
  const bytes = Buffer.from(entry.saltHex, 'hex');
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  const tampered: DeckReveal = {
    ...reveal,
    cards: [{ ...entry, saltHex: bytes.toString('hex') }],
  };
  assert.equal(verifyDeckReveal(tampered).ok, false);
});

test('a tampered proof path fails verification', () => {
  const { commitment, secret } = commitToDeck('room_1:hand_1', random);
  const reveal = revealPositions(commitment, secret, [7]);
  const entry = reveal.cards[0];
  assert.ok(entry !== undefined);
  const proof = [...entry.proof];
  proof[0] = 'f'.repeat(64);
  const tampered: DeckReveal = { ...reveal, cards: [{ ...entry, proof }] };
  assert.equal(verifyDeckReveal(tampered).ok, false);
});

test('a reveal cannot be replayed under a different context', () => {
  const { commitment, secret } = commitToDeck('room_1:hand_1', random);
  const reveal = revealPositions(commitment, secret, [0, 1]);
  // Same cards, salts and proofs, but claimed for a different hand. The context is
  // hashed into every leaf, so the root no longer matches.
  const replayed: DeckReveal = {
    ...reveal,
    commitment: { ...commitment, context: 'room_1:hand_2' },
  };
  assert.equal(verifyDeckReveal(replayed).ok, false);
});

test('two decks committed under the same context have different roots', () => {
  const a = commitToDeck('room_1:hand_1', random);
  const b = commitToDeck('room_1:hand_1', random);
  assert.notEqual(a.commitment.root, b.commitment.root, 'salts and order differ, so roots differ');
});

test('the same deck with different salts produces different roots', () => {
  const deck = shuffledDeck(random);
  const a = commitToDeckOrder('ctx', deck, random.bytes(DECK_SIZE * SALT_BYTES));
  const b = commitToDeckOrder('ctx', deck, random.bytes(DECK_SIZE * SALT_BYTES));
  assert.notEqual(a.commitment.root, b.commitment.root);
  // ...and both verify, so neither is malformed.
  assert.equal(verifyDeckReveal(revealEverything(a.commitment, a.secret)).ok, true);
  assert.equal(verifyDeckReveal(revealEverything(b.commitment, b.secret)).ok, true);
});

test('an unrevealed position leaks nothing about its card', () => {
  const { commitment, secret } = commitToDeck('room_1:hand_1', random);
  const reveal = revealPositions(commitment, secret, [0, 1]);
  const serialised = JSON.stringify(reveal);
  // Cards at positions 2..51 must be absent. Since card values are small integers
  // that collide with indices, check the structural claim instead: exactly the
  // requested positions appear, each with exactly one card.
  assert.deepEqual(
    reveal.cards.map((entry) => entry.index),
    [0, 1],
  );
  assert.ok(!serialised.includes('"deck"'));
  // A brute-force attacker knows the root and the 52 candidate cards per position.
  // The 32-byte salt is what makes each sealed leaf infeasible to test; assert it
  // is actually that long, since a short salt would silently break the property.
  for (const entry of reveal.cards) assert.equal(Buffer.from(entry.saltHex, 'hex').length, 32);
});

test('a reveal claiming the same card at two positions is rejected', () => {
  const { commitment, secret } = commitToDeck('room_1:hand_1', random);
  const reveal = revealPositions(commitment, secret, [0, 1]);
  const [first, second] = reveal.cards;
  assert.ok(first !== undefined && second !== undefined);
  const duplicated: DeckReveal = { ...reveal, cards: [first, { ...second, card: first.card }] };
  const verification = verifyDeckReveal(duplicated);
  assert.equal(verification.ok, false);
  assert.match(String(verification.reason), /two positions/);
});

test('a reveal listing the same position twice is rejected', () => {
  const { commitment, secret } = commitToDeck('room_1:hand_1', random);
  const reveal = revealPositions(commitment, secret, [4]);
  const entry = reveal.cards[0];
  assert.ok(entry !== undefined);
  const verification = verifyDeckReveal({ ...reveal, cards: [entry, entry] });
  assert.equal(verification.ok, false);
  assert.match(String(verification.reason), /revealed twice/);
});

test('malformed reveals are rejected with specific reasons', () => {
  const { commitment, secret } = commitToDeck('room_1:hand_1', random);
  const reveal = revealPositions(commitment, secret, [0]);
  const entry = reveal.cards[0];
  assert.ok(entry !== undefined);

  const cases: [DeckReveal, RegExp][] = [
    [{ ...reveal, commitment: { ...commitment, version: 'v0' as never } }, /unsupported commitment version/],
    [{ ...reveal, commitment: { ...commitment, algorithm: 'md5' as never } }, /unsupported algorithm/],
    [{ ...reveal, commitment: { ...commitment, root: 'nope' } }, /not a 32-byte hex hash/],
    [{ ...reveal, cards: [{ ...entry, index: 99 }] }, /invalid deck position/],
    [{ ...reveal, cards: [{ ...entry, card: 99 }] }, /invalid card id/],
    [{ ...reveal, cards: [{ ...entry, saltHex: 'zz' }] }, /not 32 hex bytes/],
    [{ ...reveal, cards: [{ ...entry, proof: [] }] }, /expected 6/],
    [{ ...reveal, cards: [{ ...entry, proof: ['nope', 'a', 'b', 'c', 'd', 'e'] }] }, /malformed/],
  ];
  for (const [input, pattern] of cases) {
    const verification = verifyDeckReveal(input);
    assert.equal(verification.ok, false, `expected rejection for ${pattern}`);
    assert.match(String(verification.reason), pattern);
  }
});

test('committing rejects bad inputs', () => {
  assert.throws(
    () => commitToDeckOrder('', orderedDeck(), random.bytes(DECK_SIZE * SALT_BYTES)),
    /must not be empty/,
  );
  assert.throws(() => commitToDeckOrder('ctx', orderedDeck(), random.bytes(10)), /salts must be/);
  const duplicated = Array.from({ length: DECK_SIZE }, () => 3);
  assert.throws(
    () => commitToDeckOrder('ctx', duplicated, random.bytes(DECK_SIZE * SALT_BYTES)),
    /permutation/,
  );
  assert.throws(() => commitToKnownDeck('ctx', [1, 2, 3], random), /must contain 52 cards/);
});

test('revealing an out-of-range position throws rather than producing a bad proof', () => {
  const { commitment, secret } = commitToDeck('room_1:hand_1', random);
  assert.throws(() => revealPositions(commitment, secret, [52]), /invalid deck position/);
  assert.throws(() => revealPositions(commitment, secret, [-1]), /invalid deck position/);
});
