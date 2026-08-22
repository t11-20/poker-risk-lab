/**
 * The age gate's pure decisions: what is gated, what counts as a declaration, and where a reader
 * may be sent afterwards.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Yes, and it was checked rather than assumed. Every group below has a **negative control**: an
 * input that the obvious wrong implementation accepts and the real one refuses, plus — for the two
 * checks where the wrong implementation is a one-word change — an actual demonstration that the
 * wrong implementation would have accepted it. So the assertions discriminate between the two
 * rather than merely passing against the current code.
 *
 * The three that matter most, and the defect each one is standing in front of:
 *
 *  1. **Substring cookie matching.** `cookieHeader.includes('prl_age_check')` is the natural way to
 *     write `hasAgeDeclaration` and it is wrong: a cookie named `not_prl_age_check` or
 *     `prl_age_check_backup` — set by anything else on the origin, or by a reader with a console —
 *     would open every gated route. `guest-bootstrap.test.ts` guards the same class of bug on the
 *     session cookie, for the same reason and with the same shape of test.
 *  2. **Substring path matching.** `pathname.startsWith('/play')` matches `/playground`, and
 *     `startsWith('/terms')` matches `/terms-and-conditions`. The first gates a route nobody meant
 *     to gate; the second opens one, since the legal routes are the always-open list.
 *  3. **The return parameter.** `?next=` is attacker-controlled in the ordinary sense — anyone can
 *     send anyone a link — so `safeReturnPath` is an open-redirect check. `//evil.test` and
 *     `/\evil.test` are both read by browsers as another origin.
 *
 * ## What is asserted elsewhere
 *
 * That the proxy wires these into a real response — the redirect status, the `Set-Cookie` reaching
 * the browser, the RSC-navigation case — needs a running Next server and belongs to a browser-level
 * harness. Nothing here can prove a cookie arrived; what it proves is that the decisions the proxy
 * makes from are the right ones.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGE_GATE_COOKIE_NAMES,
  AGE_GATE_DECLARE_PARAM,
  AGE_GATE_DEFAULT_MINIMUM,
  AGE_GATE_DEFAULT_RETURN,
  AGE_GATE_MAX_AGE_SECONDS,
  AGE_GATE_MINIMUM_CEILING,
  AGE_GATE_MINIMUM_FLOOR,
  AGE_GATE_PATH,
  AGE_GATE_RETURN_PARAM,
  type AgeGateConfig,
  ageCheckLocation,
  ageDeclarationCookie,
  decideAgeGate,
  declarationValue,
  hasAgeDeclaration,
  pathNeedsAgeGate,
  readAgeGateConfig,
  readDeclaredAge,
  safeReturnPath,
} from '../src/lib/age-gate.ts';

/** A config as `readAgeGateConfig` would produce it, so no test invents a shape by hand. */
const configFor = (env: Readonly<Record<string, string | undefined>>): AgeGateConfig =>
  readAgeGateConfig(env);

const ON = configFor({ PRL_AGE_GATE: 'on' });
const OFF = configFor({});

describe('the shipped configuration is no gate, and it says so rather than defaulting to a number', () => {
  it('is off, and reports that nobody has decided rather than that somebody decided off', () => {
    // `configured` is the load-bearing half. The pages render an unmissable "not set" notice from
    // it, which is what makes shipping without a gate an honest state instead of a silent one.
    assert.equal(OFF.mode, 'off');
    assert.equal(OFF.configured, false);
    assert.deepEqual(OFF.problems, []);
  });

  it('treats an explicit off as a decision', () => {
    const explicit = configFor({ PRL_AGE_GATE: 'off' });
    assert.equal(explicit.mode, 'off');
    assert.equal(explicit.configured, true);
  });

  it('accepts on, and defaults the threshold rather than inventing a jurisdiction', () => {
    assert.equal(ON.mode, 'on');
    assert.equal(ON.minimumAge, AGE_GATE_DEFAULT_MINIMUM);
    assert.equal(ON.scope, 'play');
    assert.equal(ON.jurisdiction, null);
  });
});

