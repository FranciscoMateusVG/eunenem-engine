/**
 * Webhook event archive — infrastructure port (aperture-1n6u8).
 *
 * Persists payment-provider webhook events for audit, replay, and
 * provider-migration survival. NOT a domain concept — webhook events
 * are provider-specific transport artifacts archived at the
 * infrastructure boundary. No domain entity, no domain use-case
 * operates on these records.
 *
 * Lives at `src/adapters/webhook-archive/` (top-level adapter slice,
 * NOT under `src/domain/`) because:
 *   - No Pagamento aggregate cares about webhook archives
 *   - No use-case dispatches behavior on archived rows
 *   - The persisted shape is the transport shape, not a domain VO
 *   - If we later need domain semantics ("WebhookEventReceived" as a
 *     domain event), promote then
 *
 * Idempotency anchor: `saveReceived` uses INSERT ... ON CONFLICT
 * DO NOTHING on the `(provider, provider_event_id)` UNIQUE
 * constraint. Stripe retries on 5xx; the second arrival hits the
 * constraint and returns `isDuplicate=true` so the handler can
 * short-circuit to 200.
 *
 * Write-before-verify discipline: the handler MUST call `saveReceived`
 * BEFORE signature verification, with `signatureValid` already set to
 * the verification result. This captures attack/replay attempts in the
 * archive for forensic analysis — without it, failed-signature events
 * leave no trace. The verification itself is local CPU work; the cost
 * of write-then-verify is one DB round-trip per attack attempt,
 * acceptable for the forensic value.
 */

/**
 * Persisted shape — mirrors `payment_webhook_events` columns 1:1.
 * The `rawPayload` field is the full event body as received from the
 * provider; opaque to this port (the handler's dispatch step reads it).
 */
export interface WebhookEventRecord {
  readonly id: string;
  readonly provider: string;
  readonly providerEventId: string;
  readonly eventType: string;
  readonly rawPayload: unknown;
  readonly signatureHeader: string;
  readonly signatureValid: boolean;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
  readonly processingError: string | null;
  readonly pagamentoId: string | null;
}

export interface SaveReceivedInput {
  readonly provider: string;
  readonly providerEventId: string;
  readonly eventType: string;
  readonly rawPayload: unknown;
  readonly signatureHeader: string;
  readonly signatureValid: boolean;
}

export interface SaveReceivedResult {
  /** The archive row id (newly minted on first insert, OR the existing row's id on conflict). */
  readonly id: string;
  /**
   * True when the (provider, providerEventId) tuple already existed in
   * the archive — Stripe is retrying a previously-archived event.
   * Handlers should short-circuit to 200 in that case to stop the retry
   * loop without re-dispatching domain side effects.
   */
  readonly isDuplicate: boolean;
}

/**
 * Maximum length the adapter will persist for `processingError`.
 * Exported so callers (handler + tests) can pre-truncate consistently.
 * Beyond this length, the adapter silently truncates. Stripe SDK
 * errors are typically short; this ceiling guards against arbitrarily
 * long stack-trace dumps choking the column.
 */
export const PROCESSING_ERROR_MAX_LENGTH = 2000;

export interface WebhookEventArchive {
  /**
   * Insert a received webhook event with its archived shape.
   *
   * Implements ON CONFLICT DO NOTHING semantics on the
   * `(provider, providerEventId)` UNIQUE constraint. Returns:
   *   - `{ id, isDuplicate: false }` on a fresh insert (caller proceeds to dispatch)
   *   - `{ id, isDuplicate: true }` on a retry (caller short-circuits to 200)
   *
   * The returned `id` is always a stable handle to THE archive row for
   * this (provider, providerEventId) — whether newly minted OR
   * pre-existing. Subsequent `markProcessed` / `markFailed` calls
   * should use this id.
   */
  saveReceived(input: SaveReceivedInput): Promise<SaveReceivedResult>;

