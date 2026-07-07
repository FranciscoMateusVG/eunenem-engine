import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  criarClerkBridgeClient,
  resolverLegacyOrigin,
} from '../../apps/eunenem-server/server/legacy-bridge.js';

/**
 * aperture-legacy-origin-fix — the compose wires LEGACY_SITE_ORIGIN as an EMPTY
 * STRING when unset (`${LEGACY_SITE_ORIGIN:-}`), and `?? default` would let ''
 * through → a RELATIVE `/minha-area` fallback → 404 on the new domain (the prod
 * break the operator hit). resolverLegacyOrigin must trim + `||`-default so the
 * fallback is ALWAYS an absolute old-site URL.
 */
describe('resolverLegacyOrigin (empty-string env safety)', () => {
  it('empty string → default absolute origin (NOT a relative fallback)', () => {
    expect(resolverLegacyOrigin({ LEGACY_SITE_ORIGIN: '' })).toBe('https://eunenem.com');
  });
  it('whitespace-only → default', () => {
    expect(resolverLegacyOrigin({ LEGACY_SITE_ORIGIN: '   ' })).toBe('https://eunenem.com');
  });
  it('unset (undefined) → default', () => {
    expect(resolverLegacyOrigin({})).toBe('https://eunenem.com');
  });
  it('a real value is honored (trimmed)', () => {
    expect(resolverLegacyOrigin({ LEGACY_SITE_ORIGIN: '  https://staging.eunenem.com  ' })).toBe(
      'https://staging.eunenem.com',
    );
  });
});

/**
 * aperture-as0v3 — UNIT pins for the Clerk Backend API client used by the
 * legacy bridge. These cover the two load-bearing security filters (Cipher
 * aperture-92oax checklist #7 + #8) with a mocked fetch — no network, no
 * sk_live. The full handler decision table is pinned in the Postgres
 * integration test; the session-revoke hooks in the sunl9 suite.
 *
 * SECURITY (why these matter): findVerifiedUserByEmail is the gate that decides
 * WHOSE legacy account we mint a login for. A Clerk match on an UNVERIFIED
 * address, or picking one of several matching users, would let the bridge log
 * someone into the wrong 1.0 account. The filter must be verified-only and
 * fail-closed on ambiguity.
 */

const SK = 'sk_test_fake_do_not_use';
const CLERK_USERS = 'https://api.clerk.com/v1/users';
const CLERK_TOKENS = 'https://api.clerk.com/v1/sign_in_tokens';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A Clerk user with a single email address at a chosen verification status. */
function clerkUser(id: string, email: string, status: 'verified' | 'unverified') {
  return { id, email_addresses: [{ email_address: email, verification: { status } }] };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('criarClerkBridgeClient.findVerifiedUserByEmail (aperture-as0v3 #7)', () => {
  it('sends the sk as a Bearer token and email as a query param', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([clerkUser('u1', 'a@x.com', 'verified')]));
    await criarClerkBridgeClient(SK).findVerifiedUserByEmail('a@x.com');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/users?email_address=');
    expect(url).toContain(encodeURIComponent('a@x.com'));
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SK}`);
  });

  it('found: exactly one user with the target email VERIFIED → { found, userId }', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([clerkUser('user_123', 'a@x.com', 'verified')]));
    const out = await criarClerkBridgeClient(SK).findVerifiedUserByEmail('a@x.com');
    expect(out).toEqual({ kind: 'found', userId: 'user_123' });
  });

  it('⭐ UNVERIFIED match is NOT accepted → { none } (a Clerk match on an unverified address proves nothing)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([clerkUser('u1', 'a@x.com', 'unverified')]));
    const out = await criarClerkBridgeClient(SK).findVerifiedUserByEmail('a@x.com');
    expect(out).toEqual({ kind: 'none' });
  });

  it('match is on the TARGET address, not "any verified address on the user"', async () => {
    // User has a DIFFERENT verified address + the target address UNVERIFIED →
    // must NOT match (the verified address isn't the one we're bridging).
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 'u1',
          email_addresses: [
            { email_address: 'other@x.com', verification: { status: 'verified' } },
            { email_address: 'a@x.com', verification: { status: 'unverified' } },
          ],
        },
      ]),
    );
    const out = await criarClerkBridgeClient(SK).findVerifiedUserByEmail('a@x.com');
    expect(out).toEqual({ kind: 'none' });
  });

  it('is case-insensitive on the email match', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([clerkUser('u1', 'A@X.com', 'verified')]));
    const out = await criarClerkBridgeClient(SK).findVerifiedUserByEmail('a@x.com');
    expect(out).toEqual({ kind: 'found', userId: 'u1' });
  });

  it('⭐ MULTIPLE users with the target email verified → { ambiguous } (fail closed, never pick-first)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        clerkUser('u1', 'a@x.com', 'verified'),
        clerkUser('u2', 'a@x.com', 'verified'),
      ]),
    );
    const out = await criarClerkBridgeClient(SK).findVerifiedUserByEmail('a@x.com');
    expect(out).toEqual({ kind: 'ambiguous' });
  });

  it('empty result set → { none }', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    expect(await criarClerkBridgeClient(SK).findVerifiedUserByEmail('a@x.com')).toEqual({
      kind: 'none',
    });
  });

  it('non-ok Clerk response throws (handler maps this to the fallback redirect)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 500));
    await expect(criarClerkBridgeClient(SK).findVerifiedUserByEmail('a@x.com')).rejects.toThrow();
  });
});

describe('criarClerkBridgeClient.mintSignInToken (aperture-as0v3 #8)', () => {
  it('POSTs user_id + expires_in_seconds=60 (short single-use TTL) and returns the token', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ token: 'clrk_ticket_abc', object: 'sign_in_token' }),
    );
    const token = await criarClerkBridgeClient(SK).mintSignInToken('user_123');
    expect(token).toBe('clrk_ticket_abc');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CLERK_TOKENS);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SK}`);
    expect(JSON.parse(init.body as string)).toEqual({
      user_id: 'user_123',
      expires_in_seconds: 60,
    });
  });

  it('throws when Clerk returns no token (handler → fallback)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ object: 'sign_in_token' }));
    await expect(criarClerkBridgeClient(SK).mintSignInToken('user_123')).rejects.toThrow();
  });

  it('throws on non-ok mint response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'x' }, 422));
    await expect(criarClerkBridgeClient(SK).mintSignInToken('user_123')).rejects.toThrow();
  });

  void CLERK_USERS;
});