describe('an unreadable setting fails towards the gate, never away from it', () => {
  it('shows the gate when the mode is not a mode', () => {
    // The negative control for the whole "fail closed" property: if this ever resolves to `off`,
    // a typo in a deployment's environment silently removes the gate and nothing reports it.
    const broken = configFor({ PRL_AGE_GATE: 'yes-please' });
    assert.equal(broken.mode, 'on');
    assert.ok(broken.problems.length > 0, 'a misconfiguration must be reported, not absorbed');
  });

  it('widens to the whole site when the scope is not a scope', () => {
    const broken = configFor({ PRL_AGE_GATE: 'on', PRL_AGE_GATE_SCOPE: 'tables' });
    assert.equal(broken.scope, 'site');
    assert.ok(broken.problems.length > 0);
  });

  it('clamps an out-of-range threshold instead of dropping back to the default', () => {
    // 211 is the mistyped 21. Falling back to 18 would be a LOWER threshold than the deployer
    // asked for, which is the one direction a misconfiguration must never move a gate.
    const high = configFor({ PRL_AGE_GATE: 'on', PRL_AGE_GATE_MINIMUM_AGE: '211' });
    assert.equal(high.minimumAge, AGE_GATE_MINIMUM_CEILING);
    assert.ok(high.problems.length > 0);

    const low = configFor({ PRL_AGE_GATE: 'on', PRL_AGE_GATE_MINIMUM_AGE: '4' });
    assert.equal(low.minimumAge, AGE_GATE_MINIMUM_FLOOR);
    assert.ok(low.problems.length > 0);
  });

  it('refuses a threshold that is not a decimal whole number', () => {
    // `Number('0x12')` is 18 and `Number('1e2')` is 100. Neither is a threshold anybody typed.
    for (const raw of ['0x12', '1e2', 'eighteen', '18.5', '-18', ' ']) {
      const parsed = configFor({ PRL_AGE_GATE: 'on', PRL_AGE_GATE_MINIMUM_AGE: raw });
      assert.equal(parsed.minimumAge, AGE_GATE_DEFAULT_MINIMUM, `"${raw}" must not set a threshold`);
    }
  });

  it('accepts a real threshold unchanged and reports nothing', () => {
    const set = configFor({ PRL_AGE_GATE: 'on', PRL_AGE_GATE_MINIMUM_AGE: '21' });
    assert.equal(set.minimumAge, 21);
    assert.deepEqual(set.problems, []);
  });
});

describe('the jurisdiction label is cleaned before it can reach a page', () => {
  it('keeps an ordinary label', () => {
    const set = configFor({ PRL_AGE_GATE: 'on', PRL_AGE_GATE_JURISDICTION: '  United Kingdom  ' });
    assert.equal(set.jurisdiction, 'United Kingdom');
  });

  it('strips the characters that make one string render as another', () => {
    // A right-to-left override in an operator-supplied label can reverse the sentence around it on
    // a page whose whole job is to be read literally. React escapes markup; it does not do this.
    const hostile = configFor({
      PRL_AGE_GATE: 'on',
      PRL_AGE_GATE_JURISDICTION: 'Nowhere\u202ereal\u200b\u0007',
    });
    assert.equal(hostile.jurisdiction, 'Nowherereal');
  });

  it('reports a label that cleaned away to nothing rather than silently ignoring it', () => {
    const empty = configFor({ PRL_AGE_GATE: 'on', PRL_AGE_GATE_JURISDICTION: '\u200b\u200b' });
    assert.equal(empty.jurisdiction, null);
    assert.ok(empty.problems.length > 0);
  });

  it('truncates rather than letting an unbounded value into the layout', () => {
    const long = configFor({ PRL_AGE_GATE: 'on', PRL_AGE_GATE_JURISDICTION: 'x'.repeat(400) });
    assert.ok((long.jurisdiction ?? '').length <= 80);
  });
});

