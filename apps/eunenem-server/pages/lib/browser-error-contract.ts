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
