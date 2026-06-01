import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashClientPII } from '../../src/observability/hash-client-pii.js';

/**
 * Regression test for aperture-j0ccg.
 *
 * THE BUG: a fresh checkout with default `.env` (LOG_PII_HASH_SALT empty)
 * caused `POST /api/trpc/auth.signIn` and `auth.signUp` to 500. Root
 * cause was `hashClientPII` throwing on empty salt regardless of
 * environment, while the env-validation refinement enforced ≥32 chars
 * only in production. The dev path went through validation with an
 * empty salt and then crashed at first auth request.
 *
 * THE FIX: `hashClientPII` gracefully degrades in non-production
 * environments — returns a clearly-marked `unhashed:<value>` string
 * instead of throwing. Production posture is unchanged: the env-
 * validation `superRefine` still rejects empty salt at boot, AND
 * `hashClientPII` still throws at call time as a second line of defense.
 *
 * This test replays the EXACT four call-site shapes from
 * `apps/eunenem-server/server/trpc/auth-router.ts` (signUp + signIn,
 * each producing ipHashed + emailHash) with an empty salt and asserts
 * each call returns a string instead of throwing. If a future
 * regression reintroduces the throw, every assertion here will fire —
 * a tight pin against the original 500.
 *
 * Lives in `tests/integration/` because it pins a system-level posture
 * (the auth router contract under default dev `.env`), not a pure
 * function contract (that's `tests/unit/hash-client-pii.test.ts`).
 */
describe('eunenem-server auth router — empty-salt regression (aperture-j0ccg)', () => {
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (savedNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = savedNodeEnv;
    }
  });

  describe('dev mode (NODE_ENV=development, default local-dev)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
    });

    it('auth.signUp call-site shape: hashes IP + email with empty deps.logPiiHashSalt without throwing', () => {
      // Reproduces auth-router.ts:228-229 exactly:
      //   const ipHashed   = hashClientPII(rawIp, deps.logPiiHashSalt);
      //   const emailHash  = hashClientPII(input.email, deps.logPiiHashSalt);
      const emptySalt = '';
      const ipHashed = hashClientPII('203.0.113.45', emptySalt);
      const emailHash = hashClientPII('user@example.com', emptySalt);

      expect(ipHashed).toBe('unhashed:203.0.113.45');
      expect(emailHash).toBe('unhashed:user@example.com');
      // Both values are usable as rate-limit-key fragments —
      // `trpc:signUp:${ipHashed}` works fine with the marker prefix.
      expect(`trpc:signUp:${ipHashed}`).toBe('trpc:signUp:unhashed:203.0.113.45');
    });

    it('auth.signIn call-site shape: hashes IP + email with empty deps.logPiiHashSalt without throwing', () => {
      // Reproduces auth-router.ts:333-334 exactly. Same shape, different
      // rate-limit-key composition downstream.
      const emptySalt = '';
      const ipHashed = hashClientPII('198.51.100.7', emptySalt);
      const emailHash = hashClientPII('mariana@example.com', emptySalt);

      expect(ipHashed).toBe('unhashed:198.51.100.7');
      expect(emailHash).toBe('unhashed:mariana@example.com');
      expect(`trpc:signIn:${ipHashed}:${emailHash}`).toBe(
        'trpc:signIn:unhashed:198.51.100.7:unhashed:mariana@example.com',
      );
    });

    it('empty IP (unknown trustedClientIp) still short-circuits to empty regardless of salt', () => {
      // Edge case: trustedClientIp can return '' when proxy headers
      // are missing in dev. The empty-input branch precedes the
      // empty-salt branch in the function — verify it still wins.
      expect(hashClientPII('', '')).toBe('');
    });
  });

  describe('production posture (NODE_ENV=production)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('still throws on empty salt — production cannot reach this branch if env validation passed, but defense-in-depth holds', () => {
      // ServerEnvSchema.superRefine should reject empty salt at boot in
      // production. If anyone ever bypasses env validation, this throw
      // is the second line of defense.
      expect(() => hashClientPII('user@example.com', '')).toThrow(/LOG_PII_HASH_SALT/);
    });

    it('with a real salt, produces deterministic sha256 hex (call-site shape unchanged)', () => {
      const salt = 'prod-grade-salt-thirty-two-chars-cccccccccccccccc';
      const hash = hashClientPII('user@example.com', salt);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
