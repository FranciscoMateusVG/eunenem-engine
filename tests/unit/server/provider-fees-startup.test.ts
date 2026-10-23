import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { startOptionalFeeJob } from '../../../apps/eunenem-server/server/jobs/provider-fees-startup.js';
import { createServerLifecycle } from '../../../apps/eunenem-server/server/lifecycle.js';

it('registration rejection is observable without killing HTTP/core admission', async () => {
  const exit = vi.fn();
  const lifecycle = createServerLifecycle({
    boss: { offWork: async () => {}, stop: async () => {} },
    queues: [],
    exit,
  });
  lifecycle.attachServer(
    Object.assign(new EventEmitter(), { listening: true, close: vi.fn() }) as never,
  );
  const logger = { error: vi.fn() };
  const counter = { add: vi.fn() };
  await startOptionalFeeJob(
    'stripe',
    async () => {
      throw new Error('private provider detail');
    },
    logger,
    counter,
  );
  expect(lifecycle.markReady()).toBe(true);
  const app = new Hono();
  app.use('*', lifecycle.admissionMiddleware);
  app.post('/api/webhooks/stripe', (c) => c.text('core alive'));
  expect((await app.request('/api/webhooks/stripe', { method: 'POST' })).status).toBe(200);
  expect(exit).not.toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledWith('provider_fees.registration_failed', {
    provider: 'stripe',
    reason: 'registration_failed',
  });
  expect(counter.add).toHaveBeenCalledWith(1, { provider: 'stripe' });
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private provider detail');
});
it('production composition uses the optional boundary, not a fatal startup step', () => {
  const source = readFileSync('apps/eunenem-server/server.tsx', 'utf8');
  expect(source).toContain("startOptionalFeeJob('stripe'");
  expect(source).not.toContain('startupStep(() => registerProviderFeesJob');
});
