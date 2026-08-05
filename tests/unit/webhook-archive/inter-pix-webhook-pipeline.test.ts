import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PixCobrancaProvider } from '../../../src/adapters/pagamentos/pix-cobranca-provider.js';
import {
  archiveAndDispatchInterPixWebhook,
  INTER_PIX_SIGNATURE_SENTINEL,
} from '../../../src/adapters/webhook-archive/inter-pix-webhook-pipeline.js';
import { WebhookEventArchiveMemory } from '../../../src/adapters/webhook-archive/webhook-event-archive.memory.js';

const TXID_A = 'A'.repeat(26);
const TXID_B = 'B'.repeat(26);
const E2E_A = 'E'.repeat(32);
const E2E_B = 'F'.repeat(32);
const PAID_AT = new Date('2026-08-05T12:00:00.000Z');

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

  beforeEach(() => {
    archive = new WebhookEventArchiveMemory(() => new Date('2026-08-05T12:30:00.000Z'));
    onChargeConfirmed = vi.fn().mockResolvedValue({ pagamentoId: 'pagamento-a' });
    onRefundConfirmed = vi.fn().mockResolvedValue({ pagamentoId: 'pagamento-a' });
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
    expect(onChargeConfirmed).toHaveBeenNthCalledWith(1, {
      txid: TXID_A,
      e2eId: E2E_A,
      amountCents: 10_500,
      horario: PAID_AT,
    });
    expect(onChargeConfirmed).toHaveBeenNthCalledWith(2, {
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
    expect(archivedA?.rawPayload).toMatchObject({ txid: TXID_A, endToEndId: E2E_A });
    expect(archivedB?.rawPayload).toMatchObject({ txid: TXID_B, endToEndId: E2E_B });
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

  it('marks a failed authoritative read categorically and performs no state change', async () => {
    const consultarCobranca = vi.fn().mockRejectedValue(new Error('provider body with payer PII'));
    const result = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([{ txid: TXID_A, endToEndId: E2E_A }]),
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

  it('rejects an e2e identity mismatch after GET /cob and does not dispatch', async () => {
    const result = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: envelope([{ txid: TXID_A, endToEndId: E2E_A }]),
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
          devolucoes: [{ id: 'refund1' }, { id: 'refund2' }],
        },
      ]),
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
    expect(consultarDevolucao).toHaveBeenNthCalledWith(1, E2E_A, 'refund1');
    expect(consultarDevolucao).toHaveBeenNthCalledWith(2, E2E_A, 'refund2');
    expect(onChargeConfirmed).not.toHaveBeenCalled();
    expect(onRefundConfirmed).toHaveBeenCalledTimes(2);
  });

  it('returns 400 and archives nothing for malformed or over-fanout envelopes', async () => {
    const invalidJson = await archiveAndDispatchInterPixWebhook(archive, {
      rawBody: '{',
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
      pixCobrancaProvider: provider(),
      onChargeConfirmed,
      onRefundConfirmed,
    });

    expect(invalidJson).toMatchObject({ status: 400, items: [] });
    expect(tooMany).toMatchObject({ status: 400, items: [] });
    expect(onChargeConfirmed).not.toHaveBeenCalled();
  });
});
