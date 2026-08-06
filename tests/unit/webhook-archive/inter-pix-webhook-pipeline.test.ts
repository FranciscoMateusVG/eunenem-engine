import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PixCobrancaProvider } from '../../../src/adapters/pagamentos/pix-cobranca-provider.js';
import {
  archiveAndDispatchInterPixWebhook,
  INTER_PIX_MAX_ARCHIVED_PROJECTION_BYTES,
  INTER_PIX_MAX_PARSED_EVENTS,
  INTER_PIX_MAX_REFUNDS_PER_ENVELOPE,
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

    const archivedA = await archive.findByProviderEventId('inter', `${TXID_A}:${E2E_A}`);
    const archivedB = await archive.findByProviderEventId('inter', `${TXID_B}:${E2E_B}`);
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

  it('deduplicates a processed charge identity without a second authoritative read or dispatch', async () => {
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

  it('collapses an exact charge identity repeated within one envelope before all work', async () => {
    const consultarCobranca = vi.fn().mockResolvedValue({
      status: 'concluida',
      e2eId: E2E_A,
      valorPagoCents: 10_500,
      horario: PAID_AT,
    });
    const saveReceived = vi.spyOn(archive, 'saveReceived');

    const result = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([
        { txid: TXID_A, endToEndId: E2E_A },
        { txid: TXID_A, endToEndId: E2E_A },
      ]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarCobranca }),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(result).toMatchObject({ status: 200, outcome: 'accepted' });
    expect(result.items).toEqual([
      expect.objectContaining({
        providerEventId: `${TXID_A}:${E2E_A}`,
        outcome: 'dispatched_success',
      }),
    ]);
    expect(saveReceived).toHaveBeenCalledTimes(1);
    expect(resolveChargeBinding).toHaveBeenCalledTimes(1);
    expect(consultarCobranca).toHaveBeenCalledTimes(1);
    expect(onChargeConfirmed).toHaveBeenCalledTimes(1);
  });

  it('rejects one txid mapped to distinct e2e ids before any work', async () => {
    const consultarCobranca = vi.fn();
    const consultarDevolucao = vi.fn();
    const saveReceived = vi.spyOn(archive, 'saveReceived');

    const result = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([
        { txid: TXID_A, endToEndId: E2E_A },
        { txid: TXID_A, endToEndId: E2E_B },
      ]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarCobranca, consultarDevolucao }),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(result).toMatchObject({ status: 400, outcome: 'malformed_body', items: [] });
    expect(saveReceived).not.toHaveBeenCalled();
    expect(resolveChargeBinding).not.toHaveBeenCalled();
    expect(resolveRefundBinding).not.toHaveBeenCalled();
    expect(consultarCobranca).not.toHaveBeenCalled();
    expect(consultarDevolucao).not.toHaveBeenCalled();
    expect(onChargeConfirmed).not.toHaveBeenCalled();
    expect(onRefundConfirmed).not.toHaveBeenCalled();
  });

  it('rejects one e2e id mapped to distinct txids before any work', async () => {
    const consultarCobranca = vi.fn();
    const consultarDevolucao = vi.fn();
    const saveReceived = vi.spyOn(archive, 'saveReceived');

    const result = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([
        { txid: TXID_A, endToEndId: E2E_A },
        { txid: TXID_B, endToEndId: E2E_A },
      ]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarCobranca, consultarDevolucao }),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(result).toMatchObject({ status: 400, outcome: 'malformed_body', items: [] });
    expect(saveReceived).not.toHaveBeenCalled();
    expect(resolveChargeBinding).not.toHaveBeenCalled();
    expect(resolveRefundBinding).not.toHaveBeenCalled();
    expect(consultarCobranca).not.toHaveBeenCalled();
    expect(consultarDevolucao).not.toHaveBeenCalled();
    expect(onChargeConfirmed).not.toHaveBeenCalled();
    expect(onRefundConfirmed).not.toHaveBeenCalled();
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
    await expect(
      archive.findByProviderEventId('inter', `${TXID_A}:${E2E_A}`),
    ).resolves.toMatchObject({
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
    const archived = await archive.findByProviderEventId('inter', `${TXID_A}:${E2E_A}`);
    expect(archived).toMatchObject({
      processedAt: null,
      pagamentoId: null,
      processingError: 'charge_requery_failed',
    });
    expect(JSON.stringify(archived)).not.toContain('payer PII');
  });

  it('keeps distinct txids with the same e2e in separate archive rows across deliveries', async () => {
    const consultarCobranca = vi
      .fn()
      .mockRejectedValueOnce(new Error('first txid failed'))
      .mockResolvedValueOnce({
        status: 'concluida',
        e2eId: E2E_A,
        valorPagoCents: 20_500,
        horario: PAID_AT,
      });
    onChargeConfirmed.mockResolvedValueOnce({ pagamentoId: 'pagamento-b' });
    const args = {
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarCobranca }),
      onChargeConfirmed,
      onRefundConfirmed,
    };

    const failedA = await archiveAndDispatchInterPixWebhook(archive, {
      ...args,
      rawBody: envelope([{ txid: TXID_A, endToEndId: E2E_A }]),
    });
    const succeededB = await archiveAndDispatchInterPixWebhook(archive, {
      ...args,
      rawBody: envelope([{ txid: TXID_B, endToEndId: E2E_A }]),
    });

    expect(failedA.items[0]).toMatchObject({
      providerEventId: `${TXID_A}:${E2E_A}`,
      outcome: 'charge_requery_failed',
    });
    expect(succeededB.items[0]).toMatchObject({
      providerEventId: `${TXID_B}:${E2E_A}`,
      outcome: 'dispatched_success',
    });
    expect(failedA.items[0]?.archiveId).not.toBe(succeededB.items[0]?.archiveId);
    await expect(
      archive.findByProviderEventId('inter', `${TXID_A}:${E2E_A}`),
    ).resolves.toMatchObject({
      pagamentoId: null,
      processedAt: null,
      processingError: 'charge_requery_failed',
    });
    await expect(
      archive.findByProviderEventId('inter', `${TXID_B}:${E2E_A}`),
    ).resolves.toMatchObject({
      pagamentoId: 'pagamento-b',
      processedAt: expect.any(Date),
      processingError: null,
    });
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

  it('collapses an exact refund identity repeated within one envelope before all work', async () => {
    const consultarCobranca = vi.fn();
    const consultarDevolucao = vi.fn().mockResolvedValue({ status: 'devolvida' });
    const saveReceived = vi.spyOn(archive, 'saveReceived');

    const result = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([
        {
          txid: TXID_A,
          endToEndId: E2E_A,
          devolucoes: [{ id: 'refund1' }, { id: 'refund1' }],
        },
      ]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarCobranca, consultarDevolucao }),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(result).toMatchObject({ status: 200, outcome: 'accepted' });
    expect(result.items).toEqual([
      expect.objectContaining({
        providerEventId: `${E2E_A}:devolucao:refund1`,
        outcome: 'dispatched_success',
      }),
    ]);
    expect(saveReceived).toHaveBeenCalledTimes(1);
    expect(resolveChargeBinding).not.toHaveBeenCalled();
    expect(resolveRefundBinding).toHaveBeenCalledTimes(1);
    expect(consultarCobranca).not.toHaveBeenCalled();
    expect(consultarDevolucao).toHaveBeenCalledTimes(1);
    expect(onChargeConfirmed).not.toHaveBeenCalled();
    expect(onRefundConfirmed).toHaveBeenCalledTimes(1);
  });

  it('accepts exactly 20 flattened refunds across multiple pix with one bounded work unit per refund', async () => {
    const firstRefunds = Array.from(
      { length: INTER_PIX_MAX_REFUNDS_PER_ENVELOPE / 2 },
      (_, index) => ({
        id: `refundA${String(index).padStart(2, '0')}`,
        cpf: 'must-not-persist-a',
      }),
    );
    const secondRefunds = Array.from(
      { length: INTER_PIX_MAX_REFUNDS_PER_ENVELOPE / 2 },
      (_, index) => ({
        id: `refundB${String(index).padStart(2, '0')}`,
        pagador: { cpf: 'must-not-persist-b' },
      }),
    );
    const consultarCobranca = vi.fn();
    const consultarDevolucao = vi.fn().mockResolvedValue({ status: 'devolvida' });
    const saveReceived = vi.spyOn(archive, 'saveReceived');

    const accepted = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([
        {
          txid: TXID_A,
          endToEndId: E2E_A,
          pagador: { cpf: 'must-not-persist-pix-a' },
          devolucoes: firstRefunds,
        },
        {
          txid: TXID_B,
          endToEndId: E2E_B,
          pagador: { cpf: 'must-not-persist-pix-b' },
          devolucoes: secondRefunds,
        },
      ]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarCobranca, consultarDevolucao }),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(accepted).toMatchObject({ status: 200, outcome: 'accepted' });
    expect(accepted.items).toHaveLength(INTER_PIX_MAX_REFUNDS_PER_ENVELOPE);
    expect(accepted.items.every((item) => item.outcome === 'dispatched_success')).toBe(true);
    expect(saveReceived).toHaveBeenCalledTimes(INTER_PIX_MAX_REFUNDS_PER_ENVELOPE);
    expect(resolveChargeBinding).not.toHaveBeenCalled();
    expect(resolveRefundBinding).toHaveBeenCalledTimes(INTER_PIX_MAX_REFUNDS_PER_ENVELOPE);
    expect(consultarCobranca).not.toHaveBeenCalled();
    expect(consultarDevolucao).toHaveBeenCalledTimes(INTER_PIX_MAX_REFUNDS_PER_ENVELOPE);
    expect(onChargeConfirmed).not.toHaveBeenCalled();
    expect(onRefundConfirmed).toHaveBeenCalledTimes(INTER_PIX_MAX_REFUNDS_PER_ENVELOPE);

    let totalArchivedProjectionBytes = 0;
    for (const [e2eId, refunds] of [
      [E2E_A, firstRefunds],
      [E2E_B, secondRefunds],
    ] as const) {
      for (const refund of refunds) {
        const archived = await archive.findByProviderEventId(
          'inter',
          `${e2eId}:devolucao:${refund.id}`,
        );
        expect(archived?.rawPayload).toEqual({
          endToEndId: e2eId,
          idDevolucao: refund.id,
        });
        const projectionBytes = Buffer.byteLength(JSON.stringify(archived?.rawPayload), 'utf8');
        totalArchivedProjectionBytes += projectionBytes;
        expect(projectionBytes).toBeLessThanOrEqual(INTER_PIX_MAX_ARCHIVED_PROJECTION_BYTES);
      }
    }
    expect(totalArchivedProjectionBytes).toBeLessThanOrEqual(
      INTER_PIX_MAX_REFUNDS_PER_ENVELOPE * INTER_PIX_MAX_ARCHIVED_PROJECTION_BYTES,
    );
  });

  it('rejects 21 flattened refunds across multiple pix before all work', async () => {
    const firstRefunds = Array.from({ length: 10 }, (_, index) => ({
      id: `refundA${String(index).padStart(2, '0')}`,
    }));
    const secondRefunds = Array.from({ length: 11 }, (_, index) => ({
      id: `refundB${String(index).padStart(2, '0')}`,
    }));
    const consultarCobranca = vi.fn();
    const consultarDevolucao = vi.fn();
    const saveReceived = vi.spyOn(archive, 'saveReceived');

    const rejected = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([
        { txid: TXID_A, endToEndId: E2E_A, devolucoes: firstRefunds },
        { txid: TXID_B, endToEndId: E2E_B, devolucoes: secondRefunds },
      ]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarCobranca, consultarDevolucao }),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(rejected).toMatchObject({ status: 400, outcome: 'malformed_body', items: [] });
    expect(saveReceived).not.toHaveBeenCalled();
    expect(resolveChargeBinding).not.toHaveBeenCalled();
    expect(resolveRefundBinding).not.toHaveBeenCalled();
    expect(consultarCobranca).not.toHaveBeenCalled();
    expect(consultarDevolucao).not.toHaveBeenCalled();
    expect(onChargeConfirmed).not.toHaveBeenCalled();
    expect(onRefundConfirmed).not.toHaveBeenCalled();
  });

  it('caps raw expanded events before deduplication so repeated hints cannot bypass the limit', async () => {
    const refunds = Array.from({ length: INTER_PIX_MAX_REFUNDS_PER_ENVELOPE }, (_, index) => ({
      id: `refund${String(index).padStart(2, '0')}`,
    }));
    const repeatedCharge = { txid: TXID_A, endToEndId: E2E_A };
    const consultarCobranca = vi.fn().mockResolvedValue({
      status: 'concluida',
      e2eId: E2E_A,
      valorPagoCents: 10_500,
      horario: PAID_AT,
    });
    const consultarDevolucao = vi.fn().mockResolvedValue({ status: 'devolvida' });
    const saveReceived = vi.spyOn(archive, 'saveReceived');

    const accepted = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([
        ...Array.from(
          { length: INTER_PIX_MAX_PARSED_EVENTS - refunds.length },
          () => repeatedCharge,
        ),
        { txid: TXID_B, endToEndId: E2E_B, devolucoes: refunds },
      ]),
      resolveChargeBinding,
      resolveRefundBinding,
      pixCobrancaProvider: provider({ consultarCobranca, consultarDevolucao }),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(accepted).toMatchObject({ status: 200, outcome: 'accepted' });
    expect(accepted.items).toHaveLength(1 + INTER_PIX_MAX_REFUNDS_PER_ENVELOPE);
    expect(accepted.items.every((item) => item.outcome === 'dispatched_success')).toBe(true);
    expect(saveReceived).toHaveBeenCalledTimes(1 + INTER_PIX_MAX_REFUNDS_PER_ENVELOPE);
    expect(resolveChargeBinding).toHaveBeenCalledTimes(1);
    expect(resolveRefundBinding).toHaveBeenCalledTimes(INTER_PIX_MAX_REFUNDS_PER_ENVELOPE);
    expect(consultarCobranca).toHaveBeenCalledTimes(1);
    expect(consultarDevolucao).toHaveBeenCalledTimes(INTER_PIX_MAX_REFUNDS_PER_ENVELOPE);
    expect(onChargeConfirmed).toHaveBeenCalledTimes(1);
    expect(onRefundConfirmed).toHaveBeenCalledTimes(INTER_PIX_MAX_REFUNDS_PER_ENVELOPE);

    const rejectedArchive = new WebhookEventArchiveMemory();
    const rejectedSaveReceived = vi.spyOn(rejectedArchive, 'saveReceived');
    const rejectedResolveChargeBinding = vi.fn();
    const rejectedResolveRefundBinding = vi.fn();
    const rejectedConsultarCobranca = vi.fn();
    const rejectedConsultarDevolucao = vi.fn();
    const rejectedOnChargeConfirmed = vi.fn();
    const rejectedOnRefundConfirmed = vi.fn();
    const rejected = await archiveAndDispatchInterPixWebhook(rejectedArchive, {
      rawBody: envelope([
        ...Array.from(
          { length: INTER_PIX_MAX_PARSED_EVENTS - refunds.length + 1 },
          () => repeatedCharge,
        ),
        { txid: TXID_B, endToEndId: E2E_B, devolucoes: refunds },
      ]),
      resolveChargeBinding: rejectedResolveChargeBinding,
      resolveRefundBinding: rejectedResolveRefundBinding,
      pixCobrancaProvider: provider({
        consultarCobranca: rejectedConsultarCobranca,
        consultarDevolucao: rejectedConsultarDevolucao,
      }),
      onChargeConfirmed: rejectedOnChargeConfirmed,
      onRefundConfirmed: rejectedOnRefundConfirmed,
    });

    expect(rejected).toMatchObject({ status: 400, outcome: 'malformed_body', items: [] });
    expect(rejectedSaveReceived).not.toHaveBeenCalled();
    expect(rejectedResolveChargeBinding).not.toHaveBeenCalled();
    expect(rejectedResolveRefundBinding).not.toHaveBeenCalled();
    expect(rejectedConsultarCobranca).not.toHaveBeenCalled();
    expect(rejectedConsultarDevolucao).not.toHaveBeenCalled();
    expect(rejectedOnChargeConfirmed).not.toHaveBeenCalled();
    expect(rejectedOnRefundConfirmed).not.toHaveBeenCalled();
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
