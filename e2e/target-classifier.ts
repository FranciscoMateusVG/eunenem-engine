/**
 * aperture-odyxd — exact-host target classifier for the E2E suite.
 *
 * WHY THIS EXISTS. The previous classifier (playwright.config.ts) was:
 *
 *   !/localhost|127\.0\.0\.1/.test(process.env.E2E_BASE_URL)
 *
 * an UNANCHORED substring match tested against the WHOLE URL — not the
 * hostname. Any URL merely *containing* the text "localhost" or "127.0.0.1"
 * anywhere, including in a query string or fragment, was classified LOCAL.
 * Verified misclassifications (all real remote targets read as local):
 *
 *   https://staging.eunenem.com/?redirect=localhost
 *   https://localhost.attacker.example
 *   https://eunenem.test.pocketsoftware.com.br#localhost
 *   https://127.0.0.1.evil.example
 *   https://my-localhost-staging.eunenem.com
 *
 * Appending "#localhost" to the real staging URL was enough to flip a
 * deployed target into the permissive branch. Since eunenem staging now
 * carries live Stripe keys AND live production Inter payout credentials by
 * standing operator risk acceptance — and a real R$10 payout succeeded on
 * 2026-09-04 — a misclassification here can move real money.
 *
 * DESIGN RULE: FAIL CLOSED. The two error directions are not symmetric.
 *   local misread as remote  → a test is blocked. Annoying. Safe.
 *   remote misread as local  → real money can move. Catastrophic.
 * Every ambiguous case therefore resolves to REMOTE.
 *
 * This module is deliberately PURE: no env reads, no I/O, no Playwright
 * imports. It takes a string and returns a verdict, so it is trivially
 * testable and has exactly one job.
 */

/**
 * Hostnames treated as local. EXACT matches only, after normalisation.
 *
 * Deliberately narrow. Other loopback addresses (127.0.0.2, etc.) are NOT
 * included: they classify as remote, which only ever blocks a run. This is
 * not a regression — the previous substring regex matched the literal
 * "127.0.0.1" only, so those addresses were already treated as remote.
 * Widen this set only if a real workflow needs it, never to unblock a
 * misconfigured URL.
 */
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

/** Why a verdict was reached. Surfaced in logs so the branch is never invisible. */
export type TargetVerdictReason =
  /** No E2E_BASE_URL supplied — the suite spawns its own local server. */
  | 'unset-default-local'
  /** Parsed hostname matched LOCAL_HOSTNAMES exactly. */
  | 'exact-local-host'
  /** Parsed cleanly and is genuinely not local. */
  | 'remote-host'
  /** Unparseable or hostname-less. Fails CLOSED → treated as remote. */
  | 'malformed-fail-closed';

/** Playwright's existing fallback when no E2E_BASE_URL is supplied. */
export const DEFAULT_LOCAL_BASE_URL = 'http://localhost:3002';

export type TargetVerdict = {
  /**
   * Parsed hostname, normalised (lowercased, IPv6 brackets stripped, single
   * trailing dot removed). EMPTY STRING when the input was unparseable —
   * check `reason === 'malformed-fail-closed'` to detect that case.
   *
   * SAFE TO LOG: this is the host only. It deliberately never carries the
   * query, fragment, userinfo/credentials, port or path.
   */
  readonly hostname: string;
  /** True only for an exact local-hostname match, or an unset target. */
  readonly isLocal: boolean;
  /**
   * The base URL a caller should actually use.
   * - unset    → DEFAULT_LOCAL_BASE_URL (Playwright's existing default)
   * - parseable → the trimmed input
   * - malformed → EMPTY STRING. Deliberately not the raw value: a malformed
   *   target is unusable, and returning the raw risks it being logged or
   *   dialled downstream. Callers must refuse to proceed on an empty baseUrl.
   */
  readonly baseUrl: string;
  /** Whether a non-empty E2E_BASE_URL was supplied at all. */
  readonly provided: boolean;
  /** Precise cause, so exclusion messages can say WHY rather than just "blocked". */
  readonly reason: TargetVerdictReason;
};

