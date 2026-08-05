import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PixCobrancaProvider } from '../../src/adapters/pagamentos/pix-cobranca-provider.js';
import { archiveAndDispatchInterPixWebhook } from '../../src/adapters/webhook-archive/inter-pix-webhook-pipeline.js';
import { WebhookEventArchivePostgres } from '../../src/adapters/webhook-archive/webhook-event-archive.postgres.js';
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
    const args = {
      rawBody: JSON.stringify({
        pix: [
          { txid: txidA, endToEndId: e2eA },
          { txid: txidB, endToEndId: e2eB },
        ],
      }),
      pixCobrancaProvider: provider,
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
    expect(onChargeConfirmed).toHaveBeenCalledTimes(2);
    await expect(archive.findByProviderEventId('inter', e2eA)).resolves.toMatchObject({
      signatureValid: false,
      processedAt: expect.any(Date),
    });
    await expect(archive.findByProviderEventId('inter', e2eB)).resolves.toMatchObject({
      signatureValid: false,
      processedAt: expect.any(Date),
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
      providerEventId: e2eId,
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
