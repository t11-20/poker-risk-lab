/**
 * The identity half of image signing: which workflow signed, not which key.
 * Fulcio issues a certificate to any GitHub Actions job, so a keyless signature is provenance only
 * when verification demands the exact workflow URI and the exact OIDC issuer. Both come from the
 * committed `deploy/signing/keyless-policy.json`, never from a flag or the environment.
 * Exact identities only, no `--certificate-identity-regexp`. The signer is `workflow_run`-triggered,
 * so it always runs on the default branch and has one ref. The measured cosign refusals are in
 * `node scripts/supply-chain/image-provenance.mjs --negative-control`.
 */

import { X509Certificate } from 'node:crypto';

export const KEYLESS_POLICY_PATH = 'deploy/signing/keyless-policy.json';

export const KEYLESS_POLICY_SCHEMA = 'prl.keyless-identity-policy.v1';

// Pinned so the policy is checked against it. A different issuer on a github.com workflow URI
// would accept a certificate GitHub did not vouch for.
export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

// `1.3.6.1.4.1.57264.1.8` is issuer v2 (a DER UTF8String). `1.3.6.1.4.1.57264.1.1` is the
// deprecated raw string. Both are read, v2 first, because cosign matches against either.
const OID_ISSUER_V2 = Buffer.from('060a2b0601040183bf300108', 'hex');
const OID_ISSUER_V1 = Buffer.from('060a2b0601040183bf300101', 'hex');

const REPOSITORY_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;

// Wildcards are refused. See the header.
const GIT_REF = /^refs\/(heads|tags)\/[A-Za-z0-9._\-/]+$/;

/**
 * Validates the committed policy. Pure, so tests can drive well-formed policies that are too wide.
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
 * The repository has no git remote, so `repository: null` is legal and is resolved from
 * `PRL_KEYLESS_REPOSITORY` or `GITHUB_REPOSITORY`. The resolved slug must end in `repositoryName`.
 * `keyless-provenance.mjs` refuses a committed keyless record while the owner is null.
 * `image-provenance.mjs` only warns, so its trusted identity then comes from the environment.
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

// One function builds the `--certificate-identity` value and the string a certificate must carry.
export function expectedCertificateIdentity(policy, repository) {
  return `https://github.com/${repository}/${policy.workflow.path}@${policy.workflow.ref}`;
}

/**
 * Pure, so the mismatch cases run without a network.
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

/**
 * The SAN URI and OIDC issuer read from the DER, so the gate checks the certificate itself rather
 * than cosign's exit code. `X509Certificate` does not expose the issuer extension, so it is found in
 * the raw DER and must occur exactly once.
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

// A byte scan, not an ASN.1 parser. The OID must occur once, followed by an optional critical
// BOOLEAN and an OCTET STRING. Anything else is a problem, not a guess.
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
 * Reads `certificate.rawBytes` or `x509CertificateChain.certificates[0].rawBytes`, which differ by
 * bundle version.
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

// Strips whole-line and trailing ` # …` YAML comments, so prose about a permission is not a grant.
function uncomment(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#')) return '';
  const hash = line.indexOf(' #');
  return hash === -1 ? line : line.slice(0, hash);
}
const indentOf = (line) => line.length - line.trimStart().length;

// Line-based, to keep a YAML dependency out of a supply-chain gate.
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

const unquote = (value) => value.trim().replace(/^(['"])([\s\S]*)\1$/, '$2');

function pairsAt(body, indent) {
  const pairs = new Map();
  for (const line of body) {
    if (indentOf(line) !== indent) continue;
    const match = /^\s*['"]?([A-Za-z_][\w-]*)['"]?:\s*(.*)$/.exec(line);
    if (match === null) continue;
    pairs.set(match[1], unquote(match[2] ?? ''));
  }
  return pairs;
}

// The wildcard `permissions: write-all` sets. `grantsIdTokenWrite` checks for it.
const ALL_SCOPES = '*';

/**
 * A `permissions:` value in every shape GitHub accepts: block mapping, flow mapping, quoted keys or
 * values, and `write-all`. A block-only parser returned no grant for the other four shapes.
 * `write-all` is recorded as `*`, because GitHub's scope list changes.
 *
 * @param {string} inline text after the colon on the `permissions:` line itself
 * @param {string[]} body the block's lines, when it has one
 * @param {number} indent the indentation the block's pairs sit at
 */