/**
 * Normalise a URL hostname for exact comparison.
 * - lowercases (URL already does, but be explicit — this is a security check)
 * - strips the [] wrapper the URL parser puts around IPv6 literals
 * - strips ONE trailing dot (the FQDN root form: "localhost." === "localhost")
 *
 * Trailing-dot stripping does not open a hole: "localhost.attacker.example."
 * normalises to "localhost.attacker.example", which is still not in the set.
 */
function normaliseHostname(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  if (host.endsWith('.')) {
    host = host.slice(0, -1);
  }
  return host;
}

/**
 * Classify an E2E target URL as local or remote by EXACT HOSTNAME.
 *
 * @param raw the raw E2E_BASE_URL value (or undefined/null when unset)
 *
 * Behaviour:
 * - unset / empty / whitespace-only → local. This is the documented default:
 *   Playwright falls back to http://localhost:3002 and spawns its own server.
 * - a value the URL parser rejects → REMOTE (fail closed).
 * - a value that parses but yields no hostname (e.g. "localhost:3002" with no
 *   scheme, which parses as protocol "localhost:") → REMOTE (fail closed).
 *   Supply a full URL including the scheme.
 * - otherwise → exact hostname match against LOCAL_HOSTNAMES.
 */
export function classifyTarget(raw: string | undefined | null): TargetVerdict {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return {
      hostname: 'localhost',
      isLocal: true,
      baseUrl: DEFAULT_LOCAL_BASE_URL,
      provided: false,
      reason: 'unset-default-local',
    };
  }

  const trimmed = raw.trim();
  const failClosed: TargetVerdict = {
    hostname: '',
    isLocal: false,
    baseUrl: '',
    provided: true,
    reason: 'malformed-fail-closed',
  };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Unparseable. We cannot prove it is local, so it is remote.
    return failClosed;
  }

  const hostname = normaliseHostname(parsed.hostname);
  if (hostname === '') {
    // Parsed, but no host component (e.g. a scheme-less "localhost:3002").
    return failClosed;
  }

  return {
    hostname,
    isLocal: LOCAL_HOSTNAMES.has(hostname),
    baseUrl: trimmed,
    provided: true,
    reason: LOCAL_HOSTNAMES.has(hostname) ? 'exact-local-host' : 'remote-host',
  };
}

/**
 * Render a verdict as a single log line.
 *
 * PRIVACY CONTRACT: emits the HOSTNAME and the VERDICT only. Never the full
 * URL, query, fragment, port, path or userinfo — query strings can carry
 * tokens, and the fragment is the exact vector the old regex was defeated by.
 * A malformed target logs no host at all, only that it failed closed.
 *
 * Callers log this unconditionally on every run: an invisible classification
 * is how a substring regex survived this long unnoticed.
 */
export function formatTargetVerdict(verdict: TargetVerdict): string {
  const host = verdict.hostname === '' ? '<unparseable>' : verdict.hostname;
  const mode = verdict.isLocal ? 'LOCAL' : 'REMOTE';
  return `[e2e-target] host=${host} verdict=${mode} reason=${verdict.reason}`;
}

/**
 * Emit the verdict to stdout. Thin wrapper over `formatTargetVerdict` so the
 * privacy-sensitive string construction stays independently testable while
 * callers get a one-line side-effecting helper.
 *
 * Call this UNCONDITIONALLY at Playwright startup, on every run. An invisible
 * classification is precisely how the old substring regex survived unnoticed:
 * nothing ever printed which branch had been taken.
 */
export function logTargetVerdict(verdict: TargetVerdict): void {
  // eslint-disable-next-line no-console -- deliberate: this line is the audit trail.
  console.log(formatTargetVerdict(verdict));
}
