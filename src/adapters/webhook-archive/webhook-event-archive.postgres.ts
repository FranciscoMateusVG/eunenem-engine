import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { sql } from 'kysely';
import type { Database } from '../database.js';
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
  'db.system': 'postgresql',
  'db.collection.name': 'payment_webhook_events',
} as const;

/**
 * Postgres-backed `WebhookEventArchive` (aperture-1n6u8). Persists
 * payment-provider webhook events to `payment_webhook_events` (migration
 * 016). Idempotency via the UNIQUE (provider, provider_event_id)
 * constraint + INSERT ON CONFLICT DO NOTHING.
 */
export class WebhookEventArchivePostgres implements WebhookEventArchive {
  constructor(private readonly db: Database) {}

  async saveReceived(input: SaveReceivedInput): Promise<SaveReceivedResult> {
    return tracer.startActiveSpan('db.payment_webhook_events.saveReceived', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'INSERT' });
      try {
        const newId = randomUUID();
        // INSERT ... ON CONFLICT DO NOTHING RETURNING id
        // - If insert happens: RETURNING yields the new id (fresh row)
        // - If conflict: ON CONFLICT DO NOTHING suppresses the error,
        //   RETURNING yields NO rows. We follow with a SELECT to fetch
        //   the existing row's id. Two round-trips on the rare retry
        //   path; one round-trip on the common fresh-event path.
        const inserted = await sql<{ id: string }>`
          INSERT INTO payment_webhook_events
            (id, provider, provider_event_id, event_type, raw_payload,
             signature_header, signature_valid)
          VALUES
            (${newId}, ${input.provider}, ${input.providerEventId},
             ${input.eventType}, ${JSON.stringify(input.rawPayload)}::jsonb,
             ${input.signatureHeader}, ${input.signatureValid})
          ON CONFLICT (provider, provider_event_id) DO NOTHING
          RETURNING id
        `.execute(this.db);

        if (inserted.rows.length > 0) {
          span.setStatus({ code: SpanStatusCode.OK });
          return { id: inserted.rows[0]?.id as string, isDuplicate: false };
        }

        // Conflict path — fetch the existing row's id. The unique
        // constraint guarantees exactly one match.
        const existing = await sql<{ id: string }>`
          SELECT id FROM payment_webhook_events
          WHERE provider = ${input.provider}
            AND provider_event_id = ${input.providerEventId}
          LIMIT 1
        `.execute(this.db);

        if (existing.rows.length === 0) {
          // Defensive: should be impossible given ON CONFLICT fired.
          throw new Error(
            'WebhookEventArchivePostgres: ON CONFLICT fired but the conflicting row could not be found. ' +
              'Race condition or constraint mismatch?',
          );
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return { id: existing.rows[0]?.id as string, isDuplicate: true };
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
        await sql`
          UPDATE payment_webhook_events
            SET processed_at = now(),
                processing_error = NULL,
                pagamento_id = ${pagamentoId}
            WHERE id = ${id}
        `.execute(this.db);
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
        const truncated = error.slice(0, PROCESSING_ERROR_MAX_LENGTH);
        await sql`
          UPDATE payment_webhook_events
            SET processing_error = ${truncated}
            WHERE id = ${id}
        `.execute(this.db);
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
        const rows = await sql<PaymentWebhookEventRow>`
          SELECT id, provider, provider_event_id, event_type, raw_payload,
                 signature_header, signature_valid, received_at, processed_at,
                 processing_error, pagamento_id
            FROM payment_webhook_events
            WHERE id = ${id}
            LIMIT 1
        `.execute(this.db);
        span.setStatus({ code: SpanStatusCode.OK });
        return rows.rows[0] ? toRecord(rows.rows[0]) : undefined;
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
          const rows = await sql<PaymentWebhookEventRow>`
            SELECT id, provider, provider_event_id, event_type, raw_payload,
                   signature_header, signature_valid, received_at, processed_at,
                   processing_error, pagamento_id
              FROM payment_webhook_events
              WHERE provider = ${provider}
                AND provider_event_id = ${providerEventId}
              LIMIT 1
          `.execute(this.db);
          span.setStatus({ code: SpanStatusCode.OK });
          return rows.rows[0] ? toRecord(rows.rows[0]) : undefined;
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
          // aperture-2sp6m: uses the partial index
          // `payment_webhook_events_pagamento_id_idx ON (pagamento_id)
          // WHERE pagamento_id IS NOT NULL` shipped by 1n6u8's migration
          // 016. The equality predicate is satisfied only by non-NULL
          // values, so orphan rows are naturally excluded — no extra
          // IS NOT NULL needed in the WHERE.
          const orderClause =
            (options?.orderBy ?? 'received_at_asc') === 'received_at_desc'
              ? sql`ORDER BY received_at DESC`
              : sql`ORDER BY received_at ASC`;
          const limitClause =
            typeof options?.limit === 'number' && options.limit >= 0
              ? sql`LIMIT ${options.limit}`
              : sql``;

          const rows = await sql<PaymentWebhookEventRow>`
            SELECT id, provider, provider_event_id, event_type, raw_payload,
                   signature_header, signature_valid, received_at, processed_at,
                   processing_error, pagamento_id
              FROM payment_webhook_events
              WHERE pagamento_id = ${idPagamento}
              ${orderClause}
              ${limitClause}
          `.execute(this.db);

          const result = rows.rows.map(toRecord);
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

interface PaymentWebhookEventRow {
  id: string;
  provider: string;
  provider_event_id: string;
  event_type: string;
  raw_payload: unknown;
  signature_header: string;
  signature_valid: boolean;
  received_at: Date;
  processed_at: Date | null;
  processing_error: string | null;
  pagamento_id: string | null;
}

function toRecord(row: PaymentWebhookEventRow): WebhookEventRecord {
  return {
    id: row.id,
    provider: row.provider,
    providerEventId: row.provider_event_id,
    eventType: row.event_type,
    rawPayload: row.raw_payload,
    signatureHeader: row.signature_header,
    signatureValid: row.signature_valid,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
    processingError: row.processing_error,
    pagamentoId: row.pagamento_id,
  };
}
