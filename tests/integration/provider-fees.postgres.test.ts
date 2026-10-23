import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { sql } from 'kysely';
import Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { PgBoss } from '../../apps/eunenem-server/node_modules/pg-boss/dist/index.js';
import { buildServerDeps, loadEnv } from '../../apps/eunenem-server/server/auth/setup.js';
import {
  PROVIDER_FEES_QUEUE,
  registerProviderFeesJob,
} from '../../apps/eunenem-server/server/jobs/provider-fees.pgboss.js';
import { down, up } from '../../migrations/20261023_063_provider_processing_fees.js';
import { StripeProcessingFeeReader } from '../../src/adapters/pagamentos/stripe-processing-fee-reader.js';
import { ProviderFeeSync } from '../../src/use-cases/pagamentos/provider-fee-sync.js';
import { ReceitaLedgerSeed } from '../helpers/receita-ledger-seed.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let database: TestDatabase;
let seed: ReceitaLedgerSeed;
let server: Server;
let service: ProviderFeeSync;
let requests: string[] = [];
let fee: number | null = 467;
let httpStatus = 200;
let refunded = false;
let feeReader: StripeProcessingFeeReader;
const now = new Date('2026-10-23T12:00:00Z');
beforeAll(async () => {
  database = await createTestDatabase();
  seed = new ReceitaLedgerSeed(database.db);
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/account') return void res.end(JSON.stringify({ id: 'acct_fixture' }));
    if (httpStatus !== 200) {
      res.statusCode = httpStatus;
      return void res.end(
        JSON.stringify({ error: { message: 'private', type: 'invalid_request_error' } }),
      );
    }
    const charge = {
      id: 'ch_fixture',
      object: 'charge',
      refunded,
      paid: true,
      captured: true,
      livemode: false,
      currency: 'brl',
      balance_transaction:
        fee === null
          ? null
          : {
              id: 'txn_fixture',
              object: 'balance_transaction',
              type: 'charge',
              currency: 'brl',
              amount: 10967,
              fee,
              net: 10967 - fee,
              created: now.getTime() / 1000,
              fee_details: [{ amount: fee, currency: 'brl', type: 'stripe_fee' }],
            },
    };
    res.end(
      JSON.stringify(
        req.url?.includes('/payment_intents/')
          ? { id: 'pi_fixture', latest_charge: charge }
          : charge,
      ),
    );
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback');
  const stripe = new Stripe('sk_test_fixture', {
    host: '127.0.0.1',
    port: address.port,
    protocol: 'http',
    maxNetworkRetries: 0,
  });
  feeReader = new StripeProcessingFeeReader(stripe);
  service = new ProviderFeeSync(
    database.db,
    feeReader,
    '11111111-1111-4111-8111-111111111111',
    () => now,
    true,
  );
});
afterAll(async () => {
  await sql`DELETE FROM provider_fee_events`.execute(database.db);
  await sql`DELETE FROM provider_fee_sync`.execute(database.db);
  await seed.wipe();
  await database.teardown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(async () => {
  await sql`DELETE FROM provider_fee_events`.execute(database.db);
  await sql`DELETE FROM provider_fee_sync`.execute(database.db);
  await seed.wipe();
  requests = [];
  fee = 467;
  httpStatus = 200;
  refunded = false;
});
async function payment(date = '2026-10-02T12:00:00Z') {
  const campaignId = await seed.campanha();
  const p = await seed.pagamento({
    campaignId,
    taxaCents: 500,
    adicionalCents: 999,
    metodo: 'credit_card',
    provedor: 'stripe',
    criadoEm: new Date(date),
  });
  await database.db
    .updateTable('pagamentos')
    .set({ intencao_charge_external_ref: 'ch_fixture' })
    .where('id', '=', p.idPagamento)
    .execute();
  return p.idPagamento;
}
it('dry-run is counts only: no provider calls, no persistence, September cutoff', async () => {
  await payment('2026-08-31T23:00:00-03:00');
  await payment();
  expect(await service.run({ dryRun: true })).toMatchObject({ eligible: 1, confirmed: 0 });
  expect(requests).toEqual([]);
  expect((await sql`SELECT * FROM provider_fee_events`.execute(database.db)).rows).toEqual([]);
});
it('real SDK GET → PG stores observed fee (not surcharge), concurrent reruns dedup; refund preserves it', async () => {
  const id = await payment();
  await Promise.all([service.run(), service.run()]);
  const rows = (
    await sql<{
      amount_cents: string;
      currency: string;
    }>`SELECT amount_cents, currency FROM provider_fee_events`.execute(database.db)
  ).rows;
  expect(rows).toEqual([{ amount_cents: '467', currency: 'brl' }]);
  expect(requests.some((url) => url.includes('/v1/charges/ch_fixture'))).toBe(true);
  await database.db
    .updateTable('pagamentos')
    .set({ status: 'estornado' })
    .where('id', '=', id)
    .execute();
  refunded = true;
  expect(await feeReader.read({ chargeRef: 'ch_fixture', paymentIntentRef: null })).toMatchObject({
    amountCents: 467,
  });
  await service.run();
  expect((await sql`SELECT * FROM provider_fee_events`.execute(database.db)).rows).toHaveLength(1);
});
it('missing fee stays pending, does not modify approved payment; observed zero is confirmed', async () => {
  const id = await payment();
  fee = null;
  expect(await service.run()).toMatchObject({ confirmed: 0, pending: 1 });
  expect(
    (
      await database.db
        .selectFrom('pagamentos')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).status,
  ).toBe('aprovado');
  await sql`UPDATE provider_fee_sync SET next_attempt_at = ${now}`.execute(database.db);
  fee = 0;
  expect(await service.run()).toMatchObject({ confirmed: 1 });
  expect(
    (
      await sql<{ amount_cents: string }>`SELECT amount_cents FROM provider_fee_events`.execute(
        database.db,
      )
    ).rows[0]?.amount_cents,
  ).toBe('0');
});

it('provider read failure stays pending without erasing an observed expense or exposing bodies', async () => {
  await payment();
  const failing = new ProviderFeeSync(
    database.db,
    {
      read: async () => {
        throw new Error('synthetic-private-provider-body');
      },
    },
    '11111111-1111-4111-8111-111111111111',
    () => now,
    true,
  );
  expect(await failing.run()).toMatchObject({ confirmed: 0, pending: 1 });
  const state = (
    await sql<{ last_reason: string }>`SELECT last_reason FROM provider_fee_sync`.execute(
      database.db,
    )
  ).rows;
  expect(state).toEqual([{ last_reason: 'provider_unavailable' }]);
  expect((await sql`SELECT * FROM provider_fee_events`.execute(database.db)).rows).toEqual([]);
});
it('never fetches another platform or a pending/rejected payment', async () => {
  const other = await seed.campanha('00000000-0000-4000-8000-000000000099');
  await seed.pagamento({
    campaignId: other,
    taxaCents: 500,
    metodo: 'credit_card',
    provedor: 'stripe',
    criadoEm: now,
  });
  const id = await payment();
  await database.db
    .updateTable('pagamentos')
    .set({ status: 'pendente' })
    .where('id', '=', id)
    .execute();
  expect(await service.run()).toMatchObject({ eligible: 0, confirmed: 0 });
  expect(requests).toEqual([]);
});

it('real pg-boss worker persists a fee through the production registration', async () => {
  await payment();
  const boss = new PgBoss({
    connectionString: database.connectionUri,
    pollingIntervalSeconds: 0.5,
  });
  await boss.start();
  try {
    await registerProviderFeesJob(boss, service, {
      assertAdmissionOpen: () => {},
      runJob: (op) => op(),
    });
    await boss.send(PROVIDER_FEES_QUEUE, { schemaVersion: 1 });
    await expect
      .poll(
        async () =>
          (await sql`SELECT id FROM provider_fee_events`.execute(database.db)).rows.length,
        { timeout: 10000 },
      )
      .toBe(1);
  } finally {
    await boss.stop({ graceful: true });
  }
});
it('real server composition constructs the service even without credentials; no invented expenses', async () => {
  const deps = buildServerDeps(
    loadEnv({
      DATABASE_URL: database.connectionUri,
      NODE_ENV: 'test',
      BETTER_AUTH_SECRET: 'synthetic-at-least-thirty-two-characters',
      BETTER_AUTH_URL: 'http://localhost:3001',
      TRUSTED_ORIGINS: 'http://localhost:3001',
      LEGACY_SITE_ORIGIN: 'https://eunenem.com',
    }),
  );
  try {
    expect(deps.providerFeeSync).toBeInstanceOf(ProviderFeeSync);
    await payment();
    expect(await deps.providerFeeSync.run()).toMatchObject({ confirmed: 0 });
    expect((await sql`SELECT * FROM provider_fee_events`.execute(database.db)).rows).toEqual([]);
    expect(requests).toEqual([]);
  } finally {
    await deps.db.destroy();
  }
});

it('additive migration down/up preserves the real existing payments schema and rows', async () => {
  const id = await payment();
  await down(database.db);
  expect(
    await database.db.selectFrom('pagamentos').select('id').where('id', '=', id).execute(),
  ).toHaveLength(1);
  await up(database.db);
  expect((await sql`SELECT * FROM provider_fee_events`.execute(database.db)).rows).toEqual([]);
});

it('default OFF refuses network and writes even when a reader exists', async () => {
  await payment();
  const off = new ProviderFeeSync(
    database.db,
    {
      read: async () => {
        throw new Error('must not call');
      },
    },
    '11111111-1111-4111-8111-111111111111',
    () => now,
  );
  expect(await off.run()).toMatchObject({ confirmed: 0, pending: 0 });
  expect((await sql`SELECT * FROM provider_fee_sync`.execute(database.db)).rows).toEqual([]);
});
it('missing provider references terminate instead of occupying the queue forever', async () => {
  const id = await payment();
  await database.db
    .updateTable('pagamentos')
    .set({ intencao_charge_external_ref: null })
    .where('id', '=', id)
    .execute();
  await service.run();
  expect(
    (await sql`SELECT status,last_reason FROM provider_fee_sync`.execute(database.db)).rows,
  ).toEqual([{ status: 'failed', last_reason: 'missing_reference' }]);
});

it('PI fallback persists authoritative identity, environment and date', async () => {
  const id = await payment();
  await database.db
    .updateTable('pagamentos')
    .set({ intencao_charge_external_ref: null, intencao_payment_intent_external_ref: 'pi_fixture' })
    .where('id', '=', id)
    .execute();
  await service.run();
  expect(requests.some((url) => url.includes('/payment_intents/pi_fixture'))).toBe(true);
  expect(
    (
      await sql`SELECT account_ref, environment, external_ref, occurred_at FROM provider_fee_events`.execute(
        database.db,
      )
    ).rows,
  ).toEqual([
    {
      account_ref: 'acct_fixture',
      environment: 'test',
      external_ref: 'txn_fixture',
      occurred_at: now,
    },
  ]);
});
it.each([
  [404, 'provider_not_found'],
  [401, 'provider_auth'],
  [403, 'provider_auth'],
])('HTTP%s ends with finite reason %s', async (status, reason) => {
  await payment();
  httpStatus = Number(status);
  await service.run();
  expect(
    (await sql`SELECT status,last_reason FROM provider_fee_sync`.execute(database.db)).rows,
  ).toEqual([{ status: 'failed', last_reason: reason }]);
});
it('missing asynchronous fee backs off and fails after eight attempts, never zero', async () => {
  await payment();
  fee = null;
  for (let attempt = 1; attempt <= 8; attempt++) {
    await service.run();
    const row = (
      await sql<{
        status: string;
        next_attempt_at: Date;
      }>`SELECT status,next_attempt_at FROM provider_fee_sync`.execute(database.db)
    ).rows[0];
    if (!row) throw new Error('missing retry state');
    expect(row.status).toBe(attempt === 8 ? 'failed' : 'pending');
    expect(row.next_attempt_at.getTime() - now.getTime()).toBe(
      Math.min(86400000, 300000 * 2 ** (attempt - 1)),
    );
    await sql`UPDATE provider_fee_sync SET next_attempt_at=${now}`.execute(database.db);
  }
  const n = requests.length;
  await service.run();
  expect(requests).toHaveLength(n);
  expect((await sql`SELECT * FROM provider_fee_events`.execute(database.db)).rows).toEqual([]);
});
it('a txn claimed by another payment is an identity failure, not a second expense', async () => {
  await payment();
  await service.run();
  await payment();
  await service.run();
  expect((await sql`SELECT * FROM provider_fee_events`.execute(database.db)).rows).toHaveLength(1);
  expect(
    (
      await sql`SELECT last_reason FROM provider_fee_sync WHERE status='failed'`.execute(
        database.db,
      )
    ).rows,
  ).toEqual([{ last_reason: 'identity_conflict' }]);
});
it('a worker whose lease was taken cannot persist or mark the successor confirmed', async () => {
  const id = await payment();
  const stealing = {
    read: async (input: { chargeRef: string | null; paymentIntentRef: string | null }) => {
      const observed = await feeReader.read(input);
      await sql`UPDATE provider_fee_sync SET claim_token=gen_random_uuid() WHERE payment_id=${id}::uuid`.execute(
        database.db,
      );
      return observed;
    },
  };
  const worker = new ProviderFeeSync(
    database.db,
    stealing,
    '11111111-1111-4111-8111-111111111111',
    () => now,
    true,
  );
  expect(await worker.run()).toMatchObject({ confirmed: 0 });
  expect((await sql`SELECT * FROM provider_fee_events`.execute(database.db)).rows).toEqual([]);
  expect((await sql`SELECT status FROM provider_fee_sync`.execute(database.db)).rows).toEqual([
    { status: 'pending' },
  ]);
});
it('OFF prevents queue registration as well as service writes', async () => {
  const off = new ProviderFeeSync(database.db, feeReader, '11111111-1111-4111-8111-111111111111');
  await registerProviderFeesJob(
    {
      createQueue: async () => {
        throw new Error('must not register');
      },
    } as never,
    off,
    { assertAdmissionOpen: () => {}, runJob: (op) => op() },
  );
  expect(
    loadEnv({
      DATABASE_URL: database.connectionUri,
      BETTER_AUTH_SECRET: 'synthetic-long-enough-secret-32chars',
      TRUSTED_ORIGINS: 'http://localhost:3001',
      BETTER_AUTH_URL: 'http://localhost:3001',
    }).PROVIDER_FEES_ENABLED,
  ).toBe('false');
});

it('timeout reason is finite and retryable, unlike auth/404', async () => {
  await payment();
  const timeout = new ProviderFeeSync(
    database.db,
    {
      read: async () => {
        throw Object.assign(new Error('private detail'), { code: 'ETIMEDOUT' });
      },
    },
    '11111111-1111-4111-8111-111111111111',
    () => now,
    true,
  );
  await timeout.run();
  expect(
    (await sql`SELECT status,last_reason FROM provider_fee_sync`.execute(database.db)).rows,
  ).toEqual([{ status: 'pending', last_reason: 'provider_timeout' }]);
});
