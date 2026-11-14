#!/usr/bin/env node
/**
 * Tests for scripts/backup.mjs: retention, the encrypted container, the manifest signature and every
 * refusal. Each negative control is paired with a positive one, so a detector that always fires fails.
 *
 * These are pure functions, so no PostgreSQL is needed. pg_dump, pg_restore and the row census are
 * exercised by the drill in docs/production/backup-restore.md.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  archiveHeader,
  assessRestoreSafety,
  BackupError,
  CHUNK_BYTES,
  canonicalJson,
  compareCensus,
  decodeKeyMaterial,
  decryptFrames,
  deepVerifyResults,
  encryptFrames,
  isPlainArchiveFileName,
  isSafeDatabaseName,
  manifestSignature,
  manifestSignatureValid,
  neutraliseGrantedBy,
  parseArgs,
  readInventory,
  resolveDirectory,
  selectForRetention,
  sourceDatabaseOf,
  sourceDatabases,
  unsafeArchiveFileNames,
  weekBucket,
} from './backup.mjs';

const MATERIAL = Buffer.alloc(32, 7);
const OTHER_MATERIAL = Buffer.alloc(32, 9);

async function collect(iterable) {
  const parts = [];
  for await (const chunk of iterable) parts.push(chunk);
  return Buffer.concat(parts);
}

async function seal(
  plaintext,
  { archive = 'prl-test-20260822T000000Z', payload = 'database', salt = Buffer.alloc(32, 1) } = {},
) {
  const header = archiveHeader({ archive, payload, salt, noncePrefix: Buffer.alloc(4, 2) });
  let digest = null;
  const bytes = await collect(
    encryptFrames([plaintext], { material: MATERIAL, header, report: (r) => (digest = r) }),
  );
  return { bytes, digest, header };
}

const open = (bytes, material = MATERIAL) => collect(decryptFrames([bytes], { material }));

// Uses `canonicalJson` because that is what the writer serialises with.
const frameRegionStart = (header) => 8 + 4 + Buffer.byteLength(canonicalJson(header), 'utf8');

function backupAt(iso, { good = true, id = null, source = null } = {}) {
  return {
    id: id ?? `prl-${source ?? 'test'}-${iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`,
    createdAt: iso,
    createdAtMs: Date.parse(iso),
    manifestPath: `/nowhere/${iso}.manifest.json`,
    manifest: source === null ? { files: [] } : { files: [], source: { database: source } },
    bytes: 1024,
    signatureOk: good,
    problems: good ? [] : ['manifest signature does not verify'],
    good,
  };
}

function dailySeries(days, endIso = '2026-08-22T02:00:00.000Z') {
  const end = Date.parse(endIso);
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(backupAt(new Date(end - i * 86400000).toISOString()));
  return out;
}

const POLICY = { daily: 7, weekly: 4, monthly: 6 };
const idsOf = (list) => list.map((entry) => entry.id);

describe('applying cluster globals', () => {
  // The exact tail of this cluster's `pg_dumpall --globals-only`, decrypted from a real archive.
  const GLOBALS = [
    'CREATE ROLE prl_app;',
    "ALTER ROLE prl_api WITH LOGIN PASSWORD 'SCRAM-SHA-256$4096:notarealverifier';",
    'GRANT prl_app TO prl_api WITH INHERIT TRUE GRANTED BY poker;',
    'GRANT prl_migrator TO prl_deployer WITH INHERIT TRUE GRANTED BY poker;',
  ].join('\n');

  it('NEGATIVE CONTROL: the GRANTED BY clause PostgreSQL 16 refuses is removed', () => {
    // Measured on a fresh postgres:16-bookworm with the command from disaster-recovery.md §5.4, the raw
    // GRANTED BY clauses fail with `permission denied to grant privileges as role "poker"` and leave the
    // roles with zero memberships.
    const { sql, stripped } = neutraliseGrantedBy(GLOBALS);
    assert.equal(stripped, 2, 'both membership grants must be rewritten');
    assert.doesNotMatch(sql, /GRANTED BY/i, 'no clause may survive; one is enough to fail the restore');
    assert.match(sql, /GRANT prl_app TO prl_api WITH INHERIT TRUE;/, 'the membership itself is kept');
    assert.match(sql, /GRANT prl_migrator TO prl_deployer WITH INHERIT TRUE;/);
  });

  it('leaves everything that is not a GRANT alone, including a password', () => {
    // Touching the verifier would restore the roles with no way to log in.
    const { sql } = neutraliseGrantedBy(GLOBALS);
    assert.match(sql, /ALTER ROLE prl_api WITH LOGIN PASSWORD 'SCRAM-SHA-256\$4096:notarealverifier';/);
    assert.match(sql, /^CREATE ROLE prl_app;$/m);
  });

  it('does not rewrite a line that merely mentions the words', () => {
    const text = "SELECT 'granted by poker';\nCOMMENT ON ROLE prl_app IS 'granted by poker';";
    const { sql, stripped } = neutraliseGrantedBy(text);
    assert.equal(stripped, 0);
    assert.equal(sql, text);
  });

  it('is a no-op on a globals dump that has no grantor recorded', () => {
    const text = 'CREATE ROLE prl_app;\nGRANT prl_app TO prl_api;';
    const { sql, stripped } = neutraliseGrantedBy(text);
    assert.equal(stripped, 0);
    assert.equal(sql, text);
  });
});

describe('retention selection', () => {
  it('keeps one backup per day, week and month, within the policy limits', () => {
    // 400 days is longer than every tier, so each tier's limit bounds the result.
    const backups = dailySeries(400);
    assert.ok(backups.length > 12, `the fixture must be a real set, got ${backups.length}`);
    const plan = selectForRetention(backups, POLICY);

    assert.ok(plan.keep.length >= 7, `expected at least the dailies, kept ${plan.keep.length}`);
    assert.ok(plan.keep.length <= 17, `a 7/4/6 policy cannot keep ${plan.keep.length}`);
    assert.equal(plan.keep.length + plan.delete.length, backups.length, 'every backup must be classified');

    const days = new Set();
    const weeks = new Set();
    const months = new Set();
    for (const kept of plan.keep) {
      const at = new Date(kept.createdAtMs);
      for (const reason of kept.reasons) {
        if (reason.startsWith('daily ')) days.add(at.toISOString().slice(0, 10));
        if (reason.startsWith('weekly ')) weeks.add(weekBucket(at));
        if (reason.startsWith('monthly ')) months.add(at.toISOString().slice(0, 7));
      }
    }
    assert.equal(days.size, 7, 'exactly 7 daily slots');
    assert.equal(weeks.size, 4, 'exactly 4 weekly slots');
    assert.equal(months.size, 6, 'exactly 6 monthly slots');
  });

  it('keeps the NEWEST backup of a day when several were taken that day', () => {
    const backups = [
      backupAt('2026-08-22T01:00:00.000Z'),
      backupAt('2026-08-22T13:00:00.000Z'),
      backupAt('2026-08-22T07:00:00.000Z'),
    ];
    const plan = selectForRetention(backups, { daily: 1, weekly: 0, monthly: 0 });
    assert.deepEqual(idsOf(plan.keep), [backupAt('2026-08-22T13:00:00.000Z').id]);
    assert.equal(plan.delete.length, 2);
  });

  it('NEGATIVE CONTROL: a zero policy still keeps the newest good backup', () => {
    // Without the rule this policy deletes every backup.
    const backups = dailySeries(30);
    const plan = selectForRetention(backups, { daily: 0, weekly: 0, monthly: 0 });
    assert.equal(plan.keep.length, 1, 'exactly one survivor');
    assert.equal(plan.keep[0].id, backups[backups.length - 1].id, 'and it is the newest');
    assert.deepEqual(plan.keep[0].reasons, ['newest good backup (never deleted)']);
    assert.equal(plan.delete.length, 29);
  });

  it('NEGATIVE CONTROL: when the newest backup is corrupt, the newest GOOD one survives', () => {
    // The plain reading keeps the broken newest file and deletes the last intact one.
    const backups = dailySeries(10);
    const corrupt = backupAt('2026-08-23T02:00:00.000Z', { good: false });
    const plan = selectForRetention([...backups, corrupt], { daily: 0, weekly: 0, monthly: 0 });
    assert.equal(plan.keep.length, 1);
    assert.equal(plan.keep[0].id, backups[backups.length - 1].id, 'the newest GOOD backup, not the newest');
    assert.ok(
      idsOf(plan.delete).includes(corrupt.id),
      'a corrupt archive is still deletable — it just cannot protect itself',
    );
  });

  it('NEGATIVE CONTROL: a corrupt backup cannot occupy a bucket and evict the good one under it', () => {
    // A corrupt 13:00 backup must not become today's daily over an intact 07:00 one.
    const good = backupAt('2026-08-22T07:00:00.000Z');
    const bad = backupAt('2026-08-22T13:00:00.000Z', { good: false });
    const plan = selectForRetention([good, bad], { daily: 1, weekly: 0, monthly: 0 });
    assert.deepEqual(idsOf(plan.keep), [good.id]);
    assert.deepEqual(idsOf(plan.delete), [bad.id]);
  });

  it('classifies a backup with an unusable timestamp as deletable, and says why', () => {
    // A distinct id, because the selector keys its decisions by id.
    const broken = {
      ...backupAt('2026-08-22T02:00:00.000Z', { id: 'prl-test-undated' }),
      createdAt: 'not a date',
      createdAtMs: Number.NaN,
    };
    const plan = selectForRetention([broken, ...dailySeries(3)], POLICY);
    const removed = plan.delete.find((entry) => entry.id === broken.id);
    assert.ok(removed !== undefined, 'it must not silently be kept');
    assert.match(removed.reason, /createdAt/);
  });

  it('NEGATIVE CONTROL: one directory, two source databases — each keeps its own newest good', () => {
    // Measured with the 7/4/6 policy and no per-source grouping: a 149.8 MiB archive of
    // `poker_risk_lab` was planned for deletion because a newer 77.6 KiB archive of another database
    // shared its directory. A shared directory is what disaster-recovery.md §5.5 recommends.
    const big = backupAt('2026-08-25T18:28:44.000Z', { source: 'poker_risk_lab' });
    const small = backupAt('2026-08-25T18:38:52.000Z', { source: 'poker_risk_lab_restored' });
    const plan = selectForRetention([small, big], POLICY);
    assert.deepEqual(idsOf(plan.delete), [], 'neither database may lose its only backup');
    assert.equal(plan.keep.length, 2);
    for (const kept of plan.keep) {
      assert.ok(
        kept.reasons.includes('newest good backup (never deleted)'),
        `${kept.id} must be protected in its own group, got ${kept.reasons.join(', ')}`,
      );
    }
  });

  it('NEGATIVE CONTROL: a zero policy keeps one survivor PER source database, not one overall', () => {
    // With all tiers at 0 and two sources, grouping by directory leaves one database with no archive.
    const plan = selectForRetention(
      [
        ...dailySeries(5).map((entry) => ({
          ...entry,
          id: `${entry.id}-a`,
          manifest: { files: [], source: { database: 'alpha' } },
        })),
        ...dailySeries(5).map((entry) => ({
          ...entry,
          id: `${entry.id}-b`,
          manifest: { files: [], source: { database: 'beta' } },
        })),
      ],
      { daily: 0, weekly: 0, monthly: 0 },
    );
    assert.equal(plan.keep.length, 2, 'one survivor for alpha and one for beta');
    assert.deepEqual(
      plan.keep.map((entry) => sourceDatabaseOf(entry)).sort(),
      ['alpha', 'beta'],
      'the survivors must be one of each, not two of whichever is newest',
    );
  });

  it('reports the distinct source databases in an inventory', () => {
    const inventory = [
      backupAt('2026-08-25T03:00:00.000Z', { source: 'beta' }),
      backupAt('2026-08-25T02:00:00.000Z', { source: 'alpha' }),
      backupAt('2026-08-24T02:00:00.000Z', { source: 'alpha' }),
    ];
    assert.deepEqual(sourceDatabases(inventory), ['beta', 'alpha']);
    assert.deepEqual(sourceDatabases([backupAt('2026-08-25T02:00:00.000Z')]), [null]);
  });

  it('keeps everything when the policy is wider than the history', () => {
    const backups = dailySeries(3);
    const plan = selectForRetention(backups, POLICY);
    assert.equal(plan.delete.length, 0);
    assert.equal(plan.keep.length, 3);
  });

  it('buckets weeks the way a calendar does, not the way the epoch does', () => {
    // Epoch-millisecond division puts the week boundary on a Thursday. 2026-01-01 is in 2026-W01 and
    // 2025-12-28 is in 2025-W52.
    assert.equal(weekBucket(new Date('2026-01-01T00:00:00Z')), '2026-W01');
    assert.equal(weekBucket(new Date('2025-12-28T00:00:00Z')), '2025-W52');
    assert.equal(weekBucket(new Date('2025-12-29T00:00:00Z')), '2026-W01', 'Monday starts the week');
    assert.equal(weekBucket(new Date('2026-08-22T00:00:00Z')), '2026-W34');
  });
});

describe('the encrypted container', () => {
  it('round-trips a multi-frame payload byte for byte', async () => {
    // Larger than one chunk, so the counter, the AAD binding and the terminator are exercised.
    const plaintext = randomBytes(CHUNK_BYTES * 2 + 4096);
    const { bytes, digest } = await seal(plaintext);
    assert.ok(digest.frames >= 3, `expected several frames, sealed ${digest.frames}`);
    assert.equal(digest.plainBytes, plaintext.length);
    const recovered = await open(bytes);
    assert.equal(recovered.length, plaintext.length);
    assert.ok(recovered.equals(plaintext), 'the recovered plaintext must be identical');
  });

  it('round-trips an empty payload', async () => {
    const { bytes, digest } = await seal(Buffer.alloc(0));
    assert.equal(digest.frames, 1, 'just the terminator');
    assert.equal((await open(bytes)).length, 0);
  });

  it('never writes the plaintext anywhere in the archive', async () => {
    const secret = Buffer.from('SCRAM-SHA-256$4096:this-would-be-a-role-password-verifier', 'utf8');
    const { bytes } = await seal(secret, { payload: 'globals' });
    assert.equal(bytes.includes(secret), false, 'the payload appears in the file in the clear');
  });

  it('NEGATIVE CONTROL: a single flipped ciphertext byte fails authentication', async () => {
    const { bytes } = await seal(randomBytes(CHUNK_BYTES + 1000));
    const tampered = Buffer.from(bytes);
    tampered[5000] ^= 0x01;
    await assert.rejects(() => open(tampered), /failed authentication/);
  });

  it('NEGATIVE CONTROL: the wrong key fails authentication rather than returning rubbish', async () => {
    const { bytes } = await seal(randomBytes(2048));
    await assert.rejects(() => open(bytes, OTHER_MATERIAL), /failed authentication/);
  });

  it('NEGATIVE CONTROL: a truncated archive is refused for having no terminator', async () => {
    // A checksum recomputed over the truncated file cannot catch this.
    const { bytes } = await seal(randomBytes(CHUNK_BYTES * 2));
    const truncated = bytes.subarray(0, bytes.length - 40);
    await assert.rejects(() => open(truncated), /terminator|ends mid-structure/);
  });

  it('NEGATIVE CONTROL: dropping only the terminator frame is refused', async () => {
    // The terminator is 4 length bytes plus a 16-byte tag.
    const { bytes } = await seal(randomBytes(4096));
    await assert.rejects(() => open(bytes.subarray(0, bytes.length - 20)), /no terminator frame/);
  });

  it('NEGATIVE CONTROL: appending frames after the terminator is refused', async () => {
    const { bytes } = await seal(randomBytes(4096));
    const spliced = Buffer.concat([bytes, bytes.subarray(bytes.length - 20)]);
    await assert.rejects(() => open(spliced), /past its terminator/);
  });

  it('NEGATIVE CONTROL: a frame lifted from another archive fails, even under the same key', async () => {
    // Frame 0 of one archive must not open as frame 0 of another under the same key.
    const first = await seal(randomBytes(CHUNK_BYTES + 512), { archive: 'prl-a-20260101T000000Z' });
    const second = await seal(randomBytes(CHUNK_BYTES + 512), { archive: 'prl-b-20260101T000000Z' });
    // Same-length ids put the frame region at the same offset, so this is a clean transplant.
    const cut = frameRegionStart(first.header);
    assert.equal(
      cut,
      frameRegionStart(second.header),
      'the transplant must be byte-aligned to be meaningful',
    );
    const frankenstein = Buffer.concat([first.bytes.subarray(0, cut), second.bytes.subarray(cut)]);
    await assert.rejects(() => open(frankenstein), /failed authentication|impossible length/);
  });

  it('NEGATIVE CONTROL: editing the header breaks every frame', async () => {
    const { bytes, header } = await seal(randomBytes(4096));
    const edited = Buffer.from(bytes);
    // Same byte length, so the header still parses and only the AAD binding can catch it.
    const label = Buffer.from('"payload":"database"', 'utf8');
    const at = edited.indexOf(label);
    assert.ok(at > 0, `the header must contain the payload label; header was ${canonicalJson(header)}`);
    edited[at + 18] = 'X'.charCodeAt(0);
    assert.equal(edited.includes(label), false, 'the fixture must actually have changed the header');
    await assert.rejects(() => open(edited), /failed authentication/);
  });

  it('NEGATIVE CONTROL: a file that is not an archive is refused by its magic', async () => {
    await assert.rejects(
      () => open(Buffer.from('PGDMP not an archive at all', 'utf8')),
      /not a Poker Risk Lab archive/,
    );
  });

  it('NEGATIVE CONTROL: an implausible frame length is refused before anything is allocated', async () => {
    const { bytes, header } = await seal(Buffer.from('short', 'utf8'));
    const cut = frameRegionStart(header);
    const evil = Buffer.from(bytes);
    // Without the ceiling this is a 4 GiB allocation driven by four attacker-controlled bytes.
    evil.writeUInt32BE(0xffffffff, cut);
    await assert.rejects(() => open(evil), /impossible length/);
  });
});

describe('the manifest signature', () => {
  const salt = Buffer.alloc(32, 3);
  const body = {
    format: 'prl-backup/1',
    id: 'prl-poker_risk_lab-20260822T000000Z',
    createdAt: '2026-08-22T00:00:00.000Z',
    source: { database: 'poker_risk_lab' },
    encryption: { salt: salt.toString('base64') },
    files: [{ name: 'a.dump.enc', cipherSha256: 'a'.repeat(64), cipherBytes: 10 }],
    rowCounts: { users: 3 },
  };
  const signed = { ...body, hmac: manifestSignature(MATERIAL, salt, body) };

  it('verifies a manifest it signed', () => {
    assert.equal(manifestSignatureValid(MATERIAL, signed), true);
  });

  it('NEGATIVE CONTROL: a rewritten checksum invalidates the signature', () => {
    // Whoever can corrupt the archive can also rewrite the plain-JSON checksum.
    const doctored = structuredClone(signed);
    doctored.files[0].cipherSha256 = 'b'.repeat(64);
    assert.equal(manifestSignatureValid(MATERIAL, doctored), false);
  });

  it('NEGATIVE CONTROL: and re-signing it with the RIGHT key does verify', () => {
    // Re-signed with the real key, so this proves the signature is what the previous test measured.
    const doctored = structuredClone(body);
    doctored.files[0].cipherSha256 = 'b'.repeat(64);
    const resigned = { ...doctored, hmac: manifestSignature(MATERIAL, salt, doctored) };
    assert.equal(manifestSignatureValid(MATERIAL, resigned), true);
  });

  it('NEGATIVE CONTROL: another key does not verify', () => {
    assert.equal(manifestSignatureValid(OTHER_MATERIAL, signed), false);
  });

  it('NEGATIVE CONTROL: a missing or malformed hmac does not verify', () => {
    assert.equal(manifestSignatureValid(MATERIAL, { ...body }), false);
    assert.equal(manifestSignatureValid(MATERIAL, { ...body, hmac: 'nope' }), false);
    assert.equal(manifestSignatureValid(MATERIAL, { ...body, hmac: 42 }), false);
  });

  it('signs the canonical form, so key order cannot change the signature', () => {
    const reordered = {
      rowCounts: body.rowCounts,
      files: body.files,
      encryption: body.encryption,
      source: body.source,
      createdAt: body.createdAt,
      id: body.id,
      format: body.format,
    };
    assert.equal(canonicalJson(reordered), canonicalJson(body));
    assert.equal(manifestSignature(MATERIAL, salt, reordered), signed.hmac);
  });

  it('canonicalises nested objects and arrays, not just the top level', () => {
    assert.equal(
      canonicalJson({ a: { z: 1, b: 2 }, l: [3, { y: 1, x: 2 }] }),
      '{"a":{"b":2,"z":1},"l":[3,{"x":2,"y":1}]}',
    );
    assert.equal(canonicalJson(null), 'null');
    assert.equal(canonicalJson([]), '[]');
  });
});

describe('reading an archive directory', () => {
  it('marks a good backup good, and a damaged one not good, with the reason', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prl-backup-test-'));
    try {
      const salt = Buffer.alloc(32, 5);
      const payload = await seal(Buffer.from('pretend this is a dump', 'utf8'), {
        archive: 'prl-x-20260822T000000Z',
        salt,
      });
      const write = async (id, createdAt, mutate) => {
        await writeFile(join(dir, `${id}.dump.enc`), payload.bytes);
        const draft = {
          format: 'prl-backup/1',
          id,
          createdAt,
          source: { database: 'poker_risk_lab' },
          encryption: { salt: salt.toString('base64') },
          files: [
            {
              name: `${id}.dump.enc`,
              payload: 'database',
              cipherBytes: payload.digest.cipherBytes,
              cipherSha256: payload.digest.cipherSha256,
              plainBytes: payload.digest.plainBytes,
              plainSha256: payload.digest.plainSha256,
              frames: payload.digest.frames,
            },
          ],
          rowCounts: {},
        };
        const body = mutate === undefined ? draft : mutate(draft);
        await writeFile(
          join(dir, `${id}.manifest.json`),
          JSON.stringify({ ...body, hmac: manifestSignature(MATERIAL, salt, body) }, null, 2),
        );
      };

      await write('prl-good-20260822T000000Z', '2026-08-22T00:00:00.000Z');
      // The size catches a truncated copy without reading a byte of it.
      await write('prl-short-20260822T000001Z', '2026-08-22T00:00:01.000Z', (draft) => {
        draft.files[0].cipherBytes = draft.files[0].cipherBytes + 99;
        return draft;
      });
      await write('prl-absent-20260822T000002Z', '2026-08-22T00:00:02.000Z', (draft) => {
        draft.files[0].name = 'nothing-here.dump.enc';
        return draft;
      });

      const inventory = await readInventory(dir, MATERIAL);
      assert.equal(inventory.length, 3, 'every manifest must be reported, broken ones included');
      const byId = new Map(inventory.map((entry) => [entry.id, entry]));

      assert.equal(byId.get('prl-good-20260822T000000Z').good, true);
      assert.deepEqual(byId.get('prl-good-20260822T000000Z').problems, []);

      const short = byId.get('prl-short-20260822T000001Z');
      assert.equal(short.good, false, 'a size mismatch must not be "good"');
      assert.match(short.problems.join(' '), /bytes, manifest says/);

      const absent = byId.get('prl-absent-20260822T000002Z');
      assert.equal(absent.good, false);
      assert.match(absent.problems.join(' '), /is missing/);

      // Newest first, which `prune` and the default `--id` selection depend on.
      assert.deepEqual(
        inventory.map((entry) => entry.id),
        ['prl-absent-20260822T000002Z', 'prl-short-20260822T000001Z', 'prl-good-20260822T000000Z'],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('says where to look when the directory does not exist', async () => {
    await assert.rejects(
      () => readInventory(join(tmpdir(), 'prl-backup-definitely-not-here'), MATERIAL),
      /no archive directory/,
    );
  });

  // `prune --apply` passes a manifest name to `rm(join(dir, name))`, so `../VICTIM.txt` would delete
  // the file one level up and exit 0.
  it('refuses a manifest whose payload name is a path rather than a file name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prl-backup-test-'));
    try {
      const salt = Buffer.alloc(32, 5);
      const id = 'prl-evil-20260822T000000Z';
      // The victim exists, so a regression to a resolve-and-compare check would make the archive look good.
      const victim = join(dir, '..', `prl-victim-${process.pid}.txt`);
      await writeFile(victim, 'do not delete me');
      const body = {
        format: 'prl-backup/1',
        id,
        createdAt: '2026-08-22T00:00:00.000Z',
        source: { database: 'poker_risk_lab' },
        encryption: { salt: salt.toString('base64') },
        files: [
          {
            name: `../prl-victim-${process.pid}.txt`,
            payload: 'database',
            cipherBytes: 16,
            cipherSha256: 'a'.repeat(64),
            plainBytes: 16,
            plainSha256: 'b'.repeat(64),
            frames: 1,
          },
        ],
        rowCounts: {},
      };
      // Signed with the real key, so the refusal is not the signature check.
      await writeFile(
        join(dir, `${id}.manifest.json`),
        JSON.stringify({ ...body, hmac: manifestSignature(MATERIAL, salt, body) }, null, 2),
      );

      const inventory = await readInventory(dir, MATERIAL);
      assert.equal(inventory.length, 1);
      assert.equal(inventory[0].signatureOk, true, 'the fixture must be a correctly signed manifest');
      assert.equal(inventory[0].good, false, 'an archive naming a path outside the directory is not good');
      assert.match(inventory[0].problems.join(' '), /not a plain file name/);

      const offences = unsafeArchiveFileNames(inventory);
      assert.equal(offences.length, 1, 'the traversal must be reported, not skipped');
      assert.equal(offences[0].id, id);
      assert.match(offences[0].name, /\.\./);
    } finally {
      await rm(join(dir, '..', `prl-victim-${process.pid}.txt`), { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('archive payload names', () => {
  it('accepts the two shapes this format actually writes', () => {
    assert.equal(isPlainArchiveFileName('prl-x-20260822T000000Z.dump.enc'), true);
    assert.equal(isPlainArchiveFileName('prl-x-20260822T000000Z.globals.sql.enc'), true);
  });

  it('refuses every shape that escapes the archive directory', () => {
    for (const name of ['../VICTIM.txt', '../../etc/passwd', '..', '../']) {
      assert.equal(isPlainArchiveFileName(name), false, `${JSON.stringify(name)} must be refused`);
      // Stated independently of the predicate: `join(directory, name)` lands outside the archive directory.
      assert.equal(
        join('/archives', name).startsWith('/archives/'),
        false,
        `${JSON.stringify(name)} would have been unlinked at ${join('/archives', name)}`,
      );
    }
  });

  // Contained names with separators are refused too, because this format writes exactly two names
  // (see `archiveFileName`).
  it('refuses contained names that this format nevertheless never writes', () => {
    for (const name of ['sub/x.dump.enc', 'sub/../x.dump.enc', './x.dump.enc', '..\\VICTIM.txt', '.', '']) {
      assert.equal(isPlainArchiveFileName(name), false, `${JSON.stringify(name)} must be refused`);
    }
  });

  // `join` neutralises an absolute name only because of the call site, so the name is refused here.
  it('refuses an absolute name even though `join` currently neutralises it', () => {
    assert.equal(join('/archives', '/etc/passwd'), '/archives/etc/passwd', 'join, not resolve');
    assert.equal(resolve('/archives', '/etc/passwd'), '/etc/passwd', 'which is what resolve would do');
    assert.equal(isPlainArchiveFileName('/etc/passwd'), false);
    assert.equal(isPlainArchiveFileName('/var/backups/x.dump.enc'), false);
  });

  it('refuses a name carrying a NUL, which is not the name the kernel would act on', () => {
    assert.equal(isPlainArchiveFileName('x.dump.enc\0.txt'), false);
  });

  it('refuses a name that is not a string at all', () => {
    for (const name of [undefined, null, 42, {}, ['x.dump.enc']]) {
      assert.equal(isPlainArchiveFileName(name), false);
    }
  });

  it('reports nothing for a delete set whose manifests are all well formed', () => {
    const clean = [
      { id: 'a', manifestPath: '/archives/a.manifest.json', manifest: { files: [{ name: 'a.dump.enc' }] } },
      { id: 'b', manifestPath: '/archives/b.manifest.json', manifest: { files: [] } },
      { id: 'c', manifestPath: '/archives/c.manifest.json', manifest: null },
    ];
    assert.deepEqual(unsafeArchiveFileNames(clean), []);
  });

  it('reports every offending name in the set, not just the first', () => {
    const offences = unsafeArchiveFileNames([
      { id: 'a', manifestPath: '/archives/a.manifest.json', manifest: { files: [{ name: '../one' }] } },
      { id: 'b', manifestPath: '/archives/b.manifest.json', manifest: { files: [{ name: 'b.dump.enc' }] } },
      {
        id: 'c',
        manifestPath: '/archives/c.manifest.json',
        manifest: { files: [{ name: 'c.dump.enc' }, { name: '/etc/passwd' }] },
      },
    ]);
    assert.deepEqual(
      offences.map((offence) => `${offence.id}:${offence.name}`),
      ['a:../one', 'c:/etc/passwd'],
    );
  });
});

describe('the verdict a --deep verification reports', () => {
  const CENSUS_OK = { ok: true, summary: '3 tables compared' };

  it('passes both claims when the restore matched and the scratch database went away', () => {
    const results = deepVerifyResults({
      comparison: CENSUS_OK,
      dropFailure: null,
      scratch: 'prl_verify_x',
      elapsedMs: 1234,
    });
    assert.equal(
      results.every((result) => result.ok),
      true,
    );
    assert.match(results.map((result) => result.message).join(' | '), /dropped the scratch database/);
  });

  // The old `verifyArchive` printed a failed scratch drop with `cross`, which feeds no verdict, so
  // `verify --deep` printed PASS and returned 0. Both the verdict and the sentence are asserted.
  it('fails, and does not claim a drop, when the scratch database could not be dropped', () => {
    const results = deepVerifyResults({
      comparison: CENSUS_OK,
      dropFailure: 'psql: FATAL: database "prl_verify_x" is being accessed by other users',
      scratch: 'prl_verify_x',
      elapsedMs: 1234,
    });
    assert.equal(
      results.some((result) => !result.ok),
      true,
      'a leftover plaintext copy of the database must fail the command',
    );
    const prose = results.map((result) => `${result.message} ${result.detail}`).join(' | ');
    assert.equal(/dropped it/.test(prose), false, 'no line may claim a drop that did not happen');
    assert.match(prose, /STILL ON THE CLUSTER/);
    assert.match(prose, /DROP DATABASE prl_verify_x/, 'the operator must be told how to finish the job');
  });

  it('reports the census failure and the drop failure separately', () => {
    const results = deepVerifyResults({
      comparison: { ok: false, summary: 'EMPTY after restore: users' },
      dropFailure: 'connection refused',
      scratch: 'prl_verify_y',
      elapsedMs: 10,
    });
    assert.equal(results.length, 2, 'two claims, two records');
    assert.equal(
      results.every((result) => !result.ok),
      true,
    );
    assert.match(results[0].detail, /EMPTY after restore/);
    assert.match(results[1].detail, /connection refused/);
  });
});

describe('argument parsing', () => {
  it('reads a subcommand and its options', () => {
    const options = parseArgs(['create', '--dir', '/var/backups/x', '--container', 'pg', '--no-globals']);
    assert.equal(options.command, 'create');
    assert.equal(options.dir, '/var/backups/x');
    assert.equal(options.container, 'pg');
    assert.equal(options.globals, false);
  });

  it('absorbs the `--` that `pnpm run backup create -- --dir x` forwards', () => {
    const options = parseArgs(['create', '--', '--dir', '/x']);
    assert.equal(options.command, 'create');
    assert.equal(options.dir, '/x');
  });

  it('NEGATIVE CONTROL: an unknown option names itself rather than saying "invalid"', () => {
    assert.throws(() => parseArgs(['create', '--encrypt-later']), /unknown option --encrypt-later/);
  });

  it('NEGATIVE CONTROL: an unknown command lists the ones that exist', () => {
    assert.throws(() => parseArgs(['restor']), /unknown command restor.*create, verify, restore/s);
  });

  it('NEGATIVE CONTROL: an option missing its value says which option', () => {
    assert.throws(() => parseArgs(['restore', '--target']), /--target needs a value/);
  });

  it('NEGATIVE CONTROL: a retention count that is not a whole number is refused with the reason', () => {
    assert.throws(() => parseArgs(['prune', '--daily', 'seven']), /--daily must be a whole number/);
    assert.throws(() => parseArgs(['prune', '--weekly', '-1']), /--weekly must be a whole number/);
    assert.throws(() => parseArgs(['prune', '--monthly', '2.5']), /--monthly must be a whole number/);
    assert.throws(() => parseArgs(['prune', '--daily', '9999']), /implausible; the ceiling is 365/);
  });

  it('accepts zero, which is a legal policy the last-good-backup rule then overrides', () => {
    const options = parseArgs(['prune', '--daily', '0', '--weekly', '0', '--monthly', '0']);
    assert.equal(options.daily, 0);
  });

  it('offers no --key flag, because argv is visible in ps', () => {
    assert.throws(() => parseArgs(['create', '--key', 'aaaa']), /unknown option --key/);
  });

  it('resolves the archive directory flag over env over default', () => {
    assert.equal(resolveDirectory({ PRL_BACKUP_DIR: '/from/env' }, '/from/flag').path, '/from/flag');
    assert.equal(resolveDirectory({ PRL_BACKUP_DIR: '/from/env' }, null).source, 'PRL_BACKUP_DIR');
    assert.equal(resolveDirectory({}, null).path, '/var/backups/poker-risk-lab');
    assert.equal(resolveDirectory({}, null).source, 'default');
  });

  it('does not default the archive directory into the repository', () => {
    // A default of ./backups is one `git add -A` away from a public remote.
    const fallback = resolveDirectory({}, null).path;
    assert.ok(fallback.startsWith('/'), 'the default must be absolute');
    assert.equal(fallback.includes('poker-risk-lab/backups'), false);
  });
});

describe('key material', () => {
  it('accepts hex, base64 and base64url of exactly 32 bytes', () => {
    const key = Buffer.alloc(32, 4);
    assert.ok(decodeKeyMaterial(key.toString('hex'), 'k').equals(key));
    assert.ok(decodeKeyMaterial(key.toString('base64'), 'k').equals(key));
    assert.ok(decodeKeyMaterial(key.toString('base64url'), 'k').equals(key));
    assert.ok(
      decodeKeyMaterial(`  ${key.toString('base64url')}\n`, 'k').equals(key),
      'trailing newline from a file',
    );
  });

  it('NEGATIVE CONTROL: refuses a short key and says how short it was', () => {
    // base64, not hex: 32 hex characters are also valid base64url and decode to 24 bytes.
    assert.throws(
      () => decodeKeyMaterial(Buffer.alloc(16, 1).toString('base64'), 'PRL_BACKUP_KEY'),
      /decodes to 16 bytes/,
    );
    assert.throws(() => decodeKeyMaterial('', 'PRL_BACKUP_KEY'), /is empty/);
    assert.throws(
      () => decodeKeyMaterial('not a key at all!!', 'PRL_BACKUP_KEY'),
      /not hex, base64 or base64url/,
    );
  });
});

describe('restore refusals', () => {
  const safe = {
    target: 'prl_restore_2026',
    liveDatabase: 'poker_risk_lab',
    targetExists: false,
    nodeEnv: 'development',
    dropExisting: false,
    overwriteLive: false,
    productionAcknowledged: false,
  };

  it('POSITIVE CONTROL: allows the safe case, so the refusals below mean something', () => {
    assert.deepEqual(assessRestoreSafety(safe), []);
  });

  it('requires --target, and says there is no default', () => {
    const refusals = assessRestoreSafety({ ...safe, target: null });
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /--target is required.*no default/s);
  });

  it('NEGATIVE CONTROL: refuses an existing target without --drop-existing', () => {
    const refusals = assessRestoreSafety({ ...safe, targetExists: true });
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /--drop-existing/);
    assert.deepEqual(assessRestoreSafety({ ...safe, targetExists: true, dropExisting: true }), []);
  });

  it('NEGATIVE CONTROL: refuses the live database even with --drop-existing', () => {
    // A mistyped --target naming the live database. One flag for both dangers would grant the second.
    const refusals = assessRestoreSafety({
      ...safe,
      target: 'poker_risk_lab',
      targetExists: true,
      dropExisting: true,
    });
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /--overwrite-live-database/);
    assert.deepEqual(
      assessRestoreSafety({
        ...safe,
        target: 'poker_risk_lab',
        targetExists: true,
        dropExisting: true,
        overwriteLive: true,
      }),
      [],
    );
  });

  it('NEGATIVE CONTROL: refuses under NODE_ENV=production without the second acknowledgement', () => {
    const refusals = assessRestoreSafety({ ...safe, nodeEnv: 'production' });
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /--yes-i-am-restoring-production/);
    assert.deepEqual(
      assessRestoreSafety({ ...safe, nodeEnv: 'production', productionAcknowledged: true }),
      [],
    );
  });

  it('reports every applicable refusal at once, not one at a time', () => {
    const refusals = assessRestoreSafety({
      ...safe,
      target: 'poker_risk_lab',
      targetExists: true,
      nodeEnv: 'production',
    });
    assert.equal(refusals.length, 3, `expected three refusals, got:\n${refusals.join('\n')}`);
  });

  it('NEGATIVE CONTROL: refuses a database name that is not a plain identifier', () => {
    for (const name of [
      'Robert; DROP DATABASE x',
      'has space',
      'MixedCase',
      '1leading',
      '',
      'a'.repeat(64),
      '-x',
    ]) {
      assert.equal(isSafeDatabaseName(name), false, `${name} must be refused`);
      assert.match(assessRestoreSafety({ ...safe, target: name })[0], /required|not a usable database name/);
    }
    for (const name of ['prl_restore_drill', '_scratch', 'a', 'a'.repeat(63)]) {
      assert.equal(isSafeDatabaseName(name), true, `${name} must be accepted`);
    }
  });
});

describe('census comparison', () => {
  it('POSITIVE CONTROL: an exact match passes', () => {
    const result = compareCensus({ users: 266, hands: 36 }, { users: 266, hands: 36 });
    assert.equal(result.ok, true);
  });

  it('NEGATIVE CONTROL: a table that was populated and came back empty fails', () => {
    // The failure that happens in practice: schema restored, data not.
    const result = compareCensus({ users: 266, hands: 36 }, { users: 0, hands: 36 });
    assert.equal(result.ok, false);
    assert.deepEqual(result.emptied, ['users']);
    assert.match(result.summary, /EMPTY after restore: users/);
  });

  it('NEGATIVE CONTROL: a table missing from the restored database fails', () => {
    const result = compareCensus({ users: 266, hands: 36 }, { users: 266 });
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ['hands']);
  });

  it('reports ordinary drift without failing, because the census is a second snapshot', () => {
    // The census follows pg_dump, so live writes make small differences that must not fire.
    const result = compareCensus({ users: 266, sessions: 197 }, { users: 266, sessions: 195 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.drifted, ['sessions 197→195']);
  });

  it('says so rather than throwing when a manifest predates the census', () => {
    assert.equal(compareCensus(undefined, { users: 1 }).ok, true);
    assert.match(compareCensus(null, { users: 1 }).summary, /no census recorded/);
  });
});

describe('BackupError', () => {
  it('carries a detail line, because a refusal without a next step is a dead end', () => {
    const error = new BackupError('the thing failed', 'here is what to do about it');
    assert.equal(error.name, 'BackupError');
    assert.equal(error.detail, 'here is what to do about it');
    assert.equal(new BackupError('no detail').detail, null);
  });
});
