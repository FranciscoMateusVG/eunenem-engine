import { hashPassword, verifyPassword } from 'better-auth/crypto';

/**
 * Fixed bogus plaintext used only to build a real Better Auth scrypt hash.
 * The resulting hash is process-local and never persisted.
 */
const DUMMY_PASSWORD_PLAINTEXT = 'aperture-olgk2-dummy-password-do-not-use';

/**
 * Lazily memoized so the one-time hash creation follows Better Auth's current
 * scrypt parameters without adding a second password hash to every request.
 */
let dummyPasswordHashPromise: Promise<string> | undefined;

function getDummyPasswordHash(): Promise<string> {
  if (dummyPasswordHashPromise === undefined) {
    dummyPasswordHashPromise = hashPassword(DUMMY_PASSWORD_PLAINTEXT);
  }
  return dummyPasswordHashPromise;
}

/**
 * Pay one real Better Auth password-verification cost without authenticating
 * any principal. Callers use this before returning an intentionally ambiguous
 * credential error on branches that otherwise have no account hash to verify.
 */
export async function consumeDummyPasswordVerificationWork(password: string): Promise<void> {
  const dummyHash = await getDummyPasswordHash();
  await verifyPassword({ hash: dummyHash, password });
}
