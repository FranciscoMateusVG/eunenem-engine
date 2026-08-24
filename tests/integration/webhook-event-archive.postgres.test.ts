import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PixCobrancaProvider } from '../../src/adapters/pagamentos/pix-cobranca-provider.js';
import { PagamentoRepositoryPostgres } from '../../src/adapters/pagamentos/repository.postgres.js';
import { archiveAndDispatchInterPixWebhook } from '../../src/adapters/webhook-archive/inter-pix-webhook-pipeline.js';
import { WebhookEventArchivePostgres } from '../../src/adapters/webhook-archive/webhook-event-archive.postgres.js';
import { makePagamento } from '../helpers/pagamento-repository.conformance.js';
import { seedPagamentoParents } from '../helpers/seed-pagamento-parents.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';
import { describeWebhookEventArchiveConformance } from '../helpers/webhook-event-archive.conformance.js';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describeWebhookEventArchiveConformance('Postgres', {
  factory: () => new WebhookEventArchivePostgres(testDb.db),
  resetState: async () => {
    await sql`TRUNCATE TABLE payment_webhook_events`.execute(testDb.db);
  },
});

describe('Inter Pix pipeline + real Postgres archive composition', () => {
  it('archives a split envelope, verifies each item and deduplicates redelivery', async () => {
    await sql`TRUNCATE TABLE payment_webhook_events`.execute(testDb.db);
    const archive = new WebhookEventArchivePostgres(testDb.db);
    const e2eA = 'A'.repeat(32);
    const e2eB = 'B'.repeat(32);
    const txidA = 'C'.repeat(26);
    const txidB = 'D'.repeat(26);
    const consultarCobranca = vi.fn().mockImplementation(async (txid: string) => ({
      status: 'concluida' as const,
      e2eId: txid === txidA ? e2eA : e2eB,
      valorPagoCents: txid === txidA ? 1000 : 2000,
      horario: new Date('2026-08-05T12:00:00.000Z'),
    }));
    const provider = {
      criarCobranca: vi.fn(),
      consultarCobranca,
      solicitarDevolucao: vi.fn(),
      consultarDevolucao: vi.fn(),
    } satisfies PixCobrancaProvider;
    const onChargeConfirmed = vi.fn().mockResolvedValue({ pagamentoId: null });
    const resolveChargeBinding = vi.fn(async ({ txid }: { readonly txid: string }) => ({
      pagamentoId: txid === txidA ? 'pagamento-a' : 'pagamento-b',
      txid,
    }));
    const args = {
      rawBody: JSON.stringify({
        pix: [
          {
            txid: txidA,
            endToEndId: e2eA,
            valor: '1.00',
            pagador: { cpf: 'must-not-persist', nome: 'PII' },
          },
          { txid: txidB, endToEndId: e2eB, campoLivre: 'attacker-controlled' },
        ],
      }),
      pixCobrancaProvider: provider,
      resolveChargeBinding,
      resolveRefundBinding: vi.fn().mockResolvedValue(null),
      onChargeConfirmed,
      onRefundConfirmed: vi.fn(),
    };

    const first = await archiveAndDispatchInterPixWebhook(archive, args);
    const replay = await archiveAndDispatchInterPixWebhook(archive, args);

    expect(first.items.map((item) => item.outcome)).toEqual([
      'dispatched_success',
      'dispatched_success',
    ]);
    expect(replay.items.map((item) => item.outcome)).toEqual([
      'duplicate_processed',
      'duplicate_processed',
    ]);
    expect(consultarCobranca).toHaveBeenCalledTimes(2);
    expect(resolveChargeBinding).toHaveBeenCalledTimes(2);
    expect(onChargeConfirmed).toHaveBeenCalledTimes(2);
    expect(onChargeConfirmed).toHaveBeenNthCalledWith(1, {
      pagamentoId: 'pagamento-a',
      txid: txidA,
      e2eId: e2eA,
      amountCents: 1000,
      horario: new Date('2026-08-05T12:00:00.000Z'),
    });
    expect(onChargeConfirmed).toHaveBeenNthCalledWith(2, {
      pagamentoId: 'pagamento-b',
      txid: txidB,
      e2eId: e2eB,
      amountCents: 2000,
      horario: new Date('2026-08-05T12:00:00.000Z'),
    });
    const archivedA = await archive.findByProviderEventId('inter', `${txidA}:${e2eA}`);
    const archivedB = await archive.findByProviderEventId('inter', `${txidB}:${e2eB}`);
    expect(archivedA).toMatchObject({
      signatureValid: false,
      processedAt: expect.any(Date),
    });
    expect(archivedB).toMatchObject({
      signatureValid: false,
      processedAt: expect.any(Date),
    });
    expect(archivedA?.rawPayload).toEqual({ txid: txidA, endToEndId: e2eA });
    expect(archivedB?.rawPayload).toEqual({ txid: txidB, endToEndId: e2eB });
    expect(JSON.stringify([archivedA?.rawPayload, archivedB?.rawPayload])).not.toContain(
      'must-not-persist',
    );
    expect(JSON.stringify([archivedA?.rawPayload, archivedB?.rawPayload])).not.toContain(
      'attacker-controlled',
    );
  });

  it('never links a second txid onto a failed row that used the same e2e id', async () => {
    await sql`TRUNCATE TABLE payment_webhook_events`.execute(testDb.db);
    const archive = new WebhookEventArchivePostgres(testDb.db);
    const e2eId = 'E'.repeat(32);
    const pagamentoAId = '00000000-0000-4000-8000-000000000041';
    const pagamentoBId = '00000000-0000-4000-8000-000000000042';
    const txidA = pagamentoAId.replaceAll('-', '');
    const txidB = pagamentoBId.replaceAll('-', '');
    const pagamentoB = makePagamento({ id: pagamentoBId, externalRef: txidB });
    await seedPagamentoParents(testDb.db, pagamentoB);
    await new PagamentoRepositoryPostgres(testDb.db).save(pagamentoB);
    const consultarCobranca = vi
      .fn()
      .mockRejectedValueOnce(new Error('first authoritative read failed'))
      .mockResolvedValueOnce({
        status: 'concluida' as const,
        e2eId,
        valorPagoCents: 2050,
        horario: new Date('2026-08-05T12:00:00.000Z'),
      });
    const provider = {
      criarCobranca: vi.fn(),
      consultarCobranca,
      solicitarDevolucao: vi.fn(),
      consultarDevolucao: vi.fn(),
    } satisfies PixCobrancaProvider;
    const onChargeConfirmed = vi.fn().mockResolvedValue({ pagamentoId: pagamentoBId });
    const resolveChargeBinding = vi.fn(async ({ txid }: { readonly txid: string }) => ({
      pagamentoId: txid === txidA ? pagamentoAId : pagamentoBId,
      txid,
    }));
    const args = {
      pixCobrancaProvider: provider,
      resolveChargeBinding,
      resolveRefundBinding: vi.fn().mockResolvedValue(null),
      onChargeConfirmed,
      onRefundConfirmed: vi.fn(),
    };

    const failedA = await archiveAndDispatchInterPixWebhook(archive, {
      ...args,
      rawBody: JSON.stringify({ pix: [{ txid: txidA, endToEndId: e2eId }] }),
    });
    const succeededB = await archiveAndDispatchInterPixWebhook(archive, {
      ...args,
      rawBody: JSON.stringify({ pix: [{ txid: txidB, endToEndId: e2eId }] }),
    });

    expect(failedA.items[0]).toMatchObject({
      providerEventId: `${txidA}:${e2eId}`,
      outcome: 'charge_requery_failed',
    });
    expect(succeededB.items[0]).toMatchObject({
      providerEventId: `${txidB}:${e2eId}`,
      outcome: 'dispatched_success',
    });
    expect(failedA.items[0]?.archiveId).not.toBe(succeededB.items[0]?.archiveId);
    expect(consultarCobranca).toHaveBeenCalledTimes(2);
    expect(onChargeConfirmed).toHaveBeenCalledTimes(1);
    expect(onChargeConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ pagamentoId: pagamentoBId, txid: txidB, e2eId }),
    );
    await expect(
      archive.findByProviderEventId('inter', `${txidA}:${e2eId}`),
    ).resolves.toMatchObject({
      rawPayload: { txid: txidA, endToEndId: e2eId },
      pagamentoId: null,
      processedAt: null,
      processingError: 'charge_requery_failed',
    });
    await expect(
      archive.findByProviderEventId('inter', `${txidB}:${e2eId}`),
    ).resolves.toMatchObject({
      rawPayload: { txid: txidB, endToEndId: e2eId },
      pagamentoId: pagamentoBId,
      processedAt: expect.any(Date),
      processingError: null,
    });
  });

  it('atomically claims one concurrent redelivery of a failed Inter event', async () => {
    await sql`TRUNCATE TABLE payment_webhook_events`.execute(testDb.db);
    const archive = new WebhookEventArchivePostgres(testDb.db);
    const e2eId = 'R'.repeat(32);
    const txid = 'T'.repeat(26);
    const rawBody = JSON.stringify({ pix: [{ txid, endToEndId: e2eId }] });
    const seeded = await archive.saveReceived({
      provider: 'inter',
      providerEventId: `${txid}:${e2eId}`,
      eventType: 'pix.recebido',
      rawPayload: { txid, endToEndId: e2eId },
      signatureHeader: 'not-provided-by-inter',
      signatureValid: false,
    });
    await archive.markFailed(seeded.id, 'charge_bookkeeping_failed');

    let releaseAuthoritativeRead: (() => void) | undefined;
    const authoritativeReadGate = new Promise<void>((resolve) => {
      releaseAuthoritativeRead = resolve;
    });
    const consultarCobranca = vi.fn().mockImplementation(async () => {
      await authoritativeReadGate;
      return {
        status: 'concluida' as const,
        e2eId,
        valorPagoCents: 10_500,
        horario: new Date('2026-08-05T12:00:00.000Z'),
      };
    });
    const provider = {
      criarCobranca: vi.fn(),
      consultarCobranca,
      solicitarDevolucao: vi.fn(),
      consultarDevolucao: vi.fn(),
    } satisfies PixCobrancaProvider;
    const onChargeConfirmed = vi.fn().mockResolvedValue({ pagamentoId: null });
    const args = {
      rawBody,
      pixCobrancaProvider: provider,
      resolveChargeBinding: vi.fn(async () => ({ pagamentoId: 'pagamento-a', txid })),
      resolveRefundBinding: vi.fn().mockResolvedValue(null),
      onChargeConfirmed,
      onRefundConfirmed: vi.fn(),
    };

    const deliveries = Promise.all([
      archiveAndDispatchInterPixWebhook(archive, args),
      archiveAndDispatchInterPixWebhook(archive, args),
    ]);
    await vi.waitFor(() => expect(consultarCobranca).toHaveBeenCalledTimes(1));
    // Keep the claimant inside the authoritative read long enough for the
    // competing delivery to observe the durable in-flight state.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(consultarCobranca).toHaveBeenCalledTimes(1);
    releaseAuthoritativeRead?.();

    const results = await deliveries;
    expect(results.map((result) => result.items[0]?.outcome).sort()).toEqual([
      'dispatched_success',
      'duplicate_in_flight',
    ]);
    expect(onChargeConfirmed).toHaveBeenCalledTimes(1);
    await expect(archive.findById(seeded.id)).resolves.toMatchObject({
      processedAt: expect.any(Date),
      processingError: null,
    });
  });
});
