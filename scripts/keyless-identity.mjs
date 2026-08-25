/**
 * The identity half of image signing: WHO signed, rather than WHICH KEY signed.
 *
 * `scripts/image-signing.mjs` binds a release digest to a key whose public half is committed. Its
 * own header states the limit that this module exists to address:
 *
 *     "It proves possession of a key, not the identity of a builder. … Keyless/OIDC signing exists
 *      precisely because that sentence is unavoidable for a long-lived local key."
 *
 * ## What keyless signing actually is, in the two sentences that matter here
 *
 * A GitHub Actions job with `id-token: write` can ask GitHub for a short-lived OIDC token that
 * describes it — repository, workflow file, ref, commit, trigger. cosign exchanges that token with
 * **Fulcio**, which issues a certificate valid for ten minutes whose SAN is a URI naming that
 * workflow, and records the exchange in **Rekor**, a public append-only log. Nothing long-lived is
 * created; there is no key to steal, and there is no key to be careless with.
 *
 * The half that is easy to get wrong, and that this module is mostly about: **a keyless signature
 * verifies against SOME Fulcio certificate.** Fulcio will issue one to anybody's GitHub Actions job.
 * A verification that checks only the cryptography accepts a signature made by a workflow in a
 * repository you have never heard of, and reports it as provenance. What makes it provenance is
 * demanding the certificate's **identity** — the exact workflow URI — and its **issuer** — the
 * exact OIDC provider. Measured, on this machine, offline, against a certificate minted for
 * `example-org` and verified against a policy naming `attacker-org` (the full harness is
 * `node scripts/supply-chain/image-provenance.mjs --negative-control`):
 *
 *     Error: no matching attestations: failed to verify certificate identity: no matching
 *     CertificateIdentity found, last error: expected SAN value
 *     "https://github.com/attacker-org/…/release-sign.yml@refs/tags/v1.0.0", got
 *     "https://github.com/example-org/…/release-sign.yml@refs/tags/v1.0.0"
 *
 * and with the identity right and the issuer wrong:
 *
 *     Error: … expected issuer value "https://gitlab.com", got
 *     "https://token.actions.githubusercontent.com"
 *
 * and with neither asserted at all, which is the state a careless verifier is in:
 *
 *     Error: --certificate-identity or --certificate-identity-regexp is required for verification
 *     in keyless mode
 *
 * cosign refuses to perform a keyless verification that asserts no identity. That refusal is worth
 * knowing about, because it means the failure mode this module guards against is not "cosign
 * silently accepted anything" — it is a verifier that asserts an identity somebody widened.
 *
 * ## Why the policy is a committed file and not a flag
 *
 * The identity is the whole claim. A `--certificate-identity` typed on a command line, or built
 * from an environment variable, is a claim whoever runs the command chose; it can be widened to
 * `.*` by an edit nobody reviews, and the run stays green. `deploy/signing/keyless-policy.json` is
 * committed, is read by the verifier, and is checked against the workflow it names by
 * `scripts/supply-chain/keyless-provenance.mjs` — so a rename that breaks the binding fails a gate
 * instead of quietly widening what is accepted.
 *
 * ## Exact identities only. No regexp.
 *
 * cosign offers `--certificate-identity-regexp`, and this repository deliberately does not use it.
 * A regexp is a licence to accept identities nobody enumerated, and the two ways it goes wrong are
 * both quiet: an unanchored pattern matches a longer string (`…/poker-risk-lab…` also matches
 * `…/poker-risk-lab-fork/…`), and `.*` in the ref position accepts a signature made from any
 * branch, including one an attacker pushed. The signing workflow is `workflow_run`-triggered, which
 * GitHub always runs on the default branch, so there is exactly ONE ref this identity can ever
 * carry and an exact string expresses it. If a future signer is tag-triggered it needs a regexp,
 * and the right time to argue about anchoring is then, in that diff.
 */

import { X509Certificate } from 'node:crypto';

/** The committed policy. The verifier reads this and nothing else decides what identity is demanded. */
export const KEYLESS_POLICY_PATH = 'deploy/signing/keyless-policy.json';

