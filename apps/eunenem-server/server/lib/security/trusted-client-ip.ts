/**
 * Resolve the trusted client IP from the request headers
 * (aperture-uc2ix / aperture-3pqt7).
 *
 * **Why "trusted-hop":** X-Forwarded-For is a comma-separated chain of
 * IPs prepended by each proxy on the way to the origin. The LEFTMOST
 * entry is the client-claimed IP — anyone can spoof it by sending an
 * X-Forwarded-For header on their own request. The RIGHTMOST entries
 * are added by trusted hops (our reverse proxy, cloud load balancer,
 * etc.) AFTER they've observed the real source. Reading the rightmost
 * entry that we control gives a non-spoofable IP.
 *
 * The `trustedHopCount` is the number of HOPS between the origin server
 * and the public internet that we control. For example:
 *   - Dev (no proxy): trustedHopCount = 0 → no XFF is trusted; we fall
 *     back to "unknown"
 *   - Single reverse proxy (Dokploy / Nginx): trustedHopCount = 1 → the
 *     rightmost XFF entry is what the proxy observed = real source IP
 *   - Cloudflare → Nginx → app: trustedHopCount = 2 → use the second-from-
 *     right XFF entry
 *
 * Pick wrong = security failure. Setting it too HIGH means an attacker can
 * spoof IPs by inserting forged entries (they appear "before" the trusted
 * hops and get picked up). Setting it too LOW means treating untrusted
 * client-supplied entries as authoritative. The env var should be set
 * per-deployment based on actual topology.
 *
 * **Fallback:** if no XFF or trustedHopCount is 0, returns `"unknown"`.
 * Callers MUST treat "unknown" as a valid bucket key (otherwise dev
 * environments without a proxy will throw on every request). Hashing
 * "unknown" with the salt produces a deterministic hash that all dev
 * requests share — fine for rate-limit testing, not great for forensic
 * correlation. Production deploys MUST set TRUSTED_HOP_COUNT ≥ 1 so
 * the buckets per-client.
 *
 * Source spec: aperture-ebspa security review H2 + H3, Cipher 2026-05-30.
 */
export function trustedClientIp(
  headers: Headers | Record<string, string | undefined>,
  trustedHopCount: number,
): string {
  if (trustedHopCount <= 0) return 'unknown';

  const xff = readHeader(headers, 'x-forwarded-for');
  if (!xff) return 'unknown';

  // Comma-separated chain, oldest (leftmost = client-claimed) → newest
  // (rightmost = last hop before us). We trust `trustedHopCount` entries
  // counted from the right.
  const entries = xff
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) return 'unknown';

  // The "real" client IP is the (count+1)-th from the right — that's the
  // last entry NOT injected by one of our trusted hops. Example with
  // trustedHopCount=1: entries=[client, proxy] → return client (index 0
  // from left = index 1 from right). For trustedHopCount=2: entries=
  // [client, edge, app] → return client (index 0 from left = index 2
  // from right).
  const indexFromRight = trustedHopCount;
  const indexFromLeft = entries.length - 1 - indexFromRight;
  if (indexFromLeft < 0) {
    // Caller said "trust N hops" but XFF doesn't have N+1 entries.
    // Could be: (a) misconfigured TRUSTED_HOP_COUNT, (b) request bypassed
    // the proxy chain somehow, (c) attacker manually setting XFF on a
    // direct request. Safer to return "unknown" than to mis-trust.
    return 'unknown';
  }
  const candidate = entries[indexFromLeft];
  return candidate && candidate.length > 0 ? candidate : 'unknown';
}

function readHeader(
  headers: Headers | Record<string, string | undefined>,
  name: string,
): string | null {
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  // Lowercased lookup — header keys are case-insensitive.
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      return headers[key] ?? null;
    }
  }
  return null;
}