describe('which paths sit behind the gate', () => {
  it('covers the simulated tables under the default scope', () => {
    for (const path of ['/play', '/play/', '/play/room-1']) {
      assert.equal(pathNeedsAgeGate(path, 'play'), true, `${path} must be gated`);
    }
  });

  it('leaves the written material alone under the default scope', () => {
    // Gating a lesson on probability behind an age question is not proportionate to anything, and
    // `/record` is a reader's own record of what they read.
    for (const path of ['/', '/learn', '/learn/pot-odds', '/lab', '/legends', '/review', '/record']) {
      assert.equal(pathNeedsAgeGate(path, 'play'), false, `${path} must not be gated`);
    }
  });

  it('covers everything except the documents under the site scope', () => {
    for (const path of ['/', '/learn', '/lab', '/legends', '/review', '/record', '/play']) {
      assert.equal(pathNeedsAgeGate(path, 'site'), true, `${path} must be gated under site scope`);
    }
  });

  it('never gates the documents or the gate itself, under either scope', () => {
    // The documents being reachable is a property, not a convenience: a reader has to be able to
    // read what is stored about them BEFORE being asked to declare something about themselves.
    for (const scope of ['play', 'site'] as const) {
      for (const path of [AGE_GATE_PATH, '/terms', '/privacy', '/responsible-use']) {
        assert.equal(pathNeedsAgeGate(path, scope), false, `${path} must stay open under ${scope}`);
      }
    }
  });

  it('matches whole segments, not substrings — the negative control', () => {
    // `/playground` under a `startsWith('/play')` test would be gated by accident, and
    // `/terms-and-conditions` under a `startsWith('/terms')` test would be treated as always-open,
    // which is the more dangerous of the two.
    assert.equal(pathNeedsAgeGate('/playground', 'play'), false);
    assert.equal(pathNeedsAgeGate('/playing-cards', 'play'), false);
    assert.equal(pathNeedsAgeGate('/terms-and-conditions', 'site'), true);
    assert.equal(pathNeedsAgeGate('/privacy-notice', 'site'), true);

    // And the demonstration that those inputs discriminate: the naive implementation accepts them.
    const naive = (pathname: string, prefix: string): boolean => pathname.startsWith(prefix);
    assert.equal(naive('/playground', '/play'), true, 'the wrong implementation gates /playground');
    assert.equal(naive('/terms-and-conditions', '/terms'), true, 'and opens /terms-and-conditions');
  });
});

describe('reading a declaration out of a cookie header', () => {
  it('reads the threshold under either cookie name', () => {
    for (const name of AGE_GATE_COOKIE_NAMES) {
      assert.equal(readDeclaredAge(`${name}=18`), 18);
      assert.equal(readDeclaredAge(`prl_csrf=x; ${name}=21; other=1`), 21);
      assert.equal(readDeclaredAge(` ${name} = 18 `), 18);
    }
  });

  it('is not fooled by a cookie whose name merely contains the gate cookie name', () => {
    // THE negative control. A substring match here opens every gated route to anything that can
    // set a cookie on this origin, which includes the reader's own console.
    const impostors = [
      'not_prl_age_check=18',
      'prl_age_check_backup=18',
      'x__Host-prl_age_check=18',
      'prl_age_checkx=18',
      'my_prl_age_check=99',
    ];
    for (const header of impostors) {
      assert.equal(readDeclaredAge(header), null, `${header} must not be read as a declaration`);
      assert.equal(hasAgeDeclaration(header, 18), false, `${header} must not open the gate`);
    }

    // The demonstration that these inputs discriminate: the wrong implementation lets all of them
    // through, so this group would genuinely have caught the bug rather than merely agreeing with
    // the code as written.
    const naive = (header: string): boolean => AGE_GATE_COOKIE_NAMES.some((name) => header.includes(name));
    for (const header of impostors) {
      assert.equal(naive(header), true, `the wrong implementation accepts ${header}`);
    }
  });

  it('ignores a value that is not a plain number', () => {
    assert.equal(readDeclaredAge('prl_age_check=yes'), null);
    assert.equal(readDeclaredAge('prl_age_check='), null);
    assert.equal(readDeclaredAge('prl_age_check=18a'), null);
    assert.equal(readDeclaredAge('=18'), null);
    assert.equal(readDeclaredAge(''), null);
    assert.equal(readDeclaredAge(null), null);
  });

  it('takes the lower value when both names are present', () => {
    // A gate, not a credential: the conservative answer to an ambiguous declaration is to ask
    // again. `session-cookie-names.ts` orders the prefixed name first because it is choosing a
    // credential, which is a different question.
    assert.equal(readDeclaredAge('__Host-prl_age_check=21; prl_age_check=13'), 13);
  });

  it('re-asks when the deployment raises its threshold', () => {
    // The reason the cookie stores the threshold rather than a flag. A boolean cookie would have
    // carried every existing reader straight past a threshold they never answered.
    assert.equal(hasAgeDeclaration('prl_age_check=18', 18), true);
    assert.equal(hasAgeDeclaration('prl_age_check=18', 21), false);
    assert.equal(hasAgeDeclaration('prl_age_check=21', 18), true);
  });
});