/** The schema string the policy reader checks before trusting the shape. */
export const KEYLESS_POLICY_SCHEMA = 'prl.keyless-identity-policy.v1';

/**
 * The only OIDC issuer a GitHub Actions workload identity can have.
 *
 * Pinned as a constant rather than read from the policy alone, because the policy is checked
 * against it: an issuer that is not this one, on an identity that is a github.com workflow URI, is
 * a policy that would accept a certificate GitHub did not vouch for.
 */
export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

/**
 * Fulcio's OIDC-issuer certificate extensions.
 *
 * `1.3.6.1.4.1.57264.1.8` is "issuer (v2)" and carries a DER-encoded UTF8String;
 * `1.3.6.1.4.1.57264.1.1` is the deprecated form and carries the raw string. Both are read, v2
 * first, because a certificate that carries only the deprecated one is still a certificate cosign
 * will match an issuer against — and a parser that could not see it would report "no issuer" for a
 * certificate that has one, which is the shape of every silent pass in this repository.
 */
const OID_ISSUER_V2 = Buffer.from('060a2b0601040183bf300108', 'hex');
const OID_ISSUER_V1 = Buffer.from('060a2b0601040183bf300101', 'hex');

/** `owner/name`, the shape `github.repository` has. */
const REPOSITORY_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/** A workflow path as GitHub writes it into a certificate SAN. */
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;

/** Refs a `workflow_run`/`push`-triggered workflow can run on. Wildcards are refused; see the header. */
const GIT_REF = /^refs\/(heads|tags)\/[A-Za-z0-9._\-/]+$/;

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

/**
 * Validates the committed identity policy without touching a registry, a network or a workflow.
 *
 * Pure, so `scripts/keyless-identity.test.mjs` can drive every way a policy can be wrong — and the
 * ways that matter are not malformed JSON, they are policies that are well-formed and too wide. A
 * `*` in the ref, an issuer that is not GitHub's, a workflow path outside `.github/workflows/`:
 * each of those parses cleanly, reads as a policy, and accepts signatures nobody intended.
 *
 * @param {unknown} raw
 * @returns {{policy: object|null, problems: string[]}}
 */
