import { describe, expect, it } from 'vitest';
import { hashClientPII } from '../../src/observability/hash-client-pii.js';

describe('hashClientPII (aperture-3pqt7)', () => {
  const SALT = 'test-salt-thirty-two-chars-aaaaaaaaaaaaaaa';

  it('returns empty string for empty input (callers do not have to null-check)', () => {
    expect(hashClientPII('', SALT)).toBe('');
  });

  it('throws when salt is empty (guard against forgotten env var)', () => {
    expect(() => hashClientPII('user@example.com', '')).toThrow(/LOG_PII_HASH_SALT/);
  });

  it('is deterministic — same input + same salt produces same hash', () => {
    const a = hashClientPII('user@example.com', SALT);
    const b = hashClientPII('user@example.com', SALT);
    expect(a).toBe(b);
  });

  it('changes when salt rotates (correlation breaks across rotations, intentionally)', () => {
    const before = hashClientPII('user@example.com', SALT);
    const after = hashClientPII('user@example.com', 'different-salt-thirty-two-chars-bbbbbbb');
    expect(after).not.toBe(before);
  });

  it('differentiates distinct inputs', () => {
    const a = hashClientPII('user-a@example.com', SALT);
    const b = hashClientPII('user-b@example.com', SALT);
    expect(a).not.toBe(b);
  });

  it('produces a stable-length sha256 hex output (64 chars)', () => {
    const a = hashClientPII('user@example.com', SALT);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashes IPs and emails into the same shape (caller-side semantics)', () => {
    const ipHash = hashClientPII('203.0.113.45', SALT);
    const emailHash = hashClientPII('user@example.com', SALT);
    // Both consumed as opaque hex strings — caller does not need to
    // distinguish IP-shaped from email-shaped hashes downstream.
    expect(ipHash).toMatch(/^[a-f0-9]{64}$/);
    expect(emailHash).toMatch(/^[a-f0-9]{64}$/);
    expect(ipHash).not.toBe(emailHash);
  });

  it('salt is mixed in (changing only the value, not the salt, produces different hash)', () => {
    // Sanity: implementation must use salt+value, not just hash(value).
    // If salt were ignored, every same-value call would collide across
    // salts. This test guards against that regression.
    const a = hashClientPII('user@example.com', SALT);
    const b = hashClientPII('user@example.com', SALT.split('').reverse().join(''));
    expect(a).not.toBe(b);
  });
});
