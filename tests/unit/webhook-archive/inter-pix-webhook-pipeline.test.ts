import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PixCobrancaProvider } from '../../../src/adapters/pagamentos/pix-cobranca-provider.js';
import {
  archiveAndDispatchInterPixWebhook,
  INTER_PIX_MAX_ARCHIVED_PROJECTION_BYTES,
  INTER_PIX_MAX_REFUNDS_PER_ITEM,
  INTER_PIX_SIGNATURE_SENTINEL,
} from '../../../src/adapters/webhook-archive/inter-pix-webhook-pipeline.js';
import { WebhookEventArchiveMemory } from '../../../src/adapters/webhook-archive/webhook-event-archive.memory.js';
import type { MoneyCents } from '../../../src/domain/money.js';

const TXID_A = 'A'.repeat(26);
const TXID_B = 'B'.repeat(26);
const E2E_A = 'E'.repeat(32);
const E2E_B = 'F'.repeat(32);
const PAID_AT = new Date('2026-08-05T12:00:00.000Z');
const REFUND_AMOUNT = 1005 as MoneyCents;

function provider(overrides: Partial<PixCobrancaProvider> = {}): PixCobrancaProvider {
  return {
    criarCobranca: vi.fn(),
    consultarCobranca: vi.fn().mockResolvedValue({
      status: 'concluida',
      e2eId: E2E_A,
      valorPagoCents: 10_500,
      horario: PAID_AT,
    }),
    solicitarDevolucao: vi.fn(),
    consultarDevolucao: vi.fn().mockResolvedValue({ status: 'devolvida' }),
    ...overrides,
  };
}

function envelope(pix: readonly unknown[]): string {
  return JSON.stringify({ pix });
}

