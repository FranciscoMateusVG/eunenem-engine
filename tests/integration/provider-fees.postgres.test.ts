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
const now = new Date('2026-10-23T12:00:00Z');
beforeAll(async () => {
  database = await createTestDatabase();
  seed = new ReceitaLedgerSeed(database.db);
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/account') return void res.end(JSON.stringify({ id: 'acct_fixture' }));
    res.end(
      JSON.stringify({
        id: 'ch_fixture',
        object: 'charge',
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
      }),
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
  service = new ProviderFeeSync(
    database.db,
    new StripeProcessingFeeReader(stripe),
    '11111111-1111-4111-8111-111111111111',
    () => now,
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
  );
  expect(await failing.run()).toMatchObject({ confirmed: 0, pending: 1 });
  const state = (
    await sql<{ last_reason: string }>`SELECT last_reason FROM provider_fee_sync`.execute(
      database.db,
    )
  ).rows;
  expect(state).toEqual([{ last_reason: 'provider_read_or_identity_error' }]);
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
