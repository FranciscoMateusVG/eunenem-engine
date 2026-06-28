import { trace } from '@opentelemetry/api';
import type { Logger } from '../../observability/logger.js';
import type { EmailMessage, EmailTransport } from './email-transport.js';

const tracer = trace.getTracer('frame');

/**
 * Boot-safe no-op email transport (aperture-lwx2k).
 *
 * Used when SMTP env is absent (dev / CI / any env without the legacy creds).
 * Never sends, never throws. In that posture the magicLink plugin is
 * conditionally-spread OFF, so no production sign-in path depends on this —
 * it exists so the SHARED transport seam is always non-null and the rest of
 * the app (e.g. the c0a5s thank-you email) degrades gracefully instead of
 * crashing at construction.
 *
 * Emits a span (no recipient) so a misconfigured env where a real send was
 * expected is visible in telemetry, without leaking the address.
 */
export class EmailTransportNoop implements EmailTransport {
  constructor(private readonly logger?: Logger) {}

  async enviar(_message: EmailMessage): Promise<void> {
    const span = tracer.startSpan('email.enviar');
    span.setAttribute('email.transport', 'noop');
    this.logger?.warn('email.transport_noop', {
      motivo: 'SMTP nao configurado — email descartado (boot-safe no-op)',
    });
    span.end();
  }
}