export function parseKeylessPolicy(raw) {
  const problems = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { policy: null, problems: ['the keyless identity policy is not a JSON object'] };
  }
  if (raw.schema !== KEYLESS_POLICY_SCHEMA) {
    return {
      policy: null,
      problems: [
        `the keyless identity policy's schema is ${JSON.stringify(raw.schema ?? null)}, expected ` +
          `${KEYLESS_POLICY_SCHEMA}. A reader that guesses at an unknown shape can report a pass ` +
          'over fields it never found.',
      ],
    };
  }

  const issuer = raw.issuer;
  if (issuer !== GITHUB_OIDC_ISSUER) {
    problems.push(
      `the policy's issuer is ${JSON.stringify(issuer ?? null)}, expected ${GITHUB_OIDC_ISSUER}. ` +
        'The issuer is half the claim: an identity string proves nothing about who asserted it, so ' +
        'a policy naming a different OIDC provider would accept a certificate GitHub never issued.',
    );
  }

  const repository = raw.repository ?? null;
  if (repository !== null && !REPOSITORY_SLUG.test(String(repository))) {
    problems.push(
      `the policy's repository is ${JSON.stringify(repository)}, which is not an owner/name slug. ` +
        'Use null to say "this repository has no GitHub owner yet" — that is a state the verifier ' +
        'refuses in, which is the safe direction — rather than a placeholder that reads as a name.',
    );
  }

  const name = raw.repositoryName;
  if (typeof name !== 'string' || name.trim() === '') {
    problems.push(
      'the policy names no repositoryName. It is what bounds the environment fallback used before ' +
        'an owner is committed: without it, GITHUB_REPOSITORY could resolve to any repository at all.',
    );
  } else if (repository !== null && !String(repository).endsWith(`/${name}`)) {
    problems.push(
      `the policy's repository ${JSON.stringify(repository)} does not end in /${name}, so the two ` +
        'fields describe different repositories',
    );
  }

  const workflow = raw.workflow;
  if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)) {
    problems.push('the policy carries no workflow block, so it names no identity at all');
    return { policy: null, problems };
  }
  if (!WORKFLOW_PATH.test(String(workflow.path))) {
    problems.push(
      `the policy's workflow.path is ${JSON.stringify(workflow.path ?? null)}. It must be the ` +
        'repo-relative path of a file under .github/workflows/, because that is literally the ' +
        "string GitHub puts in the certificate's SAN.",
    );
  }
  if (typeof workflow.job !== 'string' || workflow.job.trim() === '') {
    problems.push(
      'the policy names no workflow.job. The certificate identity does not carry a job name, so ' +
        'this field does not tighten the signature — it is what the gate holds the `id-token: write` ' +
        'grant to, and without it "exactly one job may mint an OIDC token" has no subject.',
    );
  }
  if (!GIT_REF.test(String(workflow.ref))) {
    problems.push(
      `the policy's workflow.ref is ${JSON.stringify(workflow.ref ?? null)}, which is not a ` +
        'refs/heads/… or refs/tags/… ref. Wildcards are refused here on purpose: the ref is the ' +
        'part of the identity that says which code ran, and a pattern in it accepts a signature ' +
        'made from a branch nobody enumerated. See this file\'s header, "Exact identities only".',
    );
  }

  const rekor = raw.transparencyLog;
  if (rekor?.required !== true) {
    problems.push(
      'the policy does not require a transparency log. Keyless signing without Rekor throws away ' +
        'the property that makes it worth the exercise: without a public record that a certificate ' +
        'was issued at a time, a compromise of the workflow is not detectable after the fact — the ' +
        'exact residual the key-based posture is stuck with.',
    );
  }

  if (problems.length > 0) return { policy: null, problems };
  return {
    policy: {
      schema: raw.schema,
      issuer,
      repository,
      repositoryName: name,
      workflow: { path: workflow.path, job: workflow.job, ref: workflow.ref },
      transparencyLog: { required: true, url: rekor?.url ?? null },
    },
    problems,
  };
}

/**
 * The repository slug the policy applies to, and where that answer came from.
 *
 * This repository has **no git remote**, so nothing in the tree knows its own GitHub owner, and a
 * policy that invented one would be a policy that accepts nothing (safe) while reading as though it
 * had been reviewed (not safe). So `repository: null` is a legal, named state, and it is resolved
 * from the environment — `PRL_KEYLESS_REPOSITORY`, or `GITHUB_REPOSITORY` inside Actions — for the
 * one case that needs it: the workflow verifying its own signature on the run that made it.
 *
 * Two things bound that fallback, and both matter:
 *
 *   * the resolved slug must still end in the policy's `repositoryName`, so an ambient
 *     `GITHUB_REPOSITORY` cannot point the verification at an unrelated repository;
 *   * the caller is told the source, and `image-provenance.mjs` REFUSES a committed keyless record
 *     that needed the fallback — an outsider checking this repository offline has no environment to
 *     resolve, and a record only they cannot verify is not provenance.
 *
 * @param {object} policy
 * @param {Record<string, string|undefined>} env
 * @returns {{repository: string, source: string} | {problem: string}}
 */
export function resolveRepository(policy, env = process.env) {
  if (policy.repository !== null) return { repository: policy.repository, source: 'the committed policy' };
  const candidate = env.PRL_KEYLESS_REPOSITORY ?? env.GITHUB_REPOSITORY ?? null;
  const from = env.PRL_KEYLESS_REPOSITORY !== undefined ? 'PRL_KEYLESS_REPOSITORY' : 'GITHUB_REPOSITORY';
  if (candidate === null || candidate === '') {
    return {
      problem:
        `${KEYLESS_POLICY_PATH} carries "repository": null — this repository has no git remote, so ` +
        'no committed file knows its GitHub owner, and an identity cannot be built without one. ' +
        'Set the owner in the policy (one reviewed line) or, inside a workflow, let ' +
        'GITHUB_REPOSITORY resolve it.',
    };
  }
  if (!REPOSITORY_SLUG.test(candidate)) {
    return { problem: `${from} is ${JSON.stringify(candidate)}, which is not an owner/name slug` };
  }
  if (!candidate.endsWith(`/${policy.repositoryName}`)) {
    return {
      problem:
        `${from} is ${JSON.stringify(candidate)}, which is not a repository called ` +
        `${policy.repositoryName}. The environment may resolve an unknown OWNER; it may not choose ` +
        'a different repository to trust.',
    };
  }
  return { repository: candidate, source: `${from} (the policy names no owner)` };
}

