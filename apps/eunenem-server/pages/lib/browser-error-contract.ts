const PUBLIC_BROWSER_DSN =
  /^https:\/\/[A-Za-z0-9]{16,128}@[A-Za-z0-9.-]{1,253}(?::[1-9][0-9]{0,4})?\/[A-Za-z0-9._/-]{1,160}$/;
const RELEASE = /^artifact-sha256:[0-9a-f]{64}$/;

export interface BrowserErrorRuntimeConfig {
  readonly browserErrorDsn?: string;
  readonly release?: string;
}

export interface ValidBrowserErrorConfig {
  readonly dsn: string;
  readonly release: string;
}

export function browserErrorRuntimeConfigFromEnv(input: {
  readonly browserDsn?: string;
  readonly release?: string;
  readonly serverDsn?: string;
}): BrowserErrorRuntimeConfig {
  if (!input.browserDsn) return {};
  const config = validateBrowserErrorConfig({
    browserErrorDsn: input.browserDsn,
    release: input.release,
  });
  if (!config) return {};

  try {
    if (input.serverDsn && new URL(input.serverDsn).href === new URL(config.dsn).href) return {};
  } catch {
    // The server DSN is never projected. An invalid server-only value cannot
    // make an independently valid, dedicated browser DSN public.
  }
  return { browserErrorDsn: config.dsn, release: config.release };
}

/**
 * Validate the only two values allowed to cross the server/browser boundary.
 *
 * A Sentry-compatible browser DSN contains a public ingestion key in the URL
 * username. Passwords, query strings and fragments are deliberately rejected;
 * the server-only GLITCHTIP_DSN is never passed to this function.
 */
export function validateBrowserErrorConfig(
  input: BrowserErrorRuntimeConfig | undefined,
): ValidBrowserErrorConfig | null {
  if (!input) return null;
  const { browserErrorDsn, release } = input;
  if (
    typeof browserErrorDsn !== 'string' ||
    browserErrorDsn.length > 512 ||
    !PUBLIC_BROWSER_DSN.test(browserErrorDsn) ||
    typeof release !== 'string' ||
    !RELEASE.test(release)
  ) {
    return null;
  }

  try {
    const parsed = new URL(browserErrorDsn);
    if (
      parsed.protocol !== 'https:' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return { dsn: browserErrorDsn, release };
}

// ── Handled checkout failures (aperture-zlkbo) ────────────────────────────
//
// The checkout catch paths render a banner and never throw to the window, so
// they need an explicit, closed report. Only these finite labels cross into
// the browser error envelope: never the error message, slug, campaign id,
// contributor identity, URL or storage key.

/** tRPC error codes (TRPC_ERROR_CODES_BY_KEY). Anything else is `unknown`. */
const TRPC_CODES = [
  'PARSE_ERROR',
  'BAD_REQUEST',
  'INTERNAL_SERVER_ERROR',
  'NOT_IMPLEMENTED',
  'BAD_GATEWAY',
  'SERVICE_UNAVAILABLE',
  'GATEWAY_TIMEOUT',
  'UNAUTHORIZED',
  'PAYMENT_REQUIRED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_SUPPORTED',
  'TIMEOUT',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNPROCESSABLE_CONTENT',
  'TOO_MANY_REQUESTS',
  'CLIENT_CLOSED_REQUEST',
] as const;

type TrpcCode = (typeof TRPC_CODES)[number];

export type CheckoutFailureCategory =
  | 'storage_unavailable'
  | 'crypto_unavailable'
  | 'cooldown'
  | 'network'
  | `trpc_${Lowercase<TrpcCode>}`
  | 'unknown';

/**
 * Where the central orchestration failed:
 * - `local`: storage key digest, sessionStorage, operation id, local cooldown
 *   (before any request);
 * - `prepare` / `confirm`: first / second tRPC request;
 * - `result`: handling a received response (server-ordered cooldown, an
 *   operation still unconfirmed after the second request).
 */
export type CheckoutFailureStep = 'local' | 'prepare' | 'confirm' | 'result';
export type CheckoutFailureMethod = 'pix' | 'card';

export interface CheckoutFailureReport {
  readonly category: CheckoutFailureCategory;
  readonly step: CheckoutFailureStep;
  readonly method: CheckoutFailureMethod;
  /**
   * In-memory dedupe identity for one checkout operation. Used only to
   * suppress repeats; it is never copied into the event.
   */
  readonly operationKey: string;
}

export type ValidCheckoutFailure = Omit<CheckoutFailureReport, 'operationKey'>;

const CHECKOUT_FAILURE_CATEGORIES: ReadonlySet<string> = new Set<CheckoutFailureCategory>([
  'storage_unavailable',
  'crypto_unavailable',
  'cooldown',
  'network',
  'unknown',
  ...TRPC_CODES.map((code) => `trpc_${code.toLowerCase()}` as CheckoutFailureCategory),
]);
const CHECKOUT_FAILURE_STEPS: ReadonlySet<string> = new Set<CheckoutFailureStep>([
  'local',
  'prepare',
  'confirm',
  'result',
]);
const CHECKOUT_FAILURE_METHODS: ReadonlySet<string> = new Set<CheckoutFailureMethod>([
  'pix',
  'card',
]);

/** Finite `trpc_<code>` category, or null for a missing/unknown code. */
export function checkoutFailureTrpcCategory(code: unknown): CheckoutFailureCategory | null {
  return typeof code === 'string' && (TRPC_CODES as readonly string[]).includes(code)
    ? (`trpc_${code.toLowerCase()}` as CheckoutFailureCategory)
    : null;
}

/**
 * Closed projection of a checkout failure report. Reads exactly three
 * fields; an unknown category collapses to `unknown` (the failure is still
 * real), while an unknown step/method rejects the report.
 */
export function validateCheckoutFailure(input: unknown): ValidCheckoutFailure | null {
  if (typeof input !== 'object' || input === null) return null;
  const { category, step, method } = input as Record<string, unknown>;
  if (typeof step !== 'string' || !CHECKOUT_FAILURE_STEPS.has(step)) return null;
  if (typeof method !== 'string' || !CHECKOUT_FAILURE_METHODS.has(method)) return null;
  return {
    category:
      typeof category === 'string' && CHECKOUT_FAILURE_CATEGORIES.has(category)
        ? (category as CheckoutFailureCategory)
        : 'unknown',
    step: step as CheckoutFailureStep,
    method: method as CheckoutFailureMethod,
  };
}
