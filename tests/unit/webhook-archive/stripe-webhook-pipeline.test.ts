import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { archiveAndDispatchStripeEvent } from '../../../src/adapters/webhook-archive/stripe-webhook-pipeline.js';
import { WebhookEventArchiveMemory } from '../../../src/adapters/webhook-archive/webhook-event-archive.memory.js';

/**
 * Pipeline tests for aperture-1n6u8.
 *
 * The Stripe webhook handler in
 * `apps/eunenem-server/server/webhooks/stripe-webhook.ts` is dumb glue;
 * `archiveAndDispatchStripeEvent` is the testable kernel. These tests
 * exercise the kernel against the memory archive + fake verifyEvent +
 * fake dispatch callbacks, covering the 5 handler-integration scenarios
 * from the bead's acceptance criteria (a)-(e):
 *
 *   (a) Valid Stripe webhook → row inserted with signature_valid=true;
 *       after dispatch, processed_at + pagamento_id populated.
 *   (b) Invalid signature → row inserted with signature_valid=false,
 *       processed_at NULL, no domain side effects.
 *   (c) Retry (duplicate evt_xxx) → ON CONFLICT returns existing id,
 *       200 sent to Stripe, no double-processing.
 *   (d) Domain dispatch throws → row exists with processed_at NULL,
 *       processing_error populated, 500 returned to Stripe.
 *   (e) Malformed body (not JSON) → 400 returned, no row inserted.
 *
 * The Hono shell + actual Stripe SDK signature math are NOT exercised
 * here — both are dumb pass-throughs with no decision logic of their
 * own. The pipeline owns every branch of behavior; testing it covers
 * the handler's real surface.
 */

function makeStripeEvent(overrides?: Partial<Stripe.Event>): Stripe.Event {
  return {
    id: 'evt_test_pipeline',
    object: 'event',
    api_version: '2024-04-10',
    created: 1717000000,
    type: 'checkout.session.completed',
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: 'cs_test_abc',
        object: 'checkout.session',
        amount_total: 4949,
      } as unknown as Stripe.Checkout.Session,
    },
    ...overrides,
  } as unknown as Stripe.Event;
}

