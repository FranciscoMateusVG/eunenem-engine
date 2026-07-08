import { describe, expect, it } from 'vitest';
import { trustedClientIp } from '../../../apps/eunenem-server/server/lib/security/trusted-client-ip.js';

/**
 * aperture-rcjms — regression + correctness for the X-Forwarded-For extractor.
 *
 * A reverse proxy appends the OBSERVED PEER's IP (client or previous proxy),
 * NOT its own address. So `trustedHopCount` trusted proxies contribute the
 * rightmost N entries, and the real client is the leftmost of that trusted
 * suffix — index `entries.length - trustedHopCount`. The old code used
 * `length - 1 - hop`, an off-by-one that resolved EVERY single-Traefik
 * request (XFF=[client], hop=1) to 'unknown'.
 */
describe('trustedClientIp', () => {
  describe('fallback / disabled', () => {
    it('returns "unknown" when trustedHopCount is 0 (dev, no proxy)', () => {
      expect(trustedClientIp({ 'x-forwarded-for': '203.0.113.7' }, 0)).toBe('unknown');
    });

    it('returns "unknown" for a negative trustedHopCount', () => {
      expect(trustedClientIp({ 'x-forwarded-for': '203.0.113.7' }, -1)).toBe('unknown');
    });

    it('returns "unknown" when there is no X-Forwarded-For header', () => {
      expect(trustedClientIp({}, 1)).toBe('unknown');
    });

    it('returns "unknown" for an empty / whitespace-only XFF', () => {
      expect(trustedClientIp({ 'x-forwarded-for': '' }, 1)).toBe('unknown');
      expect(trustedClientIp({ 'x-forwarded-for': '   ,  ' }, 1)).toBe('unknown');
    });
  });

  describe('single trusted hop (our Traefik topology)', () => {
    it('THE REGRESSION: single-entry XFF, hop=1 → returns the real client (was "unknown")', () => {
      expect(trustedClientIp({ 'x-forwarded-for': '203.0.113.7' }, 1)).toBe('203.0.113.7');
    });

    it('forged leading entry is NEVER picked — returns the rightmost (proxy-observed) IP', () => {
      // Attacker sends XFF: "1.2.3.4"; Traefik appends the real observed peer.
      expect(trustedClientIp({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }, 1)).toBe('203.0.113.7');
    });

    it('trims surrounding whitespace on the picked entry', () => {
      expect(trustedClientIp({ 'x-forwarded-for': '  203.0.113.9  ' }, 1)).toBe('203.0.113.9');
    });
  });

  describe('two trusted hops (e.g. Cloudflare → Traefik → app)', () => {
    it('no forgery: [client, edge] hop=2 → returns the leftmost (client)', () => {
      expect(trustedClientIp({ 'x-forwarded-for': '203.0.113.7, 198.51.100.2' }, 2)).toBe(
        '203.0.113.7',
      );
    });

    it('forged prefix: [forged, client, edge] hop=2 → returns the real client (index 1)', () => {
      expect(trustedClientIp({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7, 198.51.100.2' }, 2)).toBe(
        '203.0.113.7',
      );
    });
  });

  describe('misconfiguration guard', () => {
    it('returns "unknown" when XFF has fewer entries than trustedHopCount', () => {
      // hop=2 but only one entry present → chain didn't traverse the expected
      // trusted hops → fail closed rather than mis-trust.
      expect(trustedClientIp({ 'x-forwarded-for': '203.0.113.7' }, 2)).toBe('unknown');
    });
  });

  describe('header source variants', () => {
    it('reads from a Headers instance', () => {
      const h = new Headers();
      h.set('X-Forwarded-For', '1.2.3.4, 203.0.113.7');
      expect(trustedClientIp(h, 1)).toBe('203.0.113.7');
    });

    it('is case-insensitive on the header name for plain records', () => {
      expect(trustedClientIp({ 'X-Forwarded-For': '203.0.113.7' }, 1)).toBe('203.0.113.7');
    });

    it('filters empty entries from a trailing-comma chain', () => {
      // [forged, client, ""] filtered → [forged, client]; hop=1 → client.
      expect(trustedClientIp({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7, ' }, 1)).toBe(
        '203.0.113.7',
      );
    });
  });
});
