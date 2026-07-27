import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type {
  AppendCatalogoAdminAuditEventInput,
  CatalogoAdminAudit,
  CatalogoAdminAuditEvent,
} from './catalogo-admin-audit.js';
import { assertValidCatalogoAdminAuditEvent } from './catalogo-admin-audit.js';

const tracer = trace.getTracer('frame');

export class CatalogoAdminAuditMemory implements CatalogoAdminAudit {
  private readonly rows: CatalogoAdminAuditEvent[] = [];

  constructor(private readonly clock: () => Date = () => new Date()) {}

  /**
   * Snapshot for assertions. Both the array and JSON metadata are copied so a
   * test cannot mutate the append-only store through this read surface.
   */
  get events(): readonly CatalogoAdminAuditEvent[] {
    return this.rows.map((event) => ({
      ...event,
      occurredAt: new Date(event.occurredAt),
      metadata: structuredClone(event.metadata),
    }));
  }

  async append(input: AppendCatalogoAdminAuditEventInput): Promise<void> {
    assertValidCatalogoAdminAuditEvent(input);
    return tracer.startActiveSpan('db.catalogo_admin_audit_events.append', async (span) => {
      span.setAttributes({
        'db.system': 'memory',
        'db.collection.name': 'catalogo_admin_audit_events',
        'db.operation.name': 'INSERT',
        'catalogo.audit.action': input.action,
        'catalogo.audit.phase': input.phase,
      });
      try {
        this.rows.push({
          ...input,
          id: randomUUID(),
          occurredAt: this.clock(),
          metadata: structuredClone(input.metadata),
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
}
