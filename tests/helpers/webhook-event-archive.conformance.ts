import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROCESSING_ERROR_MAX_LENGTH } from '../../src/adapters/webhook-archive/webhook-event-archive.js';
import type { WebhookEventArchive } from '../../src/adapters/webhook-archive/webhook-event-archive.js';

interface ConformanceOptions {
  readonly factory: () => WebhookEventArchive | Promise<WebhookEventArchive>;
  readonly resetState?: () => Promise<void>;
}

/**
 * Parameterized conformance suite for `WebhookEventArchive`
 * (aperture-1n6u8). Same test cases drive both
 * `WebhookEventArchiveMemory` and `WebhookEventArchivePostgres`. Adapter
 * parity — especially around the ON CONFLICT DO NOTHING idempotency
 * semantics — is enforced by running identical assertions against both
 * implementations.
 *
 * Postgres call site passes a `resetState` that truncates the table
 * between tests; memory tests pass nothing (each test gets a fresh
 * archive via `factory`).
 */
export function describeWebhookEventArchiveConformance(name: string, options: ConformanceOptions) {
  describe(`WebhookEventArchive conformance — ${name}`, () => {
    let archive: WebhookEventArchive;

    beforeEach(async () => {
      if (options.resetState) {
        await options.resetState();
      }
      archive = await options.factory();
    });

    it('saveReceived inserts a fresh row and round-trips via findById (aperture-1n6u8)', async () => {
      const result = await archive.saveReceived({
        provider: 'stripe',
        providerEventId: `evt_${randomUUID()}`,
        eventType: 'checkout.session.completed',
        rawPayload: { id: 'sess_123', amount_total: 4949 },
        signatureHeader: 't=1717000000,v1=abc123',
        signatureValid: true,
      });

      expect(result.isDuplicate).toBe(false);
      expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

      const found = await archive.findById(result.id);
      expect(found).toBeDefined();
      expect(found?.provider).toBe('stripe');
      expect(found?.eventType).toBe('checkout.session.completed');
      expect(found?.signatureValid).toBe(true);
      expect(found?.signatureHeader).toBe('t=1717000000,v1=abc123');
      // raw_payload round-trips through jsonb; structural equality.
      expect(found?.rawPayload).toEqual({ id: 'sess_123', amount_total: 4949 });
      expect(found?.processedAt).toBeNull();
      expect(found?.processingError).toBeNull();
      expect(found?.pagamentoId).toBeNull();
    });

    it('saveReceived second call with same (provider, providerEventId) returns isDuplicate=true WITHOUT mutating the row (aperture-1n6u8)', async () => {
      const providerEventId = `evt_${randomUUID()}`;

      // First insert — fresh.
      const first = await archive.saveReceived({
        provider: 'stripe',
        providerEventId,
        eventType: 'checkout.session.completed',
        rawPayload: { id: 'sess_first' },
        signatureHeader: 't=first',
        signatureValid: true,
      });
      expect(first.isDuplicate).toBe(false);

      // Mutate the first row so we can detect any silent overwrite by a retry.
      const firstPagamentoId = randomUUID();
      await archive.markProcessed(first.id, firstPagamentoId);
      const firstStatePostProcess = await archive.findById(first.id);
      expect(firstStatePostProcess?.processedAt).toBeInstanceOf(Date);
      expect(firstStatePostProcess?.pagamentoId).toBe(firstPagamentoId);

      // Second insert with DIFFERENT payload + signature but same provider_event_id.
      // Must return isDuplicate=true AND must NOT change any field on the original row.
      const second = await archive.saveReceived({
        provider: 'stripe',
        providerEventId,
        eventType: 'checkout.session.completed', // same shape just to be honest
        rawPayload: { id: 'sess_DIFFERENT', shouldNotPersist: true },
        signatureHeader: 't=DIFFERENT',
        signatureValid: false,
      });
      expect(second.isDuplicate).toBe(true);
      expect(second.id).toBe(first.id);

      const finalState = await archive.findById(first.id);
      expect(finalState?.signatureHeader).toBe('t=first');
      expect(finalState?.signatureValid).toBe(true);
      expect(finalState?.rawPayload).toEqual({ id: 'sess_first' });
      expect(finalState?.processedAt).toBeInstanceOf(Date); // still processed
      expect(finalState?.pagamentoId).toBe(firstPagamentoId);
    });

    it('markProcessed sets processed_at + pagamento_id (or null) and clears processing_error (aperture-1n6u8)', async () => {
      const inserted = await archive.saveReceived({
        provider: 'stripe',
        providerEventId: `evt_${randomUUID()}`,
        eventType: 'checkout.session.completed',
        rawPayload: { id: 'sess_proc' },
        signatureHeader: 't=ok',
        signatureValid: true,
      });

      // Pre-poison processing_error so we can assert markProcessed clears it.
      await archive.markFailed(inserted.id, 'a previous attempt failed');
      const poisoned = await archive.findById(inserted.id);
      expect(poisoned?.processingError).toBe('a previous attempt failed');

      // markProcessed with pagamentoId.
      const pagamentoId = randomUUID();
      await archive.markProcessed(inserted.id, pagamentoId);
      const processed = await archive.findById(inserted.id);
      expect(processed?.processedAt).toBeInstanceOf(Date);
      expect(processed?.pagamentoId).toBe(pagamentoId);
      // markProcessed clears stale processing_error.
      expect(processed?.processingError).toBeNull();

      // markProcessed with null pagamentoId (unknown_event / unknown_session paths).
      const inserted2 = await archive.saveReceived({
        provider: 'stripe',
        providerEventId: `evt_${randomUUID()}`,
        eventType: 'invoice.created',
        rawPayload: { id: 'inv_xyz' },
        signatureHeader: 't=ok2',
        signatureValid: true,
      });
      await archive.markProcessed(inserted2.id, null);
      const processed2 = await archive.findById(inserted2.id);
      expect(processed2?.processedAt).toBeInstanceOf(Date);
      expect(processed2?.pagamentoId).toBeNull();
    });

    it('markFailed sets processing_error (truncated to PROCESSING_ERROR_MAX_LENGTH) and leaves processed_at NULL (aperture-1n6u8)', async () => {
      const inserted = await archive.saveReceived({
        provider: 'stripe',
        providerEventId: `evt_${randomUUID()}`,
        eventType: 'checkout.session.completed',
        rawPayload: { id: 'sess_fail' },
        signatureHeader: 't=ok',
        signatureValid: true,
      });

      // Short error round-trips verbatim.
      await archive.markFailed(inserted.id, 'finalizarPagamentoAprovado threw');
      const short = await archive.findById(inserted.id);
      expect(short?.processingError).toBe('finalizarPagamentoAprovado threw');
      expect(short?.processedAt).toBeNull(); // still not processed

      // Long error truncates to PROCESSING_ERROR_MAX_LENGTH.
      const longError = 'x'.repeat(PROCESSING_ERROR_MAX_LENGTH + 500);
      await archive.markFailed(inserted.id, longError);
      const long = await archive.findById(inserted.id);
      expect(long?.processingError?.length).toBe(PROCESSING_ERROR_MAX_LENGTH);
      expect(long?.processedAt).toBeNull();
    });

    it('findByProviderEventId matches; returns undefined for unknown (aperture-1n6u8)', async () => {
      const providerEventId = `evt_${randomUUID()}`;
      const inserted = await archive.saveReceived({
        provider: 'stripe',
        providerEventId,
        eventType: 'checkout.session.completed',
        rawPayload: { id: 'sess_find' },
        signatureHeader: 't=ok',
        signatureValid: true,
      });

      const found = await archive.findByProviderEventId('stripe', providerEventId);
      expect(found).toBeDefined();
      expect(found?.id).toBe(inserted.id);
      expect(found?.providerEventId).toBe(providerEventId);

      // Wrong provider returns undefined (provider is part of the key).
      const wrongProvider = await archive.findByProviderEventId(
        'pagarme', // hypothetical future provider
        providerEventId,
      );
      expect(wrongProvider).toBeUndefined();

      // Unknown event id returns undefined.
      const unknown = await archive.findByProviderEventId('stripe', 'evt_does_not_exist');
      expect(unknown).toBeUndefined();
    });
  });
}
