import { createHash } from 'node:crypto';

/**
 * Hash client-side PII (email, IP) with a per-deployment salt so log dumps
 * and forensic queries can correlate attempts without storing raw values
 * (aperture-3pqt7 / T9 banked lesson).
 *
 * **Why salted sha256 (not bcrypt/argon2):** these aren't passwords; they're
 * stable identifiers we need to group + match in O(1) on every request.
 * Bcrypt would gate our request throughput on hashing cost. Salted sha256
 * is the right tool for log-correlation hashing — fast, deterministic,
 * collision-resistant enough that two different IPs/emails won't be
 * confused, but pre-image-resistant enough that an attacker who exfiltrates
 * logs can't reverse a hash back to the original.
 *
 * **Salt discipline:** the salt MUST be a per-deployment secret (env var
 * `LOG_PII_HASH_SALT`, ≥32 chars). Hash output is `${salt}|${value}` hashed
 * with sha256 → hex. Empty input returns empty string (so callers don't
 * have to null-check before logging; an unknown IP just hashes as `""`).
 *
 * **What it does NOT solve:** if an attacker exfiltrates BOTH the salt
 * AND the log dump, they can brute-force common IPs / common emails.
 * Salt rotation breaks correlation across rotations (intentional —
 * old-hash and new-hash for the same value differ). Treat the salt as
 * tier-1 secret material alongside session signing keys.
 */
export function hashClientPII(value: string, salt: string): string {
  if (value.length === 0) return '';
  if (salt.length === 0) {
    throw new Error('hashClientPII: salt must be non-empty (set LOG_PII_HASH_SALT in env).');
  }
  return createHash('sha256').update(`${salt}|${value}`).digest('hex');
}
