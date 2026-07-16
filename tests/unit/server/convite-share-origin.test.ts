/**
 * aperture-ejghb — getDefaultConviteShareOrigin must resolve to the LIVE domain,
 * never a hardcoded (dead) host. In the browser the canonical origin is
 * window.location.origin; the non-browser fallback is env-driven.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDefaultConviteShareOrigin } from '../../../apps/eunenem-server/pages/lib/convite-share.js';

const originalWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
  vi.unstubAllEnvs();
});

function stubWindow(origin: string): void {
  (globalThis as { window?: unknown }).window = { location: { origin } };
}

describe('getDefaultConviteShareOrigin (aperture-ejghb)', () => {
  it('uses window.location.origin in the browser — whatever the live domain is', () => {
    stubWindow('https://eunenem.test.pocketsoftware.com.br');
    expect(getDefaultConviteShareOrigin()).toBe('https://eunenem.test.pocketsoftware.com.br/');
  });

  it('preserves an existing trailing slash without doubling it', () => {
    stubWindow('https://app.eunenem.com/');
    expect(getDefaultConviteShareOrigin()).toBe('https://app.eunenem.com/');
  });

  it('never returns the dead xerox host from a browser origin', () => {
    stubWindow('https://app.eunenem.com');
    expect(getDefaultConviteShareOrigin()).not.toContain('xeroxtoxerox');
  });

  it('falls back to localhost in dev/test when there is no window', () => {
    delete (globalThis as { window?: unknown }).window;
    vi.stubEnv('NODE_ENV', 'development');
    expect(getDefaultConviteShareOrigin()).toBe('http://localhost:3001/');
  });

  it('falls back to EUNENEM_PUBLIC_ORIGIN (env-driven) in production SSR', () => {
    delete (globalThis as { window?: unknown }).window;
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EUNENEM_PUBLIC_ORIGIN', 'https://app.eunenem.com');
    expect(getDefaultConviteShareOrigin()).toBe('https://app.eunenem.com/');
  });

  it('never falls back to a hardcoded xerox host when the env is unset', () => {
    delete (globalThis as { window?: unknown }).window;
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EUNENEM_PUBLIC_ORIGIN', '');
    expect(getDefaultConviteShareOrigin()).not.toContain('xeroxtoxerox');
  });
});