/**
 * The certificate SAN GitHub mints for the workflow this policy names.
 *
 * This is the string `cosign verify --certificate-identity` is given, and the string a certificate
 * read back out of the registry has to carry. One function builds both so they cannot drift.
 */
export function expectedCertificateIdentity(policy, repository) {
  return `https://github.com/${repository}/${policy.workflow.path}@${policy.workflow.ref}`;
}

/**
 * Judges an identity/issuer pair — from a signature record, or read out of a real certificate —
 * against the policy.
 *
 * Separate and pure so the mismatch cases can be driven without a network: another owner, another
 * repository, another workflow file, another ref, another issuer. Each of those is a signature that
 * verifies perfectly against some Fulcio certificate and means nothing about this repository.
 *
 * @returns {string[]} problems; empty means the pair is the identity the policy demands
 */
export function identityProblems({ identity, issuer }, policy, repository) {
  const problems = [];
  const expected = expectedCertificateIdentity(policy, repository);
  if (typeof identity !== 'string' || identity === '') {
    problems.push(
      'the signature carries no certificate identity. A keyless signature with no identity is a ' +
        'signature by "some GitHub Actions job", which is not provenance.',
    );
  } else if (identity !== expected) {
    problems.push(
      `certificate identity ${identity}\n      policy demands   ${expected}\n      ` +
        'These differ, so the signature was made by a different workflow, in a different ' +
        "repository, or on a different ref. Fulcio issues a certificate to anybody's Actions job; " +
        'the identity is the entire difference between "signed" and "signed by this builder".',
    );
  }
  if (typeof issuer !== 'string' || issuer === '') {
    problems.push('the signature carries no OIDC issuer, so nothing says who asserted that identity');
  } else if (issuer !== policy.issuer) {
    problems.push(
      `certificate issuer ${issuer}\n      policy demands  ${policy.issuer}\n      ` +
        'An identity string is not self-authenticating: another provider can assert any subject it ' +
        "likes. The issuer is what makes the identity GitHub's statement rather than somebody else's.",
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Reading the identity back out of a certificate
// ---------------------------------------------------------------------------

/**
 * The SAN URI and the OIDC issuer of an X.509 certificate, read from the DER.
 *
 * `cosign verify --certificate-identity … --certificate-oidc-issuer …` already refuses a
 * certificate that does not match — measured, and demonstrated by the negative controls. This
 * exists for the same reason `verifiedDigests` in `image-signing.mjs` exists: the gate's claim is
 * "the signature was made by THIS workflow", and reading that back out of the certificate is the
 * difference between checking the claim and trusting a tool's exit code and the flags we happened
 * to pass it.
 *
 * Node's `X509Certificate` exposes the SAN and nothing else useful here, so the issuer extension is
 * located in the raw DER. The scan asserts the OID occurs exactly once: a certificate carrying two
 * issuer extensions is ambiguous, and a parser that silently took the first would be choosing which
 * claim to believe.
 *
 * @param {Buffer|string} certificate PEM or DER
 * @returns {{identity: string, issuer: string} | {problem: string}}
 */
export function certificateIdentity(certificate) {
  let parsed;
  try {
    parsed = new X509Certificate(certificate);
  } catch (err) {
    return { problem: `the signing certificate could not be parsed: ${err.message}` };
  }
  const san = String(parsed.subjectAltName ?? '');
  const uris = san
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('URI:'))
    .map((entry) => entry.slice('URI:'.length));
  if (uris.length !== 1) {
    return {
      problem:
        `the signing certificate carries ${uris.length} URI SAN entries (${san || 'none'}); a Fulcio ` +
        'workload certificate carries exactly one, and a certificate naming several identities is ' +
        'not one this gate will choose between',
    };
  }
  const v2 = derExtensionValue(parsed.raw, OID_ISSUER_V2);
  if ('problem' in v2) return v2;
  const v1 = derExtensionValue(parsed.raw, OID_ISSUER_V1);
  if ('problem' in v1) return v1;
  let issuer = null;
  if (v2.value !== null) {
    // Issuer (v2) is a DER UTF8String inside the extension's OCTET STRING: tag 0x0c, then length.
    const body = v2.value;
    if (body.length < 2 || body[0] !== 0x0c) {
      return { problem: "the certificate's Fulcio issuer (v2) extension is not a DER UTF8String" };
    }
    issuer = body.subarray(2).toString('utf8');
  } else if (v1.value !== null) {
    issuer = v1.value.toString('utf8');
  }
  if (issuer === null || issuer === '') {
    return {
      problem:
        'the signing certificate carries no Fulcio OIDC-issuer extension (1.3.6.1.4.1.57264.1.8 or ' +
        '.1.1), so nothing in it says which provider asserted the identity',
    };
  }
  return { identity: uris[0], issuer };
}

/**
 * The value bytes of one DER extension, located by its encoded OID.
 *
 * A byte scan rather than a full ASN.1 parser, and bounded accordingly: it requires the OID to
 * occur exactly once and to be followed by an optional critical BOOLEAN and then an OCTET STRING.
 * Anything else is reported as a problem rather than guessed at — this runs inside a security gate,
 * and a parser that recovers from surprising input is a parser that can be fed surprising input.
 */
function derExtensionValue(der, oid) {
  const first = der.indexOf(oid);
  if (first === -1) return { value: null };
  if (der.indexOf(oid, first + 1) !== -1) {
    return { problem: `the signing certificate carries the extension ${oid.toString('hex')} twice` };
  }
  let p = first + oid.length;
  if (der[p] === 0x01) p += 3; // critical BOOLEAN: 01 01 ff
  if (der[p] !== 0x04) {
    return { problem: 'a Fulcio issuer extension is not followed by an OCTET STRING' };
  }
  let length = der[p + 1];
  let offset = p + 2;
  if ((length & 0x80) !== 0) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) return { problem: 'an extension length this gate will not decode' };
    length = 0;
    for (let i = 0; i < count; i++) length = (length << 8) | der[offset + i];
    offset += count;
  }
  if (offset + length > der.length) return { problem: 'an extension length runs past the certificate' };
  return { value: der.subarray(offset, offset + length) };
}

