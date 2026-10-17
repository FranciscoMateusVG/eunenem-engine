import { SpanStatusCode, trace } from '@opentelemetry/api';
import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailMessage, EmailTransport } from './email-transport.js';

const tracer = trace.getTracer('frame');

// SendGrid SMTP API, per-message (not account/global tracking settings):
// https://www.twilio.com/docs/sendgrid/for-developers/sending-email/smtp-filters
const SENDGRID_DIRECT_LINKS_HEADER = JSON.stringify({
  filters: { clicktrack: { settings: { enable: 0, enable_text: false } } },
});

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
 * records only bounded success/failure metadata + the transport host. Raw
 * SMTP exceptions are never attached because they may embed RCPT addresses.
 */
export class EmailTransportNodemailer implements EmailTransport {
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly host: string;

  constructor(config: SmtpConfig, testEndpoint?: { port: number; ca: string }) {
    if (testEndpoint && process.env.NODE_ENV !== 'test')
      throw new Error('SMTP test endpoint forbidden outside tests');
    this.from = config.from;
    this.host = config.host;
    this.transporter = nodemailer.createTransport({
      host: testEndpoint ? '127.0.0.1' : config.host,
      port: testEndpoint?.port ?? config.port,
      secure: config.secure,
      // Authentication emails contain a bearer token. Port 587 must fail
      // closed if STARTTLS is unavailable or stripped; implicit TLS on 465 is
      // already encrypted from connect. Never weaken certificate validation.
      requireTLS: !config.secure,
      tls: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        ...(testEndpoint ? { ca: testEndpoint.ca, servername: 'localhost' } : {}),
      },
      auth: { user: config.user, pass: config.pass },
      // Pool so a burst of magic-link sends reuses connections rather than
      // opening one socket per email.
      pool: true,
      // Pool reconnects must never resend an ambiguous DATA transaction.
      ...{ maxRequeues: 0 },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
  }

  close(): void {
    this.transporter.close();
  }

  async enviar(message: EmailMessage): Promise<void> {
    return tracer.startActiveSpan('email.enviar', async (span) => {
      // Deliberately NO recipient/subject attributes — keep the email off the
      // telemetry (Cipher: no address→status oracle).
      span.setAttribute('email.transport', 'smtp');
      span.setAttribute('email.host', this.host);
      try {
        // No generic/custom headers cross the port. Only the verified SendGrid
        // SMTP host supports this mapping; never silently send an auth token
        // through an unsupported tracking policy.
        if (
          (message.disableClickTracking || message.disableOpenTracking) &&
          this.host.toLowerCase() !== 'smtp.sendgrid.net'
        ) {
          throw Object.assign(
            new Error('Email click-tracking policy unsupported by this SMTP host'),
            { code: 'ETRACKINGPOLICY' },
          );
        }
        await this.transporter.sendMail({
          from: this.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          ...(message.text ? { text: message.text } : {}),
          ...(message.disableClickTracking || message.disableOpenTracking
            ? {
                headers: {
                  'X-SMTPAPI': message.disableOpenTracking
                    ? {
                        prepared: true,
                        value: JSON.stringify({
                          filters: {
                            ...(message.disableClickTracking
                              ? { clicktrack: { settings: { enable: 0, enable_text: false } } }
                              : {}),
                            opentrack: { settings: { enable: 0 } },
                          },
                        }),
                      }
                    : SENDGRID_DIRECT_LINKS_HEADER,
                },
              }
            : {}),
        });
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error) {
        span.addEvent('email.send_failed', {
          'error.type': classifySmtpError(error),
        });
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

const SAFE_SMTP_ERROR_CODES = new Set([
  'EAUTH',
  'ECONNECTION',
  'EDNS',
  'EENVELOPE',
  'EMESSAGE',
  'ENETWORK',
  'ETIMEDOUT',
]);

function classifySmtpError(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return 'Error';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && SAFE_SMTP_ERROR_CODES.has(code) ? code : 'Error';
}
