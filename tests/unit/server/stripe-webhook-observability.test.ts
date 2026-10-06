import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../apps/eunenem-server/server/auth/setup.js';
import { createRequestObservabilityMiddleware } from '../../../apps/eunenem-server/server/request-observability.js';
import { createStripeWebhookHandler } from '../../../apps/eunenem-server/server/webhooks/stripe-webhook.js';
import { sanitizeGlitchTipRequestError } from '../../../apps/eunenem-server/src/lib/glitchtip/instrument.js';
import type { Logger } from '../../../src/observability/logger.js';

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';

describe('Stripe webhook request observability', () => {
  it('reports the original caught failure once without changing the 500 response', async () => {
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const capturedStacks: string[] = [];
    const reportFailure = vi.fn((error: unknown) => {
      capturedStacks.push(sanitizeGlitchTipRequestError(error).stack ?? '');
    });
    const deps = { observability: { logger } } as unknown as ServerDeps;
    const app = new Hono();
    app.use(
      '*',
      createRequestObservabilityMiddleware({
        logger,
        reportFailure,
        generateRequestId: () => REQUEST_ID,
      }),
    );
    app.post('/api/webhooks/stripe', createStripeWebhookHandler(deps));

    const canary = 'customer@example.com/private-provider-body';
    const originalFailure = new Error(canary);
    const request = new Request('http://localhost/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'test-signature' },
      body: '{}',
    });
    vi.spyOn(request, 'text').mockRejectedValueOnce(originalFailure);

    const response = await app.request(request);

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe('internal error');
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure.mock.calls[0]?.[0]).toBe(originalFailure);
    expect(reportFailure.mock.calls[0]?.[1]).toMatchObject({
      requestId: REQUEST_ID,
      route: '/api/webhooks/stripe',
      statusCode: 500,
      source: 'hono',
    });
    expect(capturedStacks[0]).toContain('stripe-webhook-observability.test.ts');
    expect(capturedStacks[0]).not.toContain(canary);
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(canary);
  });
});
