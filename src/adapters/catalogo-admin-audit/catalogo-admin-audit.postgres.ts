import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { sql } from 'kysely';
import type { Database } from '../database.js';
import type {
  AppendCatalogoAdminAuditEventInput,
  CatalogoAdminAudit,
} from './catalogo-admin-audit.js';
import { assertValidCatalogoAdminAuditEvent } from './catalogo-admin-audit.js';

const tracer = trace.getTracer('frame');

export class CatalogoAdminAuditPostgres implements CatalogoAdminAudit {
  constructor(private readonly db: Database) {}

  async append(input: AppendCatalogoAdminAuditEventInput): Promise<void> {
    assertValidCatalogoAdminAuditEvent(input);
    return tracer.startActiveSpan('db.catalogo_admin_audit_events.append', async (span) => {
      span.setAttributes({
        'db.system': 'postgresql',
        'db.collection.name': 'catalogo_admin_audit_events',
        'db.operation.name': 'INSERT',
        'catalogo.audit.action': input.action,
        'catalogo.audit.phase': input.phase,
      });
      try {
        await sql`
          INSERT INTO catalogo_admin_audit_events
            (id, request_id, actor_usuario_id, action, phase,
             target_type, target_id, metadata)
          VALUES
            (${randomUUID()}, ${input.requestId}, ${input.actorUsuarioId},
             ${input.action}, ${input.phase}, ${input.targetType},
             ${input.targetId}, ${JSON.stringify(input.metadata)}::jsonb)
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
}