describe('archiveAndDispatchInterPixWebhook', () => {
  let archive: WebhookEventArchiveMemory;
  let onChargeConfirmed: ReturnType<typeof vi.fn>;
  let onRefundConfirmed: ReturnType<typeof vi.fn>;
  let resolveChargeBinding: ReturnType<typeof vi.fn>;
  let resolveRefundBinding: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    archive = new WebhookEventArchiveMemory(() => new Date('2026-08-05T12:30:00.000Z'));
    onChargeConfirmed = vi.fn().mockResolvedValue({ pagamentoId: 'pagamento-a' });
    onRefundConfirmed = vi.fn().mockResolvedValue({ pagamentoId: 'pagamento-a' });
    resolveChargeBinding = vi.fn(async ({ txid }) => ({
      pagamentoId: txid === TXID_A ? 'pagamento-a' : 'pagamento-b',
      txid,
    }));
    resolveRefundBinding = vi.fn(async (identity) => ({
      ...identity,
      amountCents: REFUND_AMOUNT,
    }));
  });

  it('splits pix[] into per-item rows, re-queries each txid and dispatches only authoritative values', async () => {
    const consultarCobranca = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'concluida',
        e2eId: E2E_A,
        valorPagoCents: 10_500,
        horario: PAID_AT,
      })
      .mockResolvedValueOnce({
        status: 'concluida',
        e2eId: E2E_B,
        valorPagoCents: 20_500,
        horario: PAID_AT,
      });
    const result = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([
        { txid: TXID_A, endToEndId: E2E_A, valor: '1.00', pagador: { cpf: 'hidden' } },
        { txid: TXID_B, endToEndId: E2E_B, valor: '999.00' },
      ]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarCobranca }),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(result).toMatchObject({ status: 200, outcome: 'accepted' });
    expect(result.items.map((item) => item.outcome)).toEqual([
      'dispatched_success',
      'dispatched_success',
    ]);
    expect(consultarCobranca).toHaveBeenNthCalledWith(1, TXID_A);
    expect(consultarCobranca).toHaveBeenNthCalledWith(2, TXID_B);
    expect(resolveChargeBinding).toHaveBeenNthCalledWith(1, { txid: TXID_A, e2eId: E2E_A });
    expect(resolveChargeBinding).toHaveBeenNthCalledWith(2, { txid: TXID_B, e2eId: E2E_B });
    expect(onChargeConfirmed).toHaveBeenNthCalledWith(1, {
      pagamentoId: 'pagamento-a',
      txid: TXID_A,
      e2eId: E2E_A,
      amountCents: 10_500,
      horario: PAID_AT,
    });
    expect(onChargeConfirmed).toHaveBeenNthCalledWith(2, {
      pagamentoId: 'pagamento-b',
      txid: TXID_B,
      e2eId: E2E_B,
      amountCents: 20_500,
      horario: PAID_AT,
    });

    const archivedA = await archive.findByProviderEventId('inter', E2E_A);
    const archivedB = await archive.findByProviderEventId('inter', E2E_B);
    expect(archivedA).toMatchObject({
      provider: 'inter',
      eventType: 'pix.recebido',
      signatureHeader: INTER_PIX_SIGNATURE_SENTINEL,
      signatureValid: false,
      pagamentoId: 'pagamento-a',
    });
    expect(archivedA?.rawPayload).toEqual({ txid: TXID_A, endToEndId: E2E_A });
    expect(archivedB?.rawPayload).toEqual({ txid: TXID_B, endToEndId: E2E_B });
    expect(JSON.stringify([archivedA?.rawPayload, archivedB?.rawPayload])).not.toContain('hidden');
  });

  it('deduplicates a processed e2eId without a second authoritative read or dispatch', async () => {
    const consultarCobranca = vi.fn().mockResolvedValue({
      status: 'concluida',
      e2eId: E2E_A,
      valorPagoCents: 10_500,
      horario: PAID_AT,
    });
    const args = {
      rawBody: envelope([{ txid: TXID_A, endToEndId: E2E_A }]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarCobranca }),
      onChargeConfirmed,
      onRefundConfirmed,
    };

    const first = await archiveAndDispatchInterPixWebhook(archive, args);
    const second = await archiveAndDispatchInterPixWebhook(archive, args);

    expect(first.items[0]?.outcome).toBe('dispatched_success');
    expect(second.items[0]).toMatchObject({
      archiveId: first.items[0]?.archiveId,
      outcome: 'duplicate_processed',
    });
    expect(consultarCobranca).toHaveBeenCalledTimes(1);
    expect(onChargeConfirmed).toHaveBeenCalledTimes(1);
  });

  it('grants one failed-event retry claimant under concurrent redelivery', async () => {
    const consultarCobranca = vi.fn().mockResolvedValue({
      status: 'concluida',
      e2eId: E2E_A,
      valorPagoCents: 10_500,
      horario: PAID_AT,
    });
    const args = {
      rawBody: envelope([{ txid: TXID_A, endToEndId: E2E_A }]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarCobranca }),
      onChargeConfirmed,
      onRefundConfirmed,
    };

    onChargeConfirmed.mockRejectedValueOnce(new Error('first bookkeeping attempt failed'));
    const failed = await archiveAndDispatchInterPixWebhook(archive, args);
    expect(failed.items[0]?.outcome).toBe('charge_bookkeeping_failed');

    consultarCobranca.mockClear();
    onChargeConfirmed.mockClear().mockResolvedValue({ pagamentoId: 'pagamento-a' });
    const retries = await Promise.all([
      archiveAndDispatchInterPixWebhook(archive, args),
      archiveAndDispatchInterPixWebhook(archive, args),
    ]);

    expect(retries.map((retry) => retry.items[0]?.outcome).sort()).toEqual([
      'dispatched_success',
      'duplicate_in_flight',
    ]);
    expect(consultarCobranca).toHaveBeenCalledTimes(1);
    expect(onChargeConfirmed).toHaveBeenCalledTimes(1);
    await expect(archive.findByProviderEventId('inter', E2E_A)).resolves.toMatchObject({
      processedAt: expect.any(Date),
      processingError: null,
      pagamentoId: 'pagamento-a',
    });
  });

  it('marks a failed authoritative read categorically and performs no state change', async () => {
    const consultarCobranca = vi.fn().mockRejectedValue(new Error('provider body with payer PII'));
    const result = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([{ txid: TXID_A, endToEndId: E2E_A }]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarCobranca }),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(result.status).toBe(200);
    expect(result.items[0]?.outcome).toBe('charge_requery_failed');
    expect(onChargeConfirmed).not.toHaveBeenCalled();
    const archived = await archive.findByProviderEventId('inter', E2E_A);
    expect(archived).toMatchObject({
      processedAt: null,
      pagamentoId: null,
      processingError: 'charge_requery_failed',
    });
    expect(JSON.stringify(archived)).not.toContain('payer PII');
  });

  it('fails an unknown local charge binding before any provider call or dispatch', async () => {
    const consultarCobranca = vi.fn();
    resolveChargeBinding.mockResolvedValueOnce(null);

    const result = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([{ txid: TXID_A, endToEndId: E2E_A }]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarCobranca }),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(result.items[0]?.outcome).toBe('charge_binding_failed');
    expect(resolveChargeBinding).toHaveBeenCalledWith({ txid: TXID_A, e2eId: E2E_A });
    expect(consultarCobranca).not.toHaveBeenCalled();
    expect(onChargeConfirmed).not.toHaveBeenCalled();
  });

  it('fails a mismatched local charge binding before any provider call or dispatch', async () => {
    const consultarCobranca = vi.fn();
    resolveChargeBinding.mockResolvedValueOnce({ pagamentoId: 'pagamento-a', txid: TXID_B });

    const result = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([{ txid: TXID_A, endToEndId: E2E_A }]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarCobranca }),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(result.items[0]?.outcome).toBe('charge_binding_failed');
    expect(consultarCobranca).not.toHaveBeenCalled();
    expect(onChargeConfirmed).not.toHaveBeenCalled();
  });

  it('rejects an e2e identity mismatch after GET /cob and does not dispatch', async () => {
    const result = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([{ txid: TXID_A, endToEndId: E2E_A }]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({
        consultarCobranca: vi.fn().mockResolvedValue({
          status: 'concluida',
          e2eId: E2E_B,
          valorPagoCents: 10_500,
          horario: PAID_AT,
        }),
      }),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(result.items[0]?.outcome).toBe('charge_identity_mismatch');
    expect(onChargeConfirmed).not.toHaveBeenCalled();
  });

  it('treats pix items with devolucoes as refund-only, verifies every refund and never dispatches charge', async () => {
    const consultarCobranca = vi.fn();
    const consultarDevolucao = vi.fn().mockResolvedValue({ status: 'devolvida' });
    const result = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([
        {
          txid: TXID_A,
          endToEndId: E2E_A,
          pagador: { cpf: 'refund-payer-pii' },
          devolucoes: [
            { id: 'refund1', valor: '999.99', descricao: 'extra-refund-field' },
            { id: 'refund2', valor: '0.01', cpf: 'refund-payer-pii' },
          ],
        },
      ]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarCobranca, consultarDevolucao }),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.providerEventId)).toEqual([
      `${E2E_A}:devolucao:refund1`,
      `${E2E_A}:devolucao:refund2`,
    ]);
    expect(consultarCobranca).not.toHaveBeenCalled();
    expect(consultarDevolucao).toHaveBeenNthCalledWith(1, {
      e2eId: E2E_A,
      idDevolucao: 'refund1',
      amountCents: REFUND_AMOUNT,
    });
    expect(consultarDevolucao).toHaveBeenNthCalledWith(2, {
      e2eId: E2E_A,
      idDevolucao: 'refund2',
      amountCents: REFUND_AMOUNT,
    });
    expect(onChargeConfirmed).not.toHaveBeenCalled();
    expect(onRefundConfirmed).toHaveBeenCalledTimes(2);
    const archivedRefund1 = await archive.findByProviderEventId(
      'inter',
      `${E2E_A}:devolucao:refund1`,
    );
    const archivedRefund2 = await archive.findByProviderEventId(
      'inter',
      `${E2E_A}:devolucao:refund2`,
    );
    expect(archivedRefund1?.rawPayload).toEqual({
      endToEndId: E2E_A,
      idDevolucao: 'refund1',
    });
    expect(archivedRefund2?.rawPayload).toEqual({
      endToEndId: E2E_A,
      idDevolucao: 'refund2',
    });
    expect(
      JSON.stringify([archivedRefund1?.rawPayload, archivedRefund2?.rawPayload]),
    ).not.toContain('refund-payer-pii');
  });

  it('bounds 20 refund projections and rejects 21 refunds before archive or provider work', async () => {
    const maxRefunds = Array.from({ length: INTER_PIX_MAX_REFUNDS_PER_ITEM }, (_, index) => ({
      id: `refund${String(index).padStart(2, '0')}`,
      cpf: 'must-not-persist',
    }));
    const consultarDevolucao = vi.fn().mockResolvedValue({ status: 'devolvida' });

    const accepted = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([
        { txid: TXID_A, endToEndId: E2E_A, pagador: { cpf: 'pii' }, devolucoes: maxRefunds },
      ]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarDevolucao }),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(accepted.items).toHaveLength(INTER_PIX_MAX_REFUNDS_PER_ITEM);
    let totalArchivedProjectionBytes = 0;
    for (const refund of maxRefunds) {
      const archived = await archive.findByProviderEventId(
        'inter',
        `${E2E_A}:devolucao:${refund.id}`,
      );
      expect(archived?.rawPayload).toEqual({
        endToEndId: E2E_A,
        idDevolucao: refund.id,
      });
      const projectionBytes = Buffer.byteLength(JSON.stringify(archived?.rawPayload), 'utf8');
      totalArchivedProjectionBytes += projectionBytes;
      expect(projectionBytes).toBeLessThanOrEqual(INTER_PIX_MAX_ARCHIVED_PROJECTION_BYTES);
    }
    expect(totalArchivedProjectionBytes).toBeLessThanOrEqual(
      INTER_PIX_MAX_REFUNDS_PER_ITEM * INTER_PIX_MAX_ARCHIVED_PROJECTION_BYTES,
    );

    const rejectedArchive = new WebhookEventArchiveMemory();
    const rejectedProviderCall = vi.fn();
    const rejectedResolveBinding = vi.fn();
    const rejectedDispatch = vi.fn();
    const tooManyRefunds = [...maxRefunds, { id: 'refund20' }];
    const rejected = await archiveAndDispatchInterPixWebhook(rejectedArchive, {
      rawBody: envelope([{ txid: TXID_A, endToEndId: E2E_A, devolucoes: tooManyRefunds }]),
      resolveChargeBinding,
      resolveRefundBinding: rejectedResolveBinding,
      pixCobrancaProvider: provider({ consultarDevolucao: rejectedProviderCall }),
      onChargeConfirmed,
      onRefundConfirmed: rejectedDispatch,
    });

    expect(rejected).toMatchObject({ status: 400, items: [] });
    expect(rejectedResolveBinding).not.toHaveBeenCalled();
    expect(rejectedProviderCall).not.toHaveBeenCalled();
    expect(rejectedDispatch).not.toHaveBeenCalled();
    for (const refund of tooManyRefunds) {
      await expect(
        rejectedArchive.findByProviderEventId('inter', `${E2E_A}:devolucao:${refund.id}`),
      ).resolves.toBeUndefined();
    }
  });

  it('fails closed before provider GET when no persisted refund amount is bound', async () => {
    const consultarDevolucao = vi.fn().mockResolvedValue({ status: 'devolvida' });
    resolveRefundBinding.mockResolvedValueOnce(null);

    const result = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([{ txid: TXID_A, endToEndId: E2E_A, devolucoes: [{ id: 'refund1' }] }]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarDevolucao }),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(result.items[0]?.outcome).toBe('refund_binding_failed');
    expect(consultarDevolucao).not.toHaveBeenCalled();
    expect(onRefundConfirmed).not.toHaveBeenCalled();
  });

  it('rejects a resolver identity mismatch before provider GET', async () => {
    const consultarDevolucao = vi.fn().mockResolvedValue({ status: 'devolvida' });
    resolveRefundBinding.mockResolvedValueOnce({
      e2eId: E2E_B,
      idDevolucao: 'another-refund',
      amountCents: REFUND_AMOUNT,
    });

    const result = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([{ txid: TXID_A, endToEndId: E2E_A, devolucoes: [{ id: 'refund1' }] }]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarDevolucao }),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(result.items[0]?.outcome).toBe('refund_binding_failed');
    expect(consultarDevolucao).not.toHaveBeenCalled();
    expect(onRefundConfirmed).not.toHaveBeenCalled();
  });

  it('returns 400 and archives nothing for malformed or over-fanout envelopes', async () => {
    const invalidJson = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: '{',
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider(),
      onChargeConfirmed,
      onRefundConfirmed,
    });
    const tooMany = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope(
        Array.from({ length: 101 }, (_, index) => ({
          txid: String(index).padStart(26, '0'),
          endToEndId: `E2E-${index}`,
        })),
      ),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider(),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(invalidJson).toMatchObject({ status: 400, items: [] });
    expect(tooMany).toMatchObject({ status: 400, items: [] });
    expect(onChargeConfirmed).not.toHaveBeenCalled();
  });
});
