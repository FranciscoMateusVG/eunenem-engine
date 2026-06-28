import nodemailer, { type Transporter } from 'nodemailer';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { EmailMessage, EmailTransport } from './email-transport.js';

const tracer = trace.getTracer('frame');

/**
 * SMTP config for the nodemailer transport (aperture-lwx2k). Sourced from env
 * by the composition root (SMTP_HOST/PORT/USER/PASS/FROM/SECURE); the
 * transport is only constructed when all required creds are present, so this
 * type is always fully-populated by the time it reaches here.
 */
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  /** Envelope/header From, e.g. `EuNeném <no-reply@eunenem.com>`. */
  readonly from: string;
  /** true = implicit TLS (port 465); false = STARTTLS (port 587). */
  readonly secure: boolean;
}

/**
 * Real SMTP transport via nodemailer (aperture-lwx2k). Reuses the legacy
 * eunenem SMTP infrastructure. One pooled transporter per process.
 *
 * NO per-email logging of address→status (Cipher no-oracle posture): the span
 * records only success/failure + the transport host, never the recipient.
 */
export class EmailTransportNodemailer implements EmailTransport {
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly host: string;

  constructor(config: SmtpConfig) {
    this.from = config.from;
    this.host = config.host;
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
      // Pool so a burst of magic-link sends reuses connections rather than
      // opening one socket per email.
      pool: true,
    });
  }

  async enviar(message: EmailMessage): Promise<void> {
    return tracer.startActiveSpan('email.enviar', async (span) => {
      // Deliberately NO recipient/subject attributes — keep the email off the
      // telemetry (Cipher: no address→status oracle).
      span.setAttribute('email.transport', 'smtp');
      span.setAttribute('email.host', this.host);
      try {
        await this.transporter.sendMail({
          from: this.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          ...(message.text ? { text: message.text } : {}),
        });
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