describe('the cookie the declaration writes', () => {
  it('uses the prefixed name and Secure only over TLS', () => {
    const secure = ageDeclarationCookie(18, true);
    assert.match(secure, /^__Host-prl_age_check=18;/u);
    assert.match(secure, /; Secure$/u);
    // `__Host-` is only honoured with Path=/ and no Domain. Getting this wrong is not a subtlety:
    // the browser drops the cookie and the gate asks again on every request for ever.
    assert.match(secure, /; Path=\//u);
    assert.doesNotMatch(secure, /Domain=/u);
  });

  it('uses the plain name over plain HTTP, because a Secure cookie there is discarded', () => {
    const plain = ageDeclarationCookie(18, false);
    assert.match(plain, /^prl_age_check=18;/u);
    assert.doesNotMatch(plain, /Secure/u);
  });

  it('is unreachable from script and survives a link from another site', () => {
    const cookie = ageDeclarationCookie(21, true);
    assert.match(cookie, /; HttpOnly/u);
    // `Lax` and not `Strict`: a reader arriving from a link elsewhere must land already past the
    // gate, or their declaration was worth nothing to them.
    assert.match(cookie, /; SameSite=Lax/u);
    assert.match(cookie, new RegExp(`; Max-Age=${String(AGE_GATE_MAX_AGE_SECONDS)}`, 'u'));
  });

  it('records the threshold that was declared against', () => {
    assert.match(ageDeclarationCookie(25, false), /^prl_age_check=25;/u);
    assert.equal(declarationValue(25), '25');
  });
});

describe('where a reader may be sent after declaring', () => {
  it('keeps an ordinary local path, query string and all', () => {
    assert.equal(safeReturnPath('/play'), '/play');
    assert.equal(
      safeReturnPath('/play?profile=nit&difficulty=realistic'),
      '/play?profile=nit&difficulty=realistic',
    );
  });

  it('refuses everything that could leave this origin — the negative control', () => {
    // Each of these is a real open redirect if `next` is echoed into a Location header. `//host`
    // and `/\host` are both read as scheme-relative by browsers, which is the one that gets missed.
    for (const hostile of [
      '//evil.test/phish',
      '/\\evil.test/phish',
      'https://evil.test',
      'http://evil.test',
      'javascript:alert(1)',
      '//evil.test',
      'evil.test',
      '',
    ]) {
      assert.equal(safeReturnPath(hostile), AGE_GATE_DEFAULT_RETURN, `${hostile} must be refused`);
    }
    assert.equal(safeReturnPath(null), AGE_GATE_DEFAULT_RETURN);
  });

  it('refuses a path carrying a control character, which is how a header is split', () => {
    assert.equal(safeReturnPath('/play\r\nSet-Cookie: x=1'), AGE_GATE_DEFAULT_RETURN);
    assert.equal(safeReturnPath('/play\u0000'), AGE_GATE_DEFAULT_RETURN);
  });

  it('refuses a path back to the gate, which would be a loop', () => {
    assert.equal(safeReturnPath(AGE_GATE_PATH), AGE_GATE_DEFAULT_RETURN);
    assert.equal(safeReturnPath(`${AGE_GATE_PATH}?next=/play`), AGE_GATE_DEFAULT_RETURN);
  });

  it('refuses an absurdly long path rather than putting it in a header', () => {
    assert.equal(safeReturnPath(`/play?x=${'a'.repeat(600)}`), AGE_GATE_DEFAULT_RETURN);
  });
});

describe('the challenge location', () => {
  it('carries the path the reader asked for', () => {
    const location = ageCheckLocation('/play', '');
    const params = new URLSearchParams(location.slice(location.indexOf('?')));
    assert.ok(location.startsWith(`${AGE_GATE_PATH}?`));
    assert.equal(params.get(AGE_GATE_RETURN_PARAM), '/play');
  });

  it('keeps a real query string and drops the router’s own parameter', () => {
    // `_rsc` is appended by Next on a router navigation. Sending a reader back to a URL carrying it
    // would ask for an RSC payload as a document, which is a blank screen at the end of a working
    // gate.
    const location = ageCheckLocation('/play', '?profile=nit&_rsc=abc123');
    const params = new URLSearchParams(location.slice(location.indexOf('?')));
    assert.equal(params.get(AGE_GATE_RETURN_PARAM), '/play?profile=nit');
  });

  it('round-trips through the check that guards the way back', () => {
    const location = ageCheckLocation('/play', '?profile=nit');
    const params = new URLSearchParams(location.slice(location.indexOf('?')));
    assert.equal(safeReturnPath(params.get(AGE_GATE_RETURN_PARAM)), '/play?profile=nit');
  });
});

describe('the decision the proxy makes', () => {
  const request = (over: {
    readonly pathname: string;
    readonly search?: string;
    readonly cookieHeader?: string | null;
    readonly navigation?: boolean;
    readonly secure?: boolean;
    readonly config?: AgeGateConfig;
  }) => ({
    pathname: over.pathname,
    search: over.search ?? '',
    cookieHeader: over.cookieHeader ?? null,
    navigation: over.navigation ?? true,
    secure: over.secure ?? false,
    config: over.config ?? ON,
  });

  it('allows everything while the gate is off', () => {
    for (const pathname of ['/play', '/learn', '/']) {
      assert.equal(decideAgeGate(request({ pathname, config: OFF })).kind, 'allow');
    }
  });

  it('challenges a gated path with no declaration', () => {
    const outcome = decideAgeGate(request({ pathname: '/play', search: '?profile=nit' }));
    assert.equal(outcome.kind, 'challenge');
    assert.ok(outcome.kind === 'challenge');
    assert.ok(outcome.location.startsWith(`${AGE_GATE_PATH}?`));
    assert.match(outcome.location, /profile%3Dnit/u);
  });

  it('allows a gated path once a good-enough declaration is present', () => {
    const outcome = decideAgeGate(request({ pathname: '/play', cookieHeader: 'prl_age_check=18' }));
    assert.equal(outcome.kind, 'allow');
  });

  it('challenges again when the threshold has moved above the declaration', () => {
    const raised = configFor({ PRL_AGE_GATE: 'on', PRL_AGE_GATE_MINIMUM_AGE: '21' });
    const outcome = decideAgeGate(
      request({ pathname: '/play', cookieHeader: 'prl_age_check=18', config: raised }),
    );
    assert.equal(outcome.kind, 'challenge');
  });

  it('never fires on a prefetch or a subresource', () => {
    // The proxy decides this from the request headers; here it is the parameter. A gate that fired
    // on a prefetch would put a redirect into the router's cache for a page nobody opened.
    const outcome = decideAgeGate(request({ pathname: '/play', navigation: false }));
    assert.equal(outcome.kind, 'allow');
  });

  it('accepts a declaration for the current threshold and sends the reader onward', () => {
    const search = `?${AGE_GATE_DECLARE_PARAM}=18&${AGE_GATE_RETURN_PARAM}=${encodeURIComponent('/play?profile=nit')}`;
    const outcome = decideAgeGate(request({ pathname: AGE_GATE_PATH, search, secure: true }));
    assert.ok(outcome.kind === 'accepted');
    assert.equal(outcome.location, '/play?profile=nit');
    assert.match(outcome.setCookie, /^__Host-prl_age_check=18;/u);
  });

  it('ignores a declaration for a threshold this deployment no longer uses', () => {
    // A bookmarked or shared `?declare=18` stops working the moment the deployment moves to 21,
    // rather than quietly admitting somebody under the new threshold.
    const raised = configFor({ PRL_AGE_GATE: 'on', PRL_AGE_GATE_MINIMUM_AGE: '21' });
    const outcome = decideAgeGate(
      request({ pathname: AGE_GATE_PATH, search: `?${AGE_GATE_DECLARE_PARAM}=18`, config: raised }),
    );
    assert.equal(outcome.kind, 'allow', 'the question is simply re-rendered');
  });

  it('never redirects a declaration back to the gate', () => {
    const search = `?${AGE_GATE_DECLARE_PARAM}=18&${AGE_GATE_RETURN_PARAM}=${encodeURIComponent('//evil.test')}`;
    const outcome = decideAgeGate(request({ pathname: AGE_GATE_PATH, search }));
    assert.ok(outcome.kind === 'accepted');
    assert.equal(outcome.location, AGE_GATE_DEFAULT_RETURN);
  });

  it('renders the gate page itself without looping', () => {
    const outcome = decideAgeGate(request({ pathname: AGE_GATE_PATH }));
    assert.equal(outcome.kind, 'allow');
  });
});
