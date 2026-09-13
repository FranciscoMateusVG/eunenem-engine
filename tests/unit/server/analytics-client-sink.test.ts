/**
 * aperture-4yse9 — client analytics entry point (pages/lib/analytics.ts).
 *
 * Pins: the Mixpanel-only `$insert_id` on compra_concluida (derived from the
 * durable transaction_id, within Mixpanel's 36-char [A-Za-z0-9-] limit),
 * untouched props for every other event, and the mounts-dark rule (no token →
 * the sink never initializes and never tracks).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  track: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  set_once: vi.fn(),
}));

// analytics.ts resolves `mixpanel-browser` from apps/eunenem-server/node_modules
// (the app has its own lockfile); mock that exact module id, not the bare
// specifier as seen from the root test tree.
vi.mock('../../../apps/eunenem-server/node_modules/mixpanel-browser', () => ({
  default: {
    init: mocks.init,
    track: mocks.track,
    identify: mocks.identify,
    reset: mocks.reset,
    people: { set_once: mocks.set_once },
  },
}));

type AnalyticsModule = typeof import('../../../apps/eunenem-server/pages/lib/analytics.js');

async function loadWith(mixpanelToken: string | undefined): Promise<AnalyticsModule> {
  vi.resetModules();
  (globalThis as { window?: unknown }).window = {
    __EUNENEM_ENV__: mixpanelToken === undefined ? {} : { mixpanelToken },
    localStorage: { getItem: () => null },
  };
  return import('../../../apps/eunenem-server/pages/lib/analytics.js');
}

describe('clientInsertIdFor / mixpanelPropsFor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sanitizes a Stripe session id and an Inter txid into a valid $insert_id', async () => {
    const { clientInsertIdFor } = await loadWith('tok');
    const stripe = clientInsertIdFor(
      'cs_live_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w3X4y5Z6',
    );
    expect(stripe).toHaveLength(36);
    expect(stripe).toMatch(/^[A-Za-z0-9-]{1,36}$/);
    expect(stripe.startsWith('cs-live-')).toBe(true);
    const inter = clientInsertIdFor('3f1c9a1e00004000800000000000000a');
    expect(inter).toBe('3f1c9a1e00004000800000000000000a');
  });

  it('adds $insert_id ONLY to compra_concluida with a non-empty transaction_id', async () => {
    const { mixpanelPropsFor } = await loadWith('tok');
    expect(mixpanelPropsFor('compra_concluida', { transaction_id: 'cs_x_1', value: 45 })).toEqual({
      transaction_id: 'cs_x_1',
      value: 45,
      $insert_id: 'cs-x-1',
    });
    expect(mixpanelPropsFor('compra_concluida', { transaction_id: '', value: 45 })).toEqual({
      transaction_id: '',
      value: 45,
    });
    expect(mixpanelPropsFor('checkout_iniciado', { transaction_id: 'cs_x_1' })).toEqual({
      transaction_id: 'cs_x_1',
    });
    expect(mixpanelPropsFor('page_view_custom', undefined)).toBeUndefined();
  });
});

describe('sendEvent → Mixpanel sink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('with a token: inits once and tracks compra_concluida with the $insert_id (GA branch untouched)', async () => {
    const { sendEvent } = await loadWith('tok');
    sendEvent('compra_concluida', { transaction_id: 'cs_x_1', valor_centavos: 4500 });
    sendEvent('login_concluido', { is_legacy: false });

    expect(mocks.init).toHaveBeenCalledTimes(1);
    expect(mocks.init.mock.calls[0]?.[0]).toBe('tok');
    expect(mocks.track).toHaveBeenCalledTimes(2);
    expect(mocks.track.mock.calls[0]).toEqual([
      'compra_concluida',
      { transaction_id: 'cs_x_1', valor_centavos: 4500, $insert_id: 'cs-x-1' },
    ]);
    // The $insert_id never leaks into the caller's object (which also feeds GA).
    expect(mocks.track.mock.calls[1]).toEqual(['login_concluido', { is_legacy: false }]);
  });

  it('mounts dark without a token: never inits, never tracks, never identifies', async () => {
    const { sendEvent, identifyWithUtm, resetAnalyticsIdentity } = await loadWith(undefined);
    sendEvent('compra_concluida', { transaction_id: 'cs_x_1' });
    identifyWithUtm('conta-1');
    resetAnalyticsIdentity();
    expect(mocks.init).not.toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalled();
    expect(mocks.identify).not.toHaveBeenCalled();
    expect(mocks.reset).not.toHaveBeenCalled();
  });
});