/**
 * The certificate a cosign signature bundle carries.
 *
 * Sigstore bundles put it in one of two places depending on version: `certificate.rawBytes` for a
 * single certificate, `x509CertificateChain.certificates[0].rawBytes` for a chain. Both are read,
 * because reading one and reporting "no certificate" for the other would turn a shape difference
 * into a missing check.
 *
 * @param {unknown} bundle parsed bundle JSON
 * @returns {{der: Buffer} | {problem: string}}
 */
export function bundleCertificate(bundle) {
  const material = bundle?.verificationMaterial;
  const single = material?.certificate?.rawBytes;
  const chain = material?.x509CertificateChain?.certificates;
  const base64 = typeof single === 'string' ? single : chain?.[0]?.rawBytes;
  if (typeof base64 !== 'string' || base64 === '') {
    return {
      problem:
        'the signature bundle carries no signing certificate. A keyed signature has none, so this ' +
        'is what a KEY-posture signature looks like when something asked it for an identity.',
    };
  }
  return { der: Buffer.from(base64, 'base64') };
}

// ---------------------------------------------------------------------------
// The workflow, read as text
// ---------------------------------------------------------------------------

/**
 * Strips YAML comments so prose ABOUT a permission is not read as one.
 *
 * Both forms, as `ci-pinning.mjs` does: a whole-line comment, and a trailing ` # …`. The trailing
 * form matters here because this file's own headers discuss `id-token: write` in comments, and a
 * parser that read those would find grants that do not exist — which fails safe, and would still be
 * a gate nobody could keep green.
 */
