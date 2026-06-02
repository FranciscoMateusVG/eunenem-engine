import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  type FindByPagamentoIdOptions,
  PROCESSING_ERROR_MAX_LENGTH,
  type SaveReceivedInput,
  type SaveReceivedResult,
  type WebhookEventArchive,
  type WebhookEventRecord,
} from './webhook-event-archive.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'payment_webhook_events',
} as const;

/**
 * In-memory `WebhookEventArchive` (aperture-1n6u8). Used by unit tests +
 * any future in-process integration tests. Mirrors the postgres adapter's
 * ON CONFLICT DO NOTHING semantics via a preflight `findByProviderEventId`
 * scan — single-threaded JS, so the check + insert is atomic enough for
 * test purposes.
 */
export class WebhookEventArchiveMemory implements WebhookEventArchive {
  private readonly rows = new Map<string, WebhookEventRecord>();
  /** Composite (provider, providerEventId) → row id index for fast retry detection. */
  private readonly byProviderEventId = new Map<string, string>();
  /**
   * Monotone receivedAt floor: each new saveReceived gets a Date strictly
   * later than the previous insert, so test ordering (aperture-2sp6m
   * findByPagamentoId orderBy) is stable even when multiple inserts
   * happen within the same millisecond. The postgres adapter doesn't
   * need this — Postgres `now()` advances naturally with each call.
   */
  private lastReceivedAtMs = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  private compositeKey(provider: string, providerEventId: string): string {
    return `${provider}::${providerEventId}`;
  }

  async saveReceived(input: SaveReceivedInput): Promise<SaveReceivedResult> {
    return tracer.startActiveSpan('db.payment_webhook_events.saveReceived', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        const key = this.compositeKey(input.provider, input.providerEventId);
        const existingId = this.byProviderEventId.get(key);
        if (existingId !== undefined) {
          // Retry — return the existing id, do NOT mutate the row.
          span.setStatus({ code: SpanStatusCode.OK });
          return { id: existingId, isDuplicate: true };
        }

        const id = randomUUID();
        // Monotone receivedAt floor (aperture-2sp6m): ensures stable
        // ordering for findByPagamentoId across rapid-fire inserts.
        const nowMs = this.clock().getTime();
        const receivedAtMs = Math.max(nowMs, this.lastReceivedAtMs + 1);
        this.lastReceivedAtMs = receivedAtMs;
        const record: WebhookEventRecord = {
          id,
          provider: input.provider,
          providerEventId: input.providerEventId,
          eventType: input.eventType,
          rawPayload: input.rawPayload,
          signatureHeader: input.signatureHeader,
          signatureValid: input.signatureValid,
          receivedAt: new Date(receivedAtMs),
          processedAt: null,
          processingError: null,
          pagamentoId: null,
        };
        this.rows.set(id, record);
        this.byProviderEventId.set(key, id);

        span.setStatus({ code: SpanStatusCode.OK });
        return { id, isDuplicate: false };
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async markProcessed(id: string, pagamentoId: string | null): Promise<void> {
    return tracer.startActiveSpan('db.payment_webhook_events.markProcessed', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        const existing = this.rows.get(id);
        if (!existing) {
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }
        this.rows.set(id, {
          ...existing,
          processedAt: this.clock(),
          // Clear stale failure noise — if a previous attempt failed and a
          // re-dispatch succeeded, we want the row to reflect the success.
          processingError: null,
          pagamentoId,
        });
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    return tracer.startActiveSpan('db.payment_webhook_events.markFailed', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        const existing = this.rows.get(id);
        if (!existing) {
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }
        this.rows.set(id, {
          ...existing,
          processingError: error.slice(0, PROCESSING_ERROR_MAX_LENGTH),
          // processed_at stays as-is — forensic queries distinguish
          // "never processed" (NULL) from "successfully processed" (Date).
        });
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error_: unknown) {
        span.recordException(error_ as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error_;
      } finally {
        span.end();
      }
    });
  }

  async findById(id: string): Promise<WebhookEventRecord | undefined> {
    return tracer.startActiveSpan('db.payment_webhook_events.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const result = this.rows.get(id);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findByProviderEventId(
    provider: string,
    providerEventId: string,
  ): Promise<WebhookEventRecord | undefined> {
    return tracer.startActiveSpan(
      'db.payment_webhook_events.findByProviderEventId',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          const id = this.byProviderEventId.get(this.compositeKey(provider, providerEventId));
          const result = id !== undefined ? this.rows.get(id) : undefined;
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async findByPagamentoId(
    idPagamento: string,
    options?: FindByPagamentoIdOptions,
  ): Promise<readonly WebhookEventRecord[]> {
    return tracer.startActiveSpan(
      'db.payment_webhook_events.findByPagamentoId',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          // aperture-2sp6m: filter by pagamento_id. Orphan rows
          // (pagamento_id === null) excluded by the strict-equality
          // match; matches the postgres adapter's WHERE pagamento_id = $1
          // semantics (NULL never satisfies the equality).
          const orderBy = options?.orderBy ?? 'received_at_asc';
          const limit = options?.limit;
          const filtered = [...this.rows.values()].filter(
            (r) => r.pagamentoId === idPagamento,
          );
          filtered.sort((a, b) => {
            const dt = a.receivedAt.getTime() - b.receivedAt.getTime();
            return orderBy === 'received_at_desc' ? -dt : dt;
          });
          const result =
            typeof limit === 'number' && limit >= 0 ? filtered.slice(0, limit) : filtered;
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }
}
