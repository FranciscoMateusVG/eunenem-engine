import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ServerEnv } from '../../../apps/eunenem-server/server/auth/setup.js';
import {
  INTER_PIX_WEBHOOK_MAX_BODY_BYTES,
  INTER_PIX_WEBHOOK_PATHS,
  type InterPixWebhookDeps,
  mountInterPixWebhookRoutesWhenBound,
} from '../../../apps/eunenem-server/server/webhooks/inter-pix-webhook.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';

const COMPLETE_INTER_COB_CREDENTIALS = {
  INTER_COB_BASE_URL: 'https://cdpj.partners.bancointer.com.br',
  INTER_COB_CLIENT_ID: 'client-id',
  INTER_COB_CLIENT_SECRET: 'client-secret',
  INTER_COB_SCOPE: 'cob.write cob.read pix.read',
  INTER_COB_CERT_BASE64: 'certificate-base64',
  INTER_COB_KEY_BASE64: 'private-key-base64',
  INTER_COB_PIX_KEY: 'pix-key',
} as const;

const EMPTY_INTER_COB_CREDENTIALS = {
  INTER_COB_BASE_URL: '',
  INTER_COB_CLIENT_ID: '',
  INTER_COB_CLIENT_SECRET: '',
  INTER_COB_SCOPE: '',
  INTER_COB_CERT_BASE64: '',
  INTER_COB_KEY_BASE64: '',
  INTER_COB_PIX_KEY: '',
} as const;

function env(
  nodeEnv: ServerEnv['NODE_ENV'],
  provider: ServerEnv['COBRANCA_PIX_PROVIDER'],
  credentials: typeof COMPLETE_INTER_COB_CREDENTIALS | typeof EMPTY_INTER_COB_CREDENTIALS,
): ServerEnv {
  return { NODE_ENV: nodeEnv, COBRANCA_PIX_PROVIDER: provider, ...credentials } as ServerEnv;
}

const deps = {
  db: {} as never,
  trustedHopCount: 0,
  logPiiHashSalt: 'test-salt-thirty-two-chars-aaaaaaaaaaa',
  observability: { logger: new NoopLogger(), tracer: noopTracer() },
  clock: () => new Date('2026-08-24T12:00:00.000Z'),
} as unknown as InterPixWebhookDeps;
const allow = vi.fn().mockResolvedValue({
  allowed: true,
  count: 1,
  max: 600,
  windowMs: 60_000,
});

async function statusesFor(config: ServerEnv): Promise<number[]> {
  const app = new Hono();
  mountInterPixWebhookRoutesWhenBound(app, config, deps, { consumeRateLimit: allow });
  return Promise.all(
    INTER_PIX_WEBHOOK_PATHS.map(async (path) => {
      const response = await app.request(path, {
        method: 'POST',
        body: 'x'.repeat(INTER_PIX_WEBHOOK_MAX_BODY_BYTES + 1),
      });
      return response.status;
    }),
  );
}

describe('Inter PIX webhook composition-root mount gate', () => {
  it.each([
    ['fake in non-production', env('test', 'fake', EMPTY_INTER_COB_CREDENTIALS)],
    ['Inter in non-production', env('development', 'inter', COMPLETE_INTER_COB_CREDENTIALS)],
    [
      'Stripe with complete Inter credentials in non-production',
      env('test', 'stripe', COMPLETE_INTER_COB_CREDENTIALS),
    ],
    ['Stripe with no credentials', env('production', 'stripe', EMPTY_INTER_COB_CREDENTIALS)],
    [
      'Stripe with incomplete credentials',
      env('production', 'stripe', {
        ...COMPLETE_INTER_COB_CREDENTIALS,
        INTER_COB_KEY_BASE64: '',
      }),
    ],
  ])('leaves both routes absent for %s', async (_name, config) => {
    await expect(statusesFor(config)).resolves.toEqual([404, 404]);
  });

  it('mounts both routes when Inter is selected', async () => {
    await expect(
      statusesFor(env('production', 'inter', COMPLETE_INTER_COB_CREDENTIALS)),
    ).resolves.toEqual([413, 413]);
  });

  it('keeps both routes mounted after rollback to Stripe with complete credentials', async () => {
    await expect(
      statusesFor(env('production', 'stripe', COMPLETE_INTER_COB_CREDENTIALS)),
    ).resolves.toEqual([413, 413]);
  });
});
