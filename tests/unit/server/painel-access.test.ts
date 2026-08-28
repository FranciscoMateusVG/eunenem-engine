import { describe, expect, it } from 'vitest';

import { shouldRedirectPainelRequest } from '../../../apps/eunenem-server/server/painel-access.js';

describe('painel SSR access policy', () => {
  it('redirects a request without an authenticated session', () => {
    expect(shouldRedirectPainelRequest({ ownerAccountId: 'owner-1', sessionAccountId: null })).toBe(
      true,
    );
  });

  it('redirects an authenticated non-owner', () => {
    expect(
      shouldRedirectPainelRequest({
        ownerAccountId: 'owner-1',
        sessionAccountId: 'other-account',
      }),
    ).toBe(true);
  });

  it('allows only the authenticated owner', () => {
    expect(
      shouldRedirectPainelRequest({
        ownerAccountId: 'owner-1',
        sessionAccountId: 'owner-1',
      }),
    ).toBe(false);
  });
});