function permissionsFrom(inline, body, indent) {
  const scalar = unquote(inline);
  if (scalar === 'write-all') return new Map([[ALL_SCOPES, 'write']]);
  if (scalar === 'read-all') return new Map([[ALL_SCOPES, 'read']]);
  if (scalar.startsWith('{')) {
    const pairs = new Map();
    for (const entry of scalar.replace(/^\{|\}$/g, '').split(',')) {
      const match = /^\s*['"]?([A-Za-z_][\w-]*)['"]?\s*:\s*(.*)$/.exec(entry);
      if (match !== null) pairs.set(match[1], unquote(match[2] ?? ''));
    }
    return pairs;
  }
  return pairsAt(body, indent);
}

/**
 * Both readers ask this one function, so they learn new shapes together.
 *
 * @param {Map<string,string>} permissions
 */
export function grantsIdTokenWrite(permissions) {
  return permissions.get('id-token') === 'write' || permissions.get(ALL_SCOPES) === 'write';
}

/**
 * Only the fields the policy is checked against.
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
      : permissionsFrom(
          permissions.inline,
          permissions.body,
          Math.min(...permissions.body.map(indentOf).concat([2])),
        );

  const jobs = new Map();
  const jobsBlock = topLevelBlock(text, 'jobs');
  if (jobsBlock !== null) {
    const jobIndent = Math.min(...jobsBlock.body.map(indentOf).concat([2]));
    let current = null;
    let currentBody = [];
    const flush = () => {
      if (current === null) return;
      const start = currentBody.findIndex(
        (line) => indentOf(line) === jobIndent + 2 && /^\s*['"]?permissions['"]?:/.test(line),
      );
      if (start === -1) {
        jobs.set(current, new Map());
        return;
      }
      const header = currentBody[start];
      const block = [];
      for (let i = start + 1; i < currentBody.length; i++) {
        if (indentOf(currentBody[i]) <= jobIndent + 2) break;
        block.push(currentBody[i]);
      }
      // These forms put the grant on the header line and leave an empty block.
      jobs.set(current, permissionsFrom(header.slice(header.indexOf(':') + 1), block, jobIndent + 4));
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
 * The committed policy and the workflow's actual identity must agree. A rename or retrigger makes
 * signing fail. A second job that can mint a token would let an unlisted identity sign. Both fail here.
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

  // `workflow_run` and `schedule` always run the default branch's copy, so an exact ref works.
  const ref = policy.workflow.ref;
  if (structure.triggers.length === 0) {
    // `[].every(…)` is true, so an unread `on:` block would pass the default-branch check.
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

  // `id-token: write` in exactly one job, and never at the workflow top level.
  if (grantsIdTokenWrite(structure.topLevelPermissions)) {
    problems.push(
      'id-token: write is granted at the WORKFLOW top level. Every job then inherits the ability to ' +
        "mint an OIDC token that Fulcio will bind to this repository's identity, including jobs that " +
        'install dependencies or run third-party actions. The grant belongs to the signing job alone.',
    );
  }
  const minting = [...structure.jobs.entries()]
    .filter(([, permissions]) => grantsIdTokenWrite(permissions))
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

/**
 * The runner injects `ACTIONS_ID_TOKEN_REQUEST_URL` and `_TOKEN` only into a job with
 * `id-token: write`. Without this check cosign would start an interactive OAuth flow instead.
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
