import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { sql } from 'kysely';
import type { Database } from '../database.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'postgresql',
  'db.collection.name': 'email_feedback',
} as const;

export interface EmailFeedbackAnswer {
  /** 1–5, or null for a comment-only answer. */
  nota: number | null;
  /** Up to 1000 characters, or null. */
  comentario: string | null;
}

async function comSpan<T>(nome: string, operacao: string, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(`db.email_feedback.${nome}`, async (span) => {
    span.setAttributes({ ...DB_ATTRS, 'db.operation.name': operacao });
    try {
      const result = await fn();
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

/**
 * "Avalie sua experiência" storage (aperture-tykv8). Callers validate the
 * signed per-delivery token and the input shape at the HTTP boundary; this
 * adapter binds the answer to that delivery and copies tenant/user/type from
 * the delivery row, so nothing identity-bearing comes from the form.
 */
export class EmailFeedbackPostgres {
  constructor(private readonly db: Database) {}

  async save(
    input: { deliveryId: string } & EmailFeedbackAnswer,
  ): Promise<'saved' | 'delivery_not_found'> {
    return comSpan('save', 'upsert', async () => {
      const { rows } = await sql<{ id: string }>`
        INSERT INTO email_feedback (id, delivery_id, tenant_id, user_id, type, nota, comentario)
        SELECT ${randomUUID()}, d.id, d.tenant_id, d.user_id, d.type, ${input.nota}, ${input.comentario}
          FROM lifecycle_email_deliveries d
         WHERE d.id = ${input.deliveryId}
        ON CONFLICT (delivery_id) DO UPDATE
          SET nota = EXCLUDED.nota, comentario = EXCLUDED.comentario, updated_at = now()
        RETURNING id
      `.execute(this.db);
      return rows.length === 0 ? 'delivery_not_found' : 'saved';
    });
  }

  async findByDeliveryId(deliveryId: string): Promise<EmailFeedbackAnswer | null> {
    return comSpan('findByDeliveryId', 'select', async () => {
      const row = await this.db
        .selectFrom('email_feedback')
        .select(['nota', 'comentario'])
        .where('delivery_id', '=', deliveryId)
        .executeTakeFirst();
      return row ? { nota: row.nota, comentario: row.comentario } : null;
    });
  }
}
