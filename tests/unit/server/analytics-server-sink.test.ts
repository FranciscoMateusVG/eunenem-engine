/**
 * aperture-4yse9 — server analytics sink contract.
 *
 * The sink is best-effort by design (fire-and-forget over HTTP). What it CAN
 * guarantee, and what these tests pin: a deterministic Mixpanel `$insert_id`
 * from the caller's business key, a stable business `time`, the
 * `source: 'server'` stamp, an explicit DROP (never a shared placeholder
 * profile) when no actor resolves, and "never throws into a request path".
 */
import { describe, expect, it, vi } from 'vitest';
import {
  distinctIdConvidado,
  insertIdFor,
  ServerAnalyticsMixpanel,
  ServerAnalyticsNaoConfigurado,
} from '../../../apps/eunenem-server/server/analytics/server-analytics.js';

const MIXPANEL_INSERT_ID = /^[A-Za-z0-9-]{1,36}$/;

describe('insertIdFor', () => {
  it('is deterministic for the same (event, key) and within Mixpanel limits', () => {
    const a = insertIdFor('pagamento_aprovado', '3f1c9a1e-0000-4000-8000-000000000001');
    const b = insertIdFor('pagamento_aprovado', '3f1c9a1e-0000-4000-8000-000000000001');
    expect(a).toBe(b);
    expect(a).toHaveLength(36);
    expect(a).toMatch(MIXPANEL_INSERT_ID);
  });

  it('differs per key and per event name', () => {
    const key = '3f1c9a1e-0000-4000-8000-000000000001';
    expect(insertIdFor('pagamento_aprovado', key)).not.toBe(
      insertIdFor('pagamento_aprovado', `${key}0`),
    );
    expect(insertIdFor('pagamento_aprovado', key)).not.toBe(insertIdFor('outro_evento', key));
  });
});

describe('distinctIdConvidado', () => {
  it('is an opaque, stable, prefixed actor id (never a shared placeholder)', () => {
    expect(distinctIdConvidado('abc')).toBe('convidado:abc');
    expect(distinctIdConvidado('abc')).not.toBe('anon');
  });
});

describe('ServerAnalyticsMixpanel', () => {
  function sink(overrides: { throwing?: boolean } = {}) {
    const track = vi.fn((_event: string, _props: Record<string, unknown>) => {
      if (overrides.throwing) throw new Error('network down');
    });
    const dropped: Array<{ event: string; props: Record<string, unknown> }> = [];
    const analytics = new ServerAnalyticsMixpanel('token', {
      client: { track } as never,
      onDropped: (event, props) => dropped.push({ event, props }),
    });
    return { analytics, track, dropped };
  }

  it('stamps source, distinct_id, deterministic $insert_id and business time', () => {
    const { analytics, track } = sink();
    const occurredAt = new Date('2026-09-13T12:00:00.000Z');

    analytics.track(
      'pagamento_aprovado',
      'conta-1',
      { id_pagamento: 'p1', valor_centavos: 4500 },
      { insertKey: 'p1', occurredAt },
    );

    expect(track).toHaveBeenCalledTimes(1);
    const [event, props] = track.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('pagamento_aprovado');
    expect(props).toMatchObject({
      distinct_id: 'conta-1',
      source: 'server',
      id_pagamento: 'p1',
      valor_centavos: 4500,
      $insert_id: insertIdFor('pagamento_aprovado', 'p1'),
      time: occurredAt,
    });
  });

  it('produces the SAME payload for the same fact twice (what Mixpanel dedups on)', () => {
    const { analytics, track } = sink();
    const occurredAt = new Date('2026-09-13T12:00:00.000Z');
    analytics.track('pagamento_aprovado', 'conta-1', { a: 1 }, { insertKey: 'p1', occurredAt });
    analytics.track('pagamento_aprovado', 'conta-1', { a: 1 }, { insertKey: 'p1', occurredAt });
    expect(track.mock.calls[0]).toEqual(track.mock.calls[1]);
  });

  it('omits $insert_id and time when the caller gives no options', () => {
    const { analytics, track } = sink();
    analytics.track('campanha_criada', 'conta-1', { id_campanha: 'c1' });
    const [, props] = track.mock.calls[0] as [string, Record<string, unknown>];
    expect(props).not.toHaveProperty('$insert_id');
    expect(props).not.toHaveProperty('time');
  });

  it('DROPS an event with no actor: no track call, onDropped reports it', () => {
    const { analytics, track, dropped } = sink();
    analytics.track('pagamento_aprovado', null, { id_pagamento: 'p1' });
    analytics.track('pagamento_aprovado', '', { id_pagamento: 'p2' });
    expect(track).not.toHaveBeenCalled();
    expect(dropped).toEqual([
      { event: 'pagamento_aprovado', props: { id_pagamento: 'p1' } },
      { event: 'pagamento_aprovado', props: { id_pagamento: 'p2' } },
    ]);
  });

  it('never throws into the request path when the client throws', () => {
    const { analytics } = sink({ throwing: true });
    expect(() => analytics.track('x', 'conta-1', {})).not.toThrow();
  });
});

describe('ServerAnalyticsNaoConfigurado', () => {
  it('is a no-op', () => {
    expect(() => new ServerAnalyticsNaoConfigurado().track()).not.toThrow();
  });
});
