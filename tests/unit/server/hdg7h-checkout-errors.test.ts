import { createRequire } from 'node:module';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { emitirCheckoutFalhou } from '../../../apps/eunenem-server/pages/lib/analytics-funil.js';
import { CheckoutOperationStorageUnavailableError } from '../../../apps/eunenem-server/pages/lib/checkoutOperationClient.js';
import {
  createRequestObservabilityMiddleware,
  reportCheckoutFailure,
} from '../../../apps/eunenem-server/server/request-observability.js';
import { appRouter } from '../../../apps/eunenem-server/server/trpc/router.js';

it('logs local storage failure with its real code/name, not contributor details', () => {
  const emit = vi.fn();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    emitirCheckoutFalhou(
      { metodo: 'pix', valorCentavos: 3161, erro: new CheckoutOperationStorageUnavailableError() },
      emit,
    );
    expect(emit.mock.calls[0]?.[1]).toMatchObject({
      codigo: 'CHECKOUT_STORAGE_UNAVAILABLE',
      error_name: 'CheckoutOperationStorageUnavailableError',
    });
    expect(warn).toHaveBeenCalledWith(
      'checkout.failed',
      expect.objectContaining({ codigo: 'CHECKOUT_STORAGE_UNAVAILABLE' }),
    );
  } finally {
    warn.mockRestore();
  }
});

it('logs every checkout failure in a batch, with no input or exception message', async () => {
  const warn = vi.fn();
  const app = new Hono();
  app.use(
    '*',
    createRequestObservabilityMiddleware({
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
      reportFailure: vi.fn(),
    }),
  );
  app.post('/api/trpc/*', (c) => {
    for (const code of ['BAD_REQUEST', 'CONFLICT', 'UNAUTHORIZED'])
      reportCheckoutFailure(c, {
        path: 'pagina.iniciarPagamentoCarrinho',
        code,
        input: {
          operationId: '00000000-0000-4000-8000-000000000001',
          contribuinte: { email: 'private@example.test' },
        },
      });
    reportCheckoutFailure(c, { path: 'admin.private', code: 'BAD_REQUEST', input: {} });
    return c.json({ ok: false }, 409);
  });
  expect(
    (await app.request('/api/trpc/pagina.iniciarPagamentoCarrinho', { method: 'POST' })).status,
  ).toBe(409);
  expect(warn).toHaveBeenCalledTimes(3);
  expect(warn.mock.calls[0]).toEqual([
    'checkout.request.failed',
    expect.objectContaining({
      path: 'pagina.iniciarPagamentoCarrinho',
      code: 'BAD_REQUEST',
      operationId: '00000000-0000-4000-8000-000000000001',
    }),
  ]);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private@example.test');
});

it('real Hono/tRPC HTTP logs BAD_REQUEST and pre-parser FORBIDDEN without repository calls', async () => {
  const appRequire = createRequire(
    new URL('../../../apps/eunenem-server/package.json', import.meta.url),
  );
  const { fetchRequestHandler } = appRequire('@trpc/server/adapters/fetch') as {
    fetchRequestHandler: (options: Record<string, unknown>) => Promise<Response>;
  };
  const warn = vi.fn();
  const app = new Hono();
  app.use(
    '*',
    createRequestObservabilityMiddleware({
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
      reportFailure: vi.fn(),
    }),
  );
  app.all('/api/trpc/*', (c) =>
    fetchRequestHandler({
      endpoint: '/api/trpc',
      req: c.req.raw,
      router: appRouter,
      createContext: () => ({
        deps: { publicOrigin: 'http://localhost' },
        headers: c.req.raw.headers,
        resHeaders: new Headers(),
      }),
      onError: ({
        error,
        path,
        input,
      }: {
        error: { code: string };
        path?: string;
        input?: unknown;
      }) => reportCheckoutFailure(c, { code: error.code, path, input }),
    }),
  );
  for (const [origin, status, code] of [
    ['http://localhost', 400, 'BAD_REQUEST'],
    ['http://foreign.test', 403, 'FORBIDDEN'],
  ] as const) {
    const response = await app.request(
      'http://localhost/api/trpc/pagina.iniciarPagamentoCarrinho',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({
          operationId: '00000000-0000-4000-8000-000000000001',
          secret: 'never-log',
        }),
      },
    );
    expect(response.status).toBe(status);
    expect(warn).toHaveBeenLastCalledWith(
      'checkout.request.failed',
      expect.objectContaining({
        code,
        path: 'pagina.iniciarPagamentoCarrinho',
        operationId: code === 'FORBIDDEN' ? null : '00000000-0000-4000-8000-000000000001',
      }),
    );
  }
  expect(JSON.stringify(warn.mock.calls)).not.toContain('never-log');
});