describe('archiveAndDispatchStripeEvent (aperture-1n6u8 pipeline)', () => {
  let archive: WebhookEventArchiveMemory;
  let dispatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    archive = new WebhookEventArchiveMemory();
    dispatch = vi.fn();
  });

  // ─── (a) Valid signature path ────────────────────────────────────────

  it('(a) valid signature + successful dispatch: archive row signature_valid=true, processedAt populated, pagamentoId stored, status 200', async () => {
    const event = makeStripeEvent({ id: 'evt_valid_001' });
    const rawBody = JSON.stringify(event);
    dispatch.mockResolvedValueOnce({ pagamentoId: 'pag_xyz_001' });

    const result = await archiveAndDispatchStripeEvent(archive, {
      rawBody,
      signatureHeader: 't=1717000000,v1=fakebutpresent',
      verifyEvent: () => event,
      dispatch: dispatch as never,
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe('ok');
    expect(result.outcome).toBe('dispatched_success');
    expect(result.archiveId).toBeDefined();

    const archived = await archive.findById(result.archiveId as string);
    expect(archived).toBeDefined();
    expect(archived?.signatureValid).toBe(true);
    expect(archived?.providerEventId).toBe('evt_valid_001');
    expect(archived?.eventType).toBe('checkout.session.completed');
    expect(archived?.processedAt).toBeInstanceOf(Date);
    expect(archived?.pagamentoId).toBe('pag_xyz_001');
    expect(archived?.processingError).toBeNull();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(event);
  });

  it('(a-2) valid signature + dispatch resolves with pagamentoId=null (e.g. unknown_session): processedAt populated, pagamentoId stays null', async () => {
    const event = makeStripeEvent({ id: 'evt_unknown_session' });
    dispatch.mockResolvedValueOnce({ pagamentoId: null });

    const result = await archiveAndDispatchStripeEvent(archive, {
      rawBody: JSON.stringify(event),
      signatureHeader: 't=ok',
      verifyEvent: () => event,
      dispatch: dispatch as never,
    });

    expect(result.status).toBe(200);
    expect(result.outcome).toBe('dispatched_success');

    const archived = await archive.findById(result.archiveId as string);
    expect(archived?.processedAt).toBeInstanceOf(Date);
    expect(archived?.pagamentoId).toBeNull();
  });

  // ─── (b) Invalid signature path ──────────────────────────────────────

  it('(b) invalid signature: archive row signature_valid=false, processedAt NULL, dispatch NOT called, status 400', async () => {
    const event = makeStripeEvent({ id: 'evt_bad_sig' });
    const rawBody = JSON.stringify(event);

    const result = await archiveAndDispatchStripeEvent(archive, {
      rawBody,
      signatureHeader: 't=forged',
      verifyEvent: () => {
        throw new Error('Stripe.errors.StripeSignatureVerificationError: signature mismatch');
      },
      dispatch: dispatch as never,
    });

    expect(result.status).toBe(400);
    expect(result.body).toBe('signature mismatch');
    expect(result.outcome).toBe('signature_failed');
    expect(result.archiveId).toBeDefined();

    // Row IS archived (write-before-verify discipline — forensic evidence).
    const archived = await archive.findById(result.archiveId as string);
    expect(archived?.signatureValid).toBe(false);
    expect(archived?.providerEventId).toBe('evt_bad_sig');
    expect(archived?.processedAt).toBeNull();
    expect(archived?.processingError).toBeNull(); // dispatch never ran

    // No domain side effects.
    expect(dispatch).not.toHaveBeenCalled();
  });

  // ─── (c) Retry (duplicate event id) ──────────────────────────────────

  it('(c) retry (duplicate evt_xxx): second call returns isDuplicate via ON CONFLICT, status 200, dispatch NOT called second time, original row unchanged', async () => {
    const event = makeStripeEvent({ id: 'evt_retry_test' });
    const rawBody = JSON.stringify(event);
    dispatch.mockResolvedValueOnce({ pagamentoId: 'pag_first_call' });

    // First delivery — succeeds.
    const first = await archiveAndDispatchStripeEvent(archive, {
      rawBody,
      signatureHeader: 't=ok',
      verifyEvent: () => event,
      dispatch: dispatch as never,
    });
    expect(first.outcome).toBe('dispatched_success');
    expect(dispatch).toHaveBeenCalledTimes(1);

    const firstArchive = await archive.findById(first.archiveId as string);
    expect(firstArchive?.pagamentoId).toBe('pag_first_call');

    // Second delivery (Stripe retry) — same evt id, even if dispatch would
    // have done something different, the pipeline must short-circuit.
    const dispatchRetry = vi.fn().mockResolvedValue({ pagamentoId: 'pag_DIFFERENT' });
    const second = await archiveAndDispatchStripeEvent(archive, {
      rawBody,
      signatureHeader: 't=ok',
      verifyEvent: () => event,
      dispatch: dispatchRetry as never,
    });

    expect(second.status).toBe(200);
    expect(second.body).toBe('ok (duplicate)');
    expect(second.outcome).toBe('duplicate_retry');
    expect(second.archiveId).toBe(first.archiveId);

    // CRITICAL: dispatch must NOT have been called on the retry.
    expect(dispatchRetry).not.toHaveBeenCalled();

    // Original row's pagamentoId is unchanged.
    const finalArchive = await archive.findById(first.archiveId as string);
    expect(finalArchive?.pagamentoId).toBe('pag_first_call');
  });

  // ─── (d) Domain dispatch throws ──────────────────────────────────────

  it('(d) dispatch throws: archive row exists with processedAt NULL and processing_error populated; status 500 (Stripe will retry)', async () => {
    const event = makeStripeEvent({ id: 'evt_dispatch_fails' });
    const rawBody = JSON.stringify(event);
    dispatch.mockRejectedValueOnce(
      new Error('finalizarPagamentoAprovado: Pagamento not in expected state'),
    );

    const result = await archiveAndDispatchStripeEvent(archive, {
      rawBody,
      signatureHeader: 't=ok',
      verifyEvent: () => event,
      dispatch: dispatch as never,
    });

    expect(result.status).toBe(500);
    expect(result.body).toBe('downstream error');
    expect(result.outcome).toBe('dispatched_failed');

    const archived = await archive.findById(result.archiveId as string);
    expect(archived?.signatureValid).toBe(true); // verify succeeded
    expect(archived?.processedAt).toBeNull(); // dispatch did NOT complete
    expect(archived?.processingError).toBe(
      'finalizarPagamentoAprovado: Pagamento not in expected state',
    );
    expect(archived?.pagamentoId).toBeNull();

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  // ─── (e) Malformed body ──────────────────────────────────────────────

  it('(e) malformed body (not JSON): status 400, NO archive row, dispatch NOT called', async () => {
    const result = await archiveAndDispatchStripeEvent(archive, {
      rawBody: 'this is not json',
      signatureHeader: 't=ok',
      verifyEvent: () => makeStripeEvent(), // never called
      dispatch: dispatch as never,
    });

    expect(result.status).toBe(400);
    expect(result.body).toBe('invalid json');
    expect(result.outcome).toBe('malformed_body');
    expect(result.archiveId).toBeUndefined();

    // No row inserted — there was no providerEventId to key by.
    const all = await archive.findByProviderEventId('stripe', '');
    expect(all).toBeUndefined();

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('(e-2) JSON body without required event.id / event.type fields: status 400, NO archive row', async () => {
    const result = await archiveAndDispatchStripeEvent(archive, {
      rawBody: JSON.stringify({ random: 'garbage', without_id: true }),
      signatureHeader: 't=ok',
      verifyEvent: () => makeStripeEvent(),
      dispatch: dispatch as never,
    });

    expect(result.status).toBe(400);
    expect(result.body).toBe('invalid event shape');
    expect(result.outcome).toBe('malformed_body');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
