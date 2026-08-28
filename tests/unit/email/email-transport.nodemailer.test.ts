import { afterAll, describe, expect, it, vi } from 'vitest';
import { EmailTransportNodemailer } from '../../../src/adapters/email/email-transport.nodemailer.js';
import { createTestObservability } from '../../helpers/observability.js';

const telemetry = createTestObservability();

afterAll(async () => telemetry.shutdown());

describe('EmailTransportNodemailer telemetry', () => {
  it('does not attach recipient-bearing SMTP exception content to telemetry', async () => {
    telemetry.reset();
    const sentinel = 'sentinel-payer@example.invalid';
    const smtpError = Object.assign(new Error(`RCPT TO <${sentinel}> rejected`), {
      code: 'EENVELOPE',
      stack: `Error: recipient ${sentinel}\n at smtp`,
    });
    const transport = new EmailTransportNodemailer({
      host: 'smtp.example.invalid',
      port: 587,
      user: 'test',
      pass: 'test',
      from: 'sender@example.invalid',
      secure: false,
    });
    const sendMail = vi.fn().mockRejectedValue(smtpError);
    Object.assign(transport as unknown as { transporter: unknown }, {
      transporter: { sendMail },
    });

    await expect(
      transport.enviar({
        to: sentinel,
        subject: 'receipt',
        html: '<p>receipt</p>',
      }),
    ).rejects.toBe(smtpError);

    const serialized = JSON.stringify(
      telemetry.getSpans().map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    );
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain(smtpError.message);
    expect(serialized).not.toContain(smtpError.stack);

    const span = telemetry.getSpans().find((candidate) => candidate.name === 'email.enviar');
    expect(span?.events).toEqual([
      expect.objectContaining({
        name: 'email.send_failed',
        attributes: { 'error.type': 'EENVELOPE' },
      }),
    ]);
  });
});
