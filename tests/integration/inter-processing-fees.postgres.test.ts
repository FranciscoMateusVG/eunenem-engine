import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { InterProcessingFeeReader } from '../../src/adapters/pagamentos/inter-processing-fee-reader.js';
import { InterFeeSync } from '../../src/use-cases/pagamentos/inter-fee-sync.js';
import { ReceitaLedgerSeed } from '../helpers/receita-ledger-seed.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let testDb: TestDatabase;
let seed: ReceitaLedgerSeed;
const now = new Date('2026-09-02T12:00:00Z');
const e2e = `E${'1'.repeat(31)}`;
let server: Server;
let origin: string;
let calls: string[] = [];
let rateLimited = false;
let missingIdentity = false;
let feeIdentity = 'tarifa-1';
let secondPageFails = false;
function reader() {
  return new InterProcessingFeeReader(
    {
      baseUrl: 'https://inter.example.test',
      clientId: 'fixture',
      clientSecret: 'fixture',
      scope: 'extrato.read',
      certPem: 'fixture',
      keyPem: 'fixture',
      contaCorrente: '12345',
    },
    async (method, path, headers, body) => {
      const response = await fetch(`${origin}${path}`, { method, headers, body });
      return { statusCode: response.status, body: await response.text() };
    },
  );
}
function fixtureResponse(path: string) {
  calls.push(path);
  if (path.includes('oauth'))
    return {
      statusCode: 200,
      body: JSON.stringify({ access_token: 'fixture', expires_in: 3600, token_type: 'Bearer' }),
    };
  if (secondPageFails && new URL(path, origin).searchParams.get('pagina') === '1')
    return { statusCode: 429, body: 'private' };
  if (rateLimited) return { statusCode: 429, body: 'private upstream body' };
  return {
    statusCode: 200,
    body: JSON.stringify({
      ultimaPagina: !secondPageFails,
      totalPaginas: secondPageFails ? 2 : 1,
      transacoes: [
        {
          idTransacao: missingIdentity ? undefined : feeIdentity,
          dataTransacao: '2026-09-01',
          tipoTransacao: 'TARIFA',
          tipoOperacao: 'D',
          valor: '0.67',
          detalhes: { endToEndId: e2e },
        },
        {
          idTransacao: 'pix-1',
          dataTransacao: '2026-09-01',
          tipoTransacao: 'PIX',
          tipoOperacao: 'C',
          valor: '100.00',
          detalhes: { endToEndId: e2e },
        },
      ],
    }),
  };
}
beforeAll(async () => {
  server = createServer((req, res) => {
    const reply = fixtureResponse(req.url ?? '/');
    res.writeHead(reply.statusCode, { 'content-type': 'application/json' });
    res.end(reply.body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing loopback address');
  origin = `http://127.0.0.1:${address.port}`;
  testDb = await createTestDatabase();
  seed = new ReceitaLedgerSeed(testDb.db);
});
beforeEach(async () => {
  await sql`DELETE FROM provider_fee_events`.execute(testDb.db);
  await sql`DELETE FROM provider_fee_inter_scans`.execute(testDb.db);
  await seed.wipe();
  calls = [];
  rateLimited = false;
  missingIdentity = false;
  feeIdentity = 'tarifa-1';
  secondPageFails = false;
});
afterAll(async () => {
  await sql`DELETE FROM provider_fee_events`.execute(testDb.db);
  await sql`DELETE FROM provider_fee_inter_scans`.execute(testDb.db);
  await seed.wipe();
  await testDb.teardown();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
async function payment() {
  const campaignId = await seed.campanha();
  const p = await seed.pagamento({
    campaignId,
    taxaCents: 500,
    metodo: 'pix',
    provedor: 'inter',
    criadoEm: now,
  });
  await testDb.db
    .updateTable('pagamentos')
    .set({ intencao_e2e_external_ref: e2e })
    .where('id', '=', p.idPagamento)
    .execute();
  return p.idPagamento;
}
it('TARIFA with exact E2E is stored once; PIX principal is never an expense', async () => {
  const id = await payment();
  const service = new InterFeeSync(
    testDb.db,
    reader(),
    '11111111-1111-4111-8111-111111111111',
    () => now,
    true,
  );
  await service.run();
  const rows = (
    await sql<{
      payment_id: string;
      amount_cents: string;
    }>`SELECT payment_id,amount_cents FROM provider_fee_events`.execute(testDb.db)
  ).rows;
  expect(rows).toEqual([{ payment_id: id, amount_cents: '67' }]);
  await sql`UPDATE provider_fee_inter_scans SET next_attempt_at=${new Date(now.getTime() - 1000)} WHERE day='2026-09-01'`.execute(
    testDb.db,
  );
  expect(await service.run()).toMatchObject({ pending: false });
  expect((await sql`SELECT id FROM provider_fee_events`.execute(testDb.db)).rows).toHaveLength(1);
});
it('429 preserves pending window and never writes zero or changes approved payment', async () => {
  const id = await payment();
  rateLimited = true;
  const service = new InterFeeSync(
    testDb.db,
    reader(),
    '11111111-1111-4111-8111-111111111111',
    () => now,
    true,
  );
  expect(await service.run()).toMatchObject({ pending: true });
  expect((await sql`SELECT id FROM provider_fee_events`.execute(testDb.db)).rows).toEqual([]);
  expect(
    (
      await testDb.db
        .selectFrom('pagamentos')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).status,
  ).toBe('aprovado');
});
it('missing transaction identity is pending, never E2E-only dedupe or an estimated fee', async () => {
  await payment();
  missingIdentity = true;
  expect(
    await new InterFeeSync(
      testDb.db,
      reader(),
      '11111111-1111-4111-8111-111111111111',
      () => now,
      true,
    ).run(),
  ).toMatchObject({ pending: true });
  expect((await sql`SELECT id FROM provider_fee_events`.execute(testDb.db)).rows).toEqual([]);
});
it('OFF refuses HTTP, scan admission and event writes', async () => {
  expect(
    await new InterFeeSync(
      testDb.db,
      reader(),
      '11111111-1111-4111-8111-111111111111',
      () => now,
    ).run(),
  ).toEqual({ pending: true, imported: 0 });
  expect(calls).toEqual([]);
  expect((await sql`SELECT day FROM provider_fee_inter_scans`.execute(testDb.db)).rows).toEqual([]);
});
it('unmatched E2E is retained but never attributed to a tenant payment', async () => {
  await new InterFeeSync(
    testDb.db,
    reader(),
    '11111111-1111-4111-8111-111111111111',
    () => now,
    true,
  ).run();
  const rows = (
    await sql`SELECT payment_id,matching_ref,source,currency,environment,occurred_at FROM provider_fee_events`.execute(
      testDb.db,
    )
  ).rows;
  expect(rows).toEqual([
    {
      payment_id: null,
      matching_ref: e2e,
      source: 'inter_extrato_tarifa',
      currency: 'brl',
      environment: 'test',
      occurred_at: new Date('2026-09-01T03:00:00Z'),
    },
  ]);
});
it('daily scan reaches a finite failure ceiling rather than retrying permanent failures forever', async () => {
  missingIdentity = true;
  const service = new InterFeeSync(
    testDb.db,
    reader(),
    '11111111-1111-4111-8111-111111111111',
    () => now,
    true,
  );
  for (let n = 0; n < 8; n++) {
    await service.run();
    await sql`UPDATE provider_fee_inter_scans SET next_attempt_at=${new Date(now.getTime() - 1000)} WHERE day='2026-09-01'`.execute(
      testDb.db,
    );
    await sql`UPDATE provider_fee_inter_scans SET next_attempt_at=${new Date(now.getTime() + 86400000)} WHERE day<>'2026-09-01'`.execute(
      testDb.db,
    );
  }
  const before = calls.length;
  await service.run();
  expect(calls.length).toBe(before);
  expect(
    (
      await sql`SELECT attempts,last_reason FROM provider_fee_inter_scans WHERE day='2026-09-01'`.execute(
        testDb.db,
      )
    ).rows,
  ).toEqual([{ attempts: 8, last_reason: 'invalid_fee' }]);
});

it('partial pagination followed by 429 commits no fees and leaves the entire day pending', async () => {
  await payment();
  secondPageFails = true;
  expect(
    await new InterFeeSync(
      testDb.db,
      reader(),
      '11111111-1111-4111-8111-111111111111',
      () => now,
      true,
    ).run(),
  ).toMatchObject({ pending: true, imported: 0 });
  expect((await sql`SELECT id FROM provider_fee_events`.execute(testDb.db)).rows).toEqual([]);
  expect(
    (
      await sql`SELECT last_success_at,last_reason FROM provider_fee_inter_scans WHERE day='2026-09-01'`.execute(
        testDb.db,
      )
    ).rows,
  ).toEqual([{ last_success_at: null, last_reason: 'rate_limited' }]);
});

it('distinct tariff IDs sharing an E2E remain distinct observed fees', async () => {
  await payment();
  const service = new InterFeeSync(
    testDb.db,
    reader(),
    '11111111-1111-4111-8111-111111111111',
    () => now,
    true,
  );
  await service.run();
  feeIdentity = 'tarifa-2';
  await sql`UPDATE provider_fee_inter_scans SET next_attempt_at=${new Date(now.getTime() - 1000)} WHERE day='2026-09-01'`.execute(
    testDb.db,
  );
  expect(await service.run()).toMatchObject({ pending: false });
  expect((await sql`SELECT id FROM provider_fee_events`.execute(testDb.db)).rows).toHaveLength(2);
});

it('dry-run counts historical days/payments without scan writes or provider requests', async () => {
  await payment();
  const service = new InterFeeSync(
    testDb.db,
    reader(),
    '11111111-1111-4111-8111-111111111111',
    () => now,
  );
  expect(await service.dryRun()).toEqual({ days: 2, payments: 1 });
  expect(calls).toEqual([]);
  expect((await sql`SELECT day FROM provider_fee_inter_scans`.execute(testDb.db)).rows).toEqual([]);
});
