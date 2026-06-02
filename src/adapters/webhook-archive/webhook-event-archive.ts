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
}