function uncomment(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#')) return '';
  const hash = line.indexOf(' #');
  return hash === -1 ? line : line.slice(0, hash);
}
const indentOf = (line) => line.length - line.trimStart().length;

/**
 * The lines of a top-level block — `on:`, `permissions:`, `jobs:` — with the header line dropped.
 *
 * Line-based, like `ci-pinning.mjs`, and for the same reason: this repository parses its own
 * workflows with the standard library or not at all, because a YAML dependency inside a
 * supply-chain gate is a supply-chain dependency inside the thing that checks supply-chain
 * dependencies.
 */
function topLevelBlock(text, key) {
  const lines = text.split('\n').map(uncomment);
  const start = lines.findIndex((line) => new RegExp(`^['"]?${key}['"]?:`).test(line));
  if (start === -1) return null;
  const body = [];
  const inline = lines[start].slice(lines[start].indexOf(':') + 1).trim();
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (indentOf(lines[i]) === 0) break;
    body.push(lines[i]);
  }
  return { inline, body };
}

/** `name: value` pairs at one indentation level of a block. */
function pairsAt(body, indent) {
  const pairs = new Map();
  for (const line of body) {
    if (indentOf(line) !== indent) continue;
    const match = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (match === null) continue;
    pairs.set(match[1], (match[2] ?? '').trim());
  }
  return pairs;
}

/**
 * The structural facts a signing workflow's identity depends on.
 *
 * Deliberately a small, named set rather than a general YAML load: every field here is one the
 * policy is checked against, and a parser that returned more would invite checks that are not
 * about identity.
 *
 * @param {string} text
 * @returns {{triggers: string[], pushRefs: {tags: boolean, branches: boolean},
 *            topLevelPermissions: Map<string,string>, jobs: Map<string, Map<string,string>>}}
 */
export function parseWorkflowStructure(text) {
  const on = topLevelBlock(text, 'on');
  const triggers = [];
  const pushRefs = { tags: false, branches: false };
  if (on !== null) {
    if (on.inline !== '') {
      // `on: [push, pull_request]` or `on: push`
      for (const value of on.inline.replace(/^\[|\]$/g, '').split(',')) {
        const trimmed = value.trim();
        if (trimmed !== '') triggers.push(trimmed);
      }
    }
    const indent = Math.min(...on.body.map(indentOf).concat([Number.POSITIVE_INFINITY]));
    for (const [key] of pairsAt(on.body, indent)) triggers.push(key);
    for (const line of on.body) {
      if (/^\s*-\s*\S/.test(line) && indentOf(line) === indent) {
        const item = /^\s*-\s*(\S+)/.exec(line);
        if (item !== null) triggers.push(item[1]);
      }
    }
    // `push:` with a `tags:`/`branches:` filter — which ref a signature would carry.
    const pushIndex = on.body.findIndex((line) => indentOf(line) === indent && /^\s*push:/.test(line));
    if (pushIndex !== -1) {
      for (let i = pushIndex + 1; i < on.body.length; i++) {
        if (indentOf(on.body[i]) <= indent) break;
        if (/^\s*tags(-ignore)?:/.test(on.body[i])) pushRefs.tags = true;
        if (/^\s*branches(-ignore)?:/.test(on.body[i])) pushRefs.branches = true;
      }
      if (!pushRefs.tags && !pushRefs.branches) pushRefs.branches = true;
    }
  }

  const permissions = topLevelBlock(text, 'permissions');
  const topLevelPermissions =
    permissions === null
      ? new Map()
      : pairsAt(permissions.body, Math.min(...permissions.body.map(indentOf).concat([2])));

  const jobs = new Map();
  const jobsBlock = topLevelBlock(text, 'jobs');
  if (jobsBlock !== null) {
    const jobIndent = Math.min(...jobsBlock.body.map(indentOf).concat([2]));
    let current = null;
    let currentBody = [];
    const flush = () => {
      if (current === null) return;
      const start = currentBody.findIndex(
        (line) => indentOf(line) === jobIndent + 2 && /^\s*permissions:/.test(line),
      );
      const block = [];
      if (start !== -1) {
        for (let i = start + 1; i < currentBody.length; i++) {
          if (indentOf(currentBody[i]) <= jobIndent + 2) break;
          block.push(currentBody[i]);
        }
      }
      jobs.set(current, pairsAt(block, jobIndent + 4));
    };
    for (const line of jobsBlock.body) {
      const header = new RegExp(`^\\s{${jobIndent}}([A-Za-z_][\\w-]*):\\s*$`).exec(line);
      if (header !== null) {
        flush();
        current = header[1];
        currentBody = [];
        continue;
      }
      currentBody.push(line);
    }
    flush();
  }

  return { triggers: [...new Set(triggers)], pushRefs, topLevelPermissions, jobs };
}

