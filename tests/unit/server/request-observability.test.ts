import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  createRequestObservabilityMiddleware,
  REQUEST_ID_HEADER,
  type RequestFailureContext,
  reportTrpcInternalFailure,
} from '../../../apps/eunenem-server/server/request-observability.js';
import type { Logger } from '../../../src/observability/logger.js';

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';

function testApp() {
  const error = vi.fn<Logger['error']>();
  const reportFailure = vi.fn<(error: unknown, context: RequestFailureContext) => void>();
  const app = new Hono();
  app.use(
    '*',
    createRequestObservabilityMiddleware({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error,
        debug: vi.fn(),
      },
      reportFailure,
      generateRequestId: () => REQUEST_ID,
    }),
  );
  return { app, error, reportFailure };
}

describe('request observability middleware', () => {
  it('ignores a caller-supplied correlation ID and returns the server ID', async () => {
    const { app, error, reportFailure } = testApp();
    app.get('/ok', (c) => c.text('ok'));

    const response = await app.request('/ok?private=value', {
      headers: { 'x-request-id': 'caller-controlled' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(REQUEST_ID);
    expect(error).not.toHaveBeenCalled();
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('reports a handled 5xx once with route metadata and no request values', async () => {
    const { app, error, reportFailure } = testApp();
    app.get('/accounts/:id', (c) => c.text('unavailable', 503));

    const response = await app.request('/accounts/customer-secret?token=hidden');

    expect(response.status).toBe(503);
    expect(error).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledOnce();
    const context = reportFailure.mock.calls[0]?.[1];
    expect(context).toEqual({
      requestId: REQUEST_ID,
      method: 'GET',
      route: '/accounts/:id',
      statusCode: 503,
      source: 'response',
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('customer-secret');
    expect(JSON.stringify(error.mock.calls)).not.toContain('hidden');
  });

  it('reports a thrown error once without changing Hono error semantics', async () => {
    const { app, error, reportFailure } = testApp();
    app.get('/explode', () => {
      throw new Error('private upstream body');
    });

    const response = await app.request('/explode');

    expect(response.status).toBe(500);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(REQUEST_ID);
    expect(error).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure.mock.calls[0]?.[1]).toMatchObject({
      requestId: REQUEST_ID,
      route: '/explode',
      source: 'hono',
    });
  });

  it('captures a handled tRPC internal error even when the outer response is 200', async () => {
    const { app, error, reportFailure } = testApp();
    app.get('/api/trpc/*', (c) => {
      reportTrpcInternalFailure(c, {
        error: new Error('private input'),
        path: 'checkout.create',
      });
      return c.json({ error: true }, 200);
    });

    const response = await app.request('/api/trpc/checkout.create?input=private');

    expect(response.status).toBe(200);
    expect(error).toHaveBeenCalledOnce();
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(reportFailure.mock.calls[0]?.[1]).toEqual({
      requestId: REQUEST_ID,
      method: 'GET',
      route: 'trpc.checkout.create',
      statusCode: 500,
      source: 'trpc',
    });
  });

  it('keeps the application response when either observability sink throws', async () => {
    const app = new Hono();
    app.use(
      '*',
      createRequestObservabilityMiddleware({
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: () => {
            throw new Error('logger unavailable');
          },
          debug: vi.fn(),
        },
        reportFailure: () => {
          throw new Error('reporter unavailable');
        },
        generateRequestId: () => REQUEST_ID,
      }),
    );
    app.get('/failed', (c) => c.text('upstream unavailable', 502));

    const response = await app.request('/failed');
    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toBe('upstream unavailable');
  });
});