  /**
   * Mark a successful domain dispatch: sets `processed_at = now()`,
   * sets `pagamento_id` (nullable — not every event type resolves to a
   * pagamento), and clears any previously-set `processing_error` so a
   * later successful re-dispatch doesn't leave stale failure noise.
   */
  markProcessed(id: string, pagamentoId: string | null): Promise<void>;

  /**
   * Mark a failed domain dispatch: sets `processing_error` (truncated
   * to PROCESSING_ERROR_MAX_LENGTH). `processed_at` stays NULL so
   * forensic queries can distinguish "never processed" from
   * "successfully processed."
   */
  markFailed(id: string, error: string): Promise<void>;

  /** Lookup by our own row id (used by tests and forensic UI). */
  findById(id: string): Promise<WebhookEventRecord | undefined>;

  /**
   * Lookup by the provider's event id (e.g. Stripe `evt_1ABCxxx`). Used
   * by retry detection and forensic queries. Returns undefined when
   * no archive row exists.
   */
  findByProviderEventId(
    provider: string,
    providerEventId: string,
  ): Promise<WebhookEventRecord | undefined>;

  /**
   * Enumerate webhook events linked to a specific `pagamento_id`
   * (aperture-2sp6m). Powers the admin UI's per-pagamento webhook
   * trail on /admin/contribuicao/:id (aperture-3zxkn parent).
   *
   * Orphan events (rows with `pagamento_id IS NULL`) are NEVER
   * returned here — they're filtered out by the WHERE clause
   * naturally. Orphan browsing requires a separate surface (out of
   * scope per the parent epic).
   *
   * Default ordering: `received_at ASC` — oldest first, so the visitor
   * lifecycle reads top-to-bottom in the UI (created → processing →
   * succeeded). Override via `options.orderBy` when DESC is wanted.
   *
   * Default limit: unbounded for v1. Per-pagamento event counts are
   * bounded small in practice (Stripe sends ~3-5 events per pagamento
   * lifecycle). If a pagamento accumulates pathological retry storms,
   * add an explicit limit via `options.limit`.
   *
   * Postgres adapter uses the partial index
   * `payment_webhook_events_pagamento_id_idx ON (pagamento_id) WHERE
   * pagamento_id IS NOT NULL` (1n6u8 migration 016) for selective scan.
   */
  findByPagamentoId(
    idPagamento: string,
    options?: FindByPagamentoIdOptions,
  ): Promise<readonly WebhookEventRecord[]>;

  /**
   * Plan 0015 / aperture-v4ax3. Retroactive sweep — relink orphan
   * webhook events (rows with `pagamento_id IS NULL`) to a pagamento
   * when we later learn that they belong to it.
   *
   * The scenario: payment_intent.* and charge.* events can arrive
   * BEFORE checkout.session.completed has populated the pagamento's
   * payment_intent_external_ref column. At arrival time the lookup
   * misses and the events archive as orphans. When cs.completed
   * later fires and persists the pi, we know retroactively which
   * pagamento those earlier events belonged to — this method
   * sweeps the archive for orphans referencing the same pi and
   * stamps `pagamento_id` on them.
   *
   * Match predicate (logical OR):
   *   - `raw_payload.data.object.id === $pi` — pi.* events whose
   *     primary id is the payment_intent (pi.requires_action,
   *     pi.created, pi.processing, pi.succeeded, pi.payment_failed).
   *   - `raw_payload.data.object.payment_intent === $pi` — charge.*
   *     events whose `payment_intent` field is the pi
   *     (charge.succeeded, charge.failed, charge.updated, charge.refunded).
   *
   * Idempotent: re-running with the same arguments is a no-op
   * because the WHERE clause filters on `pagamento_id IS NULL`.
   *
   * Returns the count of rows updated — caller logs this so
   * operators can see "linked N previously-orphan events" in
   * the forensic trail.
   */
  relinkOrphansByPaymentIntent(
    paymentIntentId: string,
    pagamentoId: string,
  ): Promise<number>;
}

export interface FindByPagamentoIdOptions {
  readonly orderBy?: 'received_at_asc' | 'received_at_desc';
  readonly limit?: number;
}