/**
 * The gate's core: the committed policy and the workflow's ACTUAL identity must agree.
 *
 * This is the part that is fully checkable on a laptop with no network, and it is the part that
 * matters most, because every other control here is downstream of it. If the workflow is renamed,
 * moved, retriggered on a different ref, or grows a second job that can mint an OIDC token, then
 * either the identity the policy demands is no longer an identity anything can produce (signing
 * breaks loudly — survivable), or an identity nobody enumerated can now produce signatures the
 * policy accepts (silent, and the whole point of the exercise gone). This function fails on both
 * directions.
 *
 * @param {object} policy from `parseKeylessPolicy`
 * @param {{filename: string|null, text: string|null, declared: Iterable<string>}} workflow
 * @returns {string[]}
 */
export function workflowAgreementProblems(policy, { filename, text, declared }) {
  const problems = [];
  const expectedFile = policy.workflow.path.split('/').pop();
  if (filename === null || text === null) {
    problems.push(
      `the policy names ${policy.workflow.path} and no such workflow exists. The identity it ` +
        'demands can then never be minted by anything, so every keyless verification fails closed — ' +
        'but a policy pointing at a file nobody has is also how a rename quietly stops meaning what ' +
        'it says. Rename the policy and the workflow in one diff.',
    );
    return problems;
  }
  if (filename !== expectedFile) {
    problems.push(
      `the policy names ${policy.workflow.path} and the workflow read was ${filename}: the ` +
        'certificate SAN contains the file name verbatim, so these two must be the same string',
    );
  }
  if (![...declared].includes(expectedFile)) {
    problems.push(
      `${expectedFile} is not in EXPECTED_WORKFLOWS (scripts/supply-chain/denied-packages.mjs). ` +
        'The signing workflow is the one workflow in this repository that can mint an OIDC token; ' +
        'it must be declared like every other, so that adding or replacing it is a two-file diff.',
    );
  }

  const structure = parseWorkflowStructure(text);
  if (structure.jobs.size === 0) {
    problems.push(`${expectedFile} declares no jobs that this gate could read — it judged nothing`);
    return problems;
  }

  // Which ref can this workflow run on? `workflow_run` and `schedule` always run the default
  // branch's copy of the workflow, which is the only reason an EXACT identity is expressible here.
  const ref = policy.workflow.ref;
  if (structure.triggers.length === 0) {
    // A sweep of nothing is not a pass, and this one is worse than most: `[].every(…)` is TRUE, so
    // an `on:` block this parser could not read would sail through the default-branch check below
    // and report a workflow that can run on any ref as pinned to one.
    problems.push(
      `${expectedFile} declares no trigger this gate could read. It refuses to judge the ref rather ` +
        'than assuming one: an unreadable `on:` block and a correctly restricted one must not ' +
        'produce the same answer.',
    );
    return problems;
  }
  const defaultBranchOnly = structure.triggers.every((trigger) =>
    ['workflow_run', 'schedule', 'workflow_dispatch'].includes(trigger),
  );
  if (ref.startsWith('refs/heads/')) {
    if (!defaultBranchOnly) {
      problems.push(
        `the policy pins the identity to ${ref}, but ${expectedFile} is triggered by ` +
          `${structure.triggers.join(', ')} — an event that can run on another ref. A run on a ref ` +
          'the policy does not name produces a signature the verifier refuses (loud), and a policy ' +
          'later widened to cover it accepts signatures made from any branch a contributor can push ' +
          '(silent). Keep the trigger on the default branch.',
      );
    }
    if (structure.pushRefs.tags) {
      problems.push(
        `${expectedFile} is triggered by a tag push, so it can run with github.ref = refs/tags/…, ` +
          `which is not the ${ref} the policy demands`,
      );
    }
  }
  for (const forbidden of ['pull_request_target', 'pull_request']) {
    if (!structure.triggers.includes(forbidden)) continue;
    problems.push(
      `${expectedFile} is triggered by ${forbidden}. A workflow that can mint a signing identity ` +
        'must never run on a ref a contributor controls: `pull_request_target` runs with the base ' +
        "repository's permissions, and `pull_request` puts an attacker's code one `id-token` grant " +
        'away from a signature this repository vouches for.',
    );
  }

  // `id-token: write` — exactly one job, and never the workflow top level.
  if (structure.topLevelPermissions.get('id-token') === 'write') {
    problems.push(
      'id-token: write is granted at the WORKFLOW top level. Every job then inherits the ability to ' +
        "mint an OIDC token that Fulcio will bind to this repository's identity, including jobs that " +
        'install dependencies or run third-party actions. The grant belongs to the signing job alone.',
    );
  }
  const minting = [...structure.jobs.entries()]
    .filter(([, permissions]) => permissions.get('id-token') === 'write')
    .map(([name]) => name);
  if (minting.length === 0) {
    problems.push(
      `no job in ${expectedFile} declares id-token: write, so nothing in it can obtain the OIDC ` +
        'token keyless signing needs. Either the signing step cannot work, or it is signing with ' +
        'something else.',
    );
  } else if (minting.length > 1) {
    problems.push(
      `${minting.length} jobs in ${expectedFile} declare id-token: write (${minting.join(', ')}). ` +
        "Every one of them can mint a certificate carrying this workflow's identity, so the " +
        'identity no longer names one reviewed job.',
    );
  } else if (minting[0] !== policy.workflow.job) {
    problems.push(`the policy names job ${policy.workflow.job} and id-token: write is on job ${minting[0]}`);
  }
  if (!structure.jobs.has(policy.workflow.job)) {
    problems.push(`the policy names job ${policy.workflow.job}, which ${expectedFile} does not declare`);
  }

  // The workflow must take its identity FROM the policy rather than restating one.
  if (!text.includes(KEYLESS_POLICY_PATH)) {
    problems.push(
      `${expectedFile} never mentions ${KEYLESS_POLICY_PATH}. The workflow must assert the ` +
        'committed policy rather than a string of its own, or the two can disagree while both look ' +
        'correct in isolation — which is precisely the drift this gate exists to catch.',
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The signing side
// ---------------------------------------------------------------------------

/**
 * Refuses to attempt a keyless signature outside a job that can actually do one.
 *
 * `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` are injected by the runner
 * ONLY into a job that declares `id-token: write`. Their absence is the exact symptom of the
 * mistake this whole file is written against — a signing job whose permission block was edited —
 * and without this check cosign would instead open an interactive browser flow or fail deep inside
 * an OAuth device-code handshake, neither of which reads as "the workflow lost its grant".
 *
 * @returns {string[]}
 */
export function keylessPreflight(env = process.env) {
  const problems = [];
  if (env.GITHUB_ACTIONS !== 'true') {
    problems.push(
      'keyless signing was asked for outside GitHub Actions. The identity in a keyless signature IS ' +
        'the workflow; there is nothing for Fulcio to bind a certificate to on a workstation, and a ' +
        "certificate bound to a developer's email address is not what the policy demands. Use the " +
        'key-based signer locally: `pnpm run release:sign`.',
    );
  }
  if (env.ACTIONS_ID_TOKEN_REQUEST_URL === undefined || env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === undefined) {
    problems.push(
      'this job cannot request an OIDC token: ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN are unset, which ' +
        'is what a job WITHOUT `permissions: id-token: write` looks like from the inside. Grant it ' +
        'to this job — never at the workflow top level.',
    );
  }
  return problems;
}
