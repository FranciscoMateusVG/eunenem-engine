import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  INTER_PIX_WEBHOOK_MAX_BODY_BYTES,
  INTER_PIX_WEBHOOK_PATHS,
  type InterPixWebhookDeps,
  mountInterPixWebhookRoutes,
  readBoundedBody,
} from '../../../apps/eunenem-server/server/webhooks/inter-pix-webhook.js';
import { WebhookEventArchiveMemory } from '../../../src/adapters/webhook-archive/webhook-event-archive.memory.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';

function routeDeps(): InterPixWebhookDeps {
  return {
    db: {} as never,
    trustedHopCount: 0,
    logPiiHashSalt: 'test-salt-thirty-two-chars-aaaaaaaaaaa',
    observability: { logger: new NoopLogger(), tracer: noopTracer() },
    clock: () => new Date('2026-08-05T12:00:00.000Z'),
  } as unknown as InterPixWebhookDeps;
}

describe('Banco Inter Pix webhook HTTP shell', () => {
  it.each(
    INTER_PIX_WEBHOOK_PATHS,
  )('mounts %s and enforces the actual streamed-byte cap', async (path) => {
    const app = new Hono();
    const consumeRateLimit = vi.fn().mockResolvedValue({
      allowed: true,
      count: 1,
      max: 600,
      windowMs: 60_000,
    });
    mountInterPixWebhookRoutes(app, routeDeps(), { consumeRateLimit });

    const response = await app.request(path, {
      method: 'POST',
      body: 'x'.repeat(INTER_PIX_WEBHOOK_MAX_BODY_BYTES + 1),
    });

    expect(response.status).toBe(413);
    await expect(response.text()).resolves.toBe('payload too large');
    expect(consumeRateLimit).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized declared content-length before reading the stream', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('body must not be read');
      },
    });
    const request = new Request('http://localhost/webhook', {
      method: 'POST',
      headers: { 'content-length': String(INTER_PIX_WEBHOOK_MAX_BODY_BYTES + 1) },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    await expect(readBoundedBody(request, INTER_PIX_WEBHOOK_MAX_BODY_BYTES)).rejects.toThrow(
      'inter_pix_webhook_body_too_large',
    );
  });

  it('returns 429 with Retry-After when the durable limiter denies', async () => {
    const app = new Hono();
    mountInterPixWebhookRoutes(app, routeDeps(), {
      consumeRateLimit: vi.fn().mockResolvedValue({
        allowed: false,
        count: 601,
        max: 600,
        windowMs: 60_000,
      }),
    });

    const response = await app.request(INTER_PIX_WEBHOOK_PATHS[0], {
      method: 'POST',
      body: '{}',
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
  });

  it('archives an unknown charge categorically without calling Banco Inter', async () => {
    const txid = 'A'.repeat(26);
    const e2eId = 'E'.repeat(32);
    const consultarCobranca = vi.fn();
    const findByExternalRef = vi.fn().mockResolvedValue(undefined);
    const archive = new WebhookEventArchiveMemory(() => new Date('2026-08-05T12:30:00.000Z'));
    const app = new Hono();
    mountInterPixWebhookRoutes(
      app,
      {
        ...routeDeps(),
        webhookEventArchive: archive,
        pagamentoRepository: { findByExternalRef },
        pixCobrancaProvider: { consultarCobranca },
      } as unknown as InterPixWebhookDeps,
      {
        consumeRateLimit: vi.fn().mockResolvedValue({
          allowed: true,
          count: 1,
          max: 600,
          windowMs: 60_000,
        }),
      },
    );

    const response = await app.request(INTER_PIX_WEBHOOK_PATHS[0], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pix: [{ txid, endToEndId: e2eId }] }),
    });

    expect(response.status).toBe(200);
    expect(findByExternalRef).toHaveBeenCalledTimes(1);
    expect(findByExternalRef).toHaveBeenCalledWith(txid);
    expect(consultarCobranca).not.toHaveBeenCalled();
    await expect(archive.findByProviderEventId('inter', e2eId)).resolves.toMatchObject({
      rawPayload: { txid, endToEndId: e2eId },
      processingError: 'charge_binding_failed',
      processedAt: null,
    });
  });
});
